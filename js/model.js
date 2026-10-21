// "True Potential" rating model.
//
// For each component c (points, fuel, tower, ...) we fit
//     alliance_value ≈ Σ_{robots on alliance} θ_team
// by regularized least squares that shrinks each team toward a prior:
//     (Aᵀ W A + Λ) θ = Aᵀ W y + Λ μ₀
// This is the Bayesian (MMSE) version of OPR: with Λ → 0 it is OPR, with a
// team-specific μ₀ it behaves like TBA Insights / Statbotics EPA early in an
// event, and it gives a posterior variance for every team for free.
(function (root) {
  'use strict';
  const LA = root.LinAlg || (typeof require !== 'undefined' ? require('./linalg.js') : null);

  const DEFAULT_SETTINGS = {
    lambda: 3,          // prior strength (in "matches") for teams with earlier-event history (backtested on 2019 + 2026)
    lambdaPerEvent: 0.5, // extra prior strength per additional earlier event...
    lambdaMaxMult: 2,    // ...capped at 2x
    lambdaNew: 1.5,     // prior strength for teams with no history
    useReliability: true, // recorded breakdowns lower a team's expected contribution in predictions
    relPrior: 6,          // a team's breakdown rate is blended with the event's as if from 6 matches
    relDecay: 0.85,       // a problem k matches ago counts 0.85^k: recent reliability matters more
    prevYearShrink: 0.9, // how much of last season's relative strength carries over (2026 backtest)
    lambdaPrevYear: 3,   // prior strength for a last-season-only prior
    newFactor: 0.85,    // teams with no history start at 85% of the event's average contribution
    elimWeight: 1 / 3,  // playoff matches count 1/3 (different incentives, repeated partners)
    scoutWeight: 1,     // weight of a scouted per-robot observation relative to an alliance score
    sigmaK: 20,         // pseudo-observations used to shrink the noise estimate toward the prior noise
    scaleK: 24,         // alliance-rows before prior ratings are fully rescaled to this event's scoring level
    scaleMin: 0.5,      // limits on that rescaling
    scaleMax: 2,
  };

  const QUAL = 'qm';

  function matchOrder(m) {
    const lvl = { qm: 0, ef: 1, qf: 2, sf: 3, f: 4 }[m.comp] ?? 5;
    return lvl * 100000 + (m.set || 0) * 1000 + (m.num || 0);
  }

  // Team keys can carry a suffix for second robots at offseasons ("frc190B").
  function teamCmp(a, b) {
    const na = parseInt(a.slice(3), 10), nb = parseInt(b.slice(3), 10);
    return na !== nb ? na - nb : a < b ? -1 : a > b ? 1 : 0;
  }

  function sortMatches(ms) { return ms.slice().sort((a, b) => matchOrder(a) - matchOrder(b)); }

  function isPlayed(m) { return !!(m.played && m.r && m.b && m.r.score != null && m.b.score != null); }

  // Build observation rows for one component.
  // Robot problems recorded in the match editor: m.issues[team] = {type: 'broke'|'noshow',
  // when: 'auto'|'teleop'|'endgame', what, note}. Legacy m.out[team] = no-show.
  function robotIssue(m, t) {
    if (m.issues && m.issues[t]) return m.issues[t];
    if (m.out && m.out[t]) return { type: 'noshow' };
    return null;
  }
  // A robot that never really played (no-show, or broke in auto) contributed ~nothing.
  function sitsOut(iss) { return !!iss && (iss.type === 'noshow' || (iss.type === 'broke' && iss.when === 'auto')); }
  // A mid-match breakdown makes the alliance score unreliable for everyone on it.
  function spoilsRow(iss) { return !!iss && iss.type === 'broke' && iss.when !== 'auto'; }

  function collectRows(event, game, comp, idx, settings, include) {
    const rows = [];
    // Optional recency weighting inside the event: a round ago counts matchDecay×.
    let age = null;
    if (settings.matchDecay && settings.matchDecay < 1) {
      const qs = event.matches.filter(m => m.comp === QUAL && isPlayed(m) && (!include || include(m)));
      const perRound = Math.max(1, event.teams.length / 6);
      age = {};
      qs.forEach((m, k) => { age[m.key] = (qs.length - 1 - k) / perRound; });
    }
    const cdef = game.comps.find(c => c.key === comp);
    const perRobot = !!(cdef && cdef.perRobot);
    for (const m of event.matches) {
      if (!isPlayed(m) || (include && !include(m))) continue;
      let w0 = m.comp === QUAL ? 1 : settings.elimWeight;
      if (age && age[m.key] != null) w0 *= Math.pow(settings.matchDecay, age[m.key]);
      for (const side of ['r', 'b']) {
        const teams = side === 'r' ? m.red : m.blue;
        const vals = m[side];
        const iss = teams.map(t => robotIssue(m, t));
        if (perRobot && vals.robots && vals.robots.length === teams.length) {
          teams.forEach((t, k) => {
            if (iss[k] || idx[t] === undefined) return; // a robot with a problem says nothing about its ability
            rows.push({ idx: [idx[t]], y: vals.robots[k][comp], w: w0, id: m.key + side, match: true });
          });
          continue;
        }
        const y = vals[comp];
        if (y == null) continue;
        if (iss.some(spoilsRow)) continue;
        const ids = teams.filter((t, k) => !sitsOut(iss[k]) && idx[t] !== undefined).map(t => idx[t]);
        if (!ids.length) continue;
        // For per-robot components an alliance total carries 3 robots' worth of noise.
        rows.push({ idx: ids, y, w: perRobot ? w0 / 3 : w0, id: m.key + side, match: true });
      }
    }
    const sc = event.scouting;
    if (sc && sc.rows && sc.map) {
      for (const [col, c] of Object.entries(sc.map)) {
        if (c !== comp) continue;
        for (const r of sc.rows) {
          const v = r.values[col];
          if (v == null || !isFinite(v) || idx[r.team] === undefined) continue;
          rows.push({ idx: [idx[r.team]], y: v, w: settings.scoutWeight, scout: true });
        }
      }
    }
    return { rows, perRobot };
  }

  function fitComponent(event, game, comp, teams, idx, settings, include) {
    const n = teams.length;
    const { rows, perRobot } = collectRows(event, game, comp, idx, settings, include);
    const priors = event.priors || {};
    const priorSigma2 = (event.priorMeta && event.priorMeta.sigma2 && event.priorMeta.sigma2[comp]) || null;

    // Event base level: average per-robot contribution among observed rows.
    let sw = 0, swy = 0, swk = 0;
    for (const r of rows) if (r.match) { sw += r.w; swy += r.w * r.y; swk += r.w * r.idx.length; }
    const priorVals = teams.map(t => (priors[t] && priors[t][comp] != null ? priors[t][comp] : null));
    const withPrior = priorVals.filter(v => v != null);
    const priorAvg = withPrior.length ? withPrior.reduce((a, b) => a + b, 0) / withPrior.length : null;
    let base = swk > 0 ? swy / swk : priorAvg;
    if (base == null) {
      return { available: false, nRows: 0, mean: new Float64Array(n), var: new Float64Array(n), s2: 0, noise: 0, base: 0, coverage: 0 };
    }
    // Blend observed base with the prior average while there is little data.
    if (priorAvg != null && swk > 0) {
      const a = sw / (sw + settings.scaleK);
      base = a * (swy / swk) + (1 - a) * priorAvg;
    }

    // Prior means. Rescale history to this event's scoring level as data arrives.
    const mu = new Float64Array(n), lam = new Float64Array(n);
    const rel = event.relPriors || null;
    let predSum = 0, ySum = 0, wSum = 0;
    for (const r of rows) {
      if (!r.match) continue;
      let p = 0;
      for (const i of r.idx) p += priorVals[i] != null ? priorVals[i] : base * settings.newFactor;
      predSum += r.w * p; ySum += r.w * r.y; wSum += r.w;
    }
    // Capped: when earlier events barely scored a component (e.g. 2026 climbing, which
    // appeared mostly in offseasons) a huge multiplier would inflate every prior. Instead
    // the priors are weakened in proportion, and the event's own matches cover the gap.
    let scale = 1, trust = 1;
    if (predSum > 0 && wSum > 0) {
      const raw = ySum / predSum;
      const ratio = Math.max(settings.scaleMin, Math.min(settings.scaleMax, raw));
      const conf = wSum / (wSum + settings.scaleK);
      scale = 1 + conf * (ratio - 1);
      if (raw !== ratio) trust = 1 - conf * (1 - (raw > ratio ? ratio / raw : raw / ratio));
    }
    for (let i = 0; i < n; i++) {
      if (priorVals[i] != null) {
        // More earlier events behind a prior => trust it more.
        const k = (event.priorMeta && event.priorMeta.count && event.priorMeta.count[teams[i]]) || 1;
        mu[i] = priorVals[i] * scale;
        lam[i] = Math.max(0.25, trust * settings.lambda * Math.min(settings.lambdaMaxMult, 1 + settings.lambdaPerEvent * (k - 1)));
      }
      else if (rel && rel[teams[i]] != null) {
        // No history this season, but we know last season's relative strength
        // (1 = average): start them that far from this event's average, shrunk.
        mu[i] = base * Math.max(0.1, 1 + settings.prevYearShrink * (rel[teams[i]] - 1));
        lam[i] = settings.lambdaPrevYear;
      }
      else { mu[i] = base * settings.newFactor; lam[i] = settings.lambdaNew; }
    }

    // Normal equations.
    const G = new Float64Array(n * n), b = new Float64Array(n);
    for (const r of rows) {
      for (const i of r.idx) {
        b[i] += r.w * r.y;
        for (const j of r.idx) G[i * n + j] += r.w;
      }
    }
    const N = new Float64Array(n * n);
    for (let i = 0; i < n * n; i++) N[i] = G[i];
    for (let i = 0; i < n; i++) { N[i * n + i] += lam[i]; b[i] += lam[i] * mu[i]; }
    if (!LA.cholesky(N, n)) throw new Error('Rating system is singular for ' + comp);
    const theta = LA.cholSolve(N, n, b);
    const Ninv = LA.cholInverse(N, n);

    // Noise estimate from match residuals, shrunk toward the prior noise level.
    let rss = 0, wm = 0;
    const resid = {};
    for (const r of rows) {
      let p = 0;
      for (const i of r.idx) p += theta[i];
      if (!r.match) continue;
      const e = r.y - p;
      rss += r.w * e * e; wm += r.w;
      resid[r.id] = (resid[r.id] || 0) + e;
    }
    let trH = 0;
    for (let i = 0; i < n * n; i++) trH += Ninv[i] * G[i];
    const df = Math.max(0, wm - trH);
    const fallback = priorSigma2 != null ? priorSigma2 : Math.pow(0.3 * base * (perRobot ? 1 : 3), 2) + 1;
    const s2hat = df > 0.5 ? rss / df : fallback;
    const s2 = (df * s2hat + settings.sigmaK * fallback) / (df + settings.sigmaK);

    const v = new Float64Array(n);
    for (let i = 0; i < n; i++) v[i] = s2 * Ninv[i * n + i];
    const nObs = new Float64Array(n);
    for (const r of rows) if (r.match) for (const i of r.idx) nObs[i] += r.w;

    return {
      available: true,
      nRows: rows.filter(r => r.match).length,
      coverage: withPrior.length / n,
      mean: theta, var: v, prior: mu, nObs,
      s2, noise: perRobot ? 3 * s2 : s2, // noise variance of an alliance total
      base, scale, trust, resid,
    };
  }

  // ---------- Reliability ----------
  // Share of a match's contribution lost when a robot has a problem, by when it happened.
  const LOSS = { noshow: 1, auto: 0.9, teleop: 0.5, endgame: 0.2 };
  function lossOf(iss) { return iss.type === 'noshow' ? LOSS.noshow : LOSS[iss.when] != null ? LOSS[iss.when] : 0.5; }

  // Per team: q = chance of a problem in a match, L = share of contribution lost when it
  // happens, both shrunk toward the event average (relPrior matches' worth), and
  // factor = 1 − q·L, the expected share of its working strength it delivers.
  function reliabilityOf(event, teams, settings, include) {
    const n = teams.length;
    const played = new Float64Array(n), probs = new Float64Array(n), loss = new Float64Array(n);
    const idx = {};
    teams.forEach((t, i) => { idx[t] = i; });
    // Walk each team's matches newest first so older ones are discounted by relDecay^age.
    const seen = new Float64Array(n);
    const ms = event.matches.filter(m => isPlayed(m) && (!include || include(m)));
    for (let a = ms.length - 1; a >= 0; a--) {
      const m = ms[a];
      for (const t of m.red.concat(m.blue)) {
        const i = idx[t];
        if (i === undefined) continue;
        const w = Math.pow(settings.relDecay, seen[i]++);
        played[i] += w;
        const iss = robotIssue(m, t);
        if (iss) { probs[i] += w; loss[i] += w * lossOf(iss); }
      }
    }
    let P = 0, Q = 0, Lsum = 0;
    for (let i = 0; i < n; i++) { P += played[i]; Q += probs[i]; Lsum += loss[i]; }
    const baseQ = P ? Q / P : 0, baseL = Q ? Lsum / Q : 0;
    const a = settings.relPrior;
    const q = new Float64Array(n), L = new Float64Array(n), factor = new Float64Array(n).fill(1);
    if (Q > 0 && settings.useReliability) {
      for (let i = 0; i < n; i++) {
        q[i] = (probs[i] + a * baseQ) / (played[i] + a);
        L[i] = (loss[i] + a * baseQ * baseL) / (probs[i] + a * baseQ);
        factor[i] = 1 - q[i] * L[i];
      }
    }
    return { q, L, factor, played, problems: probs, any: Q > 0 && !!settings.useReliability };
  }

  // ---------- Trend within an event ----------
  // Alliance results minus predictions over a team's clean matches. If the team improves by
  // D points its alliances beat predictions by about D, while partners' swings average out,
  // so the slope of these residuals measures the team's own change. A trend is reported only
  // when |t| > 2.2, i.e. clearly beyond match-to-match noise (about 1 in 20 unchanged teams flagged).
  function trendWithin(event, R, k) {
    const pts = [];
    for (const m of event.matches) {
      if (m.comp !== QUAL || !isPlayed(m)) continue;
      const side = m.red.includes(k) ? 'r' : m.blue.includes(k) ? 'b' : null;
      if (!side || robotIssue(m, k) || m[side].total == null) continue;
      pts.push(m[side].total - allianceDist(R, side === 'r' ? m.red : m.blue, 'total').mu);
    }
    const n = pts.length;
    if (n < 5) return null;
    const xm = (n - 1) / 2, ym = pts.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0, rss = 0;
    pts.forEach((y, x) => { sxy += (x - xm) * (y - ym); sxx += (x - xm) ** 2; });
    const slope = sxy / sxx;
    pts.forEach((y, x) => { rss += (y - ym - slope * (x - xm)) ** 2; });
    const se = Math.sqrt(rss / Math.max(1, n - 2) / sxx);
    const t = se > 0 ? slope / se : 0;
    return { delta: slope * (n - 1), t, n, label: t > 2.2 ? 'improving' : t < -2.2 ? 'slipping' : 'steady' };
  }

  // Plain least-squares OPR (tiny ridge so it exists early), for reference/comparison.
  function rawOpr(event, teams, idx, include) {
    const n = teams.length;
    const G = new Float64Array(n * n), b = new Float64Array(n), cnt = new Float64Array(n);
    for (const m of event.matches) {
      if (!isPlayed(m) || m.comp !== QUAL || (include && !include(m))) continue;
      for (const [teamsA, v] of [[m.red, m.r], [m.blue, m.b]]) {
        const ids = teamsA.map(t => idx[t]).filter(i => i !== undefined);
        const y = v.score;
        for (const i of ids) { b[i] += y; cnt[i]++; for (const j of ids) G[i * n + j] += 1; }
      }
    }
    if (!cnt.some(c => c > 0)) return null;
    for (let i = 0; i < n; i++) G[i * n + i] += cnt[i] ? 1e-6 : 1; // teams with no matches stay at 0, reported as null
    if (!LA.cholesky(G, n)) return null;
    const x = Array.from(LA.cholSolve(G, n, b));
    for (let i = 0; i < n; i++) if (!cnt[i]) x[i] = null;
    return x;
  }

  // Fit every component. opts.include(match) can restrict the data (e.g. for backtesting);
  // opts.priorOnly ignores all matches (pre-event expectations).
  function fit(event, game, settings, opts) {
    settings = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    opts = opts || {};
    const teams = event.teams.slice();
    const idx = {};
    teams.forEach((t, i) => { idx[t] = i; });
    const include = opts.priorOnly ? () => false : opts.include;
    const comps = {};
    for (const c of game.comps) comps[c.key] = fitComponent(event, game, c.key, teams, idx, settings, include);

    // Residual correlation of each component with total points (used to simulate them jointly).
    const corr = {};
    const rt = comps.total.resid || {};
    for (const c of game.comps) {
      if (c.key === 'total' || !comps[c.key].available) continue;
      const rc = comps[c.key].resid || {};
      let sxy = 0, sxx = 0, syy = 0, k = 0;
      for (const id in rc) if (rt[id] !== undefined) { sxy += rt[id] * rc[id]; sxx += rt[id] * rt[id]; syy += rc[id] * rc[id]; k++; }
      corr[c.key] = k >= 12 && sxx > 0 && syy > 0 ? Math.max(-0.95, Math.min(0.95, sxy / Math.sqrt(sxx * syy))) : 0;
    }

    const T = eventThresholds(event, game);
    return {
      teams, idx, comps, corr, game, settings,
      rel: reliabilityOf(event, teams, settings, include),
      level: event.level || 'regional', thr: T.values, thrDetected: T.detected,
      opr: opts.priorOnly ? null : rawOpr(event, teams, idx, include),
    };
  }

  // ---------- Bonus RP thresholds ----------
  // Official thresholds depend on the event level, but offseason events often set
  // their own (2026 data: 75, 150, 190 fuel…). Every played match tells us the
  // alliance's count and whether the bonus was earned, so infer the real cut-off.
  function eventThresholds(event, game) {
    const official = Object.assign({}, game.levels[event.level || 'regional'] || {});
    const out = { values: Object.assign({}, official), detected: {} };
    for (const b of game.bonuses) {
      let lo = -Infinity, hi = Infinity, n = 0;
      for (const m of event.matches || []) {
        if (m.comp !== QUAL || !isPlayed(m)) continue;
        for (const side of ['r', 'b']) {
          const v = m[side];
          if (!v.bonus || typeof v.bonus[b.key] !== 'boolean' || v[b.comp] == null) continue;
          n++;
          if (v.bonus[b.key]) hi = Math.min(hi, v[b.comp]); else lo = Math.max(lo, v[b.comp]);
        }
      }
      if (n < 6) continue;
      const off = official[b.key];
      let t;
      if (off != null && off > lo && off <= hi) t = off;          // data agrees with the rulebook
      else if (hi < Infinity && lo < hi) t = hi;                    // smallest value that earned it
      else if (hi === Infinity && lo > -Infinity) t = off != null && off > lo ? off : lo + 1;
      else if (hi < Infinity && lo >= hi) t = hi;                   // inconsistent data: trust achieved values
      if (t != null && t !== off) { out.values[b.key] = t; out.detected[b.key] = { official: off, lo, hi }; }
    }
    return out;
  }

  // ---------- Predictions ----------

  function allianceDist(R, teamKeys, comp) {
    const c = R.comps[comp];
    let mu = 0, v = 0;
    for (const t of teamKeys) {
      const i = R.idx[t];
      if (i === undefined) { mu += c.base * R.settings.newFactor; v += c.noise / 3; continue; }
      // Breakdown risk: mean × (1 − qL), plus the extra spread a possible breakdown adds.
      const rel = R.rel;
      if (rel && rel.any) {
        const q = rel.q[i], L = rel.L[i], th = c.mean[i];
        mu += th * (1 - q * L);
        v += c.var[i] * (1 - q * L) * (1 - q * L) + q * (1 - q) * (L * th) * (L * th);
      } else { mu += c.mean[i]; v += c.var[i]; }
    }
    return { mu, varParam: v, sd: Math.sqrt(v + c.noise) };
  }

  // How bonus RP probabilities are computed for this rating set.
  function bonusMode(R) {
    const g = R.game;
    if (!g.bonuses.length) return R.comps.bonusRP && R.comps.bonusRP.available ? 'linear' : 'none';
    const ok = g.bonuses.every(b => {
      const c = R.comps[b.comp];
      return c && c.available && (c.nRows >= 6 || c.coverage >= 0.5);
    });
    if (ok) return 'threshold';
    return R.comps.bonusRP && R.comps.bonusRP.available && R.comps.bonusRP.nRows >= 6 ? 'linear' : 'none';
  }

  function pAtLeast(d, thr) { return 1 - LA.normCdf((thr - 0.5 - d.mu) / d.sd); }

  function predictAlliance(R, teamKeys) {
    const out = { total: allianceDist(R, teamKeys, 'total'), bonus: {}, bonusExp: 0 };
    const mode = bonusMode(R);
    const thr = R.thr || R.game.levels[R.level] || {};
    if (mode === 'threshold') {
      for (const b of R.game.bonuses) {
        const p = pAtLeast(allianceDist(R, teamKeys, b.comp), thr[b.key]);
        out.bonus[b.key] = p; out.bonusExp += p;
      }
    } else if (mode === 'linear') {
      const d = allianceDist(R, teamKeys, 'bonusRP');
      const cap = R.game.bonuses.length || 3;
      out.bonusExp = Math.max(0, Math.min(cap, d.mu));
    }
    out.mode = mode;
    return out;
  }

  function predictMatch(R, red, blue) {
    const pr = predictAlliance(R, red), pb = predictAlliance(R, blue);
    const sd = Math.sqrt(pr.total.sd * pr.total.sd + pb.total.sd * pb.total.sd);
    // Expected foul points: what each alliance gives away goes to the opponent.
    let fr = 0, fb = 0;
    const fw = R.settings.foulWin || 0;
    if (fw && R.comps.fouls && R.comps.fouls.available) {
      fr = Math.max(0, allianceDist(R, blue, 'fouls').mu) * fw;
      fb = Math.max(0, allianceDist(R, red, 'fouls').mu) * fw;
    }
    const sharpen = R.settings.sharpen || 1;
    const pRed = R.comps.total.available && sd > 0 ? LA.normCdf(sharpen * (pr.total.mu + fr - pb.total.mu - fb) / sd) : 0.5;
    const g = R.game;
    return {
      pRed,
      red: { score: pr.total.mu, bonus: pr.bonus, expRP: g.winRP * pRed + pr.bonusExp },
      blue: { score: pb.total.mu, bonus: pb.bonus, expRP: g.winRP * (1 - pRed) + pb.bonusExp },
      mode: pr.mode,
    };
  }

  // ---------- Actual results / standings ----------

  function winnerOf(m) {
    if (m.r.score > m.b.score) return 'r';
    if (m.b.score > m.r.score) return 'b';
    return 't';
  }

  // Ranking points an alliance earned (before surrogate/DQ adjustments).
  function allianceRP(m, side, game, level, thrOverride) {
    const v = m[side];
    if (v.rp != null) return v.rp;
    const w = winnerOf(m);
    let rp = w === side ? game.winRP : w === 't' ? game.tieRP : 0;
    const thr = thrOverride || game.levels[level] || {};
    for (const b of game.bonuses) {
      if (v.bonus && typeof v.bonus[b.key] === 'boolean') { if (v.bonus[b.key]) rp++; }
      else if (v[b.comp] != null && thr[b.key] != null && v[b.comp] >= thr[b.key]) rp++;
    }
    return rp;
  }

  function standings(event, game, include) {
    const level = event.level || 'regional';
    const thr = eventThresholds(event, game).values;
    const S = {};
    for (const t of event.teams) S[t] = { team: t, rp: 0, n: 0, w: 0, l: 0, tie: 0, dq: 0, tb: game.tiebreakers.map(() => 0), tbN: 0 };
    for (const m of event.matches) {
      if (m.comp !== QUAL || !isPlayed(m) || (include && !include(m))) continue;
      const w = winnerOf(m);
      for (const side of ['r', 'b']) {
        const teams = side === 'r' ? m.red : m.blue;
        const surr = (side === 'r' ? m.redSurr : m.blueSurr) || [];
        const dq = (side === 'r' ? m.redDQ : m.blueDQ) || [];
        const rp = allianceRP(m, side, game, level, thr);
        for (const t of teams) {
          const s = S[t];
          if (!s || surr.includes(t)) continue;
          s.n++;
          if (dq.includes(t)) { s.dq++; } else s.rp += rp;
          if (w === side) s.w++; else if (w === 't') s.tie++; else s.l++;
          game.tiebreakers.forEach((c, k) => { const v = m[side][c]; s.tb[k] += v != null ? v : 0; });
          s.tbN++;
        }
      }
    }
    const list = Object.values(S);
    for (const s of list) { s.rs = s.n ? s.rp / s.n : 0; s.tbAvg = s.tb.map(x => (s.tbN ? x / s.tbN : 0)); }
    list.sort((a, b) => {
      if (b.rs !== a.rs) return b.rs - a.rs;
      for (let k = 0; k < a.tbAvg.length; k++) if (b.tbAvg[k] !== a.tbAvg[k]) return b.tbAvg[k] - a.tbAvg[k];
      return 0;
    });
    list.forEach((s, i) => { s.rank = s.n ? i + 1 : null; });
    return list;
  }

  const api = {
    DEFAULT_SETTINGS, teamCmp, robotIssue, trendWithin, fit, eventThresholds, predictMatch, predictAlliance, allianceDist, bonusMode,
    standings, allianceRP, winnerOf, isPlayed, sortMatches, matchOrder,
  };
  root.Model = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

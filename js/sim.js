// Monte Carlo ranking forecast and strength-of-schedule / schedule-luck analysis.
(function (root) {
  'use strict';
  const LA = root.LinAlg || (typeof require !== 'undefined' ? require('./linalg.js') : null);
  const Model = root.Model || (typeof require !== 'undefined' ? require('./model.js') : null);

  // ---------- Ranking simulation ----------
  // "Hot" simulation: each run draws every team's strength from its posterior
  // once, then plays out all remaining qualification matches with correlated
  // component noise (points, fuel, tower move together).
  function simulateRankings(event, R, opts) {
    opts = opts || {};
    const nSims = opts.nSims || 5000;
    const rng = LA.makeRng(opts.seed || 12345);
    const g = R.game;
    const T = R.teams.length;
    const idx = R.idx;
    const base = Model.standings(event, g);
    const baseBy = {};
    for (const s of base) baseBy[s.team] = s;

    const mode = Model.bonusMode(R);
    const thr = R.thr || g.levels[R.level] || {};
    const compKeys = ['total'];
    const want = new Set(g.tiebreakers);
    if (mode === 'threshold') g.bonuses.forEach(b => want.add(b.comp));
    if (mode === 'linear') want.add('bonusRP');
    for (const c of want) if (c !== 'total' && R.comps[c] && R.comps[c].available) compKeys.push(c);
    const C = compKeys.length;
    const ci = {};
    compKeys.forEach((c, k) => { ci[c] = k; });
    const mean = compKeys.map(c => R.comps[c].mean);
    const sdT = compKeys.map(c => Float64Array.from(R.comps[c].var, v => Math.sqrt(v)));
    const noiseSd = compKeys.map(c => Math.sqrt(R.comps[c].noise));
    const rho = compKeys.map(c => (c === 'total' ? 1 : R.corr[c] || 0));
    const rhoC = rho.map(r => Math.sqrt(1 - r * r));

    const remaining = event.matches.filter(m => m.comp === 'qm' && !Model.isPlayed(m) && m.red && m.blue);
    const rem = remaining.map(m => ({
      red: m.red.map(t => idx[t]), blue: m.blue.map(t => idx[t]),
      rs: (m.redSurr || []).map(t => idx[t]), bs: (m.blueSurr || []).map(t => idx[t]),
    })).filter(x => x.red.every(i => i !== undefined) && x.blue.every(i => i !== undefined));

    const nTb = g.tiebreakers.length;
    const tbComp = g.tiebreakers.map(c => (ci[c] !== undefined ? ci[c] : -1));
    const rp0 = new Float64Array(T), n0 = new Float64Array(T), tb0 = new Float64Array(T * nTb), tbN0 = new Float64Array(T);
    R.teams.forEach((t, i) => {
      const s = baseBy[t];
      if (!s) return;
      rp0[i] = s.rp; n0[i] = s.n; tbN0[i] = s.tbN;
      for (let k = 0; k < nTb; k++) tb0[i * nTb + k] = s.tb[k];
    });

    const rankCount = new Int32Array(T * T);
    const rsSum = new Float64Array(T);
    const theta = new Float64Array(C * T);
    const rp = new Float64Array(T), nn = new Float64Array(T), tb = new Float64Array(T * nTb), tbN = new Float64Array(T);
    const order = new Int32Array(T);
    const key = new Float64Array(T * (nTb + 2));
    const allianceVals = new Float64Array(C);
    const bonusList = g.bonuses.map(b => ({ c: ci[b.comp], thr: thr[b.key] }));
    const linearCap = g.bonuses.length || 3;

    // Breakdowns: each robot independently has a problem with chance q, delivering 1 − L.
    const relQ = R.rel && R.rel.any ? R.rel.q : null, relL = R.rel && R.rel.any ? R.rel.L : null;
    const share = new Float64Array(3);
    function playAlliance(teams, out) {
      const z0 = rng.normal();
      teams.forEach((i, j) => { share[j] = relQ && rng.uniform() < relQ[i] ? 1 - relL[i] : 1; });
      for (let k = 0; k < C; k++) {
        let mu = 0;
        teams.forEach((i, j) => { mu += theta[k * T + i] * share[j]; });
        const z = k === 0 ? z0 : rho[k] * z0 + rhoC[k] * rng.normal();
        out[k] = Math.max(0, mu + noiseSd[k] * z);
      }
    }
    function bonusRP(vals) {
      let n = 0;
      if (mode === 'threshold') { for (const b of bonusList) if (vals[b.c] >= b.thr) n++; }
      else if (mode === 'linear') {
        const p = Math.max(0, Math.min(1, vals[ci.bonusRP] / linearCap));
        for (let k = 0; k < linearCap; k++) if (rng.uniform() < p) n++;
      }
      return n;
    }
    const redVals = new Float64Array(C), blueVals = new Float64Array(C);

    for (let s = 0; s < nSims; s++) {
      for (let k = 0; k < C; k++) for (let i = 0; i < T; i++) theta[k * T + i] = mean[k][i] + sdT[k][i] * rng.normal();
      rp.set(rp0); nn.set(n0); tb.set(tb0); tbN.set(tbN0);
      for (const m of rem) {
        playAlliance(m.red, redVals); playAlliance(m.blue, blueVals);
        const rT = Math.round(redVals[0]), bT = Math.round(blueVals[0]);
        const rRP = (rT > bT ? g.winRP : rT === bT ? g.tieRP : 0) + bonusRP(redVals);
        const bRP = (bT > rT ? g.winRP : rT === bT ? g.tieRP : 0) + bonusRP(blueVals);
        for (const [teams, surr, v, r] of [[m.red, m.rs, redVals, rRP], [m.blue, m.bs, blueVals, bRP]]) {
          for (const i of teams) {
            if (surr.includes(i)) continue;
            rp[i] += r; nn[i]++; tbN[i]++;
            for (let k = 0; k < nTb; k++) tb[i * nTb + k] += tbComp[k] >= 0 ? v[tbComp[k]] : 0;
          }
        }
      }
      const W = nTb + 2;
      for (let i = 0; i < T; i++) {
        order[i] = i;
        const rs = nn[i] ? rp[i] / nn[i] : -1;
        key[i * W] = Math.round(rs * 100) / 100; // RS is rounded to 2 decimals for ranking
        for (let k = 0; k < nTb; k++) key[i * W + 1 + k] = tbN[i] ? tb[i * nTb + k] / tbN[i] : 0;
        key[i * W + nTb + 1] = rng.uniform();
        rsSum[i] += rs < 0 ? 0 : rs;
      }
      order.sort((a, b) => {
        for (let k = 0; k < W; k++) { const d = key[b * W + k] - key[a * W + k]; if (d !== 0) return d; }
        return 0;
      });
      for (let r = 0; r < T; r++) rankCount[order[r] * T + r]++;
    }

    const out = {};
    R.teams.forEach((t, i) => {
      const dist = new Float64Array(T);
      let er = 0;
      for (let r = 0; r < T; r++) { dist[r] = rankCount[i * T + r] / nSims; er += (r + 1) * dist[r]; }
      let c = 0, p10 = null, p50 = null, p90 = null;
      for (let r = 0; r < T; r++) {
        c += dist[r];
        if (p10 === null && c >= 0.1) p10 = r + 1;
        if (p50 === null && c >= 0.5) p50 = r + 1;
        if (p90 === null && c >= 0.9) p90 = r + 1;
      }
      const top = k => { let p = 0; for (let r = 0; r < Math.min(k, T); r++) p += dist[r]; return p; };
      out[t] = { dist, expRank: er, p10, p50, p90, p1: top(1), p4: top(4), p8: top(8), p16: top(16), expRS: rsSum[i] / nSims };
    });
    return { byTeam: out, nSims, remaining: rem.length, mode };
  }

  // ---------- Strength of schedule / schedule luck ----------
  // For each team, compare the RP/match an *average-luck* version of that team
  // would expect on its actual schedule against random partners/opponents.
  function scheduleLuck(event, R, Rprior, opts) {
    opts = opts || {};
    const nRand = opts.nRand || 400;
    const g = R.game;
    const tp = R.comps.total.mean;
    let avgTP = 0;
    for (let i = 0; i < tp.length; i++) avgTP += tp[i];
    avgTP /= Math.max(1, tp.length);
    const st = Model.standings(event, g);
    const stBy = {};
    for (const s of st) stBy[s.team] = s;

    const teamMatches = {};
    for (const t of R.teams) teamMatches[t] = [];
    for (const m of event.matches) {
      if (m.comp !== 'qm' || !m.red || !m.blue) continue;
      for (const [mine, opp, surr] of [[m.red, m.blue, m.redSurr || []], [m.blue, m.red, m.blueSurr || []]]) {
        for (const t of mine) {
          if (!teamMatches[t] || surr.includes(t)) continue;
          teamMatches[t].push({ m, mine, opp, played: Model.isPlayed(m) });
        }
      }
    }

    const expRP = (RR, mine, opp) => {
      const p = Model.predictMatch(RR, mine, opp);
      return p.red.expRP;
    };

    const out = {};
    const rng = LA.makeRng(opts.seed || 777);
    for (const t of R.teams) {
      const others = R.teams.filter(x => x !== t);
      // Random-schedule baseline for this team.
      let sum = 0, sum2 = 0, sumPre = 0;
      for (let k = 0; k < nRand; k++) {
        const pick = [];
        while (pick.length < 5) {
          const c = others[Math.floor(rng.uniform() * others.length)];
          if (!pick.includes(c)) pick.push(c);
        }
        const e = expRP(R, [t, pick[0], pick[1]], pick.slice(2));
        sum += e; sum2 += e * e;
        if (Rprior) sumPre += expRP(Rprior, [t, pick[0], pick[1]], pick.slice(2));
      }
      const eRand = sum / nRand;
      const sdRand = Math.sqrt(Math.max(1e-9, sum2 / nRand - eRand * eRand));
      const eRandPre = Rprior ? sumPre / nRand : null;

      const ms = teamMatches[t];
      let eAll = 0, ePlayed = 0, nPlayed = 0, eAllPre = 0, tail = 0;
      for (const x of ms) {
        const e = expRP(R, x.mine, x.opp);
        eAll += e;
        if (Rprior) eAllPre += expRP(Rprior, x.mine, x.opp);
        if (x.played) { ePlayed += e; nPlayed++; }
        let part = 0, opp = 0;
        for (const p of x.mine) if (p !== t) part += tp[R.idx[p]] - avgTP;
        for (const o of x.opp) opp += tp[R.idx[o]] - avgTP;
        tail += part - opp;
      }
      const N = ms.length;
      const s = stBy[t];
      const res = {
        matches: N, played: nPlayed,
        eRand, sdRand,
        eSched: N ? eAll / N : null,
        luck: N ? eAll / N - eRand : null,                     // + = easier than a random schedule (RP/match)
        easePct: N ? 100 * LA.normCdf((eAll / N - eRand) / (sdRand / Math.sqrt(N))) : null,
        tailwind: N ? tail / N : null,                         // points/match of partner help minus opponent strength
        actualRS: s && s.n ? s.rs : null,
        ePlayedRS: nPlayed ? ePlayed / nPlayed : null,
      };
      if (nPlayed && s && s.n) {
        res.luckPlayed = res.ePlayedRS - eRand;
        res.adjRS = s.rs - res.luckPlayed;                     // RS with schedule luck removed
        res.perfLuck = s.rs - res.ePlayedRS;                   // RS above/below what the model expected
      }
      if (Rprior && N) {
        res.luckPre = eAllPre / N - eRandPre;                  // difficulty judged at schedule release
      }
      out[t] = res;
    }
    // "True rank": everyone on a neutral (random) schedule.
    const order = R.teams.slice().sort((a, b) => out[b].eRand - out[a].eRand);
    order.forEach((t, i) => { out[t].trueRank = i + 1; });
    return out;
  }

  const api = { simulateRankings, scheduleLuck };
  root.Sim = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

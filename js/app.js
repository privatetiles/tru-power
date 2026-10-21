// TRU POWER — UI. Plain DOM, no dependencies, works from file:// with no internet.
(function () {
  'use strict';
  const $ = sel => document.querySelector(sel);
  const main = $('#main');

  const S = {
    settings: Store.loadSettings(),
    event: null, game: null,
    R: null, Rprior: null, st: null, stBy: {}, luck: null, sim: null, simBusy: false,
    tab: 'overview',
    sort: { teams: ['tp', -1], picks: ['pickScore', -1], luck: ['luck', 1], forecast: ['expRank', 1] },
    filter: '', hidePicked: false, matchFilter: 'all',
    accuracy: null,
  };

  // ---------- helpers ----------
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const tnum = k => (k || '').replace(/^frc/, '');
  const tkey = n => 'frc' + String(n).trim().replace(/^frc/i, '').toUpperCase(); // "190b" -> frc190B
  const f1 = (x, d = 1) => (x == null || !isFinite(x) ? '–' : x.toFixed(d));
  const pct = (p, d = 0) => (p == null || !isFinite(p) ? '–' : (100 * p).toFixed(d) + '%');
  const sgn = (x, d = 2) => (x == null || !isFinite(x) ? '–' : (x > 0 ? '+' : '') + x.toFixed(d));
  const cls = x => (x == null ? '' : x > 0.005 ? 'pos' : x < -0.005 ? 'neg' : '');
  // 80% ranges. Ratings use the posterior (z = 1.28). Predicted scores use z = 1.35: real
  // scores have fatter tails than a normal curve, and on the 2026 backtest z = 1.28 covered
  // only 77.6% of alliance scores.
  const Z_RATING = 1.2816, Z_SCORE = 1.35;
  const range = (mu, sd, z = Z_RATING) => (mu == null || sd == null ? '–' : `${f1(Math.max(0, mu - z * sd), 0)}–${f1(mu + z * sd, 0)}`);
  // How sure: rating uncertainty relative to how spread out the teams are.
  function sureOf(sd) {
    if (sd == null || !S.tpSpread) return null;
    const r = sd / S.tpSpread;
    return r < 0.25 ? 'High' : r < 0.5 ? 'Medium' : 'Low';
  }
  const surePill = sd => { const s = sureOf(sd); return s ? `<span class="pill ${s === 'High' ? 'good' : s === 'Low' ? 'bad' : 'muted'}" title="How sure the rating is: its uncertainty compared with the spread between teams">${s}</span>` : ''; };
  const ours = k => S.settings.ourTeam && k === tkey(S.settings.ourTeam);
  const teamLink = (k, extra = '') => `<a class="team ${ours(k) ? 'ours' : ''} ${extra}" data-team="${esc(k)}" title="${esc(S.event && S.event.teamNames && S.event.teamNames[k] || '')}">${esc(tnum(k))}</a>`;
  const ago = ts => {
    if (!ts) return 'never';
    const s = (Date.now() - ts) / 1000;
    if (s < 90) return 'just now';
    if (s < 5400) return Math.round(s / 60) + ' min ago';
    if (s < 129600) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' days ago';
  };
  const matchLabel = m => {
    if (m.comp === 'qm') return 'Q' + m.num;
    if (m.comp === 'f') return 'F' + m.num;
    if (m.comp === 'sf') return 'M' + m.set + (m.num > 1 ? '-' + m.num : '');
    return m.comp.toUpperCase() + m.set + '-' + m.num;
  };
  const PROBLEM_WHEN = [['auto', 'Auto'], ['teleop', 'Teleop'], ['endgame', 'Endgame']];
  const PROBLEM_WHAT = [['drivetrain', 'Drivetrain'], ['intake', 'Intake'], ['shooter', 'Shooter'], ['climber', 'Climber'],
    ['electrical', 'Electrical / comms'], ['bumpers', 'Bumpers'], ['other', 'Other']];
  const label = (list, v) => (list.find(x => x[0] === v) || [, v || ''])[1];
  // Short human description of a robot problem, e.g. "broke in teleop · drivetrain".
  function issueText(iss) {
    if (!iss) return '';
    if (iss.type === 'noshow') return 'no-show';
    return ['broke' + (iss.when ? ' in ' + label(PROBLEM_WHEN, iss.when).toLowerCase() : ''), iss.what ? label(PROBLEM_WHAT, iss.what).toLowerCase() : '']
      .filter(Boolean).join(' · ');
  }
  // Breakdowns/no-shows per team across played matches.
  function reliability(k) {
    let played = 0;
    const list = [];
    for (const m of S.event.matches) {
      if (!Model.isPlayed(m) || !(m.red.includes(k) || m.blue.includes(k))) continue;
      played++;
      const iss = Model.robotIssue(m, k);
      if (iss) list.push({ m, iss });
    }
    return { played, list };
  }

  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, ms);
  }
  function openModal(html) { $('#modalBody').innerHTML = html; $('#modal').hidden = false; }
  function closeModal() { $('#modal').hidden = true; $('#modalBody').innerHTML = ''; }

  // ---------- data / computation ----------
  function modelSettings() { return Object.assign({}, S.settings.model || {}); }

  function setEvent(ev) {
    S.event = ev;
    S.settings.current = ev ? ev.key : null;
    Store.saveSettings(S.settings);
    S.accuracy = null;
    recompute();
  }

  function persist() {
    if (!S.event) return;
    if (!Store.saveEvent(S.event)) toast('⚠️ Could not save to browser storage — use Data → Export to keep a backup.', 5000);
  }

  function recompute() {
    const ev = S.event;
    S.sim = null;
    if (!ev) { S.R = null; render(); return; }
    ev.matches = Model.sortMatches(ev.matches || []);
    S.game = Games.getGame(ev.year);
    const t0 = performance.now();
    S.R = Model.fit(ev, S.game, modelSettings());
    S.Rprior = Model.fit(ev, S.game, modelSettings(), { priorOnly: true });
    S.st = Model.standings(ev, S.game);
    S.stBy = Object.fromEntries(S.st.map(s => [s.team, s]));
    S.trendCache = {};
    S.luck = Sim.scheduleLuck(ev, S.R, S.Rprior);
    { const m = Array.from(S.R.comps.total.mean); const mu = m.reduce((a, b) => a + b, 0) / (m.length || 1);
      S.tpSpread = Math.sqrt(m.reduce((a, b) => a + (b - mu) ** 2, 0) / (m.length || 1)) || null; }
    S.computeMs = performance.now() - t0;
    render();
    scheduleSim();
  }

  function scheduleSim() {
    clearTimeout(scheduleSim._t);
    scheduleSim._t = setTimeout(() => {
      if (!S.R) return;
      const t0 = performance.now();
      S.sim = Sim.simulateRankings(S.event, S.R, { nSims: +S.settings.nSims || 3000, seed: 4242 });
      S.simMs = performance.now() - t0;
      if (['overview', 'teams', 'forecast'].includes(S.tab)) render();
      else renderStatus();
    }, 20);
  }

  function teamRow(k) {
    const R = S.R, i = R.idx[k], c = R.comps;
    const get = key => (c[key] && c[key].available ? c[key].mean[i] : null);
    const sd = key => (c[key] && c[key].available ? Math.sqrt(c[key].var[i]) : null);
    const L = S.luck[k] || {}, st = S.stBy[k] || {}, sim = S.sim && S.sim.byTeam[k];
    const sc = scoutAverages()[k] || {};
    return {
      key: k, num: parseInt(tnum(k), 10) + (/[A-Za-z]$/.test(k) ? 0.5 : 0), name: (S.event.teamNames || {})[k] || '',
      tp: get('total'), tpSd: sd('total'), auto: get('auto'), fuel: get('fuel'), autoFuel: get('autoFuel'), tower: get('tower'),
      fouls: get('fouls'), net: get('total') != null ? get('total') - (get('fouls') || 0) : null,
      opr: R.opr ? R.opr[i] : null, prior: c.total.prior ? c.total.prior[i] : null,
      nObs: c.total.nObs ? c.total.nObs[i] : 0,
      rank: st.rank || null, rs: st.n ? st.rs : null, rec: st.n ? `${st.w}-${st.l}-${st.tie}` : '',
      trueRank: L.trueRank, eRand: L.eRand, luck: L.luck, easePct: L.easePct, adjRS: L.adjRS, tailwind: L.tailwind, perfLuck: L.perfLuck, luckPre: L.luckPre,
      expRank: sim ? sim.expRank : null, p8: sim ? sim.p8 : null, p1: sim ? sim.p1 : null, p4: sim ? sim.p4 : null,
      sim, scout: sc,
      starred: !!(S.event.starred || {})[k], picked: !!(S.event.picked || {})[k] || allianceOf(k) != null,
      relOn: R.rel.any, relQ: R.rel.any ? R.rel.q[i] : null, relFactor: R.rel.any ? R.rel.factor[i] : 1,
      // Expected points it actually delivers: working strength × reliability, minus fouls given away.
      defense: R.defense ? R.defense[i] : null,
      tags: (S.event.scoutTags || {})[k] || {},
      // Expected points it actually delivers: working strength × reliability, plus points it
      // takes away from opponents (defense), minus fouls given away.
      pickScore: get('total') != null ? get('total') * (R.rel.any ? R.rel.factor[i] : 1) + (R.defense ? R.defense[i] : 0) - Math.max(0, get('fouls') || 0) : null,
      ...(() => { const rel = reliability(k); return { played: rel.played, problems: rel.list.length, problemText: rel.list.map(x => `${matchLabel(x.m)} ${issueText(x.iss)}${x.iss.note ? ' (' + x.iss.note + ')' : ''}`).join('; ') }; })(),
    };
  }

  function scoutAverages() {
    const sc = S.event && S.event.scouting;
    if (!sc || !sc.rows || !sc.rows.length) return {};
    if (scoutAverages._src === sc.rows && scoutAverages._n === sc.rows.length) return scoutAverages._v;
    const acc = {};
    for (const r of sc.rows) {
      const a = acc[r.team] = acc[r.team] || { n: 0 };
      a.n++;
      for (const [col, v] of Object.entries(r.values)) if (isFinite(v)) { a[col] = (a[col] || 0) + v; a['#' + col] = (a['#' + col] || 0) + 1; }
    }
    const out = {};
    for (const [t, a] of Object.entries(acc)) {
      out[t] = { n: a.n };
      for (const col of sc.columns || []) if (a['#' + col]) out[t][col] = a[col] / a['#' + col];
    }
    scoutAverages._src = sc.rows; scoutAverages._n = sc.rows.length; scoutAverages._v = out;
    return out;
  }

  // ---------- rendering ----------
  function render() {
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === S.tab));
    renderEventSelect();
    renderStatus();
    if (!S.event && S.tab !== 'data') { main.innerHTML = emptyState(); return; }
    const fn = { scout: renderScout, overview: renderOverview, teams: renderTeams, picks: renderPicks, alliances: renderAlliances, luck: renderLuck, matches: renderMatches, forecast: renderForecast, predict: renderPredict, data: renderData }[S.tab];
    main.innerHTML = fn();
    if (S.tab === 'predict') updatePrediction();
    if (S.tab === 'data') loadCatalogueAndShow(false);
    if (S.tab === 'scout') setupPathPad();
  }

  function emptyState() {
    return `<div class="empty"><h2>No event loaded</h2>
      <p>Load an event before you go (needs internet once), create one by hand, or try the demo.</p>
      <p><button class="btn primary" data-act="goto-data">Set up an event</button>
      <button class="btn" data-act="load-demo">Load demo event</button></p></div>`;
  }

  function renderEventSelect() {
    const sel = $('#eventSelect');
    const list = Store.listEvents();
    const cur = S.event && S.event.key;
    if (cur && !list.some(e => e.key === cur)) list.push({ key: cur, name: S.event.name, year: S.event.year });
    sel.innerHTML = (list.length ? '' : '<option value="">— no events —</option>') +
      list.map(e => `<option value="${esc(e.key)}" ${e.key === cur ? 'selected' : ''}>${esc(e.year + ' ' + (e.name || e.key))}</option>`).join('');
  }

  function renderStatus() {
    const ev = S.event;
    const online = navigator.onLine;
    let s = `<span class="dot ${online ? '' : 'off'}"></span>${online ? 'Online' : 'Offline'} · `;
    if (ev) {
      const q = ev.matches.filter(m => m.comp === 'qm');
      s += `${q.filter(Model.isPlayed).length}/${q.length} quals played · `;
      if (ev.demo || ev.manual) s += 'manual entry';
      else s += S.syncing ? 'syncing with TBA…' : `TBA ${ago(ev.tbaSynced)}${S.settings.autoSync && S.settings.tbaKey ? (online ? ' · auto-sync on' : ' · auto-sync waiting for internet') : ''}${S.syncError ? ' · <span class="neg" title="' + esc(S.syncError) + '">last sync failed</span>' : ''}`;
      if (S.computeMs != null) s += ` · calc ${Math.round(S.computeMs + (S.simMs || 0))} ms`;
    } else s += 'no event';
    if (!Store.ok) s += ' · <b class="neg">storage unavailable — export your data!</b>';
    $('#status').innerHTML = s;
  }

  function statCard(label, v, sub) { return `<div class="stat"><div class="v">${v}${sub ? ` <small>${sub}</small>` : ''}</div><div class="l">${label}</div></div>`; }

  // ----- Overview -----
  function renderOverview() {
    const ev = S.event, R = S.R;
    const rows = R.teams.map(teamRow);
    const byTP = rows.slice().sort((a, b) => b.tp - a.tp);
    const tpRank = Object.fromEntries(byTP.map((r, i) => [r.key, i + 1]));
    const q = ev.matches.filter(m => m.comp === 'qm');
    const playedN = q.filter(Model.isPlayed).length;
    let html = '';
    if (ev.demo) html += `<div class="card" style="margin-bottom:14px">This is a <b>synthetic demo event</b> — numbers are made up. Load a real event in the <a data-act="goto-data">Data</a> tab.</div>`;

    const ot = S.settings.ourTeam && tkey(S.settings.ourTeam);
    if (ot && R.idx[ot] !== undefined) {
      const r = rows.find(x => x.key === ot);
      const next = q.find(m => !Model.isPlayed(m) && (m.red.includes(ot) || m.blue.includes(ot)));
      let nextHtml = '<span class="help">No upcoming qualification match.</span>';
      if (next) {
        const p = Model.predictMatch(R, next.red, next.blue);
        const onRed = next.red.includes(ot);
        const pw = onRed ? p.pRed : 1 - p.pRed;
        nextHtml = `<b>${matchLabel(next)}</b> ${allianceHtml(next.red, 'red-t')} vs ${allianceHtml(next.blue, 'blue-t')}<br>
          Win chance <b>${pct(pw)}</b> · expected RP <b>${f1((onRed ? p.red : p.blue).expRP, 2)}</b> · predicted ${f1(p.red.score, 0)}–${f1(p.blue.score, 0)}`;
      }
      html += `<div class="card hl" style="margin-bottom:14px"><h3>Our team · ${teamLink(ot)} ${esc(r.name)}</h3>
        <div class="stats">
          ${statCard('True Potential', f1(r.tp), 'likely ' + range(r.tp, r.tpSd) + ' · ' + (sureOf(r.tpSd) || '') + ' confidence')}
          ${statCard('TP rank', '#' + tpRank[ot], 'of ' + rows.length)}
          ${statCard('Current rank', r.rank ? '#' + r.rank : '–', r.rs != null ? 'RS ' + f1(r.rs, 2) : '')}
          ${statCard('True rank', '#' + r.trueRank, 'neutral sched.')}
          ${statCard('Schedule luck', `<span class="${cls(r.luck)}">${sgn(r.luck)}</span>`, 'RP/match')}
          ${statCard('Proj. final rank', r.expRank != null ? f1(r.expRank, 1) : '…', r.sim ? `${r.sim.p10}–${r.sim.p90}` : '')}
          ${statCard('P(top 8)', r.p8 != null ? pct(r.p8) : '…')}
        </div>
        <p style="margin:12px 0 0">${nextHtml}</p></div>`;
    }

    const luckSorted = rows.filter(r => r.luck != null).sort((a, b) => b.luck - a.luck);
    const top = byTP.slice(0, 12);
    html += `<div class="grid cols-2">
      <div class="card"><h3>Top True Potential</h3>
        <table><thead><tr><th>#</th><th>Team</th><th class="n">TP</th><th class="n">Rank now</th><th class="n">True rank</th><th class="n">P(top 8)</th></tr></thead><tbody>
        ${top.map((r, i) => `<tr class="${ours(r.key) ? 'ours' : ''}"><td>${i + 1}</td><td>${teamLink(r.key)} <span class="sd">${esc(r.name).slice(0, 22)}</span></td><td class="n"><b>${f1(r.tp)}</b> <span class="sd">±${f1(r.tpSd, 0)}</span></td><td class="n">${r.rank || '–'}</td><td class="n">${r.trueRank}</td><td class="n">${r.p8 != null ? pct(r.p8) : '…'}</td></tr>`).join('')}
        </tbody></table></div>
      <div class="card"><h3>Event</h3>
        <div class="stats">
          ${statCard('Teams', ev.teams.length)}
          ${statCard('Quals played', playedN + '/' + q.length)}
          ${statCard('Avg alliance pts', f1(R.comps.total.base * 3, 0), 'no fouls')}
          ${statCard('Score noise', '±' + f1(Math.sqrt(R.comps.total.noise), 0), 'pts/alliance')}
          ${statCard('Level', esc(ev.level || 'regional'))}
          ${statCard('Priors', Object.keys(ev.priors || {}).length + '/' + ev.teams.length, 'teams')}
        </div>
        ${S.game.bonuses.length ? `<p class="help">Bonus thresholds: ${S.game.bonuses.map(b => `${b.label} <b>${R.thr[b.key]}</b>${R.thrDetected[b.key] ? ' <span class="pill muted" title="Differs from the official ' + R.thrDetected[b.key].official + ' — inferred from this event\'s results">detected</span>' : ''}`).join(' · ')}</p>` : ''}
        <p class="help">Bonus RP model: <b>${Model.bonusMode(R)}</b>${Model.bonusMode(R) === 'threshold' ? ' (from predicted fuel / tower vs. the official thresholds)' : Model.bonusMode(R) === 'linear' ? ' (from past bonus RPs earned)' : ' — no bonus data, forecast uses wins only'}.</p>
        <p>${S.accuracy ? accuracyHtml(S.accuracy) : `<button class="btn small" data-act="accuracy">Check model accuracy at this event</button> <span class="help">Re-predicts every played match using only earlier matches.</span>`}</p>
      </div>
      <div class="card"><h3>Luckiest schedules</h3>${luckList(luckSorted.slice(0, 6))}</div>
      <div class="card"><h3>Toughest schedules</h3>${luckList(luckSorted.slice(-6).reverse())}</div>
    </div>`;
    return html;
  }

  function accuracyHtml(a) {
    if (!a.n) return '<span class="help">No decided matches to check yet.</span>';
    return `Out-of-sample accuracy here: <b>${pct(a.correct / a.n, 1)}</b> of ${a.n} matches · Brier ${f1(a.brier / a.n, 3)} <span class="help">(coin flip = 0.25, good models ≈ 0.17–0.20)</span>`;
  }

  function luckList(rows) {
    return `<table><thead><tr><th>Team</th><th class="n">Luck RP/m</th><th class="n">Ease %ile</th><th class="n">Rank → True</th></tr></thead><tbody>
      ${rows.map(r => `<tr class="${ours(r.key) ? 'ours' : ''}"><td>${teamLink(r.key)}</td><td class="n ${cls(r.luck)}">${sgn(r.luck)}</td><td class="n">${f1(r.easePct, 0)}</td><td class="n">${r.rank || '–'} → ${r.trueRank}</td></tr>`).join('')}
      </tbody></table>`;
  }

  // Plain-English rule for a bonus RP, e.g. "at least 100 fuel scored".
  function bonusRule(b, thr) {
    const what = { fuel: 'fuel scored', tower: 'tower points', autoFuel: 'auto fuel' }[b.comp] || b.comp;
    return thr != null ? `at least ${thr} ${what}` : what;
  }

  // Alliance team list; with a match, robots marked broke / no-show get a ⚠.
  function allianceHtml(teams, c, m) {
    return `<span class="alliance ${c}">${teams.map(t => {
      const iss = m ? Model.robotIssue(m, t) : null;
      return teamLink(t) + (iss ? `<span class="warn" title="${esc(tnum(t) + ' ' + issueText(iss) + (iss.note ? ' — ' + iss.note : ''))}">⚠</span>` : '');
    }).join(' ')}</span>`;
  }

  // ----- sortable table -----
  function table(id, cols, rows, opts = {}) {
    let [sk, dir] = S.sort[id] || [];
    if (!cols.some(c => c.key === sk && !c.nosort)) { [sk, dir] = { teams: ['tp', -1], picks: ['pickScore', -1], luck: ['luck', 1], forecast: ['expRank', 1] }[id] || []; }
    const col = cols.find(c => c.key === sk);
    if (col) {
      const get = col.sortVal || (r => r[col.key]);
      rows = rows.slice().sort((a, b) => {
        const va = get(a), vb = get(b);
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
      });
    }
    return `<div class="table-wrap"><table data-table="${id}"><thead><tr>${cols.map(c =>
      `<th class="${c.n ? 'n' : ''} ${c.key === sk ? 'sorted' : ''}" ${c.nosort ? '' : `data-sort="${c.key}"`} title="${esc(c.title || '')}">${c.label}${c.key === sk ? (dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}
      </tr></thead><tbody>${rows.map(r => `<tr class="${opts.rowClass ? opts.rowClass(r) : ''}">${cols.map(c => `<td class="${c.n ? 'n' : ''} ${c.cls || ''}">${c.fmt ? c.fmt(r) : esc(r[c.key])}</td>`).join('')}</tr>`).join('')}
      </tbody></table></div>`;
  }

  // ----- Teams -----
  function renderTeams() {
    const R = S.R, g = S.game;
    let rows = R.teams.map(teamRow);
    const q = S.filter.trim().toLowerCase();
    if (q) rows = rows.filter(r => String(r.num).includes(q) || r.name.toLowerCase().includes(q) || ((S.event.notes || {})[r.key] || '').toLowerCase().includes(q));
    if (S.hidePicked) rows = rows.filter(r => !r.picked);
    const has = c => R.comps[c] && R.comps[c].available;
    const sc = S.event.scouting;
    const scoutCols = sc && sc.columns ? sc.columns.filter(c => (sc.show || {})[c] !== false).slice(0, 6) : [];
    const cols = [
      { key: 'starred', label: '★', nosort: false, sortVal: r => (r.starred ? 1 : 0), fmt: r => `<a data-star="${r.key}" title="Star">${r.starred ? '★' : '☆'}</a>` },
      { key: 'num', label: 'Team', fmt: r => teamLink(r.key) },
      { key: 'name', label: 'Name', cls: 'name', fmt: r => esc(r.name) },
      { key: 'tp', label: 'True Potential', n: 1, title: 'Expected points this robot adds per match (no fouls), schedule- and partner-adjusted. Grey = 80% likely range.', fmt: r => `<b>${f1(r.tp)}</b> <span class="sd">${range(r.tp, r.tpSd)}</span>` },
      { key: 'trend', label: 'Trend', title: 'Improving / steady / slipping at this event (only when clearly beyond match noise)', sortVal: r => { const t = trendOf(r.key).within; return t ? t.delta : null; }, fmt: r => trendArrow(r.key) },
      { key: 'sure', label: 'Sure', title: 'How sure the rating is (uncertainty vs. spread between teams)', sortVal: r => r.tpSd, fmt: r => surePill(r.tpSd) },
    ];
    if (has('auto')) cols.push({ key: 'auto', label: 'Auto', n: 1, fmt: r => f1(r.auto) });
    if (has('fuel')) cols.push({ key: 'fuel', label: 'Fuel', n: 1, fmt: r => f1(r.fuel) });
    if (has('autoFuel')) cols.push({ key: 'autoFuel', label: 'A.Fuel', n: 1, fmt: r => f1(r.autoFuel) });
    if (has('tower')) cols.push({ key: 'tower', label: 'Tower', n: 1, fmt: r => f1(r.tower) });
    if (has('fouls')) cols.push({ key: 'fouls', label: 'Fouls', n: 1, title: 'Foul points given to opponents per match (lower is better)', fmt: r => f1(r.fouls) });
    if (S.R.defense) cols.push({ key: 'defense', label: 'Defense', n: 1, title: 'Points per match opponents score below prediction when this team plays against them (higher = better defender). Usually small.', fmt: r => `<span class="${cls(r.defense)}">${sgn(r.defense, 1)}</span>` });
    if (has('fouls')) cols.push({ key: 'net', label: 'Net', n: 1, title: 'True Potential minus foul points given away', fmt: r => f1(r.net) });
    cols.push(
      { key: 'opr', label: 'OPR', n: 1, title: 'Plain OPR (incl. fouls) for reference — noisier than True Potential', fmt: r => `<span class="sd">${f1(r.opr)}</span>` },
      { key: 'rank', label: 'Rank', n: 1, fmt: r => (r.rank ? r.rank : '–') + (r.rs != null ? ` <span class="sd">${f1(r.rs, 2)}</span>` : '') },
      { key: 'trueRank', label: 'True rank', n: 1, title: 'Rank by expected RP/match on a neutral (random) schedule', fmt: r => r.trueRank },
      { key: 'expRank', label: 'Proj. rank', n: 1, title: 'Average final rank across simulations', fmt: r => f1(r.expRank, 1) },
      { key: 'p8', label: 'P(top 8)', n: 1, fmt: r => pct(r.p8) },
    );
    for (const c of scoutCols) cols.push({ key: 'sc:' + c, label: esc(c), n: 1, title: 'Scouting average', sortVal: r => r.scout[c], fmt: r => f1(r.scout[c]) });
    cols.push(
      { key: 'problems', label: 'Problems', n: 1, title: 'Matches where this robot broke or was a no-show (marked in the match editor)', sortVal: r => r.problems, fmt: r => (r.problems ? `<span class="neg" title="${esc(r.problemText)}">${r.problems}/${r.played}</span>` : `<span class="sd">0</span>`) },
      { key: 'notes', label: 'Notes', nosort: true, fmt: r => { const n = (S.event.notes || {})[r.key]; return n ? `<span class="sd" title="${esc(n)}">${esc(n.slice(0, 24))}${n.length > 24 ? '…' : ''}</span>` : ''; } },
      { key: 'picked', label: 'Picked', sortVal: r => (r.picked ? 1 : 0), fmt: r => `<input type="checkbox" data-pick="${r.key}" ${r.picked ? 'checked' : ''} title="Mark as picked during alliance selection">` },
    );
    return `<div class="toolbar">
        <input id="teamFilter" placeholder="Filter team / name / notes" value="${esc(S.filter)}" style="width:240px">
        <label><input type="checkbox" id="hidePicked" ${S.hidePicked ? 'checked' : ''}> Hide picked</label>
        <span class="spacer"></span>
        <button class="btn small" data-act="clear-picked">Clear picks</button>
        <button class="btn small" data-act="export-csv">Export CSV</button>
      </div>
      <p class="help"><b>True Potential</b> = points a robot adds to its alliance per match (fouls excluded), solved jointly across all matches so strong/weak partners are accounted for, and blended with the team's earlier-event results while data is thin. ± is one standard deviation. Click a team for details; click headers to sort.</p>
      ${table('teams', cols, rows, { rowClass: r => (ours(r.key) ? 'ours ' : '') + (r.picked ? 'picked' : '') })}`;
  }

  // ----- Best picks -----
  function renderPicks() {
    const R = S.R;
    const ot = S.settings.ourTeam && tkey(S.settings.ourTeam);
    let rows = R.teams.filter(k => k !== ot).map(teamRow).filter(r => r.tp != null);
    // Pick order among teams still available.
    const order = rows.filter(r => !r.picked).sort((a, b) => b.pickScore - a.pickScore);
    const pickNo = Object.fromEntries(order.map((r, i) => [r.key, i + 1]));
    const q = S.filter.trim().toLowerCase();
    if (q) rows = rows.filter(r => String(r.num).includes(q) || r.name.toLowerCase().includes(q) || ((S.event.notes || {})[r.key] || '').toLowerCase().includes(q));
    if (S.hidePicked) rows = rows.filter(r => !r.picked);
    const has = c => R.comps[c] && R.comps[c].available;
    const relOn = R.rel.any;
    const cols = [
      { key: 'pickNo', label: '#', n: 1, sortVal: r => pickNo[r.key] || 999, fmt: r => (r.picked ? '<span class="sd">—</span>' : `<b>${pickNo[r.key]}</b>`) },
      { key: 'starred', label: '★', sortVal: r => (r.starred ? 1 : 0), fmt: r => `<a data-star="${r.key}" title="Star">${r.starred ? '★' : '☆'}</a>` },
      { key: 'num', label: 'Team', fmt: r => teamLink(r.key) },
      { key: 'name', label: 'Name', cls: 'name', fmt: r => esc(r.name) },
      { key: 'pickScore', label: 'Pick score', n: 1, title: 'Points per match you can count on: True Potential × reliability, minus foul points given away', fmt: r => `<b>${f1(r.pickScore)}</b>` },
      { key: 'tp', label: 'When working', n: 1, title: 'True Potential: points added per match when the robot works', fmt: r => `${f1(r.tp)} <span class="sd">±${f1(r.tpSd, 0)}</span>` },
      { key: 'relQ', label: 'Reliability', n: 1, title: 'Chance of a clean match (no breakdown / no-show), from recorded problems blended with the event average', sortVal: r => (r.relQ == null ? 1 : 1 - r.relQ),
        fmt: r => (r.relQ == null ? '<span class="sd">—</span>' : `${pct(1 - r.relQ)}<span class="meter"><i style="width:${100 * (1 - r.relQ)}%;${r.relQ > 0.15 ? 'background:var(--bad)' : ''}"></i></span>`) },
      { key: 'problems', label: 'Problems', n: 1, sortVal: r => r.problems, fmt: r => (r.problems ? `<span class="neg" title="${esc(r.problemText)}">${r.problems}/${r.played}</span>` : `<span class="sd">0/${r.played}</span>`) },
      { key: 'scouts', label: 'Scouts', nosort: true, title: 'Scout ratings from team pages: driving 1–5, defense role, robot condition', fmt: r => tagsHtml(r.tags) },
    ];
    if (has('auto')) cols.push({ key: 'auto', label: 'Auto', n: 1, fmt: r => f1(r.auto) });
    if (has('fuel')) cols.push({ key: 'fuel', label: 'Fuel', n: 1, fmt: r => f1(r.fuel) });
    if (has('tower')) cols.push({ key: 'tower', label: 'Tower', n: 1, fmt: r => f1(r.tower) });
    if (has('fouls')) cols.push({ key: 'fouls', label: 'Fouls', n: 1, fmt: r => f1(r.fouls) });
    cols.push(
      { key: 'rank', label: 'Rank', n: 1, fmt: r => (r.rank || '–') + (r.rank && r.rank <= 8 ? ' <span class="pill muted" title="Currently a top-8 seed: would be an alliance captain">captain</span>' : '') },
      { key: 'notes', label: 'Notes', nosort: true, fmt: r => { const n = (S.event.notes || {})[r.key]; return n ? `<span class="sd" title="${esc(n)}">${esc(n.slice(0, 24))}${n.length > 24 ? '…' : ''}</span>` : ''; } },
      { key: 'picked', label: 'Picked', sortVal: r => (r.picked ? 1 : 0), fmt: r => `<input type="checkbox" data-pick="${r.key}" ${r.picked ? 'checked' : ''} title="Mark as picked during alliance selection">` },
    );
    const best = order.slice(0, 3);
    return `<div class="toolbar">
        <input id="teamFilter" placeholder="Filter team / name / notes" value="${esc(S.filter)}" style="width:240px">
        <label><input type="checkbox" id="hidePicked" ${S.hidePicked ? 'checked' : ''}> Hide picked</label>
        <span class="spacer"></span>
        <button class="btn small" data-act="print-picks">Print pick list</button>
        <button class="btn small" data-act="clear-picked">Clear picks</button>
      </div>
      ${best.length ? `<div class="grid cols-3" style="margin-bottom:14px">${best.map((r, i) => `<div class="card ${i === 0 ? 'hl' : ''}">
        <h3>${['Best available', '2nd', '3rd'][i]}</h3>
        <div style="font-size:20px">${teamLink(r.key)} <span class="sd">${esc(r.name)}</span></div>
        <div class="stats" style="margin-top:8px">${statCard('Pick score', f1(r.pickScore))}${statCard('When working', f1(r.tp))}${statCard('Reliability', r.relQ == null ? '—' : pct(1 - r.relQ))}</div>
        ${r.problems ? `<p class="help neg">${esc(r.problemText)}</p>` : ''}</div>`).join('')}</div>` : ''}
      <p class="help"><b>Pick score</b> = points per match you can count on: the robot's True Potential, reduced by its chance of breaking down, minus foul points it gives away.
        ${relOn ? 'Reliability comes from problems marked in the match editor, blended with the event average so one bad match doesn\'t sink a team.' : '<b>No breakdowns recorded yet</b> — mark robots as Broke / No-show in the match editor and reliability will start counting.'}
        Tick <b>Picked</b> during alliance selection and the list re-ranks what's left.${ot ? ` Your team (${esc(tnum(ot))}) is left out.` : ''}</p>
      ${table('picks', cols, rows, { rowClass: r => (r.picked ? 'picked' : '') })}`;
  }

  // ----- Alliance selection -----
  // event.alliances = { n, slots: [[captain, pick1, pick2], ...] }. Every alliance starts
  // empty and is filled by hand (drag & drop). The "captain" tags live in the available
  // list: they mark the teams that would be captains right now, following how FRC seats
  // them, and move to the next-ranked team when a would-be captain is placed as a pick.
  const SLOT_NAMES = ['Captain', '1st pick', '2nd pick'];

  function allianceState() {
    const ev = S.event;
    let a = ev.alliances;
    if (!a || !a.slots) a = ev.alliances = { n: Math.min(8, Math.floor(ev.teams.length / 3)) || 1, slots: [] };
    while (a.slots.length < a.n) a.slots.push([null, null, null]);
    a.slots.length = a.n;
    return a;
  }

  // Seeding order: current rank, then (for teams without one) true rank.
  function seedOrder() {
    const ranked = S.st.filter(s => s.rank).map(s => s.team);
    const rest = S.R.teams.filter(t => !ranked.includes(t)).sort((x, y) => (S.luck[x] ? S.luck[x].trueRank : 999) - (S.luck[y] ? S.luck[y].trueRank : 999));
    return ranked.concat(rest);
  }

  // Who would captain each alliance whose captain slot is still empty: the best-ranked
  // team not already placed and not expected to captain an earlier alliance.
  function expectedCaptains(a) {
    const order = seedOrder();
    const used = new Set(a.slots.flat().filter(Boolean));
    const out = [];
    for (let k = 0; k < a.n; k++) {
      if (a.slots[k][0]) { out[k] = null; continue; }
      const t = order.find(x => !used.has(x)) || null;
      out[k] = t;
      if (t) used.add(t);
    }
    return out;
  }

  function allianceOf(t) {
    const a = S.event && S.event.alliances;
    if (!a || !a.slots) return null;
    for (let k = 0; k < a.slots.length; k++) for (let j = 0; j < 3; j++) if (a.slots[k][j] === t) return { k, slot: j };
    return null;
  }

  function placeTeam(t, k, j) {
    const a = allianceState();
    const from = allianceOf(t);
    const prev = a.slots[k][j];
    if (from) a.slots[from.k][from.slot] = null;
    // Dropping onto an occupied slot swaps the two teams (or sends the old one back).
    if (prev && prev !== t && from) a.slots[from.k][from.slot] = prev;
    a.slots[k][j] = t;
    persist(); render();
  }

  function removeTeam(t) {
    const a = allianceState(), from = allianceOf(t);
    if (from) a.slots[from.k][from.slot] = null;
    persist(); render();
  }

  // Next empty slot in the order selection happens: each captain is seated then makes
  // their 1st pick (A1 → A8), then 2nd picks go back up (A8 → A1).
  function nextSlot(a) {
    for (let k = 0; k < a.n; k++) for (const j of [0, 1]) if (!a.slots[k][j]) return { k, j };
    for (let k = a.n - 1; k >= 0; k--) if (!a.slots[k][2]) return { k, j: 2 };
    return null;
  }

  // Fill empty slots with the most likely choices, in selection order: an empty captain slot
  // gets the best-ranked team not yet placed, an empty pick slot the best available by pick
  // score (an assumption: other alliances may value robots differently).
  function projectSlots(slots, pickOrder) {
    const out = slots.map(sl => sl.slice()), proj = slots.map(sl => sl.map(() => false));
    const placed = new Set(out.flat().filter(Boolean));
    const seeds = seedOrder();
    const fill = (k, j) => {
      if (out[k][j]) return;
      const t = (j === 0 ? seeds : pickOrder).find(x => !placed.has(x));
      if (t) { out[k][j] = t; proj[k][j] = true; placed.add(t); }
    };
    for (let k = 0; k < out.length; k++) { fill(k, 0); fill(k, 1); }
    for (let k = out.length - 1; k >= 0; k--) fill(k, 2);
    return { slots: out, proj };
  }

  function allianceOdds(slots) {
    const als = slots.map(sl => sl.filter(Boolean));
    if (als.some(x => !x.length)) return null;
    return Sim.playoffOdds(S.R, als, { nSims: 3000, seed: 7 });
  }

  // Best next pick for the alliance whose turn it is: try the strongest available robots and
  // keep the one that most raises that alliance's chance to win the event.
  function bestNextPicks(a, next, pickOrder) {
    if (!next || next.j === 0) return null;
    const key = JSON.stringify(a.slots) + '|' + next.k + next.j + '|' + (S.computeMs || 0);
    if (S.bestPickCache && S.bestPickCache.key === key) return S.bestPickCache.val;
    const placed = new Set(a.slots.flat().filter(Boolean));
    const cands = pickOrder.filter(t => !placed.has(t)).slice(0, 12);
    const val = cands.map(t => {
      const trial = a.slots.map(sl => sl.slice());
      trial[next.k][next.j] = t;
      const odds = allianceOdds(projectSlots(trial, pickOrder).slots);
      return { team: t, pWin: odds ? odds[next.k].pWin : null, pFinal: odds ? odds[next.k].pFinal : null };
    }).filter(x => x.pWin != null).sort((x, y) => y.pWin - x.pWin);
    S.bestPickCache = { key, val };
    return val;
  }

  function renderAlliances() {
    const a = allianceState();
    const exp = expectedCaptains(a);
    const capFor = Object.fromEntries(exp.map((t, k) => [t, k]).filter(x => x[0]));
    const rows = Object.fromEntries(S.R.teams.map(t => [t, teamRow(t)]));
    const next = nextSlot(a);
    const chip = (t, opts = {}) => {
      const r = rows[t];
      if (!t || !r) return '';
      const cap = capFor[t];
      return `<div class="chip ${ours(t) ? 'ours' : ''}" draggable="true" data-drag="${esc(t)}" title="${esc(r.name)} — drag to move">
        ${teamLink(t)}${opts.pool && cap != null ? ` <span class="pill good" title="Would captain Alliance ${cap + 1} right now">captain · A${cap + 1}</span>` : ''}
        <span class="sd">${f1(r.pickScore)}</span>${r.relQ != null && r.relQ > 0.1 ? ` <span class="pill bad" title="${esc(r.problemText)}">${pct(1 - r.relQ)}</span>` : ''}
        ${opts.removable ? `<button class="x" data-unpick="${esc(t)}" title="Back to available">×</button>` : ''}</div>`;
    };
    // Alliance strength = expected points per match from its robots (reliability included),
    // and playoff odds with empty slots filled by the most likely picks.
    const pickOrder = S.R.teams.map(t => rows[t]).filter(r => r.tp != null).sort((x, y) => y.pickScore - x.pickScore).map(r => r.key);
    const P = projectSlots(a.slots, pickOrder);
    const odds = allianceOdds(P.slots);
    const anyProj = P.proj.some(r => r.some(Boolean));
    const strengths = P.slots.map(sl => { const ts = sl.filter(Boolean); return ts.length ? Model.allianceDist(S.R, ts, 'total').mu : null; });
    const best = bestNextPicks(a, next, pickOrder);
    const order = strengths.map((v, k) => [v, k]).filter(x => x[0] != null).sort((x, y) => y[0] - x[0]).map(x => x[1]);
    const cards = a.slots.map((sl, k) => {
      const slot = j => {
        const t = sl[j];
        const isNext = next && next.k === k && next.j === j;
        const pt = P.proj[k][j] ? P.slots[k][j] : null;
        return `<div class="slot ${j === 0 ? 'cap' : ''} ${isNext ? 'next' : ''}" data-slot="${k}:${j}">${t ? chip(t, { removable: true }) : `<span class="sd">${SLOT_NAMES[j]}${isNext ? ' — next' : ''}${pt ? ` · <i title="Projected: most likely choice for this slot">likely ${esc(tnum(pt))}</i>` : ''}</span>`}</div>`;
      };
      const sv = strengths[k];
      return `<div class="card alliance-card ${sl.some(ours) ? 'hl' : ''}">
        <h3>Alliance ${k + 1}${sv != null ? ` <span class="sd" style="text-transform:none;letter-spacing:0">· ${f1(sv, 0)} pts${order.length > 1 ? ' · #' + (order.indexOf(k) + 1) + ' strongest' : ''}</span>` : ''}</h3>
        ${odds ? `<div class="odds" title="Chance to win the event / reach the finals, from simulating the playoff bracket${P.proj[k].some(Boolean) ? ' (includes projected picks)' : ''}"><b>${pct(odds[k].pWin)}</b> win event · ${pct(odds[k].pFinal)} reach finals${P.proj[k].some(Boolean) ? ' <span class="sd">(projected)</span>' : ''}</div>` : ''}
        ${slot(0)}${slot(1)}${slot(2)}</div>`;
    }).join('');
    const placed = new Set(a.slots.flat().filter(Boolean));
    // Available list order, chosen by the user: best robots (pick score) or event ranking.
    const byRank = S.settings.poolSort === 'rank';
    const seedPos = Object.fromEntries(seedOrder().map((t, i) => [t, i]));
    const pool = S.R.teams.filter(t => !placed.has(t)).map(t => rows[t]).filter(r => r.tp != null)
      .sort((x, y) => (byRank ? seedPos[x.key] - seedPos[y.key] : y.pickScore - x.pickScore));
    return `<div class="toolbar">
        <label>Alliances <select id="nAlliances">${[2, 3, 4, 5, 6, 7, 8].map(n => `<option ${a.n === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <span class="help">${next ? `Next: <b>Alliance ${next.k + 1} ${SLOT_NAMES[next.j].toLowerCase()}</b>` : 'All alliances are full.'}</span>
        <span class="spacer"></span>
        <button class="btn small danger" data-act="reset-alliances">Clear all alliances</button>
      </div>
      <p class="help">Alliances start empty — drag teams in as they're announced (onto any slot, between slots, or back to the list; dropping on a filled slot swaps). <b>Add ▸</b> fills the next slot in selection order.
        The <span class="pill good">captain · A#</span> tags show who would captain each alliance right now: pick a would-be captain and the tag moves to the next-ranked team. Strength = expected points per match of the robots placed.</p>
      ${best && best.length ? `<div class="card best-pick ${a.slots[next.k].some(ours) ? 'hl' : ''}"><h3>Best next pick for Alliance ${next.k + 1}</h3>
        <p class="help">Each candidate is tried in Alliance ${next.k + 1}'s ${SLOT_NAMES[next.j].toLowerCase()}, the remaining picks are projected, and the playoff bracket is simulated. Ranked by Alliance ${next.k + 1}'s chance to win the event.</p>
        <div class="best-list">${best.slice(0, 5).map((b, i) => `<div class="best-row">${i === 0 ? '<span class="pill good">best</span>' : `<span class="sd">${i + 1}</span>`} ${chip(b.team, { pool: true })}
          <span><b>${pct(b.pWin)}</b> win event <span class="sd">· ${pct(b.pFinal)} finals${i ? ' · ' + sgn(100 * (b.pWin - best[0].pWin), 1) + ' pts vs best' : ''}</span></span>
          <button class="btn small" data-pickteam="${esc(b.team)}">Add ▸</button></div>`).join('')}</div></div>` : ''}
      ${anyProj && odds ? '<p class="help">Win chances include <i>likely</i> picks for empty slots (best available by pick score, captains by rank) — they firm up as real picks are entered.</p>' : ''}
      <div class="sel-layout">
        <div class="alliance-grid">${cards}</div>
        <div class="card pool" data-slot="pool"><h3>Available</h3>
          <div class="seg" role="group" aria-label="Sort available teams">
            <button class="${byRank ? '' : 'on'}" data-poolsort="best" title="Highest pick score first: True Potential × reliability − fouls">Best robots</button>
            <button class="${byRank ? 'on' : ''}" data-poolsort="rank" title="Event ranking order (current rank)">Highest ranked</button>
          </div>
          ${pool.map(r => `<div class="pool-row">${chip(r.key, { pool: true })}<span class="sd">TP ${f1(r.tp)} · rank ${r.rank || '–'}</span>${next ? `<button class="btn small" data-pickteam="${esc(r.key)}">Add ▸</button>` : ''}</div>`).join('') || '<p class="help">Everyone is on an alliance.</p>'}
        </div>
      </div>`;
  }

  // ----- Schedule luck -----
  function renderLuck() {
    const rows = S.R.teams.map(teamRow);
    const cols = [
      { key: 'num', label: 'Team', fmt: r => teamLink(r.key) },
      { key: 'rank', label: 'Rank', n: 1, fmt: r => r.rank || '–' },
      { key: 'rs', label: 'RS', n: 1, title: 'Actual ranking score (RP per match)', fmt: r => f1(r.rs, 2) },
      { key: 'adjRS', label: 'Luck-adj. RS', n: 1, title: 'RS with the schedule effect on played matches removed', fmt: r => `<b>${f1(r.adjRS, 2)}</b>` },
      { key: 'luck', label: 'Schedule luck', n: 1, title: 'Expected RP/match on this schedule minus on a random schedule (all quals, played + upcoming). + = easier', fmt: r => `<span class="${cls(r.luck)}">${sgn(r.luck)}</span>` },
      { key: 'easePct', label: 'Ease %ile', n: 1, title: '100 = easiest possible schedule, 50 = average, 0 = hardest', fmt: r => `${f1(r.easePct, 0)}<span class="meter"><i style="width:${Math.max(0, Math.min(100, r.easePct || 0))}%"></i></span>` },
      { key: 'tailwind', label: 'Tailwind pts', n: 1, title: 'Avg (partner strength − opponent strength) vs. event average, in points per match', fmt: r => `<span class="${cls(r.tailwind)}">${sgn(r.tailwind, 1)}</span>` },
      { key: 'perfLuck', label: 'Over/under', n: 1, title: 'Actual RS minus what the model expected on the matches played. + = outperformed (lucky breaks, or improving)', fmt: r => `<span class="${cls(r.perfLuck)}">${sgn(r.perfLuck)}</span>` },
      { key: 'luckPre', label: 'Luck at release', n: 1, title: 'Schedule luck judged with pre-event ratings only (what the schedule looked like when published)', fmt: r => `<span class="${cls(r.luckPre)}">${sgn(r.luckPre)}</span>` },
      { key: 'trueRank', label: 'True rank', n: 1, fmt: r => r.trueRank },
      { key: 'gap', label: 'Rank − True', n: 1, title: 'Positive = ranked worse than true strength', sortVal: r => (r.rank ? r.rank - r.trueRank : null), fmt: r => (r.rank ? sgn(r.rank - r.trueRank, 0) : '–') },
    ];
    return `<p class="help"><b>Schedule luck</b> compares the RP/match a team should expect on its actual schedule against the same team with random partners and opponents (using current ratings). +0.30 means the schedule alone is worth about 0.3 RP per match.
      <b>Luck-adjusted RS</b> removes that effect from the matches already played — the best single number for "who deserves to be where".
      <b>Over/under</b> is what's left: results above or below what the model expected on that schedule.</p>
      ${table('luck', cols, rows, { rowClass: r => (ours(r.key) ? 'ours' : '') })}`;
  }

  // ----- Matches -----
  function renderMatches() {
    const ev = S.event, R = S.R;
    const ot = S.settings.ourTeam && tkey(S.settings.ourTeam);
    let ms = ev.matches;
    if (S.matchFilter === 'ours' && ot) ms = ms.filter(m => m.red.includes(ot) || m.blue.includes(ot));
    if (S.matchFilter === 'upcoming') ms = ms.filter(m => !Model.isPlayed(m));
    if (S.matchFilter === 'played') ms = ms.filter(m => Model.isPlayed(m));
    const rows = ms.map(m => {
      const p = Model.predictMatch(R, m.red, m.blue);
      const played = Model.isPlayed(m);
      let actual = '<span class="sd">—</span>';
      if (played) {
        const w = Model.winnerOf(m);
        const rrp = m.comp === 'qm' ? Model.allianceRP(m, 'r', S.game, ev.level, R.thr) : null;
        const brp = m.comp === 'qm' ? Model.allianceRP(m, 'b', S.game, ev.level, R.thr) : null;
        actual = `<b class="red-t">${m.r.score}</b>–<b class="blue-t">${m.b.score}</b>${rrp != null ? ` <span class="sd">RP ${rrp}/${brp}</span>` : ''}`;
        const upset = (w === 'r' && p.pRed < 0.35) || (w === 'b' && p.pRed > 0.65);
        if (upset) actual += ' <span class="pill bad" title="Model favoured the other alliance">upset</span>';
      }
      // Each bonus RP spelled out, with red's chance in red and blue's in blue.
      const thrNow = R.thr || {};
      const bonusTxt = Object.keys(p.red.bonus).length
        ? S.game.bonuses.map(b => `<span title="${esc(b.label)}: ${esc(bonusRule(b, thrNow[b.key]))}">${esc(b.label)} <span class="red-t">${pct(p.red.bonus[b.key])}</span>/<span class="blue-t">${pct(p.blue.bonus[b.key])}</span></span>`).join(' · ') : '';
      const surr = (m.redSurr || []).concat(m.blueSurr || []);
      return `<tr class="${ot && (m.red.includes(ot) || m.blue.includes(ot)) ? 'ours' : ''}">
        <td><a data-match="${esc(m.key)}"><b>${matchLabel(m)}</b></a>${m.source === 'manual' ? ' <span class="pill muted" title="Entered by hand">manual</span>' : ''}</td>
        <td>${allianceHtml(m.red, 'red-t', m)}</td><td>${allianceHtml(m.blue, 'blue-t', m)}</td>
        <td><span class="probbar" title="Red win ${pct(p.pRed, 1)}"><span class="r" style="width:${100 * p.pRed}%">${p.pRed >= 0.2 ? pct(p.pRed) : ''}</span><span class="b" style="width:${100 * (1 - p.pRed)}%">${p.pRed <= 0.8 ? pct(1 - p.pRed) : ''}</span></span></td>
        <td class="n">${f1(p.red.score, 0)}–${f1(p.blue.score, 0)}</td>
        <td class="sd">${played && m.comp === 'qm' ? '' : bonusTxt}</td>
        <td class="n">${actual}</td>
        <td>${m.red.concat(m.blue).map(t => { const iss = Model.robotIssue(m, t); return iss ? `<span class="pill bad" title="${esc(iss.note || '')}">${esc(tnum(t))} ${esc(issueText(iss))}</span> ` : ''; }).join('')}${surr.length ? `<span class="pill muted" title="Surrogate = an extra match the schedule needed. It earns these teams no ranking points and doesn't count toward their ranking score (their robot performance still counts toward ratings).">surrogate: ${surr.map(tnum).join(', ')}</span>` : ''}</td>
        <td style="white-space:nowrap"><button class="btn small" data-match="${esc(m.key)}">${played ? 'Edit' : 'Enter'}</button> <button class="btn small" data-act="print-match" data-key="${esc(m.key)}" title="Printable strategy sheet for this match">Sheet</button></td></tr>`;
    }).join('');
    return `<div class="toolbar">
        <select id="matchFilter">
          ${[['all', 'All matches'], ['upcoming', 'Upcoming'], ['played', 'Played'], ['ours', 'Our matches']].map(([v, l]) => `<option value="${v}" ${S.matchFilter === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <span class="spacer"></span>
        <button class="btn small" data-act="new-match">+ Add match</button>
        <button class="btn small" data-act="paste-schedule">Paste schedule</button>
        <button class="btn small" data-act="paste-results">Paste scores</button>
        ${navigator.onLine && S.settings.tbaKey && !ev.demo ? '<button class="btn small primary" data-act="tba-refresh">Refresh from TBA</button>' : ''}
      </div>
      <p class="help">Predictions use the current ratings (for played matches this includes the match itself). The bonus columns show each alliance's chance of earning each bonus RP (${S.game.bonuses.map(b => `${b.label}: ${bonusRule(b, (R.thr || {})[b.key])}`).join('; ') || 'none this season'}). Click a match to enter or correct its result — ratings update instantly.</p>
      <div class="table-wrap"><table><thead><tr><th>Match</th><th>Red</th><th>Blue</th><th>Win chance</th><th class="n">Pred.</th><th title="Chance each alliance earns each bonus ranking point (red / blue)">Bonus RP chance <span class="red-t">red</span>/<span class="blue-t">blue</span></th><th class="n">Result</th><th></th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="9" class="empty">No matches yet — paste the schedule or add matches.</td></tr>'}</tbody></table></div>`;
  }

  // ----- Forecast -----
  function renderForecast() {
    if (!S.sim) return '<p class="help">Simulating…</p>';
    const rows = S.R.teams.map(teamRow);
    const T = rows.length;
    const spark = d => {
      const w = 2.4, h = 22;
      let max = 0;
      for (const v of d) max = Math.max(max, v);
      let svg = `<svg class="spark" width="${Math.ceil(T * w)}" height="${h}">`;
      for (let r = 0; r < T; r++) {
        const bh = max ? Math.max(d[r] > 0 ? 1 : 0, d[r] / max * h) : 0;
        if (bh) svg += `<rect class="${r < 8 ? 'cut' : ''}" x="${r * w}" y="${h - bh}" width="${w - 0.4}" height="${bh}"/>`;
      }
      return svg + '</svg>';
    };
    const cols = [
      { key: 'num', label: 'Team', fmt: r => teamLink(r.key) },
      { key: 'rank', label: 'Now', n: 1, fmt: r => r.rank || '–' },
      { key: 'expRank', label: 'Avg final', n: 1, fmt: r => `<b>${f1(r.expRank, 1)}</b>` },
      { key: 'range', label: '80% range', n: 1, sortVal: r => r.sim.p90 - r.sim.p10, fmt: r => `${r.sim.p10}–${r.sim.p90}` },
      { key: 'p1', label: 'P(#1)', n: 1, fmt: r => pct(r.p1) },
      { key: 'p4', label: 'P(top 4)', n: 1, fmt: r => pct(r.p4) },
      { key: 'p8', label: 'P(top 8)', n: 1, fmt: r => `<b>${pct(r.p8)}</b>` },
      { key: 'expRS', label: 'Exp. RS', n: 1, sortVal: r => r.sim.expRS, fmt: r => f1(r.sim.expRS, 2) },
      { key: 'dist', label: 'Final rank distribution (green = top 8)', nosort: true, fmt: r => spark(r.sim.dist) },
    ];
    return `<div class="toolbar"><span class="help">${S.sim.nSims.toLocaleString()} simulations of ${S.sim.remaining} remaining qualification matches · ${Math.round(S.simMs)} ms · each run redraws team strengths from their uncertainty, so early-event ranges are honest.</span>
      <span class="spacer"></span>
      <select id="nSims">${[1000, 3000, 10000, 30000].map(n => `<option value="${n}" ${+S.settings.nSims === n ? 'selected' : ''}>${n.toLocaleString()} sims</option>`).join('')}</select></div>
      ${table('forecast', cols, rows, { rowClass: r => (ours(r.key) ? 'ours' : '') })}`;
  }

  // ----- Predictor -----
  function renderPredict() {
    const opts = S.R.teams.map(t => `<option value="${tnum(t)}">${esc((S.event.teamNames || {})[t] || '')}</option>`).join('');
    const pv = S.predictTeams || ['', '', '', '', '', ''];
    const inp = (i, c) => `<input class="pt ${c}" data-i="${i}" list="teamList" value="${esc(pv[i])}" placeholder="Team" style="width:90px">`;
    return `<datalist id="teamList">${opts}</datalist>
      <p class="help">Type any six teams (e.g. a playoff matchup or a pick-list "what if"). Leave a slot empty for an average robot. Bonus thresholds: ${S.game.bonuses.map(b => `${b.label} ${S.R.thr[b.key]}`).join(', ') || 'n/a'}.</p>
      <div class="form-grid">
        <div class="side red"><h4>Red alliance</h4>${inp(0, 'red')} ${inp(1, 'red')} ${inp(2, 'red')}</div>
        <div class="side blue"><h4>Blue alliance</h4>${inp(3, 'blue')} ${inp(4, 'blue')} ${inp(5, 'blue')}</div>
      </div>
      <div id="predOut" style="margin-top:14px"></div>`;
  }

  function updatePrediction() {
    const out = $('#predOut');
    if (!out) return;
    const vals = [...document.querySelectorAll('.pt')].map(i => i.value.trim());
    S.predictTeams = vals;
    const keys = vals.map(v => (v ? tkey(v) : null));
    // A robot can only be in one slot: flag repeats and don't predict until fixed.
    const dupes = new Set(keys.filter((k, i) => k && keys.indexOf(k) !== i));
    document.querySelectorAll('.pt').forEach((el, i) => el.classList.toggle('invalid', !!keys[i] && dupes.has(keys[i])));
    if (dupes.size) {
      out.innerHTML = `<p class="neg">Team ${[...dupes].map(tnum).join(', ')} is entered more than once — a robot can only be in one slot.</p>`;
      return;
    }
    const unknown = keys.filter(k => k && S.R.idx[k] === undefined);
    const red = keys.slice(0, 3).map(k => k || '__avg'), blue = keys.slice(3).map(k => k || '__avg');
    const p = Model.predictMatch(S.R, red, blue);
    const comp = (k, label) => {
      if (!S.R.comps[k] || !S.R.comps[k].available) return '';
      const a = Model.allianceDist(S.R, red, k), b = Model.allianceDist(S.R, blue, k);
      return `<tr><td>${label}</td><td class="n red-t">${f1(a.mu)}</td><td class="n blue-t">${f1(b.mu)}</td></tr>`;
    };
    const g = S.game;
    out.innerHTML = `${unknown.length ? `<p class="neg">Not at this event (treated as average): ${unknown.map(tnum).join(', ')}</p>` : ''}
      <div class="grid cols-2"><div class="card"><h3>Prediction</h3>
        <div class="stats">${statCard('Red win', `<span class="red-t">${pct(p.pRed, 1)}</span>`)}${statCard('Blue win', `<span class="blue-t">${pct(1 - p.pRed, 1)}</span>`)}
        ${statCard('Score', `<span class="red-t">${f1(p.red.score, 0)}</span>–<span class="blue-t">${f1(p.blue.score, 0)}</span>`, `likely ${range(p.red.score, Model.allianceDist(S.R, red, 'total').sd, Z_SCORE)} vs ${range(p.blue.score, Model.allianceDist(S.R, blue, 'total').sd, Z_SCORE)} · no fouls`)}
        ${statCard('Exp. RP', `<span class="red-t">${f1(p.red.expRP, 2)}</span> / <span class="blue-t">${f1(p.blue.expRP, 2)}</span>`)}</div></div>
      <div class="card"><h3>Breakdown</h3><table><thead><tr><th></th><th class="n">Red</th><th class="n">Blue</th></tr></thead><tbody>
        ${g.comps.filter(c => !c.hidden && c.key !== 'fouls').map(c => comp(c.key, c.label)).join('')}
        ${g.bonuses.map(b => p.red.bonus[b.key] != null ? `<tr><td>P(${b.label} RP)</td><td class="n red-t">${pct(p.red.bonus[b.key])}</td><td class="n blue-t">${pct(p.blue.bonus[b.key])}</td></tr>` : '').join('')}
      </tbody></table></div></div>`;
  }

  // ----- Data -----
  function renderData() {
    const s = S.settings, ev = S.event;
    const evList = Store.listEvents();
    const sc = ev && ev.scouting;
    return `<div class="grid cols-2">
      <div class="card"><h3>1 · Download an event (needs internet once)</h3>
        <p class="help">Do this at home / school before the event. It pulls the team list, schedule and results from The Blue Alliance, plus every earlier ${new Date().getFullYear()} event for each team to build their starting ratings. Everything is saved on this Mac — no internet needed afterwards.</p>
        <div class="field"><label>TBA read API key <a href="https://www.thebluealliance.com/account" target="_blank" rel="noopener" class="help">(get one)</a></label><input id="tbaKey" type="password" value="${esc(s.tbaKey)}" style="width:260px" placeholder="paste key"></div>
        <div class="toolbar" style="margin:10px 0 6px">
          <input id="evSearch" placeholder="Search events: name, city or code (e.g. battlecry, worcester)" value="${esc(S.evQuery || '')}" style="flex:1; min-width:200px">
          <select id="evYear">${[2027, 2026, 2025, 2024].map(y => `<option ${y === evSearchYear() ? 'selected' : ''}>${y}</option>`).join('')}</select>
        </div>
        <div id="evResults">${eventResultsHtml()}</div>
        <details style="margin-top:8px"><summary>Know the exact key?</summary>
          <div class="field"><label>Event key (e.g. 2026bc)</label><input id="tbaEvent" value="${esc(ev && !ev.demo && !ev.manual ? ev.key : '')}" style="width:200px"></div>
          <p><button class="btn primary" data-act="tba-import">Download event + priors</button></p>
        </details>
        ${ev && !ev.demo && !ev.manual ? '<p><button class="btn" data-act="tba-refresh">Refresh results for ' + esc(ev.name) + '</button></p>' : ''}
        <div id="importLog" class="log" hidden></div>
      </div>

      <div class="card"><h3>Settings</h3>
        <div class="field"><label>Auto-refresh results from TBA when online (every 2 min)</label><input type="checkbox" id="autoSync" ${s.autoSync ? 'checked' : ''}></div>
        <div class="field"><label>Count recorded breakdowns in predictions &amp; picks</label><input type="checkbox" id="useReliability" ${!(s.model && s.model.useReliability === false) ? 'checked' : ''}></div>
        <div class="field"><label>Our team number</label><input id="ourTeam" value="${esc(tnum(s.ourTeam))}" style="width:100px"></div>
        <div class="field"><label>Bonus RP thresholds (auto-corrected from results after ~3 matches)</label><select id="level">${['regional', 'dcmp', 'cmp'].map(l => `<option value="${l}" ${(ev && ev.level) === l ? 'selected' : ''}>${{ regional: 'Regional / District / Offseason', dcmp: 'District Championship', cmp: 'FIRST Championship' }[l]}</option>`).join('')}</select></div>
        <div class="field"><label>Prior strength (matches-worth of earlier events)</label><input id="lambda" type="number" step="0.5" min="0.5" value="${(s.model && s.model.lambda) || Model.DEFAULT_SETTINGS.lambda}"></div>
        <div class="field"><label>Playoff match weight</label><input id="elimWeight" type="number" step="0.05" min="0" max="1" value="${f1((s.model && s.model.elimWeight != null ? s.model.elimWeight : Model.DEFAULT_SETTINGS.elimWeight), 2)}"></div>
        <div class="field"><label>Scouting observation weight</label><input id="scoutWeight" type="number" step="0.25" min="0" value="${(s.model && s.model.scoutWeight != null ? s.model.scoutWeight : Model.DEFAULT_SETTINGS.scoutWeight)}"></div>
        <p class="help">Defaults were tuned by backtesting on the full 2026 season (predicts 78% of official-event match winners) and 2019. Higher prior strength trusts earlier events more.</p>
        <p class="help">Storage used: ${Store.usageKB() != null ? Store.usageKB() + ' KB' : 'unknown'} ${Store.ok ? '' : '<b class="neg">— browser storage is blocked; export regularly!</b>'}</p>
      </div>

      <div class="card"><h3>2 · Back up / share (no wifi needed)</h3>
        <p class="help">Export a file and move it on a USB stick. Avoid AirDrop at events: it creates an ad-hoc wireless link, which rule E301 likely prohibits. Importing merges with what's already here (newest result for each match wins).</p>
        <p>${ev ? '<button class="btn" data-act="export-event">Export this event</button> ' : ''}<button class="btn" data-act="export-all">Export everything</button>
        <label class="btn">Import file…<input type="file" id="importFile" accept=".json,application/json" hidden></label></p>
      </div>

      <div class="card"><h3>3 · Scouting data (optional)</h3>
        <p class="help">Import a CSV from your scouting app. Needs a <b>team</b> column; a <b>match</b> column is optional. Numeric columns become averages in the Teams table, and you can link a column to a rating component (e.g. scouted fuel → Fuel) so it sharpens that rating directly.</p>
        <p><label class="btn">Import scouting CSV…<input type="file" id="scoutFile" accept=".csv,text/csv" hidden></label>
        ${sc && sc.rows && sc.rows.length ? `<span class="help">${sc.rows.length} rows loaded.</span> <button class="btn small" data-act="scout-map">Column links</button> <button class="btn small danger" data-act="scout-clear">Remove</button>` : ''}</p>
      </div>

      <div class="card"><h3>No internet at all?</h3>
        <p class="help">Create the event by hand: enter team numbers now, then paste or type the schedule (Matches tab) and enter scores as matches finish. Teams without earlier data start at an event-average rating.</p>
        <p><button class="btn" data-act="manual-event">Create event manually</button> <button class="btn" data-act="load-demo">Load demo event</button></p>
      </div>

      <div class="card"><h3>Saved events</h3>
        ${evList.length ? `<table class="wrap"><tbody>${evList.map(e => `<tr><td>${esc(e.year)} ${esc(e.name || e.key)}</td><td class="sd">${esc(e.key)}</td><td class="sd">${ago(e.updated)}</td>
          <td><button class="btn small" data-open="${esc(e.key)}">Open</button> <button class="btn small danger" data-del="${esc(e.key)}">Delete</button></td></tr>`).join('')}</tbody></table>` : '<p class="help">None yet.</p>'}
      </div>
    </div>`;
  }

  // ---------- Event search ----------
  const TYPE_NAMES = { 0: 'Regional', 1: 'District', 2: 'District Champs', 3: 'Champs division', 4: 'Einstein', 5: 'DCMP division', 6: 'Festival', 99: 'Offseason' };

  function evSearchYear() {
    if (S.evYear) return S.evYear;
    const d = new Date();
    return d.getMonth() >= 0 && d.getMonth() < 1 ? d.getFullYear() - 1 : d.getFullYear(); // January: last season still most useful
  }

  function catalogue(year) { return (Store.loadCatalogue && Store.loadCatalogue(year)) || null; }

  async function ensureCatalogue(year, force) {
    const have = catalogue(year);
    const fresh = have && have.team === S.settings.ourTeam && Date.now() - have.fetched < 6 * 3600 * 1000;
    if ((fresh && !force) || !S.settings.tbaKey || !navigator.onLine) return have;
    if (S.catLoading) return S.catLoading;
    S.catLoading = (async () => { try {
      const events = await TBA.listEvents(year, S.settings.tbaKey);
      let ours = [];
      if (S.settings.ourTeam) ours = await TBA.teamEventKeys(tkey(S.settings.ourTeam), year, S.settings.tbaKey).catch(() => []);
      const c = { year, fetched: Date.now(), events, ours, team: S.settings.ourTeam };
      Store.saveCatalogue(year, c);
      S.evError = null;
      return c;
    } catch (e) { S.evError = e.message; return have; } finally { S.catLoading = null; } })();
    return S.catLoading;
  }

  function eventResultsHtml() {
    const year = evSearchYear();
    const c = catalogue(year);
    if (!S.settings.tbaKey) return '<p class="help">Paste your TBA key above to search events.</p>';
    if (!c) return `<p class="help">${navigator.onLine ? 'Loading the ' + year + ' event list…' : 'Connect to the internet once to load the event list.'}${S.evError ? ' <span class="neg">' + esc(S.evError) + '</span>' : ''}</p>`;
    const q = (S.evQuery || '').trim().toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    const ours = new Set(c.ours || []);
    const today = new Date().toISOString().slice(0, 10);
    let list = c.events.filter(e => {
      const hay = `${e.name} ${e.city} ${e.state} ${e.country} ${e.key} ${e.code} ${TYPE_NAMES[e.type] || ''}`.toLowerCase();
      return words.every(w => hay.includes(w));
    });
    // Our team's events first, then whatever is happening soonest / most recently.
    const dist = e => Math.abs(Date.parse(e.start) - Date.parse(today));
    list.sort((a, b) => (ours.has(b.key) - ours.has(a.key)) || dist(a) - dist(b));
    const shown = list.slice(0, q ? 15 : 8);
    if (!shown.length) return `<p class="help">No ${year} events match “${esc(q)}”.</p>`;
    const fmtD = d => (d ? new Date(d + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');
    return `<p class="help">${q ? `${list.length} match${list.length === 1 ? '' : 'es'}` : (ours.size ? 'Your team\'s events first, then the nearest dates' : 'Nearest dates first')} — type to search ${c.events.length} ${year} events.</p>
      <table class="wrap"><tbody>${shown.map(e => `<tr>
        <td><b>${esc(e.name)}</b>${ours.has(e.key) ? ' <span class="pill good">our team</span>' : ''}<br><span class="sd">${esc([e.city, e.state, e.country].filter(Boolean).join(', '))} · ${fmtD(e.start)}–${fmtD(e.end)} · ${esc(TYPE_NAMES[e.type] || 'Event')} · ${esc(e.key)}</span></td>
        <td style="text-align:right"><button class="btn small primary" data-act="tba-import" data-key="${esc(e.key)}">Download</button></td></tr>`).join('')}</tbody></table>`;
  }

  function refreshEventResults() { const el = $('#evResults'); if (el) el.innerHTML = eventResultsHtml(); }

  async function loadCatalogueAndShow(force) {
    await ensureCatalogue(evSearchYear(), force);
    refreshEventResults();
  }

  // ---------- Trends ----------
  // Within the event: Model.trendWithin (residual slope, reported only beyond match noise).
  // Across the season: its rating at each earlier event vs. now (display only: weighting
  // recent events more did not improve predictions in the 2026 backtest).
  function trendOf(k) {
    S.trendCache = S.trendCache || {};
    if (S.trendCache[k]) return S.trendCache[k];
    const R = S.R, ev = S.event;
    const out = { within: Model.trendWithin(ev, R, k), season: null };
    const info = ev.priorEventInfo || {};
    const hist = ((ev.teamPriorEvents || {})[k] || []).map(e => ({ key: e, name: (info[e] || {}).name || e, start: (info[e] || {}).start || '', v: ev.priorEvents && ev.priorEvents[e] && ev.priorEvents[e].ratings[k] && ev.priorEvents[e].ratings[k].total }))
      .filter(h => h.v != null).sort((a, b) => (a.start < b.start ? -1 : 1));
    if (hist.length) {
      const now = R.comps.total.mean[R.idx[k]];
      const before = hist.reduce((a, h) => a + h.v, 0) / hist.length;
      const ch = before > 0 ? (now - before) / before : 0;
      out.season = { hist, now, before, change: ch, label: ch > 0.12 ? 'rising' : ch < -0.12 ? 'falling' : 'steady' };
    }
    return (S.trendCache[k] = out);
  }
  function trendArrow(k) {
    const t = trendOf(k).within;
    if (!t) return '<span class="sd" title="Needs 5+ clean matches">·</span>';
    const sym = { improving: '↑', slipping: '↓', steady: '→' }[t.label];
    return `<span class="${t.label === 'improving' ? 'pos' : t.label === 'slipping' ? 'neg' : 'sd'}" title="${t.label} at this event: about ${sgn(t.delta, 0)} pts per alliance from first to latest match">${sym}</span>`;
  }
  function trendText(k) {
    const t = trendOf(k), parts = [];
    if (t.within) parts.push(`At this event: <b>${t.within.label}</b> (about ${sgn(t.within.delta, 0)} pts per alliance from first to latest match, over ${t.within.n} clean matches${t.within.label === 'steady' ? '; within normal match-to-match noise' : ''}).`);
    if (t.season) parts.push(`This season: ${t.season.hist.map(h => `${esc(h.name)} ${f1(h.v, 0)}`).join(' → ')} → now ${f1(t.season.now, 0)} (<b>${t.season.label}</b>; earlier events can score differently, so treat this as a rough guide).`);
    return parts.join(' ');
  }

  // ---------- Printable reports ----------
  // Rendered into #print and sent to the system print dialog (or "Save as PDF").
  function printHtml(html) {
    const el = $('#print');
    el.innerHTML = html;
    document.body.classList.add('printing');
    const done = () => { document.body.classList.remove('printing'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    setTimeout(() => window.print(), 50);
  }

  function reportHead(title, sub) {
    const ev = S.event;
    return `<div class="rp-head"><div><div class="rp-title">${title}</div><div class="rp-sub">${sub || ''}</div></div>
      <div class="rp-meta">${esc(ev.year + ' ' + (ev.name || ev.key))}<br>${new Date().toLocaleString()}<br>TRU POWER</div></div>`;
  }

  function teamReportHtml(k) {
    const r = teamRow(k), R = S.R, i = R.idx[k], g = S.game, ev = S.event, L = S.luck[k] || {};
    const comps = g.comps.filter(c => !c.hidden && R.comps[c.key].available).map(c => {
      const C = R.comps[c.key];
      const vals = R.teams.map((_, j) => C.mean[j]).sort((a, b) => (c.lowerBetter ? a - b : b - a));
      return `<tr><td>${c.label}</td><td class="n"><b>${f1(C.mean[i])}</b></td><td class="n">${range(C.mean[i], Math.sqrt(C.var[i]))}</td><td class="n">${vals.indexOf(C.mean[i]) + 1}/${R.teams.length}</td></tr>`;
    }).join('');
    const rel = reliability(k);
    const ms = ev.matches.filter(m => m.red.includes(k) || m.blue.includes(k)).map(m => {
      const onRed = m.red.includes(k), p = Model.predictMatch(R, m.red, m.blue);
      const partners = (onRed ? m.red : m.blue).filter(t => t !== k).map(tnum).join(' ');
      const opps = (onRed ? m.blue : m.red).map(tnum).join(' ');
      let res = `win ${pct(onRed ? p.pRed : 1 - p.pRed)}`;
      if (Model.isPlayed(m)) {
        const mine = onRed ? m.r : m.b, th = onRed ? m.b : m.r, w = Model.winnerOf(m);
        res = `${w === 't' ? 'T' : (w === 'r') === onRed ? 'W' : 'L'} ${mine.score}–${th.score}`;
      }
      const iss = Model.robotIssue(m, k);
      return `<tr><td>${matchLabel(m)}</td><td>${onRed ? 'Red' : 'Blue'}</td><td>${partners}</td><td>${opps}</td><td class="nw">${res}</td><td>${iss ? esc(issueText(iss)) : ''}</td></tr>`;
    }).join('');
    const sc = r.scout, scCols = (ev.scouting && ev.scouting.columns) || [];
    return `<div class="rp">${reportHead(`Team ${esc(tnum(k))} · ${esc(r.name)}`, 'Team report')}
      <div class="rp-stats">
        <div><b>${f1(r.tp)}</b><span>True Potential (pts/match)<br>likely ${range(r.tp, r.tpSd)} · ${sureOf(r.tpSd) || ''} confidence</span></div>
        <div><b>${r.rank ? '#' + r.rank : '–'}</b><span>Rank${r.rs != null ? ' · RS ' + f1(r.rs, 2) + ' · ' + r.rec : ''}</span></div>
        <div><b>#${r.trueRank || '–'}</b><span>True rank (neutral schedule)</span></div>
        <div><b>${sgn(r.luck)}</b><span>Schedule luck, RP/match<br>luck-adj. RS ${f1(r.adjRS, 2)}</span></div>
        <div><b>${r.relQ == null ? '—' : pct(1 - r.relQ)}</b><span>Reliability (clean matches)<br>problems ${rel.list.length}/${rel.played}</span></div>
        <div><b>${r.p8 != null ? pct(r.p8) : '…'}</b><span>Chance of top 8<br>proj. rank ${f1(r.expRank, 1)}</span></div>
      </div>
      <p>${r.defense != null ? 'Defense: ' + sgn(r.defense, 1) + ' opponent pts/match · ' : ''}Pick score ${f1(r.pickScore)} · Scouts: ${esc(tagsText(r.tags)) || '—'}</p>
      <div class="rp-cols">
        <div><h4>Ratings</h4><table><thead><tr><th></th><th class="n">Value</th><th class="n">Likely range</th><th class="n">Rank</th></tr></thead><tbody>${comps}</tbody></table>
          ${trendText(k) ? `<h4>Trend</h4><p>${trendText(k)}</p>` : ''}
          ${sc && sc.n ? `<h4>Scouting (${sc.n} entries)</h4><table><tbody>${scCols.filter(c => sc[c] != null).map(c => `<tr><td>${esc(c)}</td><td class="n">${f1(sc[c])}</td></tr>`).join('')}</tbody></table>` : ''}
          ${teamPathsHtml(k, true)}
          <h4>Notes</h4><div class="rp-notes">${esc((ev.notes || {})[k] || '') || '&nbsp;'}</div></div>
        <div><h4>Matches</h4><table><thead><tr><th>Match</th><th></th><th>Partners</th><th>Opponents</th><th>Result</th><th>Problem</th></tr></thead><tbody>${ms}</tbody></table></div>
      </div></div>`;
  }

  // Strategy sheet: both alliances robot by robot, plus what it takes to earn each bonus RP.
  function matchSheetHtml(m) {
    const R = S.R, g = S.game, ev = S.event, p = Model.predictMatch(R, m.red, m.blue);
    const thr = R.thr || {};
    const side = (teams, color, pred, pWin) => {
      const rows = teams.map(t => {
        const r = teamRow(t);
        const note = ((ev.notes || {})[t] || '').slice(0, 60);
        return `<tr><td><b>${esc(tnum(t))}</b> ${esc(r.name).slice(0, 18)}</td><td class="n">${f1(r.tp)}</td><td class="n">${f1(r.auto)}</td><td class="n">${f1(r.fuel)}</td><td class="n">${f1(r.tower)}</td>${S.R.defense ? `<td class="n">${sgn(r.defense, 0)}</td>` : ''}<td class="n">${r.relQ == null ? '—' : pct(1 - r.relQ)}</td><td class="n">${trendArrow(t)}</td><td>${esc([tagsText(r.tags), note].filter(Boolean).join(' · '))}</td></tr>`;
      }).join('');
      const bonus = g.bonuses.map(b => {
        const d = Model.allianceDist(R, teams, b.comp);
        const need = thr[b.key] != null ? thr[b.key] - d.mu : null;
        const what = { fuel: 'fuel', tower: 'tower pts', autoFuel: 'auto fuel' }[b.comp] || b.comp;
        return `<li><b>${b.label}</b> ${pct(pred.bonus[b.key])} — expect ${f1(d.mu, 0)} ${what} (need ${thr[b.key]})${need != null && need > 0 ? `: <b>${f1(need, 0)} short</b>` : ': on track'}</li>`;
      }).join('');
      const sd = Model.allianceDist(R, teams, 'total').sd;
      return `<div class="rp-side ${color}"><h4>${color === 'red' ? 'Red' : 'Blue'} alliance — win ${pct(pWin)}, score ${f1(pred.score, 0)} (likely ${range(pred.score, sd, Z_SCORE)}), exp. RP ${f1(pred.expRP, 2)}</h4>
        <table><thead><tr><th>Team</th><th class="n">TP</th><th class="n">Auto</th><th class="n">Fuel</th><th class="n">Tower</th>${S.R.defense ? '<th class="n">Def</th>' : ''}<th class="n">Reliab.</th><th class="n">Trend</th><th>Scouts / notes</th></tr></thead><tbody>${rows}</tbody></table>
        ${bonus ? `<ul>${bonus}</ul>` : ''}</div>`;
    };
    return `<div class="rp">${reportHead(`${matchLabel(m)} strategy sheet`, Model.isPlayed(m) ? `Played: ${m.r.score}–${m.b.score}` : 'Upcoming match')}
      ${side(m.red, 'red', p.red, p.pRed)}${side(m.blue, 'blue', p.blue, 1 - p.pRed)}
      <h4>Plan</h4><div class="rp-notes tall">&nbsp;</div></div>`;
  }

  function pickListHtml() {
    const ot = S.settings.ourTeam && tkey(S.settings.ourTeam);
    const rows = S.R.teams.filter(k => k !== ot).map(teamRow).filter(r => r.tp != null && !r.picked).sort((a, b) => b.pickScore - a.pickScore);
    return `<div class="rp">${reportHead('Pick list', 'Ranked by pick score: True Potential × reliability − fouls given away')}
      <table class="rp-list"><thead><tr><th>#</th><th>Team</th><th class="n">Pick score</th><th class="n">TP (likely)</th><th class="n">Reliab.</th><th class="n">Auto</th><th class="n">Fuel</th><th class="n">Tower</th>${S.R.defense ? '<th class="n">Def</th>' : ''}<th class="n">Rank</th><th class="n">Trend</th><th>Scouts / notes</th><th>✓</th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr><td>${i + 1}</td><td><b>${esc(tnum(r.key))}</b> ${esc(r.name).slice(0, 20)}</td><td class="n"><b>${f1(r.pickScore)}</b></td><td class="n">${f1(r.tp)} <span>(${range(r.tp, r.tpSd)})</span></td><td class="n">${r.relQ == null ? '—' : pct(1 - r.relQ)}</td><td class="n">${f1(r.auto)}</td><td class="n">${f1(r.fuel)}</td><td class="n">${f1(r.tower)}</td>${S.R.defense ? `<td class="n">${sgn(r.defense, 0)}</td>` : ''}<td class="n">${r.rank || '–'}</td><td class="n">${trendArrow(r.key)}</td><td>${esc([tagsText(r.tags), ((S.event.notes || {})[r.key] || '').slice(0, 40)].filter(Boolean).join(' · '))}</td><td class="box"></td></tr>`).join('')}
      </tbody></table></div>`;
  }

  // ---------- Team detail ----------
  function openTeam(k) {
    if (!S.R || S.R.idx[k] === undefined) return;
    const r = teamRow(k), R = S.R, i = R.idx[k], g = S.game, ev = S.event;
    const L = S.luck[k];
    const compRows = g.comps.filter(c => !c.hidden && R.comps[c.key].available).map(c => {
      const C = R.comps[c.key];
      const vals = R.teams.map((_, j) => C.mean[j]).sort((a, b) => (c.lowerBetter ? a - b : b - a));
      const rank = vals.indexOf(C.mean[i]) + 1;
      const pri = ev.priors && ev.priors[k] && ev.priors[k][c.key];
      return `<tr><td>${c.label}</td><td class="n"><b>${f1(C.mean[i])}</b> <span class="sd">±${f1(Math.sqrt(C.var[i]))}</span></td><td class="n">${rank}/${R.teams.length}</td><td class="n sd">${pri != null ? f1(pri) : '—'}</td><td class="n sd">${f1(C.nObs[i], 1)}</td></tr>`;
    }).join('');
    const ms = ev.matches.filter(m => m.red.includes(k) || m.blue.includes(k));
    const matchRows = ms.map(m => {
      const onRed = m.red.includes(k);
      const p = Model.predictMatch(R, m.red, m.blue);
      const pw = onRed ? p.pRed : 1 - p.pRed;
      const partners = (onRed ? m.red : m.blue).filter(t => t !== k);
      const opps = onRed ? m.blue : m.red;
      let res = '';
      if (Model.isPlayed(m)) {
        const mine = onRed ? m.r : m.b, theirs = onRed ? m.b : m.r;
        const w = Model.winnerOf(m);
        const won = (w === 'r') === onRed && w !== 't';
        res = `<span class="pill ${w === 't' ? 'muted' : won ? 'good' : 'bad'}">${w === 't' ? 'T' : won ? 'W' : 'L'}</span> ${mine.score}–${theirs.score}`;
        if (m.comp === 'qm') res += ` <span class="sd">${Model.allianceRP(m, onRed ? 'r' : 'b', g, ev.level, R.thr)} RP</span>`;
        const side = onRed ? m.r : m.b;
        const pos = (onRed ? m.red : m.blue).indexOf(k);
        if (side.robots && side.robots[pos]) {
          const rb = side.robots[pos];
          const lv = [rb.autoLevel === 'Level1' ? 'auto L1' : '', rb.endLevel !== 'None' ? rb.endLevel.replace('Level', 'L') : ''].filter(Boolean).join(' + ');
          res += ` <span class="sd">tower: ${lv || 'none'}</span>`;
        }
      }
      const surr = ((onRed ? m.redSurr : m.blueSurr) || []).includes(k);
      const iss = Model.robotIssue(m, k);
      return `<tr><td><a data-match="${esc(m.key)}">${matchLabel(m)}</a>${surr ? ' <span class="pill muted">surrogate</span>' : ''}${iss ? ` <span class="pill bad" title="${esc(iss.note || '')}">${esc(issueText(iss))}</span>` : ''}</td>
        <td class="${onRed ? 'red-t' : 'blue-t'}">${onRed ? 'Red' : 'Blue'}</td><td>${partners.map(t => teamLink(t)).join(' ')}</td><td>${opps.map(t => teamLink(t)).join(' ')}</td>
        <td class="n">${pct(pw)}</td><td>${res}</td></tr>`;
    }).join('');
    const sc = r.scout;
    const scCols = (ev.scouting && ev.scouting.columns) || [];
    openModal(`<h2>${teamLink(k)} ${esc(r.name)} <a data-star="${k}" style="font-size:20px">${r.starred ? '★' : '☆'}</a>
        <button class="btn small" data-act="print-team" data-key="${esc(k)}" style="margin-left:10px">Print report</button></h2>
      <div class="stats" style="margin-bottom:14px">
        ${statCard('True Potential', f1(r.tp), 'likely ' + range(r.tp, r.tpSd) + ' · ' + (sureOf(r.tpSd) || '') + ' confidence')}
        ${statCard('Rank', r.rank ? '#' + r.rank : '–', r.rs != null ? 'RS ' + f1(r.rs, 2) + ' · ' + r.rec : '')}
        ${statCard('True rank', '#' + r.trueRank)}
        ${statCard('Luck-adj. RS', f1(r.adjRS, 2))}
        ${statCard('Schedule luck', `<span class="${cls(r.luck)}">${sgn(r.luck)}</span>`, `ease ${f1(r.easePct, 0)}%ile`)}
        ${statCard('Proj. rank', f1(r.expRank, 1), r.sim ? `P(top 8) ${pct(r.p8)}` : '')}
      </div>
      <div class="split">
        <div><h3>Ratings</h3><table><thead><tr><th></th><th class="n">Now</th><th class="n">Rank</th><th class="n" title="Average of earlier events">Prior</th><th class="n" title="Matches of data at this event">Data</th></tr></thead><tbody>${compRows}</tbody></table>
          <p class="help">${ev.priorMeta && ev.priorMeta.count && ev.priorMeta.count[k] ? `Prior from ${ev.priorMeta.count[k]} earlier event(s).` : 'No earlier-event data — starts near event average.'} Plain OPR: ${f1(r.opr)}.</p>
          ${r.defense != null ? `<p class="help">Defense: opponents score about <b>${sgn(r.defense, 1)}</b> pts below prediction when this team plays against them (rank ${S.R.teams.map(t => S.R.defense[S.R.idx[t]]).sort((x, y) => y - x).indexOf(r.defense) + 1}/${S.R.teams.length}). Small values are normal; scores show defense only weakly.</p>` : ''}
          <h3 style="margin-top:12px">Scout ratings</h3>
          <div class="toolbar">${scoutTagControls(k, r.tags)}</div>
          ${trendText(k) ? `<p class="help">${trendText(k)}</p>` : ''}
          ${(() => { const rel = reliability(k); if (!rel.played) return ''; if (!rel.list.length) return `<p class="help">Reliability: no problems recorded in ${rel.played} matches.</p>`;
            return `<p class="help"><b class="neg">Reliability: problems in ${rel.list.length} of ${rel.played} matches</b> — ${rel.list.map(x => `${matchLabel(x.m)} ${esc(issueText(x.iss))}${x.iss.note ? ' (' + esc(x.iss.note) + ')' : ''}`).join('; ')}. Those matches are left out of its rating.</p>`; })()}
          ${L ? `<p class="help">Schedule: partners vs. opponents ${sgn(L.tailwind, 1)} pts/match vs. average. Expected RS on this schedule ${f1(L.eSched, 2)} vs. ${f1(L.eRand, 2)} on a random one.</p>` : ''}
          ${sc && sc.n ? `<h3>Scouting (${sc.n} entries)</h3><table><tbody>${scCols.filter(c => sc[c] != null).map(c => `<tr><td>${esc(c)}</td><td class="n">${f1(sc[c])}</td></tr>`).join('')}</tbody></table>` : ''}
          ${teamPathsHtml(k)}
          <h3 style="margin-top:12px">Notes</h3><textarea id="teamNotes" data-team-notes="${k}" rows="4" placeholder="Drive team notes, mechanisms, reliability…">${esc((ev.notes || {})[k] || '')}</textarea>
        </div>
        <div><h3>Matches</h3><table><thead><tr><th>Match</th><th></th><th>Partners</th><th>Opponents</th><th class="n">Win %</th><th>Result</th></tr></thead><tbody>${matchRows}</tbody></table></div>
      </div>`);
  }

  // ---------- Scout ratings (what scores can't show) ----------
  const TAGS = {
    drive: { label: 'Driving', opts: [['', '–'], ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5']] },
    defense: { label: 'Defense role', opts: [['', '–'], ['none', 'None'], ['some', 'Some'], ['strong', 'Strong']] },
    condition: { label: 'Condition', opts: [['', '–'], ['good', 'Good'], ['fair', 'Fair'], ['poor', 'Poor']] },
  };
  function scoutTagControls(k, tags) {
    return Object.entries(TAGS).map(([key, d]) => `<label>${d.label} <select data-tag="${key}" data-team-tag="${esc(k)}">${d.opts.map(([v, txt]) => `<option value="${v}" ${(tags[key] || '') === v ? 'selected' : ''}>${txt}</option>`).join('')}</select></label>`).join(' ');
  }
  function tagsHtml(tags) {
    const out = [];
    if (tags.drive) out.push(`<span class="pill ${+tags.drive >= 4 ? 'good' : +tags.drive <= 2 ? 'bad' : 'muted'}" title="Driving (scouts)">drive ${esc(tags.drive)}</span>`);
    if (tags.defense && tags.defense !== 'none') out.push(`<span class="pill ${tags.defense === 'strong' ? 'good' : 'muted'}" title="Defense role (scouts)">def ${esc(tags.defense)}</span>`);
    if (tags.condition) out.push(`<span class="pill ${tags.condition === 'good' ? 'good' : tags.condition === 'poor' ? 'bad' : 'muted'}" title="Robot condition (scouts)">${esc(tags.condition)}</span>`);
    return out.join(' ');
  }
  const tagsText = tags => [tags.drive ? 'drive ' + tags.drive : '', tags.defense && tags.defense !== 'none' ? 'def ' + tags.defense : '', tags.condition || ''].filter(Boolean).join(', ');

  // ---------- Scouted per-robot fuel (match editor) ----------
  const SCOUT_FUEL = 'Fuel (scouted)';
  const SCOUT_AUTO = 'Auto fuel (scouted)';
  const SCOUT_DEF = 'Defense played (0-2)';

  // ---------- Scout mode ----------
  // One scout watches one robot (their seat: Red 1–3 / Blue 1–3) and counts its fuel.
  const SEATS = [['r', 0, 'Red 1'], ['r', 1, 'Red 2'], ['r', 2, 'Red 3'], ['b', 0, 'Blue 1'], ['b', 1, 'Blue 2'], ['b', 2, 'Blue 3']];
  function scoutState() {
    S.sc = S.sc || { auto: 0, tele: 0, counted: true, status: 'ok', when: 'teleop', what: 'drivetrain', def: 0, note: '', paths: [], markers: [], hist: [], tool: 'draw', linkFrom: null };
    return S.sc;
  }
  function scoutRow(matchKey, team) {
    const sc = S.event.scouting;
    return sc && sc.rows ? sc.rows.find(r => r.match === matchKey && r.team === team && r.at && (r.scout || '') === (S.settings.scoutName || '')) : null;
  }
  function scoutMatches() { return S.event.matches.filter(m => m.comp === 'qm' && m.red.length && m.blue.length); }
  function seatTeam(m, seat) { const [side, k] = (SEATS.find(x => x[2] === seat) || SEATS[0]); return (side === 'r' ? m.red : m.blue)[k]; }
  function currentScoutMatch() {
    const ms = scoutMatches();
    const seat = S.settings.scoutSeat || 'Red 1';
    let m = ms.find(x => x.key === S.scoutMatch);
    if (!m) m = ms.find(x => !scoutRow(x.key, seatTeam(x, seat))) || ms[ms.length - 1];
    S.scoutMatch = m && m.key;
    return m;
  }
  function loadScoutFor(m) {
    const st = scoutState();
    const t = m && seatTeam(m, S.settings.scoutSeat || 'Red 1');
    const row = m && t ? scoutRow(m.key, t) : null;
    const iss = m && t ? Model.robotIssue(m, t) : null;
    Object.assign(st, { counted: !row || row.values[SCOUT_FUEL] != null,
      auto: row ? row.values[SCOUT_AUTO] || 0 : 0, tele: row && row.values[SCOUT_FUEL] != null ? row.values[SCOUT_FUEL] - (row.values[SCOUT_AUTO] || 0) : 0,
      def: row ? row.values[SCOUT_DEF] || 0 : 0, note: row ? row.note || '' : '',
      status: iss ? iss.type : 'ok', when: (iss && iss.when) || 'teleop', what: (iss && iss.what) || 'drivetrain', loadedFor: m && m.key + '|' + t,
      paths: Paths.strokesOf(row), markers: row && row.markers ? row.markers.map(k => Object.assign({ p: 0 }, k)) : [], hist: [], tool: 'draw', linkFrom: null });
  }
  function bumpCount(which, d) {
    const st = scoutState();
    st[which] = Math.max(0, st[which] + d);
    const el = document.querySelector(`[data-count="${which}"]`);
    if (el) el.textContent = st[which];
    const tot = document.querySelector('#scoutTotal');
    if (tot) tot.textContent = st.auto + st.tele;
  }
  function saveScout() {
    const m = currentScoutMatch(), st = scoutState();
    if (!m) return;
    const t = seatTeam(m, S.settings.scoutSeat || 'Red 1');
    const ev = S.event;
    const sc = ev.scouting = ev.scouting || { columns: [], rows: [], map: {}, show: {} };
    const who = S.settings.scoutName || '';
    sc.rows = sc.rows.filter(r => !(r.match === m.key && r.team === t && (r.scout || '') === who && r.at));
    // Only record fuel if the scout says they counted it: an uncounted 0 would read as "scored nothing".
    const values = st.counted ? { [SCOUT_FUEL]: st.auto + st.tele, [SCOUT_AUTO]: st.auto, [SCOUT_DEF]: st.def } : { [SCOUT_DEF]: st.def };
    sc.rows.push({ team: t, match: m.key, scout: who, at: Date.now(), note: st.note, values,
      paths: st.paths.length ? st.paths : undefined, markers: st.paths.length && st.markers.length ? st.markers : undefined });
    for (const c of [SCOUT_FUEL, SCOUT_AUTO, SCOUT_DEF]) if (!sc.columns.includes(c)) sc.columns.push(c);
    sc.map[SCOUT_FUEL] = 'fuel'; sc.map[SCOUT_AUTO] = 'autoFuel';
    m.issues = m.issues || {};
    if (st.status === 'ok') delete m.issues[t];
    else m.issues[t] = st.status === 'noshow' ? { type: 'noshow' } : { type: 'broke', when: st.when, what: st.what, note: st.note };
    if (!Object.keys(m.issues).length) delete m.issues;
    m.updated = Date.now();
    if (st.note) { ev.notes = ev.notes || {}; const line = `${matchLabel(m)}: ${st.note}`; if (!(ev.notes[t] || '').includes(line)) ev.notes[t] = [ev.notes[t], line].filter(Boolean).join('\n'); }
    persist();
    // Next match for this seat.
    const ms = scoutMatches(), i = ms.indexOf(m);
    S.scoutMatch = ms[Math.min(ms.length - 1, i + 1)].key;
    S.sc = null;
    recompute();
    toast(`Saved ${tnum(t)} in ${matchLabel(m)} — ${st.counted ? (st.auto + st.tele) + ' fuel' : 'fuel not counted'}. Now ${matchLabel(ms[Math.min(ms.length - 1, i + 1)])}.`);
  }

  // Scouting quality: compare the sum of scouted robots on an alliance with the official
  // fuel count. Only alliances where all three robots were scouted can be checked.
  function scoutQuality() {
    const sc = S.event.scouting;
    const rows = sc && sc.rows ? sc.rows.filter(r => r.values[SCOUT_FUEL] != null) : [];
    let robots = 0;
    const checks = [], perScout = {};
    for (const m of S.event.matches) {
      if (m.comp !== 'qm' || !Model.isPlayed(m)) continue;
      for (const [teams, v, side] of [[m.red, m.r, 'Red'], [m.blue, m.b, 'Blue']]) {
        robots += teams.length;
        if (v.fuel == null) continue;
        const got = teams.map(t => rows.filter(r => r.match === m.key && r.team === t));
        if (got.some(g => !g.length)) continue;
        const sum = got.reduce((a, g) => a + g.reduce((x, r) => x + r.values[SCOUT_FUEL], 0) / g.length, 0);
        const err = v.fuel ? (sum - v.fuel) / v.fuel : 0;
        checks.push({ m, side, sum, official: v.fuel, err });
        got.flat().forEach(r => { const p = perScout[r.scout || 'unnamed'] = perScout[r.scout || 'unnamed'] || []; p.push(err); });
      }
    }
    const scouted = new Set(rows.map(r => r.match + '|' + r.team)).size;
    return { robots, scouted, checks, perScout };
  }

  function renderScout() {
    const ms = scoutMatches();
    if (!ms.length) return '<div class="empty"><h2>No schedule yet</h2><p>Scout mode needs the qualification schedule (Data tab, or paste it on the Matches tab).</p></div>';
    const seat = S.settings.scoutSeat || 'Red 1';
    const m = currentScoutMatch();
    const t = seatTeam(m, seat);
    const st = scoutState();
    if (st.loadedFor !== m.key + '|' + t) loadScoutFor(m);
    const r = S.R.idx[t] !== undefined ? teamRow(t) : null;
    const done = scoutRow(m.key, t);
    const q = scoutQuality();
    const mae = q.checks.length ? q.checks.reduce((a, c) => a + Math.abs(c.err), 0) / q.checks.length : null;
    const worst = q.checks.slice().sort((a, b) => Math.abs(b.err) - Math.abs(a.err)).filter(c => Math.abs(c.err) > 0.2).slice(0, 6);
    const counter = (key, label, keys) => `<div class="counter"><div class="ts-label">${label} <span class="kbd">${keys}</span></div>
      <div class="ctrl"><button class="btn big" data-bump="${key}:-1">−1</button><span class="count" data-count="${key}">${st[key]}</span><button class="btn big primary" data-bump="${key}:1">+1</button><button class="btn big" data-bump="${key}:5">+5</button></div></div>`;
    const opt = (list, cur) => list.map(([v, txt]) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${txt}</option>`).join('');
    return `<div class="toolbar">
        <label>Scout <input id="scoutName" value="${esc(S.settings.scoutName || '')}" placeholder="your name" style="width:140px"></label>
        <label>Seat <select id="scoutSeat">${SEATS.map(x => `<option ${x[2] === seat ? 'selected' : ''}>${x[2]}</option>`).join('')}</select></label>
        <label>Match <select id="scoutMatch">${ms.map(x => `<option value="${esc(x.key)}" ${x.key === m.key ? 'selected' : ''}>${matchLabel(x)}${scoutRow(x.key, seatTeam(x, seat)) ? ' ✓' : ''}</option>`).join('')}</select></label>
        <span class="spacer"></span><span class="help">Keys: A/Z auto ±1 · S/X teleop ±1 · Enter save</span>
      </div>
      <div class="grid cols-2">
        <div class="card scout-card ${seat.startsWith('Red') ? 'red' : 'blue'}">
          <div class="scout-team"><span class="sd">${matchLabel(m)} · ${esc(seat)}</span><div class="big-team">${esc(tnum(t))}</div><div class="sd">${esc(r ? r.name : '')}${done ? ' · <b class="pos">already scouted — saving replaces it</b>' : ''}</div></div>
          ${counter('auto', 'Auto fuel', 'A / Z')}
          ${counter('tele', 'Teleop fuel', 'S / X')}
          <div class="ts-label" style="margin-top:6px">Total fuel: <b id="scoutTotal">${st.auto + st.tele}</b>
            <label style="margin-left:14px" title="Untick if you didn't count this robot's fuel (e.g. only traced its path). Nothing is recorded instead of a misleading 0."><input type="checkbox" id="scCounted" ${st.counted ? 'checked' : ''}> Fuel counted</label></div>
          <div class="toolbar" style="margin-top:10px">
            <label>Robot <select id="scStatus">${opt([['ok', 'OK'], ['broke', 'Broke'], ['noshow', 'No-show']], st.status)}</select></label>
            <span id="scBroke" ${st.status === 'broke' ? '' : 'hidden'}><label>When <select id="scWhen">${opt(PROBLEM_WHEN, st.when)}</select></label> <label>What <select id="scWhat">${opt(PROBLEM_WHAT, st.what)}</select></label></span>
            <label>Played defense <select id="scDef">${opt([['0', 'No'], ['1', 'Some'], ['2', 'Most of match']], String(st.def))}</select></label>
          </div>
          <input id="scNote" value="${esc(st.note)}" placeholder="Note (optional): what you noticed" style="width:100%;margin-top:6px">
          <p class="toolbar" style="margin-top:12px"><button class="btn primary big" data-act="scout-save">Save &amp; next ▸</button></p>
        </div>
        <div class="card"><h3>Scouting quality</h3>
          <div class="stats">
            ${statCard('Robots scouted', `${q.scouted}`, `of ${q.robots} played`)}
            ${statCard('Alliances checkable', q.checks.length, 'all 3 robots scouted')}
            ${statCard('Typical miss', mae == null ? '—' : pct(mae, 0), 'scouted vs official fuel')}
          </div>
          <p class="help">Each check adds up the three scouted robots and compares with the official alliance fuel count. Within about 10–15% is good counting. A scout who is consistently high or low should adjust.</p>
          ${q.checks.length ? '' : '<p class="help"><b>No checks yet.</b> They need all three robots on an alliance scouted and the official fuel count, which arrives from TBA when online (or type it into the match editor).</p>'}
          <p class="help"><b>No internet needed.</b> Each scout saves on their own laptop. At a break, use Data → Export and carry the file to the main laptop on a USB stick, then Import there (merging never double-counts).</p>
          ${Object.keys(q.perScout).length ? `<table><thead><tr><th>Scout</th><th class="n">Checks</th><th class="n">Typical over/under</th></tr></thead><tbody>${Object.entries(q.perScout).map(([n, errs]) => `<tr><td>${esc(n)}</td><td class="n">${errs.length}</td><td class="n ${Math.abs(errs.reduce((a, b) => a + b, 0) / errs.length) > 0.1 ? 'neg' : ''}">${sgn(100 * errs.reduce((a, b) => a + b, 0) / errs.length, 0)}%</td></tr>`).join('')}</tbody></table>` : ''}
          ${worst.length ? `<h3 style="margin-top:12px">Worth a recheck</h3><table><tbody>${worst.map(c => `<tr><td><a data-match="${esc(c.m.key)}">${matchLabel(c.m)}</a> ${c.side}</td><td class="n">scouted ${f1(c.sum, 0)}</td><td class="n">official ${c.official}</td><td class="n neg">${sgn(100 * c.err, 0)}%</td></tr>`).join('')}</tbody></table>` : ''}
        </div>
      </div>
      <div class="card path-card" style="margin-top:14px"><h3>Robot path · ${esc(tnum(t))} in ${matchLabel(m)}${st.paths.length > 1 ? ` · ${st.paths.length} pieces` : ''}</h3>
        <div class="toolbar">
          <div class="seg" role="group" aria-label="Path tool">
            <button class="${st.tool === 'draw' ? 'on' : ''}" data-ptool="draw" title="Drag to trace. Lift and drag again to add another piece; a piece that starts where the last one ended continues it.">Trace</button>
            <button class="${st.tool === 'mark' ? 'on' : ''}" data-ptool="mark" title="Click on a line to add a marker">Add marker</button>
            <button class="${st.tool === 'link' ? 'on' : ''}" data-ptool="link" title="Click the end of one piece, then the start of another, to join them">Link ends</button>
            <button class="${st.tool === 'erase' ? 'on' : ''}" data-ptool="erase" title="Click a piece to remove it (and its markers)">Erase piece</button>
          </div>
          <button class="btn small" data-act="path-undo" ${st.hist.length ? '' : 'disabled'}>Undo</button>
          <button class="btn small danger" data-act="path-clear" ${st.paths.length ? '' : 'disabled'}>Clear all</button>

        </div>
        <p class="help path-help">${{ draw: 'Drag to trace. Lifted too early? Start the next drag near where the line stopped and it continues.', mark: 'Click on a line: the marker snaps onto it and points along the direction of travel.', link: st.linkFrom ? 'Now click the end you want to join it to.' : 'Click near the end of one piece, then near the end of another.', erase: 'Click a piece to remove it.' }[st.tool]} Saved with <b>Save &amp; next</b>.</p>
        <div class="path-layout">
        <div id="pathPad" class="path-pad ${st.tool}">${fieldSvg([{ strokes: st.paths, markers: st.markers, ends: st.tool === 'link', linkFrom: st.linkFrom }], { numbered: true })}</div>
        <div class="marker-notes"><div class="ts-label">Marker notes</div>${st.markers.length ? st.markers.map((k, i) => `<label class="mnote"><span class="mnum">${i + 1}</span><input data-mnote="${i}" value="${esc(k.note || '')}" placeholder="e.g. picked up fuel, got defended"></label>`).join('') : '<p class="help">Use <b>Add marker</b> and click on the line. Each marker gets a note here.</p>'}</div>
        </div>
      </div>`;
  }

  // Field drawing shared by the Scout tab, team pages and printed reports. Schematic only:
  // alliance walls, centerline and a grid (no detailed 2026 field elements).
  const PATH_COLORS = ['#2b62d9', '#d73a3a', '#1a7f37', '#b7791f', '#7c3aed', '#0e7490', '#be185d', '#4b5563'];
  function fieldSvg(items, opts = {}) {
    const W = Paths.FIELD_W, H = Paths.FIELD_H;
    let g = `<svg class="field" viewBox="-8 -8 ${W + 16} ${H + 16}" width="100%" role="img" aria-label="Field with traced robot path">`;
    g += `<rect x="0" y="0" width="${W}" height="${H}" rx="6" class="f-bg"/>`;
    for (let x = 100; x < W; x += 100) g += `<line x1="${x}" y1="0" x2="${x}" y2="${H}" class="f-grid"/>`;
    for (let y = 100; y < H; y += 100) g += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" class="f-grid"/>`;
    g += `<line x1="${W / 2}" y1="0" x2="${W / 2}" y2="${H}" class="f-mid"/>`;
    g += `<rect x="0" y="0" width="10" height="${H}" class="f-red"/><rect x="${W - 10}" y="0" width="10" height="${H}" class="f-blue"/>`;
    g += `<text x="18" y="22" class="f-lbl red">Red alliance wall</text><text x="${W - 18}" y="22" text-anchor="end" class="f-lbl blue">Blue alliance wall</text>`;
    items.forEach((it, n) => {
      const col = opts.numbered ? '#16191f' : PATH_COLORS[n % PATH_COLORS.length];
      const strokes = it.strokes || [];
      strokes.forEach((p, si) => {
        if (p.length > 1) g += `<polyline points="${p.map(q => q.join(',')).join(' ')}" class="f-path" style="stroke:${col}" data-stroke="${si}"><title>${esc(it.title || 'Piece ' + (si + 1))}</title></polyline>`;
        if (!p.length) return;
        g += `<circle cx="${p[0][0]}" cy="${p[0][1]}" r="7" class="f-start" style="stroke:${col}"><title>Start${it.title ? ' · ' + esc(it.title) : ''}</title></circle>`;
        if (p.length > 1) {
          // End of a piece: a small arrowhead along the last segment.
          const a = p[p.length - 2], b = p[p.length - 1], ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
          g += `<path d="M0,0 L-12,-7 L-12,7 Z" transform="translate(${b[0]},${b[1]}) rotate(${ang.toFixed(1)})" style="fill:${col}"/>`;
          if (it.ends) for (const [end, q] of [['start', p[0]], ['end', b]]) {
            const picked = it.linkFrom && it.linkFrom.p === si && it.linkFrom.end === end;
            g += `<circle cx="${q[0]}" cy="${q[1]}" r="${picked ? 15 : 11}" class="f-endpt ${picked ? 'picked' : ''}"/>`;
          }
        }
      });
      (it.markers || []).forEach((k, i) => {
        const p = strokes[k.p || 0] || [];
        const ps = Paths.pose(p, k.seg, k.t);
        if (!ps) return;
        const deg = ps.angle * 180 / Math.PI;
        // Marker: a bar lying exactly along the tangent, an arrowhead for direction of travel,
        // and its number set off along the normal so it never covers the line.
        g += `<g transform="translate(${ps.x.toFixed(1)},${ps.y.toFixed(1)}) rotate(${deg.toFixed(2)})" class="f-marker"><title>${esc((it.title ? it.title + ' · ' : '') + 'Marker ' + (i + 1) + (k.note ? ': ' + k.note : ''))}</title>
          <line x1="-22" y1="0" x2="22" y2="0" class="f-tan" style="stroke:${opts.numbered ? '#e8590c' : col}"/>
          <path d="M22,0 L12,-7 L12,7 Z" style="fill:${opts.numbered ? '#e8590c' : col}"/>
          <circle cx="0" cy="0" r="5.5" class="f-mdot" style="stroke:${opts.numbered ? '#e8590c' : col}"/>
          ${opts.numbered ? `<g transform="translate(0,-20) rotate(${(-deg).toFixed(2)})"><circle r="10" class="f-mbadge"/><text text-anchor="middle" dy="4" class="f-mnum">${i + 1}</text></g>` : ''}
        </g>`;
      });
    });
    return g + '</svg>';
  }

  // Pointer handling for the Scout tab's path pad (attached after each render).
  function setupPathPad() {
    const pad = $('#pathPad');
    const svg = pad && pad.querySelector('svg');
    if (!svg) return;
    const st = scoutState();
    const toField = e => { const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY; const q = pt.matrixTransform(svg.getScreenCTM().inverse()); return [q.x, q.y]; };
    let drawing = null;
    const snapshot = () => { st.hist.push(JSON.stringify({ paths: st.paths, markers: st.markers })); if (st.hist.length > 50) st.hist.shift(); };
    svg.addEventListener('pointerdown', e => {
      e.preventDefault(); // keep the browser from moving focus on click (the note box gets it)
      const [x, y] = toField(e);
      if (st.tool === 'draw') {
        drawing = []; svg.setPointerCapture(e.pointerId);
        Paths.addPoint(drawing, x, y);
        const live = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        live.setAttribute('id', 'livePath'); live.setAttribute('class', 'f-path'); live.style.stroke = '#e8590c';
        svg.appendChild(live);
        live.setAttribute('points', drawing.map(q => q.join(',')).join(' '));
        return;
      }
      if (!st.paths.length) { toast('Trace the path first.'); return; }
      if (st.tool === 'mark') {
        const hit = Paths.projectAll(st.paths, x, y);
        if (!hit || hit.dist > Paths.SNAP) { toast('Click on a line to place a marker.'); return; }
        snapshot();
        const mk = { p: hit.p, seg: hit.seg, t: Math.round(hit.t * 1000) / 1000, note: '' };
        st.markers.push(mk);
        // Keep markers in route order (piece, then position along it) so numbers follow the route.
        st.markers.sort((a, b) => a.p - b.p || a.seg + a.t - (b.seg + b.t));
        const idx = st.markers.indexOf(mk);
        render();
        // Focus the new marker's note once the click has finished, so typing goes straight in.
        setTimeout(() => { const inp = document.querySelector(`[data-mnote="${idx}"]`); if (inp) inp.focus({ preventScroll: true }); }, 0);
      } else if (st.tool === 'link') {
        const endHit = Paths.nearestEnd(st.paths, x, y, Paths.SNAP * 1.5);
        if (!endHit) { toast('Click near the end of a piece.'); return; }
        if (!st.linkFrom) { st.linkFrom = endHit; render(); return; }
        if (endHit.p === st.linkFrom.p) { st.linkFrom = endHit; render(); return; }
        snapshot();
        const res = Paths.linkEnds(st.paths, st.markers, st.linkFrom, endHit);
        st.linkFrom = null;
        render();
        if (res.ok) toast('Pieces joined.');
      } else if (st.tool === 'erase') {
        const hit = Paths.projectAll(st.paths, x, y);
        if (!hit || hit.dist > Paths.SNAP) { toast('Click on a piece to remove it.'); return; }
        snapshot();
        st.paths.splice(hit.p, 1);
        st.markers = st.markers.filter(k => k.p !== hit.p).map(k => (k.p > hit.p ? Object.assign(k, { p: k.p - 1 }) : k));
        render();
      }
    });
    svg.addEventListener('pointermove', e => {
      if (!drawing) return;
      const [x, y] = toField(e);
      Paths.addPoint(drawing, x, y);
      const live = svg.querySelector('#livePath');
      if (live) live.setAttribute('points', drawing.map(q => q.join(',')).join(' '));
    });
    const end = () => {
      if (!drawing) return;
      const stroke = drawing; drawing = null;
      if (stroke.length < 2) { render(); return; }
      snapshot();
      const res = Paths.addStroke(st.paths, st.markers, stroke);
      render();
      if (res.joined.length) toast('Piece ' + res.joined.join(' and ') + '.');
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
  }
  function scoutedFuel(matchKey, t) {
    const sc = S.event.scouting;
    if (!sc || !sc.rows) return null;
    const r = sc.rows.find(x => x.match === matchKey && x.team === t && x.values[SCOUT_FUEL] != null);
    return r ? r.values[SCOUT_FUEL] : null;
  }
  function saveScoutedFuel(key, oldKey, entries) {
    const ev = S.event;
    const sc = ev.scouting = ev.scouting || { columns: [], rows: [], map: {}, show: {} };
    sc.rows = sc.rows.filter(x => !((x.match === key || x.match === oldKey) && x.values[SCOUT_FUEL] != null));
    let any = false;
    for (const { t, v } of entries) {
      if (!t || v === '' || !isFinite(+v)) continue;
      sc.rows.push({ team: t, match: key, values: { [SCOUT_FUEL]: +v } });
      any = true;
    }
    if (any && !sc.columns.includes(SCOUT_FUEL)) sc.columns.push(SCOUT_FUEL);
    if (sc.columns.includes(SCOUT_FUEL)) sc.map[SCOUT_FUEL] = 'fuel';
  }

  // All traced paths for a team, one color per match, with marker notes listed.
  function teamPathsHtml(k, print) {
    const sc = S.event.scouting;
    const rows = sc && sc.rows ? sc.rows.filter(r => r.team === k && Paths.strokesOf(r).length) : [];
    if (!rows.length) return '';
    const label = r => { const m = S.event.matches.find(x => x.key === r.match); return m ? matchLabel(m) : r.match; };
    rows.sort((a, b) => Model.matchOrder(S.event.matches.find(x => x.key === a.match) || {}) - Model.matchOrder(S.event.matches.find(x => x.key === b.match) || {}));
    const items = rows.map(r => ({ strokes: Paths.strokesOf(r), markers: (r.markers || []).map(x => Object.assign({ p: 0 }, x)), title: label(r) + (r.scout ? ' (' + r.scout + ')' : '') }));
    const notes = rows.flatMap((r, n) => (r.markers || []).filter(x => x.note).map(x => `<li><span class="sw" style="background:${PATH_COLORS[n % PATH_COLORS.length]}"></span>${esc(label(r))}: ${esc(x.note)}</li>`)).join('');
    return `${print ? '<h4>Traced paths</h4>' : '<h3 style="margin-top:12px">Traced paths</h3>'}
      <div class="path-mini">${fieldSvg(items)}</div>
      <div class="path-legend">${rows.map((r, n) => `<span><span class="sw" style="background:${PATH_COLORS[n % PATH_COLORS.length]}"></span>${esc(label(r))}</span>`).join(' ')}</div>
      ${notes ? `<ul class="path-notes">${notes}</ul>` : ''}`;
  }

  // ---------- Match editor ----------
  function openMatch(key) {
    const ev = S.event, g = S.game;
    let m = ev.matches.find(x => x.key === key);
    const isNew = !m;
    if (isNew) {
      const n = Math.max(0, ...ev.matches.filter(x => x.comp === 'qm').map(x => x.num)) + 1;
      m = { key: ev.key + '_qm' + n, comp: 'qm', set: 1, num: n, red: ['', '', ''], blue: ['', '', ''], redSurr: [], blueSurr: [], played: false };
    }
    const sideHtml = (side, label, teams) => {
      const v = m[side] || {};
      const fields = g.manual.map(f => `<div class="field"><label>${f.label}</label><input type="number" min="0" data-f="${side}.${f.key}" value="${v[f.key] != null ? v[f.key] : ''}"></div>`).join('');
      const rp = `<div class="field"><label>RP earned (optional)</label><input type="number" min="0" data-f="${side}.rp" value="${v.rp != null ? v.rp : ''}"></div>`;
      const bon = g.bonuses.length ? `<div class="checks">${g.bonuses.map(b => `<label><input type="checkbox" data-b="${side}.${b.key}" ${v.bonus && v.bonus[b.key] ? 'checked' : ''}> ${b.label}</label>`).join('')}</div>` : '';
      const lv = g.robotLevels;
      const robots = `<div class="robots"><span class="sd">Team</span><span class="sd">${lv ? 'Auto tower' : ''}</span><span class="sd">${lv ? 'End tower' : ''}</span><span class="sd" title="Fuel this robot scored, counted by a scout (optional)">Fuel</span><span class="sd">Robot</span>
        ${[0, 1, 2].map(k => {
          const rb = v.robots && v.robots[k];
          const t = teams[k] || '';
          const iss = t ? Model.robotIssue(m, t) : null;
          const st = iss ? iss.type : 'ok';
          const opt = (list, cur) => list.map(([val, txt]) => `<option value="${val}" ${cur === val ? 'selected' : ''}>${txt}</option>`).join('');
          return `<input class="tm" data-t="${side}.${k}" value="${esc(tnum(t))}">
            ${lv ? `<select data-ra="${side}.${k}">${lv.auto.map(o => `<option ${rb && rb.autoLevel === o ? 'selected' : ''}>${o}</option>`).join('')}</select>
            <select data-re="${side}.${k}">${lv.end.map(o => `<option ${rb && rb.endLevel === o ? 'selected' : ''}>${o}</option>`).join('')}</select>` : '<span></span><span></span>'}
            <input class="rf" type="number" min="0" data-rf="${side}.${k}" value="${t != null && scoutedFuel(m.key, t) != null ? scoutedFuel(m.key, t) : ''}" placeholder="–" title="Fuel this robot scored (scouted)">
            <select data-st="${side}.${k}" class="status-${st}">${opt([['ok', 'OK'], ['broke', 'Broke'], ['noshow', 'No-show']], st)}</select>
            <div class="problem" data-pb="${side}.${k}" ${st === 'broke' ? '' : 'hidden'}>
              <label>When <select data-pw="${side}.${k}">${opt(PROBLEM_WHEN, (iss && iss.when) || 'teleop')}</select></label>
              <label>What <select data-px="${side}.${k}">${opt(PROBLEM_WHAT, (iss && iss.what) || 'drivetrain')}</select></label>
              <input data-pn="${side}.${k}" placeholder="Note (optional)" value="${esc((iss && iss.note) || '')}">
            </div>`;
        }).join('')}</div>`;
      return `<div class="side ${side === 'r' ? 'red' : 'blue'}"><h4>${label}</h4>${robots}${fields}${rp}${bon}</div>`;
    };
    openModal(`<h2>${isNew ? 'New match' : matchLabel(m)}</h2>
      <div class="toolbar"><label>Level <select id="mComp">${['qm', 'sf', 'f'].map(c => `<option value="${c}" ${m.comp === c ? 'selected' : ''}>${{ qm: 'Qualification', sf: 'Playoff', f: 'Final' }[c]}</option>`).join('')}</select></label>
        <label>Number <input id="mNum" type="number" min="1" value="${m.comp === 'sf' ? m.set : m.num}" style="width:70px"></label>
        <span class="help">Only the final score is required. Tower levels per robot are the most valuable extra info. Mark a robot <b>Broke</b> or <b>No-show</b> so the bad match doesn't drag down its rating.</span></div>
      <div class="form-grid">${sideHtml('r', 'Red', m.red)}${sideHtml('b', 'Blue', m.blue)}</div>
      <p class="toolbar" style="margin-top:14px"><button class="btn primary" data-act="save-match" data-key="${esc(isNew ? '' : m.key)}">Save</button>
        ${!isNew && Model.isPlayed(m) ? '<button class="btn" data-act="clear-result" data-key="' + esc(m.key) + '">Clear result</button>' : ''}
        ${!isNew ? '<button class="btn danger" data-act="delete-match" data-key="' + esc(m.key) + '">Delete match</button>' : ''}
        <span class="help">Tip: Enter saves.</span></p>`);
    const first = document.querySelector('[data-f="r.score"]');
    if (first && !isNew) first.focus();
  }

  function saveMatchFromForm(oldKey) {
    const ev = S.event, g = S.game;
    const val = sel => { const el = document.querySelector(sel); return el ? el.value.trim() : ''; };
    const numOrNull = s => (s === '' ? null : +s);
    const comp = val('#mComp'), n = +val('#mNum') || 1;
    const key = ev.key + '_' + (comp === 'qm' ? 'qm' + n : comp === 'sf' ? 'sf' + n + 'm1' : 'f1m' + n);
    const teams = side => [0, 1, 2].map(k => val(`[data-t="${side}.${k}"]`)).filter(Boolean).map(tkey);
    const red = teams('r'), blue = teams('b');
    if (!red.length || !blue.length) { toast('Enter the teams on each alliance.'); return; }
    const all = red.concat(blue);
    const dup = all.filter((t, i) => all.indexOf(t) !== i);
    if (dup.length) { toast(`Team ${tnum(dup[0])} is entered more than once in this match.`, 4000); return; }
    let m = oldKey ? ev.matches.find(x => x.key === oldKey) : null;
    if (!m) m = { redSurr: [], blueSurr: [], redDQ: [], blueDQ: [] };
    if (oldKey && oldKey !== key) ev.matches = ev.matches.filter(x => x.key !== oldKey);
    Object.assign(m, { key, comp, set: comp === 'sf' ? n : 1, num: comp === 'sf' ? 1 : n, red, blue, source: 'manual', updated: Date.now() });
    // Per-robot fuel typed in by scouts: stored as scouting rows that feed the fuel rating.
    saveScoutedFuel(key, oldKey, [0, 1, 2].flatMap(k => [['r', red[k]], ['b', blue[k]]].map(([side, t]) => ({ t, v: val(`[data-rf="${side}.${k}"]`) }))));
    m.issues = {};
    delete m.out;
    for (const side of ['r', 'b']) [0, 1, 2].forEach(k => {
      const t = (side === 'r' ? red : blue)[k];
      const st = val(`[data-st="${side}.${k}"]`);
      if (!t || !st || st === 'ok') return;
      m.issues[t] = st === 'noshow' ? { type: 'noshow' }
        : { type: 'broke', when: val(`[data-pw="${side}.${k}"]`), what: val(`[data-px="${side}.${k}"]`), note: val(`[data-pn="${side}.${k}"]`) };
    });
    if (!Object.keys(m.issues).length) delete m.issues;
    const sides = {};
    for (const side of ['r', 'b']) {
      const v = {};
      for (const f of g.manual) v[f.key] = numOrNull(val(`[data-f="${side}.${f.key}"]`));
      v.rp = numOrNull(val(`[data-f="${side}.rp"]`));
      if (g.bonuses.length) {
        v.bonus = {};
        for (const b of g.bonuses) { const el = document.querySelector(`[data-b="${side}.${b.key}"]`); v.bonus[b.key] = !!(el && el.checked); }
      }
      if (g.robotLevels) {
        const tl = side === 'r' ? red : blue;
        const robots = tl.map((_, k) => {
          const a = val(`[data-ra="${side}.${k}"]`) || 'None', e = val(`[data-re="${side}.${k}"]`) || 'None';
          return { autoLevel: a, endLevel: e, tower: g.robotTowerPoints(a, e) };
        });
        // Only keep per-robot data if someone actually filled it in.
        if (robots.some(r => r.autoLevel !== 'None' || r.endLevel !== 'None')) {
          v.robots = robots;
          if (v.tower == null) v.tower = robots.reduce((a, r) => a + r.tower, 0);
        }
      }
      sides[side] = v;
    }
    const hasScore = sides.r.score != null && sides.b.score != null;
    if (hasScore) {
      for (const [side, other] of [['r', 'b'], ['b', 'r']]) {
        const v = sides[side];
        v.total = v.score - (v.foulRecv || 0);
        v.fouls = sides[other].foulRecv;
        if (v.bonus && g.bonuses.length) {
          // Tick bonus boxes automatically when the entered counts clear the threshold.
          const thr = Model.eventThresholds(ev, g).values;
          for (const b of g.bonuses) if (!v.bonus[b.key] && v[b.comp] != null && thr[b.key] != null && v[b.comp] >= thr[b.key]) v.bonus[b.key] = true;
        }
      }
      m.r = sides.r; m.b = sides.b; m.played = true;
    } else { m.played = false; delete m.r; delete m.b; }
    for (const t of red.concat(blue)) if (!ev.teams.includes(t)) ev.teams.push(t);
    ev.teams.sort(Model.teamCmp);
    if (!ev.matches.includes(m)) ev.matches.push(m);
    persist();
    closeModal();
    recompute();
    toast(`${matchLabel(m)} saved${hasScore ? '' : ' (schedule only)'} — ratings updated.`);
  }

  // ---------- Paste helpers ----------
  function openPaste(kind) {
    const isSched = kind === 'schedule';
    openModal(`<h2>${isSched ? 'Paste schedule' : 'Paste scores'}</h2>
      <p class="help">${isSched
        ? 'One qualification match per line: <code>match red1 red2 red3 blue1 blue2 blue3</code>. Commas, tabs or spaces all work, e.g. <code>Q12, 254, 1678, 971, 118, 148, 1323</code>. Existing matches keep their results.'
        : 'One line per match: <code>match redScore blueScore [redRP blueRP]</code>, e.g. <code>12 143 120 4 1</code>. The match must already be on the schedule.'}</p>
      <textarea id="pasteBox" rows="14" placeholder="${isSched ? 'Q1 254 1678 971 118 148 1323' : '1 143 120'}"></textarea>
      <p><button class="btn primary" data-act="apply-paste" data-kind="${kind}">Apply</button></p>`);
    $('#pasteBox').focus();
  }

  function applyPaste(kind) {
    const ev = S.event;
    const lines = $('#pasteBox').value.split('\n').map(l => l.trim()).filter(Boolean);
    let ok = 0;
    const bad = [];
    for (const line of lines) {
      const toks = line.match(/\d+[A-Za-z]?\b/g) || []; // allows B robots like 190B
      const nums = toks.map(x => parseInt(x, 10));
      if (kind === 'schedule') {
        if (nums.length < 7) { bad.push(line); continue; }
        const n = nums[0], t = toks.slice(1);
        if (new Set(t.slice(0, 6).map(x => x.toUpperCase())).size < 6) { bad.push(line + ' (repeated team)'); continue; }
        const key = ev.key + '_qm' + n;
        let m = ev.matches.find(x => x.key === key);
        if (!m) { m = { key, comp: 'qm', set: 1, num: n, redSurr: [], blueSurr: [], redDQ: [], blueDQ: [], played: false, source: 'manual' }; ev.matches.push(m); }
        m.red = t.slice(0, 3).map(tkey); m.blue = t.slice(3, 6).map(tkey);
        for (const k of m.red.concat(m.blue)) if (!ev.teams.includes(k)) ev.teams.push(k);
        ok++;
      } else {
        if (nums.length < 3) { bad.push(line); continue; }
        const m = ev.matches.find(x => x.key === ev.key + '_qm' + nums[0]);
        if (!m) { bad.push(line); continue; }
        m.r = Object.assign({}, m.r || {}, { score: nums[1], total: nums[1] - ((m.r && m.r.foulRecv) || 0) });
        m.b = Object.assign({}, m.b || {}, { score: nums[2], total: nums[2] - ((m.b && m.b.foulRecv) || 0) });
        if (nums.length >= 5) { m.r.rp = nums[3]; m.b.rp = nums[4]; }
        m.played = true; m.source = 'manual'; m.updated = Date.now();
        ok++;
      }
    }
    ev.teams.sort(Model.teamCmp);
    persist(); closeModal(); recompute();
    toast(`${ok} line(s) applied${bad.length ? `, ${bad.length} skipped: ${bad.slice(0, 3).join(' | ')}` : ''}.`, 4000);
  }

  // ---------- Scouting CSV ----------
  function parseCSV(text) {
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
      else if (c === '"') q = true;
      else if (c === ',' || c === '\t') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(x => x.trim() !== ''));
  }

  function importScouting(text) {
    const rows = parseCSV(text);
    if (rows.length < 2) { toast('CSV looks empty.'); return; }
    const head = rows[0].map(h => h.trim());
    const lower = head.map(h => h.toLowerCase().replace(/[^a-z]/g, ''));
    const ti = lower.findIndex(h => ['team', 'teamnumber', 'teamnum', 'teamno', 'scoutedteam'].includes(h));
    const mi = lower.findIndex(h => ['match', 'matchnumber', 'matchnum', 'matchno', 'qm'].includes(h));
    if (ti < 0) { toast('Could not find a "team" column in the CSV header.', 4000); return; }
    const numericCols = head.map((h, i) => i).filter(i => i !== ti && i !== mi &&
      rows.slice(1).filter(r => (r[i] || '').trim() !== '').every(r => !isNaN(+r[i])) && rows.slice(1).some(r => (r[i] || '').trim() !== ''));
    const sc = { columns: numericCols.map(i => head[i]), rows: [], map: {}, show: {} };
    for (const r of rows.slice(1)) {
      const t = (r[ti] || '').match(/\d+/);
      if (!t) continue;
      const values = {};
      for (const i of numericCols) if ((r[i] || '').trim() !== '') values[head[i]] = +r[i];
      sc.rows.push({ team: tkey(t[0]), match: mi >= 0 ? (r[mi] || '').trim() : '', values });
    }
    // Guess links to rating components from column names.
    const guess = { fuel: /^(tele)?.*fuel|balls?|cargo/i, autoFuel: /auto.*fuel/i, tower: /tower|climb/i };
    for (const c of sc.columns) {
      if (guess.autoFuel.test(c)) sc.map[c] = 'autoFuel';
      else if (guess.fuel.test(c) && !/miss/i.test(c)) sc.map[c] = 'fuel';
    }
    S.event.scouting = sc;
    persist(); recompute();
    toast(`Imported ${sc.rows.length} scouting rows, ${sc.columns.length} numeric columns.`);
    openScoutMap();
  }

  function openScoutMap() {
    const sc = S.event.scouting, g = S.game;
    const opts = g.comps.filter(c => !c.hidden && c.key !== 'total' && c.key !== 'fouls');
    openModal(`<h2>Scouting columns</h2>
      <p class="help">Link a column to a rating component only if it measures the same thing <b>per robot per match</b> (e.g. fuel scored by that robot). Linked columns feed the rating directly as extra observations; unlinked ones are just shown as averages.</p>
      <table><thead><tr><th>Column</th><th>Show in Teams</th><th>Feeds rating</th></tr></thead><tbody>
      ${sc.columns.map(c => `<tr><td>${esc(c)}</td><td><input type="checkbox" data-scshow="${esc(c)}" ${(sc.show || {})[c] !== false ? 'checked' : ''}></td>
        <td><select data-scmap="${esc(c)}"><option value="">— no —</option>${opts.map(o => `<option value="${o.key}" ${sc.map[c] === o.key ? 'selected' : ''}>${o.label}</option>`).join('')}</select></td></tr>`).join('')}
      </tbody></table><p><button class="btn primary" data-act="scout-map-save">Save</button></p>`);
  }

  // ---------- Accuracy check ----------
  function accuracyCheck() {
    const ev = S.event, g = S.game;
    const quals = ev.matches.filter(m => m.comp === 'qm' && Model.isPlayed(m));
    const acc = { n: 0, correct: 0, brier: 0 };
    quals.forEach((m, k) => {
      if (m.r.score === m.b.score) return;
      const before = new Set(quals.slice(0, k).map(x => x.key));
      const R = Model.fit(ev, g, modelSettings(), { include: x => before.has(x.key) });
      const p = Model.predictMatch(R, m.red, m.blue).pRed;
      const y = m.r.score > m.b.score ? 1 : 0;
      acc.n++; acc.brier += (p - y) * (p - y); acc.correct += (p > 0.5) === (y === 1) ? 1 : 0;
    });
    S.accuracy = acc;
    render();
  }

  // ---------- actions ----------
  async function tbaImport(explicitKey) {
    const key = $('#tbaKey').value.trim(), evKey = (explicitKey || $('#tbaEvent').value).trim().toLowerCase();
    if (!key || !evKey) { toast('Enter your TBA key and the event key.'); return; }
    S.settings.tbaKey = key; Store.saveSettings(S.settings);
    const log = $('#importLog');
    log.hidden = false; log.textContent = '';
    const say = msg => { log.textContent += msg + '\n'; log.scrollTop = log.scrollHeight; };
    try {
      const existing = Store.loadEvent(evKey);
      const ev = await TBA.importEvent(evKey, key, say, existing);
      // Keep only earlier-event ratings for teams at this event (saves space).
      for (const pe of Object.values(ev.priorEvents || {})) for (const t of Object.keys(pe.ratings)) if (!ev.teams.includes(t)) delete pe.ratings[t];
      Store.saveEvent(ev);
      say('Saved. You can now use this event offline.');
      S.tab = 'overview';
      setEvent(ev);
      toast(`${ev.name} downloaded — ${ev.teams.length} teams, priors for ${Object.keys(ev.priors || {}).length}. Ready offline.`, 4000);
    } catch (e) {
      say('ERROR: ' + e.message + (navigator.onLine ? '' : ' (you appear to be offline)'));
    }
  }

  async function tbaRefresh(quiet) {
    if (!S.settings.tbaKey) { if (!quiet) toast('Add your TBA key in the Data tab first.'); return; }
    const ev = S.event;
    if (!ev || ev.demo || ev.manual) return;
    S.syncing = true; S.lastSyncTry = Date.now(); renderStatus();
    try {
      if (!quiet) toast('Refreshing from TBA…');
      const r = await TBA.refreshMatches(ev, S.settings.tbaKey);
      S.syncError = null;
      persist();
      if (r.newResults || r.changed || !quiet) {
        recompute();
        const what = r.newResults ? `${r.newResults} new result${r.newResults > 1 ? 's' : ''}` : r.changed ? `${r.changed} updated` : 'no new results';
        toast(`TBA: ${what}${r.newResults || r.changed ? ' — ratings updated' : ''}.`);
      }
    } catch (e) {
      S.syncError = e.message;
      if (!quiet) toast('Refresh failed: ' + e.message, 5000);
    } finally { S.syncing = false; renderStatus(); }
  }

  // Auto-sync: whenever the Mac has internet, pull new results from TBA every few
  // minutes (and right away when a connection appears) so nobody has to type scores.
  const AUTO_SYNC_MS = 2 * 60 * 1000;
  function autoSyncTick(force) {
    const ev = S.event;
    if (!S.settings.autoSync || !S.settings.tbaKey || !ev || ev.demo || ev.manual || S.syncing || !navigator.onLine) return;
    if (!force && S.lastSyncTry && Date.now() - S.lastSyncTry < AUTO_SYNC_MS) return;
    tbaRefresh(true);
  }
  setInterval(autoSyncTick, 15000);

  function createManualEvent() {
    openModal(`<h2>Create event manually</h2>
      <div class="field"><label>Event name</label><input id="mkName" style="width:300px" placeholder="e.g. Silicon Valley Regional"></div>
      <div class="field"><label>Short key</label><input id="mkKey" style="width:300px" placeholder="e.g. 2026casj"></div>
      <div class="field"><label>Season</label><input id="mkYear" type="number" value="2026" style="width:300px"></div>
      <div class="field"><label>Level</label><select id="mkLevel" style="width:300px"><option value="regional">Regional / District / Offseason</option><option value="dcmp">District Championship</option><option value="cmp">FIRST Championship</option></select></div>
      <p class="help">Team numbers (any separators). You can also skip this and just paste the schedule — teams are added automatically.</p>
      <textarea id="mkTeams" rows="5" placeholder="254 1678 971 …"></textarea>
      <p><button class="btn primary" data-act="manual-create">Create</button></p>`);
  }

  function exportCSV() {
    const rows = S.R.teams.map(teamRow).sort((a, b) => b.tp - a.tp);
    const head = ['team', 'name', 'true_potential', 'tp_sd', 'auto', 'fuel', 'auto_fuel', 'tower', 'fouls_given', 'opr', 'rank', 'rs', 'adj_rs', 'schedule_luck', 'ease_pct', 'true_rank', 'proj_rank', 'p_top8', 'problems', 'notes'];
    const q = v => (typeof v === 'string' ? '"' + v.replace(/"/g, '""') + '"' : v == null || !isFinite(v) ? '' : +v.toFixed(3));
    const lines = [head.join(',')].concat(rows.map(r => [r.num, r.name, r.tp, r.tpSd, r.auto, r.fuel, r.autoFuel, r.tower, r.fouls, r.opr, r.rank, r.rs, r.adjRS, r.luck, r.easePct, r.trueRank, r.expRank, r.p8, r.problemText, (S.event.notes || {})[r.key] || ''].map(q).join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `${S.event.key}-true-potential.csv`;
    document.body.appendChild(a); a.click(); setTimeout(() => a.remove(), 500);
  }

  function readFile(file, cb) { const r = new FileReader(); r.onload = () => cb(r.result); r.readAsText(file); }

  function importJSON(text) {
    let data;
    try { data = JSON.parse(text); } catch (e) { toast('Not a valid JSON file.'); return; }
    const events = data.trupower === 'all' ? data.events : data.trupower === 'event' ? [data.event] : data.matches ? [data] : null;
    if (!events) { toast('This file is not a TRU POWER export.'); return; }
    for (const inc of events) {
      const merged = Store.mergeEvent(Store.loadEvent(inc.key), inc);
      Store.saveEvent(merged);
      if (!S.event || S.event.key === merged.key) S.event = merged;
    }
    setEvent(S.event || Store.loadEvent(events[0].key));
    toast(`Imported ${events.length} event(s).`);
  }

  const actions = {
    'goto-data': () => { S.tab = 'data'; render(); },
    'load-demo': () => { const ev = Demo.makeDemoEvent({ seed: Date.now() % 100000 }); Store.saveEvent(ev); setEvent(ev); S.tab = 'overview'; render(); toast('Demo event loaded (synthetic data).'); },
    'tba-import': el => tbaImport(el.dataset.key),
    'tba-refresh': () => tbaRefresh(false),
    'accuracy': () => { toast('Checking…', 800); setTimeout(accuracyCheck, 30); },
    'new-match': () => openMatch(null),
    'paste-schedule': () => openPaste('schedule'),
    'paste-results': () => openPaste('results'),
    'apply-paste': el => applyPaste(el.dataset.kind),
    'save-match': el => saveMatchFromForm(el.dataset.key),
    'clear-result': el => { const m = S.event.matches.find(x => x.key === el.dataset.key); if (m) { m.played = false; delete m.r; delete m.b; m.updated = Date.now(); } persist(); closeModal(); recompute(); },
    'delete-match': el => {
      if (el.dataset.confirm !== '1') { el.dataset.confirm = '1'; el.textContent = 'Click again to delete'; return; }
      S.event.matches = S.event.matches.filter(x => x.key !== el.dataset.key); persist(); closeModal(); recompute();
    },
    'clear-picked': () => { S.event.picked = {}; persist(); render(); },
    'scout-save': () => saveScout(),
    'path-undo': () => { const st = scoutState(); const h = st.hist.pop(); if (h) { const v = JSON.parse(h); st.paths = v.paths; st.markers = v.markers; st.linkFrom = null; } render(); },
    'path-clear': () => { const st = scoutState(); st.hist.push(JSON.stringify({ paths: st.paths, markers: st.markers })); st.paths = []; st.markers = []; st.linkFrom = null; render(); },
    'print-team': el => printHtml(teamReportHtml(el.dataset.key)),
    'print-match': el => { const m = S.event.matches.find(x => x.key === el.dataset.key); if (m) printHtml(matchSheetHtml(m)); },
    'print-picks': () => printHtml(pickListHtml()),
    'reset-alliances': el => {
      if (el.dataset.confirm !== '1') { el.dataset.confirm = '1'; el.textContent = 'Click again to reset'; return; }
      const a = allianceState(); a.slots = []; allianceState(); persist(); render();
    },
    'export-csv': exportCSV,
    'export-event': () => Store.download(`${S.event.key}-trupower.json`, { trupower: 'event', exported: Date.now(), event: S.event }),
    'export-all': () => Store.download(`trupower-backup-${new Date().toISOString().slice(0, 10)}.json`, { trupower: 'all', exported: Date.now(), events: Store.listEvents().map(e => Store.loadEvent(e.key)).filter(Boolean) }),
    'manual-event': createManualEvent,
    'manual-create': () => {
      const name = $('#mkName').value.trim() || 'My event';
      const year = +$('#mkYear').value || 2026;
      const key = ($('#mkKey').value.trim() || (year + name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8))).toLowerCase();
      if (Store.loadEvent(key) && !confirm('An event with this key exists. Replace it?')) return;
      const teams = [...new Set(($('#mkTeams').value.match(/\d+/g) || []).map(tkey))].sort(Model.teamCmp);
      const ev = { schema: 1, key, name, year, level: $('#mkLevel').value, teams, teamNames: {}, matches: [], priors: {}, priorMeta: {}, notes: {}, starred: {}, picked: {}, manual: true, created: Date.now() };
      Store.saveEvent(ev); closeModal(); setEvent(ev); S.tab = 'matches'; render();
      toast('Event created — now paste the schedule.');
    },
    'scout-map': openScoutMap,
    'scout-map-save': () => {
      const sc = S.event.scouting;
      document.querySelectorAll('[data-scmap]').forEach(el => { if (el.value) sc.map[el.dataset.scmap] = el.value; else delete sc.map[el.dataset.scmap]; });
      document.querySelectorAll('[data-scshow]').forEach(el => { sc.show[el.dataset.scshow] = el.checked; });
      persist(); closeModal(); recompute();
    },
    'scout-clear': () => { delete S.event.scouting; persist(); recompute(); },
  };

  // ---------- events ----------
  document.addEventListener('click', e => {
    const pt = e.target.closest('[data-ptool]');
    if (pt) { const st = scoutState(); st.tool = pt.dataset.ptool; st.linkFrom = null; render(); return; }
    const bump = e.target.closest('[data-bump]');
    if (bump) { const [w, d] = bump.dataset.bump.split(':'); bumpCount(w, +d); return; }
    const ps = e.target.closest('[data-poolsort]');
    if (ps) { S.settings.poolSort = ps.dataset.poolsort; Store.saveSettings(S.settings); render(); return; }
    const pk = e.target.closest('[data-pickteam],[data-unpick]');
    if (pk) {
      if (pk.dataset.unpick) removeTeam(pk.dataset.unpick);
      else { const n = nextSlot(allianceState()); if (n) placeTeam(pk.dataset.pickteam, n.k, n.j); }
      return;
    }
    const el = e.target.closest('[data-act],[data-team],[data-match],[data-sort],[data-star],[data-open],[data-del],[data-close],#tabs button');
    if (!el) { if (e.target.id === 'modal') closeModal(); return; }
    if (el.matches('#tabs button')) { S.tab = el.dataset.tab; render(); return; }
    if (el.dataset.close !== undefined) { closeModal(); return; }
    if (el.dataset.act) { actions[el.dataset.act] && actions[el.dataset.act](el); return; }
    if (el.dataset.team) { e.preventDefault(); openTeam(el.dataset.team); return; }
    if (el.dataset.match) { openMatch(el.dataset.match); return; }
    if (el.dataset.star) {
      S.event.starred = S.event.starred || {};
      S.event.starred[el.dataset.star] = !S.event.starred[el.dataset.star];
      persist();
      if (!$('#modal').hidden) openTeam(el.dataset.star);
      render();
      return;
    }
    if (el.dataset.sort) {
      const id = el.closest('table').dataset.table;
      const [k, d] = S.sort[id] || [];
      const lowFirst = ['num', 'rank', 'trueRank', 'expRank', 'fouls', 'gap', 'range', 'name', 'pickNo', 'problems', 'sure'].includes(el.dataset.sort);
      S.sort[id] = [el.dataset.sort, k === el.dataset.sort ? -d : lowFirst ? 1 : -1];
      render();
      return;
    }
    if (el.dataset.open) { setEvent(Store.loadEvent(el.dataset.open)); S.tab = 'overview'; render(); return; }
    if (el.dataset.del) {
      if (el.dataset.confirm !== '1') { el.dataset.confirm = '1'; el.textContent = 'Click again'; return; }
      Store.deleteEvent(el.dataset.del);
      if (S.event && S.event.key === el.dataset.del) setEvent(null);
      render();
    }
  });

  document.addEventListener('change', e => {
    const el = e.target;
    if (el.id === 'eventSelect' && el.value) { setEvent(Store.loadEvent(el.value)); return; }
    if (el.dataset.pick) { S.event.picked = S.event.picked || {}; S.event.picked[el.dataset.pick] = el.checked; persist(); render(); return; }
    if (el.id === 'scoutName') { S.settings.scoutName = el.value.trim(); Store.saveSettings(S.settings); S.sc = null; render(); return; }
    if (el.id === 'scoutSeat') { S.settings.scoutSeat = el.value; Store.saveSettings(S.settings); S.sc = null; S.scoutMatch = null; render(); return; }
    if (el.id === 'scoutMatch') { S.scoutMatch = el.value; S.sc = null; render(); return; }
    if (el.id === 'scCounted') { scoutState().counted = el.checked; return; }
    if (el.id === 'scStatus') { scoutState().status = el.value; const b = $('#scBroke'); if (b) b.hidden = el.value !== 'broke'; return; }
    if (el.id === 'scWhen') { scoutState().when = el.value; return; }
    if (el.id === 'scWhat') { scoutState().what = el.value; return; }
    if (el.id === 'scDef') { scoutState().def = +el.value; return; }
    if (el.id === 'nAlliances') { const a = allianceState(); a.n = +el.value; allianceState(); persist(); render(); return; }
    if (el.id === 'hidePicked') { S.hidePicked = el.checked; render(); return; }
    if (el.id === 'matchFilter') { S.matchFilter = el.value; render(); return; }
    if (el.id === 'nSims') { S.settings.nSims = +el.value; Store.saveSettings(S.settings); S.sim = null; render(); scheduleSim(); return; }
    if (el.id === 'ourTeam') { S.settings.ourTeam = el.value.trim() ? tkey(el.value) : ''; Store.saveSettings(S.settings); render(); loadCatalogueAndShow(true); return; }
    if (el.id === 'tbaKey') { S.settings.tbaKey = el.value.trim(); Store.saveSettings(S.settings); loadCatalogueAndShow(true); return; }
    if (el.id === 'evYear') { S.evYear = +el.value; refreshEventResults(); loadCatalogueAndShow(false); return; }
    if (el.dataset.teamTag) {
      const all = S.event.scoutTags = S.event.scoutTags || {};
      const tg = all[el.dataset.teamTag] = all[el.dataset.teamTag] || {};
      if (el.value) tg[el.dataset.tag] = el.value; else delete tg[el.dataset.tag];
      persist(); return;
    }
    if (el.id === 'useReliability') { S.settings.model = S.settings.model || {}; S.settings.model.useReliability = el.checked; Store.saveSettings(S.settings); recompute(); return; }
    if (el.id === 'autoSync') { S.settings.autoSync = el.checked; Store.saveSettings(S.settings); renderStatus(); autoSyncTick(true); return; }
    if (el.id === 'level' && S.event) { S.event.level = el.value; persist(); recompute(); return; }
    if (['lambda', 'elimWeight', 'scoutWeight'].includes(el.id)) {
      S.settings.model = S.settings.model || {};
      const v = parseFloat(el.value);
      if (isFinite(v)) S.settings.model[el.id] = v; else delete S.settings.model[el.id];
      Store.saveSettings(S.settings); recompute(); return;
    }
    if (el.id === 'importFile' && el.files[0]) { readFile(el.files[0], importJSON); el.value = ''; return; }
    if (el.id === 'scoutFile' && el.files[0]) { if (!S.event) { toast('Load an event first.'); return; } readFile(el.files[0], importScouting); el.value = ''; return; }
    if (el.dataset.st) {
      const box = document.querySelector(`[data-pb="${el.dataset.st}"]`);
      if (box) box.hidden = el.value !== 'broke';
      el.className = 'status-' + el.value;
      return;
    }
    if (el.dataset.ra || el.dataset.re) {
      // Keep the alliance tower total in sync with per-robot levels.
      const side = (el.dataset.ra || el.dataset.re)[0];
      let tot = 0, any = false;
      for (let k = 0; k < 3; k++) {
        const a = document.querySelector(`[data-ra="${side}.${k}"]`), en = document.querySelector(`[data-re="${side}.${k}"]`);
        if (a && en) { tot += S.game.robotTowerPoints(a.value, en.value); any = any || a.value !== 'None' || en.value !== 'None'; }
      }
      const tf = document.querySelector(`[data-f="${side}.tower"]`);
      if (tf && any) tf.value = tot;
    }
  });

  document.addEventListener('input', e => {
    const el = e.target;
    if (el.id === 'teamFilter') {
      S.filter = el.value;
      const pos = el.selectionStart;
      render();
      const f = $('#teamFilter'); f.focus(); f.setSelectionRange(pos, pos);
      return;
    }
    if (el.classList.contains('pt')) { updatePrediction(); return; }
    if (el.id === 'scNote') { scoutState().note = el.value; return; }
    if (el.dataset.mnote != null) { const k = scoutState().markers[+el.dataset.mnote]; if (k) k.note = el.value; return; }
    if (el.id === 'evSearch') { S.evQuery = el.value; refreshEventResults(); return; }
    if (el.dataset.teamNotes) {
      S.event.notes = S.event.notes || {};
      S.event.notes[el.dataset.teamNotes] = el.value;
      clearTimeout(el._t); el._t = setTimeout(persist, 400);
    }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('#modal').hidden) { closeModal(); render(); return; }
    if (e.key === 'Enter' && !$('#modal').hidden && e.target.tagName === 'INPUT') {
      const btn = document.querySelector('[data-act="save-match"],[data-act="manual-create"]');
      if (btn) { e.preventDefault(); btn.click(); }
      return;
    }
    const typing = /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
    // In Scout mode, Enter in the note box saves too (scouts type a note, then hit Enter).
    if (S.tab === 'scout' && $('#modal').hidden && e.key === 'Enter' && e.target.id === 'scNote') { e.preventDefault(); scoutState().note = e.target.value; saveScout(); return; }
    // Scout mode keys: A/Z auto fuel ±1, S/X teleop fuel ±1, Enter saves.
    if (!typing && $('#modal').hidden && S.tab === 'scout' && !e.metaKey && !e.ctrlKey) {
      const k = e.key.toLowerCase();
      const map = { a: ['auto', 1], z: ['auto', -1], s: ['tele', 1], x: ['tele', -1] };
      if (map[k]) { e.preventDefault(); bumpCount(map[k][0], map[k][1]); return; }
      if (e.key === 'Enter') { e.preventDefault(); saveScout(); return; }
    }
    if (!typing && $('#modal').hidden && /^[0-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey) {
      S.tab = ['data', 'overview', 'teams', 'picks', 'alliances', 'luck', 'matches', 'scout', 'forecast', 'predict'][+e.key];
      render();
    }
  });

  // ---------- drag & drop (alliance selection) ----------
  document.addEventListener('dragstart', e => {
    const d = e.target.closest && e.target.closest('[data-drag]');
    if (!d) return;
    e.dataTransfer.setData('text/plain', d.dataset.drag);
    e.dataTransfer.effectAllowed = 'move';
    d.classList.add('dragging');
  });
  document.addEventListener('dragend', e => { const d = e.target.closest && e.target.closest('[data-drag]'); if (d) d.classList.remove('dragging'); });
  document.addEventListener('dragover', e => {
    const s = e.target.closest && e.target.closest('[data-slot]');
    if (!s) return;
    e.preventDefault();
    document.querySelectorAll('.slot.over,.pool.over').forEach(x => x !== s && x.classList.remove('over'));
    s.classList.add('over');
  });
  document.addEventListener('dragleave', e => { const s = e.target.closest && e.target.closest('[data-slot]'); if (s && !s.contains(e.relatedTarget)) s.classList.remove('over'); });
  document.addEventListener('drop', e => {
    const s = e.target.closest && e.target.closest('[data-slot]');
    if (!s) return;
    e.preventDefault();
    s.classList.remove('over');
    const t = e.dataTransfer.getData('text/plain');
    if (!t) return;
    const where = s.dataset.slot;
    if (where === 'pool') { removeTeam(t); return; }
    const [k, j] = where.split(':');
    placeTeam(t, +k, +j);
  });

  window.addEventListener('online', () => { renderStatus(); autoSyncTick(true); });
  window.addEventListener('offline', renderStatus);

  // ---------- boot ----------
  const cur = S.settings.current && Store.loadEvent(S.settings.current);
  if (cur) setEvent(cur); else { S.tab = Store.listEvents().length ? 'data' : 'overview'; render(); }
  autoSyncTick(true);
})();

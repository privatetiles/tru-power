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
    sort: { teams: ['tp', -1], luck: ['luck', 1], forecast: ['expRank', 1] },
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
    S.luck = Sim.scheduleLuck(ev, S.R, S.Rprior);
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
      starred: !!(S.event.starred || {})[k], picked: !!(S.event.picked || {})[k],
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
    const fn = { overview: renderOverview, teams: renderTeams, luck: renderLuck, matches: renderMatches, forecast: renderForecast, predict: renderPredict, data: renderData }[S.tab];
    main.innerHTML = fn();
    if (S.tab === 'predict') updatePrediction();
    if (S.tab === 'data') loadCatalogueAndShow(false);
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
          ${statCard('True Potential', f1(r.tp), '± ' + f1(r.tpSd))}
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

  function allianceHtml(teams, c) { return `<span class="alliance ${c}">${teams.map(t => teamLink(t)).join(' ')}</span>`; }

  // ----- sortable table -----
  function table(id, cols, rows, opts = {}) {
    let [sk, dir] = S.sort[id] || [];
    if (!cols.some(c => c.key === sk && !c.nosort)) { [sk, dir] = { teams: ['tp', -1], luck: ['luck', 1], forecast: ['expRank', 1] }[id] || []; }
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
      { key: 'tp', label: 'True Potential', n: 1, title: 'Expected points this robot adds per match (no fouls), schedule- and partner-adjusted', fmt: r => `<b>${f1(r.tp)}</b> <span class="sd">±${f1(r.tpSd, 0)}</span>` },
    ];
    if (has('auto')) cols.push({ key: 'auto', label: 'Auto', n: 1, fmt: r => f1(r.auto) });
    if (has('fuel')) cols.push({ key: 'fuel', label: 'Fuel', n: 1, fmt: r => f1(r.fuel) });
    if (has('autoFuel')) cols.push({ key: 'autoFuel', label: 'A.Fuel', n: 1, fmt: r => f1(r.autoFuel) });
    if (has('tower')) cols.push({ key: 'tower', label: 'Tower', n: 1, fmt: r => f1(r.tower) });
    if (has('fouls')) cols.push({ key: 'fouls', label: 'Fouls', n: 1, title: 'Foul points given to opponents per match (lower is better)', fmt: r => f1(r.fouls) });
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
      const bonusTxt = Object.keys(p.red.bonus).length
        ? S.game.bonuses.map(b => `${b.label[0]} ${pct(p.red.bonus[b.key])}/${pct(p.blue.bonus[b.key])}`).join(' · ') : '';
      const surr = (m.redSurr || []).concat(m.blueSurr || []);
      return `<tr class="${ot && (m.red.includes(ot) || m.blue.includes(ot)) ? 'ours' : ''}">
        <td><a data-match="${esc(m.key)}"><b>${matchLabel(m)}</b></a>${m.source === 'manual' ? ' <span class="pill muted" title="Entered by hand">manual</span>' : ''}</td>
        <td>${allianceHtml(m.red, 'red-t')}</td><td>${allianceHtml(m.blue, 'blue-t')}</td>
        <td><span class="probbar" title="Red win ${pct(p.pRed, 1)}"><span class="r" style="width:${100 * p.pRed}%">${p.pRed >= 0.2 ? pct(p.pRed) : ''}</span><span class="b" style="width:${100 * (1 - p.pRed)}%">${p.pRed <= 0.8 ? pct(1 - p.pRed) : ''}</span></span></td>
        <td class="n">${f1(p.red.score, 0)}–${f1(p.blue.score, 0)}</td>
        <td class="sd">${played && m.comp === 'qm' ? '' : bonusTxt}</td>
        <td class="n">${actual}</td>
        <td>${surr.length ? `<span class="sd" title="Surrogates">S: ${surr.map(tnum).join(',')}</span>` : ''}</td>
        <td><button class="btn small" data-match="${esc(m.key)}">${played ? 'Edit' : 'Enter'}</button></td></tr>`;
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
      <p class="help">Predictions use the current ratings (for played matches this includes the match itself). Bonus columns show Red/Blue chances for each bonus RP. Click a match to enter or correct its result — ratings update instantly.</p>
      <div class="table-wrap"><table><thead><tr><th>Match</th><th>Red</th><th>Blue</th><th>Win chance</th><th class="n">Pred.</th><th>Bonus RP chance</th><th class="n">Result</th><th></th><th></th></tr></thead>
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
        ${statCard('Score', `<span class="red-t">${f1(p.red.score, 0)}</span>–<span class="blue-t">${f1(p.blue.score, 0)}</span>`, 'no fouls')}
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
        <div class="field"><label>Our team number</label><input id="ourTeam" value="${esc(tnum(s.ourTeam))}" style="width:100px"></div>
        <div class="field"><label>Bonus RP thresholds (auto-corrected from results after ~3 matches)</label><select id="level">${['regional', 'dcmp', 'cmp'].map(l => `<option value="${l}" ${(ev && ev.level) === l ? 'selected' : ''}>${{ regional: 'Regional / District / Offseason', dcmp: 'District Championship', cmp: 'FIRST Championship' }[l]}</option>`).join('')}</select></div>
        <div class="field"><label>Prior strength (matches-worth of earlier events)</label><input id="lambda" type="number" step="0.5" min="0.5" value="${(s.model && s.model.lambda) || Model.DEFAULT_SETTINGS.lambda}"></div>
        <div class="field"><label>Playoff match weight</label><input id="elimWeight" type="number" step="0.05" min="0" max="1" value="${f1((s.model && s.model.elimWeight != null ? s.model.elimWeight : Model.DEFAULT_SETTINGS.elimWeight), 2)}"></div>
        <div class="field"><label>Scouting observation weight</label><input id="scoutWeight" type="number" step="0.25" min="0" value="${(s.model && s.model.scoutWeight != null ? s.model.scoutWeight : Model.DEFAULT_SETTINGS.scoutWeight)}"></div>
        <p class="help">Defaults were tuned by backtesting on the full 2026 season (predicts 78% of official-event match winners) and 2019. Higher prior strength trusts earlier events more.</p>
        <p class="help">Storage used: ${Store.usageKB() != null ? Store.usageKB() + ' KB' : 'unknown'} ${Store.ok ? '' : '<b class="neg">— browser storage is blocked; export regularly!</b>'}</p>
      </div>

      <div class="card"><h3>2 · Back up / share (no wifi needed)</h3>
        <p class="help">Export a file and move it with AirDrop or a USB stick. Importing merges with what's already here (newest result for each match wins).</p>
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
      const out = m.out && m.out[k];
      return `<tr><td><a data-match="${esc(m.key)}">${matchLabel(m)}</a>${surr ? ' <span class="pill muted">surrogate</span>' : ''}${out ? ' <span class="pill bad">no-show</span>' : ''}</td>
        <td class="${onRed ? 'red-t' : 'blue-t'}">${onRed ? 'Red' : 'Blue'}</td><td>${partners.map(t => teamLink(t)).join(' ')}</td><td>${opps.map(t => teamLink(t)).join(' ')}</td>
        <td class="n">${pct(pw)}</td><td>${res}</td></tr>`;
    }).join('');
    const sc = r.scout;
    const scCols = (ev.scouting && ev.scouting.columns) || [];
    openModal(`<h2>${teamLink(k)} ${esc(r.name)} <a data-star="${k}" style="font-size:20px">${r.starred ? '★' : '☆'}</a></h2>
      <div class="stats" style="margin-bottom:14px">
        ${statCard('True Potential', f1(r.tp), '± ' + f1(r.tpSd))}
        ${statCard('Rank', r.rank ? '#' + r.rank : '–', r.rs != null ? 'RS ' + f1(r.rs, 2) + ' · ' + r.rec : '')}
        ${statCard('True rank', '#' + r.trueRank)}
        ${statCard('Luck-adj. RS', f1(r.adjRS, 2))}
        ${statCard('Schedule luck', `<span class="${cls(r.luck)}">${sgn(r.luck)}</span>`, `ease ${f1(r.easePct, 0)}%ile`)}
        ${statCard('Proj. rank', f1(r.expRank, 1), r.sim ? `P(top 8) ${pct(r.p8)}` : '')}
      </div>
      <div class="split">
        <div><h3>Ratings</h3><table><thead><tr><th></th><th class="n">Now</th><th class="n">Rank</th><th class="n" title="Average of earlier events">Prior</th><th class="n" title="Matches of data at this event">Data</th></tr></thead><tbody>${compRows}</tbody></table>
          <p class="help">${ev.priorMeta && ev.priorMeta.count && ev.priorMeta.count[k] ? `Prior from ${ev.priorMeta.count[k]} earlier event(s).` : 'No earlier-event data — starts near event average.'} Plain OPR: ${f1(r.opr)}.</p>
          ${L ? `<p class="help">Schedule: partners vs. opponents ${sgn(L.tailwind, 1)} pts/match vs. average. Expected RS on this schedule ${f1(L.eSched, 2)} vs. ${f1(L.eRand, 2)} on a random one.</p>` : ''}
          ${sc && sc.n ? `<h3>Scouting (${sc.n} entries)</h3><table><tbody>${scCols.filter(c => sc[c] != null).map(c => `<tr><td>${esc(c)}</td><td class="n">${f1(sc[c])}</td></tr>`).join('')}</tbody></table>` : ''}
          <h3 style="margin-top:12px">Notes</h3><textarea id="teamNotes" data-team-notes="${k}" rows="4" placeholder="Drive team notes, mechanisms, reliability…">${esc((ev.notes || {})[k] || '')}</textarea>
        </div>
        <div><h3>Matches</h3><table><thead><tr><th>Match</th><th></th><th>Partners</th><th>Opponents</th><th class="n">Win %</th><th>Result</th></tr></thead><tbody>${matchRows}</tbody></table></div>
      </div>`);
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
      const robots = `<div class="robots"><span class="sd">Team</span><span class="sd">${lv ? 'Auto tower' : ''}</span><span class="sd">${lv ? 'End tower' : ''}</span><span class="sd">No-show</span>
        ${[0, 1, 2].map(k => {
          const rb = v.robots && v.robots[k];
          const t = teams[k] || '';
          return `<input class="tm" data-t="${side}.${k}" value="${esc(tnum(t))}">
            ${lv ? `<select data-ra="${side}.${k}">${lv.auto.map(o => `<option ${rb && rb.autoLevel === o ? 'selected' : ''}>${o}</option>`).join('')}</select>
            <select data-re="${side}.${k}">${lv.end.map(o => `<option ${rb && rb.endLevel === o ? 'selected' : ''}>${o}</option>`).join('')}</select>` : '<span></span><span></span>'}
            <input type="checkbox" data-out="${side}.${k}" ${t && m.out && m.out[t] ? 'checked' : ''}>`;
        }).join('')}</div>`;
      return `<div class="side ${side === 'r' ? 'red' : 'blue'}"><h4>${label}</h4>${robots}${fields}${rp}${bon}</div>`;
    };
    openModal(`<h2>${isNew ? 'New match' : matchLabel(m)}</h2>
      <div class="toolbar"><label>Level <select id="mComp">${['qm', 'sf', 'f'].map(c => `<option value="${c}" ${m.comp === c ? 'selected' : ''}>${{ qm: 'Qualification', sf: 'Playoff', f: 'Final' }[c]}</option>`).join('')}</select></label>
        <label>Number <input id="mNum" type="number" min="1" value="${m.comp === 'sf' ? m.set : m.num}" style="width:70px"></label>
        <span class="help">Only the final score is required. Tower levels per robot are the most valuable extra info (they rate each robot directly).</span></div>
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
    m.out = {};
    for (const side of ['r', 'b']) [0, 1, 2].forEach(k => {
      const el = document.querySelector(`[data-out="${side}.${k}"]`);
      const t = (side === 'r' ? red : blue)[k];
      if (el && el.checked && t) m.out[t] = true;
    });
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
    const head = ['team', 'name', 'true_potential', 'tp_sd', 'auto', 'fuel', 'auto_fuel', 'tower', 'fouls_given', 'opr', 'rank', 'rs', 'adj_rs', 'schedule_luck', 'ease_pct', 'true_rank', 'proj_rank', 'p_top8', 'notes'];
    const q = v => (typeof v === 'string' ? '"' + v.replace(/"/g, '""') + '"' : v == null || !isFinite(v) ? '' : +v.toFixed(3));
    const lines = [head.join(',')].concat(rows.map(r => [r.num, r.name, r.tp, r.tpSd, r.auto, r.fuel, r.autoFuel, r.tower, r.fouls, r.opr, r.rank, r.rs, r.adjRS, r.luck, r.easePct, r.trueRank, r.expRank, r.p8, (S.event.notes || {})[r.key] || ''].map(q).join(',')));
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
      const lowFirst = ['num', 'rank', 'trueRank', 'expRank', 'fouls', 'gap', 'range', 'name'].includes(el.dataset.sort);
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
    if (el.id === 'hidePicked') { S.hidePicked = el.checked; render(); return; }
    if (el.id === 'matchFilter') { S.matchFilter = el.value; render(); return; }
    if (el.id === 'nSims') { S.settings.nSims = +el.value; Store.saveSettings(S.settings); S.sim = null; render(); scheduleSim(); return; }
    if (el.id === 'ourTeam') { S.settings.ourTeam = el.value.trim() ? tkey(el.value) : ''; Store.saveSettings(S.settings); render(); loadCatalogueAndShow(true); return; }
    if (el.id === 'tbaKey') { S.settings.tbaKey = el.value.trim(); Store.saveSettings(S.settings); loadCatalogueAndShow(true); return; }
    if (el.id === 'evYear') { S.evYear = +el.value; refreshEventResults(); loadCatalogueAndShow(false); return; }
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
    if (!typing && $('#modal').hidden && /^[1-7]$/.test(e.key) && !e.metaKey && !e.ctrlKey) {
      S.tab = ['overview', 'teams', 'luck', 'matches', 'forecast', 'predict', 'data'][+e.key - 1];
      render();
    }
  });

  window.addEventListener('online', () => { renderStatus(); autoSyncTick(true); });
  window.addEventListener('offline', renderStatus);

  // ---------- boot ----------
  const cur = S.settings.current && Store.loadEvent(S.settings.current);
  if (cur) setEvent(cur); else { S.tab = Store.listEvents().length ? 'data' : 'overview'; render(); }
  autoSyncTick(true);
})();

// The Blue Alliance API v3 import. Only used while online (e.g. at home before
// the event); everything it fetches is stored locally so the tool works offline.
(function (root) {
  'use strict';
  const BASE = 'https://www.thebluealliance.com/api/v3';

  async function get(path, apiKey) {
    const opts = { headers: { 'X-TBA-Auth-Key': apiKey } };
    // In the browser, 'no-cache' revalidates with TBA's ETag: unchanged data costs a tiny 304.
    if (typeof window !== 'undefined') opts.cache = 'no-cache';
    const res = await fetch(BASE + path, opts);
    if (res.status === 401) throw new Error('TBA rejected the API key (401). Get a read key at thebluealliance.com/account.');
    if (res.status === 404) throw new Error('Not found on TBA: ' + path);
    if (!res.ok) throw new Error('TBA error ' + res.status + ' for ' + path);
    return res.json();
  }

  // Run async tasks with limited concurrency.
  async function pool(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    async function worker() {
      while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  }

  function convertMatch(m, game) {
    const red = m.alliances.red, blue = m.alliances.blue;
    const bd = m.score_breakdown || null;
    const played = red.score != null && red.score >= 0 && blue.score != null && blue.score >= 0;
    const out = {
      key: m.key, comp: m.comp_level, set: m.set_number, num: m.match_number,
      red: red.team_keys, blue: blue.team_keys,
      redSurr: red.surrogate_team_keys || [], blueSurr: blue.surrogate_team_keys || [],
      redDQ: red.dq_team_keys || [], blueDQ: blue.dq_team_keys || [],
      played, source: 'tba', time: m.actual_time || m.predicted_time || m.time || null,
    };
    if (played) {
      out.r = game.fromTba(bd && bd.red, bd && bd.blue, red.score);
      out.b = game.fromTba(bd && bd.blue, bd && bd.red, blue.score);
    }
    return out;
  }

  // End-of-event ratings for one earlier event (no priors), used to build priors.
  function rateEvent(evKey, rawMatches, game, year) {
    const matches = rawMatches.filter(m => m.comp_level === 'qm').map(m => convertMatch(m, game));
    const teams = [...new Set(matches.flatMap(m => m.red.concat(m.blue)))];
    if (!teams.length || !matches.some(m => m.played)) return null;
    const ev = { key: evKey, year, teams, matches };
    const R = root.Model.fit(ev, game, { lambda: 1.5, lambdaNew: 1.5, newFactor: 1 });
    const ratings = {};
    R.teams.forEach((t, i) => {
      ratings[t] = {};
      for (const c of game.comps) if (R.comps[c.key].available && R.comps[c.key].nObs[i] > 0) ratings[t][c.key] = R.comps[c.key].mean[i];
    });
    const s2 = {};
    for (const c of game.comps) if (R.comps[c.key].available) s2[c.key] = R.comps[c.key].s2;
    return { ratings, s2 };
  }

  // Combine earlier-event ratings into per-team priors (plain mean; backtests on
  // 2019 showed the mean of all earlier events beats "most recent only").
  function buildPriors(event, game) {
    const priors = {}, count = {};
    const s2s = {};
    for (const t of event.teams) {
      const evs = (event.teamPriorEvents && event.teamPriorEvents[t]) || [];
      const acc = {};
      let n = 0;
      for (const ek of evs) {
        const pe = event.priorEvents[ek];
        if (!pe || !pe.ratings[t]) continue;
        n++;
        for (const [c, v] of Object.entries(pe.ratings[t])) (acc[c] = acc[c] || []).push(v);
      }
      if (!n) continue;
      priors[t] = {};
      for (const [c, vs] of Object.entries(acc)) priors[t][c] = vs.reduce((a, b) => a + b, 0) / vs.length;
      count[t] = n;
    }
    for (const pe of Object.values(event.priorEvents || {})) for (const [c, v] of Object.entries(pe.s2 || {})) (s2s[c] = s2s[c] || []).push(v);
    const sigma2 = {};
    for (const [c, vs] of Object.entries(s2s)) { vs.sort((a, b) => a - b); sigma2[c] = vs[vs.length >> 1]; }
    event.priors = priors;
    event.priorMeta = { count, sigma2, source: 'tba', built: Date.now() };
  }

  async function importEvent(eventKey, apiKey, log, existing) {
    eventKey = eventKey.trim().toLowerCase();
    log('Fetching event ' + eventKey + '…');
    const info = await get('/event/' + eventKey, apiKey);
    const year = info.year;
    const game = root.Games.getGame(year);
    const [teams, matches] = await Promise.all([
      get('/event/' + eventKey + '/teams/simple', apiKey),
      get('/event/' + eventKey + '/matches', apiKey),
    ]);
    log(`${teams.length} teams, ${matches.length} matches (${matches.filter(m => m.alliances.red.score >= 0).length} played).`);
    const event = existing || { schema: 1, notes: {}, starred: {}, picked: {}, created: Date.now() };
    Object.assign(event, {
      key: eventKey, name: info.name, year, level: root.Games.levelFromEventType(info.event_type),
      eventType: info.event_type, startDate: info.start_date, endDate: info.end_date,
      teams: teams.map(t => t.key).sort(root.Model.teamCmp),
      teamNames: Object.fromEntries(teams.map(t => [t.key, t.nickname || ''])),
    });
    mergeTbaMatches(event, matches.map(m => convertMatch(m, game)));

    log('Finding each team\'s earlier ' + year + ' events…');
    event.priorEvents = event.priorEvents || {};
    event.teamPriorEvents = {};
    const lists = await pool(event.teams, 6, t => get('/team/' + t + '/events/' + year + '/simple', apiKey).catch(() => []));
    const needed = new Set();
    event.teams.forEach((t, i) => {
      const evs = (lists[i] || []).filter(e => e.key !== eventKey && e.event_type !== 100 &&
        (!info.start_date || (e.end_date && e.end_date <= info.start_date) || (e.start_date && e.start_date < info.start_date)));
      event.teamPriorEvents[t] = evs.map(e => e.key);
      evs.forEach(e => needed.add(e.key));
    });
    const todo = [...needed].filter(k => !event.priorEvents[k]);
    log(`${needed.size} earlier events (${todo.length} to download)…`);
    let done = 0;
    await pool(todo, 5, async ek => {
      try {
        const ms = await get('/event/' + ek + '/matches', apiKey);
        const r = rateEvent(ek, ms, game, year);
        if (r) event.priorEvents[ek] = r;
      } catch (e) { log('  skipped ' + ek + ': ' + e.message); }
      done++;
      if (done % 5 === 0 || done === todo.length) log(`  rated ${done}/${todo.length} earlier events`);
    });
    buildPriors(event, game);
    await buildPrevYear(event, year - 1, apiKey, log);
    const nPrev = event.teams.filter(t => !event.priors[t] && event.relPriors && event.relPriors[t] != null).length;
    log(`Priors ready: ${Object.keys(event.priors).length} teams from ${year} events, ${nPrev} more from ${year - 1}, ` +
      `${event.teams.length - Object.keys(event.priors).length - nPrev} starting at average.`);
    event.tbaSynced = Date.now();
    return event;
  }

  // Last season's strength for teams with no events yet this season (week 1, or
  // teams new to offseasons). Backtest on 2026: +1.7 pts overall accuracy, +7 pts
  // early at events where most teams have no history. Uses TBA's per-event OPRs
  // (small files); relative strength = team's average OPR / average of all OPRs fetched.
  async function buildPrevYear(event, prevYear, apiKey, log) {
    const need = event.teams.filter(t => !event.priors[t] && /^frc\d+$/.test(t));
    if (!need.length) return;
    log(`Looking up ${prevYear} results for ${need.length} team(s) with no ${prevYear + 1} history…`);
    const lists = await pool(need, 6, t => get('/team/' + t + '/events/' + prevYear + '/keys', apiKey).catch(() => []));
    const evKeys = [...new Set(lists.flat())];
    event.prevOprs = {};
    const todo = evKeys;
    await pool(todo, 6, async k => {
      try {
        const o = await get('/event/' + k + '/oprs', apiKey);
        if (o && o.oprs) event.prevOprs[k] = o.oprs;
      } catch (e) { /* event without OPRs */ }
    });
    let sum = 0, n = 0;
    for (const k of evKeys) for (const v of Object.values(event.prevOprs[k] || {})) if (isFinite(v)) { sum += v; n++; }
    if (!n) return;
    const mean = sum / n;
    event.relPriors = event.relPriors || {};
    need.forEach((t, i) => {
      const vs = (lists[i] || []).map(k => event.prevOprs[k] && event.prevOprs[k][t]).filter(v => isFinite(v));
      if (vs.length) event.relPriors[t] = Math.max(0, Math.min(4, vs.reduce((a, b) => a + b, 0) / vs.length / mean));
    });
    delete event.prevOprs; // only the derived relative strengths are kept
  }

  // TBA results win over manual entries once TBA has the match as played;
  // manual results are kept for matches TBA does not have yet.
  function mergeTbaMatches(event, incoming) {
    const byKey = {};
    for (const m of event.matches || []) byKey[m.key] = m;
    for (const m of incoming) {
      const old = byKey[m.key];
      if (old && old.played && !m.played) continue; // keep manual result
      if (old && old.out) m.out = old.out;
      if (old && old.issues) m.issues = old.issues; // robot problems are ours, TBA doesn't know them
      byKey[m.key] = m;
    }
    event.matches = root.Model.sortMatches(Object.values(byKey));
    // Offseason "B" robots (frc190B) play matches but are missing from /teams.
    const known = new Set(event.teams || []);
    for (const m of event.matches) for (const t of m.red.concat(m.blue)) if (!known.has(t)) { known.add(t); event.teams.push(t); }
    event.teams.sort(root.Model.teamCmp);
  }

  async function refreshMatches(event, apiKey) {
    const game = root.Games.getGame(event.year);
    const matches = await get('/event/' + event.key + '/matches', apiKey);
    const sig = () => Object.fromEntries((event.matches || []).map(m => [m.key, m.played ? m.r.score + '-' + m.b.score : '']));
    const before = sig();
    mergeTbaMatches(event, matches.map(m => convertMatch(m, game)));
    const after = sig();
    let newResults = 0, changed = 0;
    for (const [k, v] of Object.entries(after)) {
      if (v && !before[k]) newResults++;
      else if (v !== (before[k] || '')) changed++;
    }
    event.tbaSynced = Date.now();
    return { total: matches.length, newResults, changed };
  }

  // Event catalogue for search (one small request per season, cached by the app).
  async function listEvents(year, apiKey) {
    const evs = await get('/events/' + year + '/simple', apiKey);
    return evs.filter(e => e.event_type !== 100).map(e => ({
      key: e.key, name: e.name, code: e.event_code, type: e.event_type,
      city: e.city || '', state: e.state_prov || '', country: e.country || '',
      start: e.start_date, end: e.end_date,
    }));
  }

  async function teamEventKeys(team, year, apiKey) {
    return get('/team/' + team + '/events/' + year + '/keys', apiKey);
  }

  root.TBA = { listEvents, teamEventKeys, importEvent, refreshMatches, buildPriors, convertMatch, rateEvent };
})(typeof window !== 'undefined' ? window : globalThis);

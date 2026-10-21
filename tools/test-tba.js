#!/usr/bin/env node
// Tests the TBA import path against a mock API that returns 2026-format JSON
// (field names from the TBA v3 OpenAPI spec): node tools/test-tba.js
'use strict';
const assert = require('assert');
require('../js/linalg.js');
const Games = require('../js/games.js');
const Model = require('../js/model.js');
const Demo = require('../js/demo.js');
require('../js/tba.js');
const TBA = globalThis.TBA;

// Build TBA-shaped data from two synthetic events: an earlier one (for priors) and the target.
function toTba(ev, key) {
  const lvlName = { None: 'None', Level1: 'Level1', Level2: 'Level2', Level3: 'Level3' };
  return ev.matches.map(m => {
    const al = (teams, surr, v) => ({ team_keys: teams, surrogate_team_keys: surr || [], dq_team_keys: [], score: m.played ? v.score : -1 });
    const bd = v => {
      if (!m.played) return null;
      const o = {
        foulPoints: v.foulRecv, totalAutoPoints: v.auto, totalTowerPoints: v.tower, totalPoints: v.score, rp: null,
        energizedAchieved: v.bonus.energized, superchargedAchieved: v.bonus.supercharged, traversalAchieved: v.bonus.traversal,
        hubScore: { autoCount: v.autoFuel, totalCount: v.fuel, teleopCount: v.fuel - v.autoFuel },
      };
      v.robots.forEach((r, i) => { o['autoTowerRobot' + (i + 1)] = lvlName[r.autoLevel]; o['endGameTowerRobot' + (i + 1)] = lvlName[r.endLevel]; });
      return o;
    };
    return {
      key: key + '_qm' + m.num, comp_level: 'qm', set_number: 1, match_number: m.num, event_key: key,
      alliances: { red: al(m.red, m.redSurr, m.r), blue: al(m.blue, m.blueSurr, m.b) },
      score_breakdown: m.played ? { red: bd(m.r), blue: bd(m.b) } : null,
      winning_alliance: m.played ? (m.r.score > m.b.score ? 'red' : m.b.score > m.r.score ? 'blue' : '') : '',
    };
  });
}

const earlier = Demo.makeDemoEvent({ seed: 11, playedFrac: 1 });
const target = Demo.makeDemoEvent({ seed: 11, playedFrac: 0.4 }); // same teams/abilities, new schedule draw
const routes = {
  '/event/2026test': { key: '2026test', name: 'Test Regional', year: 2026, event_type: 0, start_date: '2026-03-20', end_date: '2026-03-22' },
  '/event/2026test/teams/simple': target.teams.map(t => ({ key: t, team_number: +t.slice(3), nickname: 'Team ' + t.slice(3) })),
  '/event/2026test/matches': toTba(target, '2026test'),
  '/event/2026early/matches': toTba(earlier, '2026early'),
};
for (const t of target.teams) {
  routes['/team/' + t + '/events/2026/simple'] = [
    { key: '2026early', event_type: 0, start_date: '2026-03-06', end_date: '2026-03-08' },
    { key: '2026test', event_type: 0, start_date: '2026-03-20', end_date: '2026-03-22' },
    { key: '2026later', event_type: 0, start_date: '2026-04-02', end_date: '2026-04-04' },
  ];
}
let calls = 0;
globalThis.fetch = async (url, opts) => {
  calls++;
  assert(opts.headers['X-TBA-Auth-Key'] === 'KEY', 'auth header sent');
  const p = url.replace('https://www.thebluealliance.com/api/v3', '');
  if (!(p in routes)) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(routes[p])) };
};

(async () => {
  const logs = [];
  const ev = await TBA.importEvent('2026test', 'KEY', m => logs.push(m));
  console.log(logs.join('\n'));
  const game = Games.getGame(2026);
  assert.strictEqual(ev.teams.length, target.teams.length);
  assert.strictEqual(ev.level, 'regional');
  assert(ev.priorEvents['2026early'], 'earlier event rated');
  assert(!ev.priorEvents['2026later'], 'later event must not be used as a prior');
  const played = ev.matches.filter(Model.isPlayed);
  assert.strictEqual(played.length, target.matches.filter(m => m.played).length);
  const m0 = played[0], src = target.matches[0];
  assert.strictEqual(m0.r.fuel, src.r.fuel, 'fuel parsed from hubScore.totalCount');
  assert.strictEqual(m0.r.tower, src.r.tower, 'tower parsed');
  assert.strictEqual(m0.r.total, src.r.total, 'no-foul total = score - foulPoints');
  assert.strictEqual(m0.r.fouls, src.b.foulRecv, 'fouls given = opponent foulPoints');
  assert.deepStrictEqual(m0.r.robots.map(r => r.tower), src.r.robots.map(r => r.tower), 'per-robot tower points');
  assert(Object.keys(ev.priors).length === target.teams.length, 'every team has a prior');
  // Priors from the earlier event should track the hidden truth.
  const ts = ev.teams;
  const pr = ts.map(t => ev.priors[t].fuel), tr = ts.map(t => target.truth[t].fuel);
  const mean = a => a.reduce((x, y) => x + y) / a.length;
  const ma = mean(pr), mb = mean(tr);
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < ts.length; i++) { sab += (pr[i] - ma) * (tr[i] - mb); saa += (pr[i] - ma) ** 2; sbb += (tr[i] - mb) ** 2; }
  const r = sab / Math.sqrt(saa * sbb);
  console.log(`prior fuel vs truth r=${r.toFixed(3)}, ${calls} API calls`);
  assert(r > 0.8);
  const R = Model.fit(ev, game);
  assert.strictEqual(Model.bonusMode(R), 'threshold');
  // Refresh merge keeps manual results TBA doesn't have yet.
  const unplayed = ev.matches.find(m => !Model.isPlayed(m));
  unplayed.played = true; unplayed.r = { score: 100, total: 100 }; unplayed.b = { score: 90, total: 90 }; unplayed.source = 'manual';
  const tbaPlayed = ev.matches.find(m => Model.isPlayed(m) && m.source === 'tba');
  tbaPlayed.issues = { [tbaPlayed.red[0]]: { type: 'broke', when: 'auto', what: 'electrical' } };
  await TBA.refreshMatches(ev, 'KEY');
  assert(Model.isPlayed(ev.matches.find(m => m.key === unplayed.key)), 'manual result kept after refresh');
  assert.strictEqual(ev.matches.find(m => m.key === tbaPlayed.key).issues[tbaPlayed.red[0]].what, 'electrical', 'robot problems survive a TBA refresh');
  console.log('TBA IMPORT TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });

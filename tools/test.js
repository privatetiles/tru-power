#!/usr/bin/env node
// Sanity tests on a synthetic 2026 event: node tools/test.js
'use strict';
const assert = require('assert');
require('../js/linalg.js');
const Games = require('../js/games.js');
const Model = require('../js/model.js');
const Sim = require('../js/sim.js');
const Demo = require('../js/demo.js');

const game = Games.getGame(2026);
const ev = Demo.makeDemoEvent({ seed: 7, playedFrac: 0.55 });
const played = ev.matches.filter(Model.isPlayed).length;
console.log(`demo: ${ev.teams.length} teams, ${ev.matches.length} quals, ${played} played`);

let t0 = Date.now();
const R = Model.fit(ev, game);
const Rprior = Model.fit(ev, game, null, { priorOnly: true });
console.log(`fit: ${Date.now() - t0} ms, bonus mode ${Model.bonusMode(R)}, corr ${JSON.stringify(R.corr)}`);

// Ratings should track hidden truth better than the priors alone.
function corr(a, b) {
  const n = a.length, ma = a.reduce((x, y) => x + y) / n, mb = b.reduce((x, y) => x + y) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return sab / Math.sqrt(saa * sbb);
}
const trueFuel = R.teams.map(t => ev.truth[t].fuel);
const cPost = corr(Array.from(R.comps.fuel.mean), trueFuel);
const cPrior = corr(Array.from(Rprior.comps.fuel.mean), trueFuel);
const cOpr = R.opr ? corr(Array.from(R.opr), trueFuel) : NaN;
console.log(`fuel vs truth: posterior r=${cPost.toFixed(3)}, prior-only r=${cPrior.toFixed(3)}, raw OPR(total) r=${cOpr.toFixed(3)}`);
assert(cPost > cPrior, 'posterior should beat prior');
assert(cPost > 0.8, 'posterior should correlate strongly with truth');

// Per-robot tower data should give tight tower estimates.
const trueTower = R.teams.map(t => { const c = ev.truth[t].climb; return 10 * c + 10 * c * c + 10 * c ** 3 + (ev.truth[t].autoClimb ? 11.25 : 0); });
console.log(`tower vs truth r=${corr(Array.from(R.comps.tower.mean), trueTower).toFixed(3)}`);

// Prediction sanity.
const m = ev.matches.find(x => !Model.isPlayed(x));
const p = Model.predictMatch(R, m.red, m.blue);
console.log('next match prediction', JSON.stringify(p));
assert(p.pRed > 0 && p.pRed < 1);

t0 = Date.now();
const sim = Sim.simulateRankings(ev, R, { nSims: 5000 });
console.log(`sim 5000 runs, ${sim.remaining} remaining matches: ${Date.now() - t0} ms`);
const sumP1 = Object.values(sim.byTeam).reduce((a, x) => a + x.p1, 0);
assert(Math.abs(sumP1 - 1) < 1e-9, 'P(rank 1) sums to 1');
const sumP8 = Object.values(sim.byTeam).reduce((a, x) => a + x.p8, 0);
assert(Math.abs(sumP8 - 8) < 1e-9, 'P(top 8) sums to 8');

t0 = Date.now();
const luck = Sim.scheduleLuck(ev, R, Rprior);
console.log(`schedule luck: ${Date.now() - t0} ms`);
const luckVals = Object.values(luck).map(x => x.luck);
console.log(`luck range ${Math.min(...luckVals).toFixed(2)} .. ${Math.max(...luckVals).toFixed(2)} RP/match, mean ${(luckVals.reduce((a, b) => a + b) / luckVals.length).toFixed(3)}`);

const st = Model.standings(ev, game);
console.log('\nTop 8 now     team     RS    adjRS  luck  ease%  trueRank  P(top8)');
for (const s of st.slice(0, 8)) {
  const L = luck[s.team], S = sim.byTeam[s.team];
  console.log(`  #${String(s.rank).padEnd(3)} ${s.team.padEnd(9)} ${s.rs.toFixed(2)}  ${L.adjRS.toFixed(2)}  ${L.luck >= 0 ? '+' : ''}${L.luck.toFixed(2)}  ${L.easePct.toFixed(0).padStart(3)}    ${String(L.trueRank).padStart(3)}     ${(100 * S.p8).toFixed(0)}%`);
}

// Robot problems: a breakdown should stop a bad match from dragging a robot's rating down.
{
  const ev2 = JSON.parse(JSON.stringify(ev));
  const t = ev2.teams[3];
  const mine = ev2.matches.filter(m => Model.isPlayed(m) && (m.red.includes(t) || m.blue.includes(t)));
  const worst = mine.map(m => ({ m, side: m.red.includes(t) ? 'r' : 'b' })).sort((a, b) => a.m[a.side].total - b.m[b.side].total)[0];
  worst.m[worst.side].total = 0; worst.m[worst.side].fuel = 0; // a disastrous match
  const before = Model.fit(ev2, game).comps.total.mean[R.idx[t]];
  worst.m.issues = { [t]: { type: 'broke', when: 'teleop', what: 'drivetrain' } };
  const after = Model.fit(ev2, game).comps.total.mean[R.idx[t]];
  worst.m.issues = { [t]: { type: 'noshow' } };
  const noshow = Model.fit(ev2, game).comps.total.mean[R.idx[t]];
  console.log(`breakdown handling: TP with bad match ${before.toFixed(1)} → marked broke ${after.toFixed(1)}, no-show ${noshow.toFixed(1)}`);
  assert(after > before + 1, 'marking a breakdown should remove the penalty from that match');
  assert.strictEqual(Model.robotIssue(worst.m, t).type, 'noshow');
  assert.strictEqual(Model.robotIssue({ out: { [t]: true } }, t).type, 'noshow', 'legacy no-show flag still works');
}

// Reliability: repeated breakdowns lower a team's expected contribution in predictions,
// and with no problems recorded nothing changes.
{
  const ev3 = JSON.parse(JSON.stringify(ev));
  const t = ev3.teams[5];
  const base = Model.fit(ev3, game);
  assert(!base.rel.any, 'no recorded problems → reliability off');
  const mine = ev3.matches.filter(m => Model.isPlayed(m) && (m.red.includes(t) || m.blue.includes(t)));
  mine.slice(0, 3).forEach(m => { m.issues = { [t]: { type: 'broke', when: 'teleop', what: 'drivetrain' } }; });
  const R3 = Model.fit(ev3, game);
  const i = R3.idx[t];
  const others = ev3.teams.filter(x => x !== t).slice(0, 5);
  const pA = Model.predictMatch(R3, [t, others[0], others[1]], others.slice(2, 5));
  const R3off = Model.fit(ev3, game, { useReliability: false });
  const pB = Model.predictMatch(R3off, [t, others[0], others[1]], others.slice(2, 5));
  console.log(`reliability: ${t} problems 3/${mine.length}, chance of problem ${(100 * R3.rel.q[i]).toFixed(0)}%, delivers ${(100 * R3.rel.factor[i]).toFixed(0)}% of working strength; ` +
    `alliance score ${pB.red.score.toFixed(1)} → ${pA.red.score.toFixed(1)}, win ${(100 * pB.pRed).toFixed(1)}% → ${(100 * pA.pRed).toFixed(1)}%`);
  assert(pA.red.score < pB.red.score && pA.pRed < pB.pRed, 'unreliable robot lowers its alliance prediction');
  assert(R3.rel.factor[R3.idx[others[0]]] > R3.rel.factor[i], 'teams without problems rate as more reliable');
  const sim3 = Sim.simulateRankings(ev3, R3, { nSims: 1000 });
  assert(Math.abs(Object.values(sim3.byTeam).reduce((a, x) => a + x.p8, 0) - 8) < 1e-9);
}

// Trend detection: a team that gets much better halfway through is flagged; with no real
// change, few teams should be (false alarms).
{
  let falseAlarms = 0, total = 0, caught = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const evT = Demo.makeDemoEvent({ seed: 500 + seed, playedFrac: 1 });
    const t = evT.teams[seed];
    const mine = evT.matches.filter(m => Model.isPlayed(m) && (m.red.includes(t) || m.blue.includes(t)));
    const RT0 = Model.fit(evT, game);
    for (const k of evT.teams) { if (k === t) continue; const w = Model.trendWithin(evT, RT0, k); if (w) { total++; if (w.label !== 'steady') falseAlarms++; } }
    mine.slice(Math.floor(mine.length / 2)).forEach(m => { const s2 = m.red.includes(t) ? m.r : m.b; s2.total += 60; s2.fuel += 60; }); // big mid-event upgrade
    const w = Model.trendWithin(evT, Model.fit(evT, game), t);
    if (w && w.label === 'improving') caught++;
  }
  console.log(`trend detection: caught ${caught}/6 real upgrades, false alarms ${(100 * falseAlarms / total).toFixed(1)}% of ${total} unchanged teams`);
  assert(caught >= 4, 'should catch most real upgrades');
  assert(falseAlarms / total < 0.2, 'should rarely flag unchanged teams');
}

// Rating ranges: the 80% "likely range" should contain the hidden true strength ~80% of the time.
{
  let inside = 0, n = 0;
  for (const frac of [0.3, 0.6, 1]) for (let seed = 1; seed <= 8; seed++) {
    const evC = Demo.makeDemoEvent({ seed: 900 + seed, playedFrac: frac });
    const RC = Model.fit(evC, game);
    RC.teams.forEach((t, i) => {
      const tr = evC.truth[t], c = tr.climb;
      const truth = tr.fuel + 10 * c + 10 * c * c + 10 * c ** 3 + (tr.autoClimb ? 11.25 : 0);
      const mu = RC.comps.total.mean[i], sd = Math.sqrt(RC.comps.total.var[i]);
      n++; if (Math.abs(truth - mu) <= 1.2816 * sd) inside++;
    });
  }
  console.log(`rating ranges: true strength inside the 80% likely range ${(100 * inside / n).toFixed(1)}% of ${n} team-events`);
  assert(inside / n > 0.7 && inside / n < 0.92, 'likely ranges should be roughly honest');
}

// Generic game path (scores only).
const g19 = Games.getGame(2019);
const ev19 = { teams: ev.teams, year: 2019, matches: ev.matches.map(x => x.played ? { ...x, r: { score: x.r.score, total: x.r.score }, b: { score: x.b.score, total: x.b.score } } : x) };
const R19 = Model.fit(ev19, g19);
Sim.simulateRankings(ev19, R19, { nSims: 200 });
console.log('\ngeneric game path ok, bonus mode', Model.bonusMode(R19));
console.log('ALL TESTS PASSED');

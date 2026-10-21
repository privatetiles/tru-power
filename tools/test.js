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

// Robot path markers: snap exactly onto the traced line and point along its tangent.
{
  const P = require('../js/paths.js');
  const path = [];
  for (let i = 0; i <= 50; i++) P.addPoint(path, 100 + i * 8, 250 + 120 * Math.sin(i / 8)); // a wavy route
  P.addPoint(path, path[path.length - 1][0] + 1, path[path.length - 1][1]);                 // too close: dropped
  assert(path.length === 51, 'points closer than the minimum step are dropped');
  let worstOff = 0, worstAngle = 0;
  for (let k = 0; k < 200; k++) {
    const x = 100 + Math.random() * 400, y = 130 + Math.random() * 240;
    const hit = P.project(path, x, y);
    const ps = P.pose(path, hit.seg, hit.t);
    // On the line: the marker's position equals the projected point on its segment.
    worstOff = Math.max(worstOff, Math.hypot(ps.x - hit.x, ps.y - hit.y));
    // Tangent: the marker's direction equals that segment's direction.
    const [a, b] = [path[hit.seg], path[hit.seg + 1]];
    const segAngle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    worstAngle = Math.max(worstAngle, Math.abs(Math.atan2(Math.sin(ps.angle - segAngle), Math.cos(ps.angle - segAngle))));
    // Nothing on the path is closer than the projected point.
    for (const q of path) assert(Math.hypot(q[0] - x, q[1] - y) >= hit.dist - 1e-9);
  }
  assert(worstOff < 1e-9 && worstAngle < 1e-9, 'markers lie on the line along its tangent');
  assert(P.project(path, 900, 20).dist > P.SNAP, 'a click far from the line is too far to snap');
  const dup = [[0, 0], [10, 0], [10, 0], [10, 10]];
  assert(Math.abs(P.pose(dup, 1, 0.5).angle - Math.PI / 2) < 1e-9, 'a zero-length segment borrows the next direction');
  console.log(`path markers: max distance from line ${worstOff.toExponential(1)}, max tangent error ${worstAngle.toExponential(1)} rad over 200 random clicks`);
}

// Multiple strokes: joining and linking pieces must never move a marker or change its direction.
{
  const P = require('../js/paths.js');
  const mk = (x0, y0, dx, dy, n) => { const s = []; for (let i = 0; i < n; i++) P.addPoint(s, x0 + i * dx, y0 + i * dy + 10 * Math.sin(i)); return s; };
  const poses = (strokes, markers) => markers.map(m => P.pose(strokes[m.p], m.seg, m.t));
  const same = (a, b, flip) => a.every((q, i) => Math.hypot(q.x - b[i].x, q.y - b[i].y) < 1e-9 &&
    Math.abs(Math.atan2(Math.sin(q.angle + (flip && flip[i] ? Math.PI : 0) - b[i].angle), Math.cos(q.angle + (flip && flip[i] ? Math.PI : 0) - b[i].angle))) < 1e-9);
  // Auto-continue: a new stroke starting near the end of the first joins it.
  const strokes = [], markers = [];
  P.addStroke(strokes, markers, mk(50, 100, 12, 5, 20));
  markers.push({ p: 0, seg: 5, t: 0.4, note: 'a' }, { p: 0, seg: 15, t: 0.9, note: 'b' });
  const end0 = strokes[0][strokes[0].length - 1];
  const before = poses(strokes, markers);
  const r1 = P.addStroke(strokes, markers, mk(end0[0] + 8, end0[1] + 6, 10, -4, 15));
  assert(strokes.length === 1 && r1.joined.length === 1, 'a stroke starting at the previous end continues it');
  assert(same(poses(strokes, markers), before), 'markers unchanged after auto-continue');
  // A separate piece far away stays separate; then the link tool joins it.
  P.addStroke(strokes, markers, mk(700, 400, 8, -3, 12));
  assert(strokes.length === 2, 'a far-away stroke stays a separate piece');
  markers.push({ p: 1, seg: 4, t: 0.5, note: 'c' });
  const b2 = poses(strokes, markers);
  // Pick END of piece 1 and END of piece 0: piece 0 must be reversed so the route flows.
  const res = P.linkEnds(strokes, markers, { p: 1, end: 'end' }, { p: 0, end: 'end' });
  assert(res.ok && strokes.length === 1, 'link tool joins two pieces');
  const after = poses(strokes, markers);
  // Markers a and b were on the reversed piece: same spot, opposite direction. c unchanged.
  assert(same(after, b2, [true, true, false]), 'markers keep their exact spot through a link (reversed piece points the other way)');
  // Reverse twice = identity.
  const b3 = poses(strokes, markers); P.reverse(strokes, markers, 0); P.reverse(strokes, markers, 0);
  assert(same(poses(strokes, markers), b3), 'reversing twice restores markers');
  console.log('multi-stroke paths: auto-continue, separate pieces, link (with reversal) keep every marker exactly in place');
}

// Generic game path (scores only).
const g19 = Games.getGame(2019);
const ev19 = { teams: ev.teams, year: 2019, matches: ev.matches.map(x => x.played ? { ...x, r: { score: x.r.score, total: x.r.score }, b: { score: x.b.score, total: x.b.score } } : x) };
const R19 = Model.fit(ev19, g19);
Sim.simulateRankings(ev19, R19, { nSims: 200 });
console.log('\ngeneric game path ok, bonus mode', Model.bonusMode(R19));
console.log('ALL TESTS PASSED');

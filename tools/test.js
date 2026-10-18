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

// Generic game path (scores only).
const g19 = Games.getGame(2019);
const ev19 = { teams: ev.teams, year: 2019, matches: ev.matches.map(x => x.played ? { ...x, r: { score: x.r.score, total: x.r.score }, b: { score: x.b.score, total: x.b.score } } : x) };
const R19 = Model.fit(ev19, g19);
Sim.simulateRankings(ev19, R19, { nSims: 200 });
console.log('\ngeneric game path ok, bonus mode', Model.bonusMode(R19));
console.log('ALL TESTS PASSED');

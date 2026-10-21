#!/usr/bin/env node
// How much does per-robot scouted fuel sharpen the fuel rating? Simulated events where each
// robot's true fuel ability is known; scouts count each robot's fuel with ~10% error.
//   node tools/scouting-value.js
'use strict';
const LA = require('../js/linalg.js');
const Games = require('../js/games.js');
const Model = require('../js/model.js');
const Demo = require('../js/demo.js');
const game = Games.getGame(2026);

function corr(a, b) {
  const n = a.length, ma = a.reduce((x, y) => x + y) / n, mb = b.reduce((x, y) => x + y) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return sab / Math.sqrt(saa * sbb);
}
const rng = LA.makeRng(4);
for (const frac of [0.25, 0.5, 1]) {
  const res = { none: [], w1: [], w3: [], rmseNone: [], rmseW3: [] };
  for (let seed = 1; seed <= 12; seed++) {
    const ev = Demo.makeDemoEvent({ seed: 300 + seed, playedFrac: frac });
    ev.priors = {}; ev.priorMeta = {}; // no earlier events: isolate what this event's data shows
    const truth = ev.teams.map(t => ev.truth[t].fuel);
    const rows = [];
    for (const m of ev.matches) {
      if (!Model.isPlayed(m)) continue;
      for (const [teams, v] of [[m.red, m.r], [m.blue, m.b]]) teams.forEach((t, k) => {
        rows.push({ team: t, match: m.key, values: { fuel: Math.max(0, Math.round(v.robots[k].trueFuel * (1 + 0.1 * rng.normal()))) } });
      });
    }
    const run = (sc, w) => {
      const R = Model.fit(Object.assign({}, ev, { scouting: sc }), game, { scoutWeight: w });
      return Array.from(R.comps.fuel.mean);
    };
    const a = run(null, 1), b = run({ rows, map: { fuel: 'fuel' } }, 1), c = run({ rows, map: { fuel: 'fuel' } }, 3);
    res.none.push(corr(a, truth)); res.w1.push(corr(b, truth)); res.w3.push(corr(c, truth));
    const rmse = x => Math.sqrt(x.reduce((s, v, i) => s + (v - truth[i]) ** 2, 0) / x.length);
    res.rmseNone.push(rmse(a)); res.rmseW3.push(rmse(c));
  }
  const avg = a => a.reduce((x, y) => x + y) / a.length;
  const mp = Math.round(frac * 12);
  console.log(`~${mp} matches per team: fuel rating vs true ability r = ${avg(res.none).toFixed(3)} from scores only, ` +
    `${avg(res.w1).toFixed(3)} with scouting (weight 1), ${avg(res.w3).toFixed(3)} (weight 3); ` +
    `typical error ${avg(res.rmseNone).toFixed(1)} → ${avg(res.rmseW3).toFixed(1)} fuel`);
}

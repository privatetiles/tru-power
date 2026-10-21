#!/usr/bin/env node
// How much does per-robot scouted fuel sharpen the fuel rating? Simulated events where each
// robot's true fuel ability is known. Scouts count each robot's fuel with error; in the
// "biased" scenarios each scout also has a personal bias (e.g. always undercounts by 15%).
// "Shares" uses scouts only for each robot's share of the official alliance total
// (official fuel × robot count / scouted alliance count), which cancels a scout's bias.
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
const avg = a => a.reduce((x, y) => x + y) / a.length;

const scenarios = [
  { name: 'careful scouts (±10%)', noise: 0.1, bias: 0 },
  { name: 'sloppy scouts (±30%)', noise: 0.3, bias: 0 },
  { name: 'biased scouts (±10%, each scout off by up to ±25%)', noise: 0.1, bias: 0.25 },
];
for (const sc of scenarios) {
  console.log(`\n${sc.name}`);
  for (const frac of [0.25, 0.5, 1]) {
    const res = { none: [], raw: [], share: [], eNone: [], eRaw: [], eShare: [] };
    const rng = LA.makeRng(4);
    for (let seed = 1; seed <= 12; seed++) {
      const ev = Demo.makeDemoEvent({ seed: 300 + seed, playedFrac: frac });
      ev.priors = {}; ev.priorMeta = {}; // isolate what this event's data shows
      const truth = ev.teams.map(t => ev.truth[t].fuel);
      // Six scouts, one per driver-station slot, each with a personal bias.
      const scoutBias = Array.from({ length: 6 }, () => 1 + sc.bias * (2 * rng.uniform() - 1));
      const raw = [], share = [];
      for (const m of ev.matches) {
        if (!Model.isPlayed(m)) continue;
        [[m.red, m.r, 0], [m.blue, m.b, 3]].forEach(([teams, v, s0]) => {
          const counts = teams.map((t, k) => Math.max(0, Math.round(v.robots[k].trueFuel * scoutBias[s0 + k] * (1 + sc.noise * rng.normal()))));
          const tot = counts.reduce((a, b) => a + b, 0);
          teams.forEach((t, k) => {
            raw.push({ team: t, match: m.key, values: { fuel: counts[k] } });
            share.push({ team: t, match: m.key, values: { fuel: tot > 0 ? v.fuel * counts[k] / tot : v.fuel / 3 } });
          });
        });
      }
      const run = rows => Array.from(Model.fit(Object.assign({}, ev, { scouting: rows && { rows, map: { fuel: 'fuel' } } }), game).comps.fuel.mean);
      const rmse = x => Math.sqrt(x.reduce((s, v, i) => s + (v - truth[i]) ** 2, 0) / x.length);
      const a = run(null), b = run(raw), c = run(share);
      res.none.push(corr(a, truth)); res.raw.push(corr(b, truth)); res.share.push(corr(c, truth));
      res.eNone.push(rmse(a)); res.eRaw.push(rmse(b)); res.eShare.push(rmse(c));
    }
    console.log(`  ~${Math.round(frac * 12)} matches/team: r = ${avg(res.none).toFixed(3)} scores only · ${avg(res.raw).toFixed(3)} raw counts · ${avg(res.share).toFixed(3)} shares of official total` +
      `   (typical error ${avg(res.eNone).toFixed(1)} · ${avg(res.eRaw).toFixed(1)} · ${avg(res.eShare).toFixed(1)} fuel)`);
  }
}

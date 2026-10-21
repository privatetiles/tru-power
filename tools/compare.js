#!/usr/bin/env node
// Compare two sets of match predictions on the same matches, with uncertainty that respects
// how the data is grouped: matches at one event share teams, so they are not independent.
// The confidence interval comes from resampling whole events (cluster bootstrap).
//
//   node tools/compare.js <matches-dir> <predsA.json> <predsB.json> [nameA] [nameB]
//
// preds files map match key -> predicted red-win probability (backtest-tba.js / epa-baseline.js --dump).
'use strict';
const fs = require('fs');
const path = require('path');
const LA = require('../js/linalg.js');

const [dir, fa, fb, nameA = 'A', nameB = 'B'] = process.argv.slice(2);
if (!fb) { console.error('usage: compare.js <matches-dir> <predsA.json> <predsB.json> [nameA] [nameB]'); process.exit(1); }
const A = JSON.parse(fs.readFileSync(fa, 'utf8')), B = JSON.parse(fs.readFileSync(fb, 'utf8'));

// Outcomes of decided qualification matches, grouped by event.
const byEvent = {};
for (const f of fs.readdirSync(dir)) {
  let raw; try { raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
  if (!Array.isArray(raw)) continue;
  for (const m of raw) {
    if (m.comp_level !== 'qm') continue;
    const a = m.alliances;
    if (a.red.score < 0 || a.red.score === a.blue.score || A[m.key] == null || B[m.key] == null) continue;
    const y = a.red.score > a.blue.score ? 1 : 0;
    (byEvent[m.event_key] = byEvent[m.event_key] || []).push({ y, a: A[m.key], b: B[m.key] });
  }
}
const events = Object.values(byEvent);

// Per-event sums so a bootstrap draw is cheap.
const sums = events.map(ms => {
  const s = { n: ms.length, ca: 0, cb: 0, ba: 0, bb: 0 };
  for (const x of ms) {
    s.ca += (x.a > 0.5) === (x.y === 1) ? 1 : 0; s.cb += (x.b > 0.5) === (x.y === 1) ? 1 : 0;
    s.ba += (x.a - x.y) ** 2; s.bb += (x.b - x.y) ** 2;
  }
  return s;
});
function stats(list) {
  const t = { n: 0, ca: 0, cb: 0, ba: 0, bb: 0 };
  for (const s of list) for (const k in t) t[k] += s[k];
  return { accA: t.ca / t.n, accB: t.cb / t.n, brA: t.ba / t.n, brB: t.bb / t.n, n: t.n };
}
const all = stats(sums);
const rng = LA.makeRng(2026);
const nBoot = 2000, dBr = [], dAcc = [];
for (let r = 0; r < nBoot; r++) {
  const draw = [];
  for (let i = 0; i < sums.length; i++) draw.push(sums[Math.floor(rng.uniform() * sums.length)]);
  const s = stats(draw);
  dBr.push(s.brB - s.brA); dAcc.push(s.accA - s.accB);
}
const q = (arr, p) => { const a = arr.slice().sort((x, y) => x - y); return a[Math.floor(p * (a.length - 1))]; };
const betterEvents = sums.filter(s => s.ba < s.bb).length;
const pct = v => (100 * v).toFixed(1) + '%';
console.log(`${events.length} events, ${all.n} decided matches`);
console.log(`  ${nameA.padEnd(16)} accuracy ${pct(all.accA)}  Brier ${all.brA.toFixed(4)}`);
console.log(`  ${nameB.padEnd(16)} accuracy ${pct(all.accB)}  Brier ${all.brB.toFixed(4)}`);
console.log(`  Brier advantage of ${nameA}: ${(all.brB - all.brA).toFixed(4)}  (95% CI over events ${q(dBr, 0.025).toFixed(4)} to ${q(dBr, 0.975).toFixed(4)}; ${pct(dBr.filter(d => d > 0).length / nBoot)} of resamples favour ${nameA})`);
console.log(`  Accuracy difference: ${(100 * (all.accA - all.accB)).toFixed(2)} pts  (95% CI ${(100 * q(dAcc, 0.025)).toFixed(2)} to ${(100 * q(dAcc, 0.975)).toFixed(2)})`);
console.log(`  ${nameA} has the better Brier at ${betterEvents} of ${events.length} events (${pct(betterEvents / events.length)})`);

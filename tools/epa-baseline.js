#!/usr/bin/env node
// Re-implementation of Statbotics' EPA model (github.com/avgupta456/statbotics,
// backend/src/models/epa: constants.py, init.py, main.py, math.py) for a fair
// head-to-head on identical matches, since the Statbotics API was unavailable.
//
//   node tools/epa-baseline.js <events.json> <matches-dir> <oprs-dir Y-1> <oprs-dir Y-2> --dump=preds.json
//
// Faithful parts: constants (NORM 1500/250, INIT_PENALTY 0.2, YEAR_ONE_WEIGHT 0.7,
// MEAN_REVERSION 0.4, ELIM_WEIGHT 1/3), season-start EPA formula, per-match update
// EPA += w·p(n)·err/3 with p(n) = 2/3·clip(0.5 − 0.2/6·(n−6), 0.3, 0.5), win
// probability 1/(1+10^(−5/8·Δ/σ)), and chronological processing across the season.
// Approximation: Statbotics' previous-season "norm EPA" is replaced by a z-score of
// TBA OPR within that season (Statbotics maps EPA through a fitted distribution).
'use strict';
const fs = require('fs');
const path = require('path');
require('../js/linalg.js');
const Games = require('../js/games.js');
require('../js/model.js');
require('../js/tba.js');
const TBA = globalThis.TBA;

const [evFile, dir, prev1, prev2] = process.argv.slice(2);
const dumpArg = process.argv.find(a => a.startsWith('--dump='));
const events = JSON.parse(fs.readFileSync(evFile, 'utf8')).filter(e => e.event_type !== 100 && e.event_type !== 99);
const year = events[0].year;
const game = Games.getGame(year);

function seasonZ(d) {
  if (!d || !fs.existsSync(d)) return {};
  const per = {};
  for (const f of fs.readdirSync(d)) {
    let o; try { o = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch (e) { continue; }
    if (!o || !o.oprs) continue;
    for (const [t, v] of Object.entries(o.oprs)) if (isFinite(v)) (per[t] = per[t] || []).push(v);
  }
  const means = Object.fromEntries(Object.entries(per).map(([t, vs]) => [t, vs.reduce((a, b) => a + b, 0) / vs.length]));
  const vals = Object.values(means);
  const mu = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mu) ** 2, 0) / vals.length);
  return Object.fromEntries(Object.entries(means).map(([t, v]) => [t, (v - mu) / sd]));
}
const z1 = seasonZ(prev1), z2 = seasonZ(prev2);

// Load all matches with their events.
const all = [];
for (const info of events) {
  const f = path.join(dir, info.key + '.json');
  if (!fs.existsSync(f)) continue;
  let raw; try { raw = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { continue; }
  if (!Array.isArray(raw)) continue;
  for (const m of raw) {
    const c = TBA.convertMatch(m, game);
    if (!c.played) continue;
    c.t = m.actual_time || m.time || Date.parse(info.start_date) / 1000;
    c.start = info.start_date;
    all.push(c);
  }
}
all.sort((a, b) => a.t - b.t);

// Season constants from week 1 (Statbotics data/avg.py uses week-1 alliance scores).
const firstStart = events.map(e => e.start_date).sort()[0];
const wk1End = new Date(Date.parse(firstStart) + 7 * 864e5).toISOString().slice(0, 10);
const w1 = all.filter(m => m.start < wk1End);
const noFoul = w1.flatMap(m => [m.r.total, m.b.total]);
const scores = w1.flatMap(m => [m.r.score, m.b.score]);
const mean = noFoul.reduce((a, b) => a + b, 0) / noFoul.length;
const sMean = scores.reduce((a, b) => a + b, 0) / scores.length;
const sd = Math.sqrt(scores.reduce((a, b) => a + (b - sMean) ** 2, 0) / scores.length);
console.log(`week-1 no-foul mean ${mean.toFixed(1)}, score sd ${sd.toFixed(1)}, ${all.length} matches`);

const INIT = 1500 - 0.2 * 250;
const epa = {}, count = {};
function start(t) {
  const n1 = z1[t] != null ? 1500 + 250 * z1[t] : INIT;
  const n2 = z2[t] != null ? 1500 + 250 * z2[t] : INIT;
  const prev = 0.7 * n1 + 0.3 * n2;
  const curr = 0.6 * prev + 0.4 * INIT;
  const z = Math.max(-mean / 3 / sd, (curr - 1500) / 250);
  return mean / 3 + (sd / (sMean || 1)) * mean * z;
}
const get = t => (epa[t] != null ? epa[t] : (epa[t] = start(t)));
const pct = n => (2 / 3) * Math.min(0.5, Math.max(0.3, 0.5 - (0.2 / 6) * (n - 6)));

const preds = {};
const acc = { n: 0, c: 0, b: 0 };
for (const m of all) {
  const R = m.red.reduce((a, t) => a + get(t), 0), B = m.blue.reduce((a, t) => a + get(t), 0);
  const p = 1 / (1 + Math.pow(10, (-5 / 8) * (R - B) / sd));
  if (m.comp === 'qm') {
    preds[m.key] = p;
    if (m.r.score !== m.b.score) {
      const y = m.r.score > m.b.score ? 1 : 0;
      acc.n++; acc.c += (p > 0.5) === (y === 1) ? 1 : 0; acc.b += (p - y) ** 2;
    }
  }
  const elim = m.comp !== 'qm';
  for (const [teams, pred, act] of [[m.red, R, m.r.total], [m.blue, B, m.b.total]]) {
    if (act == null) continue;
    const err = act - pred;
    for (const t of teams) {
      const w = elim ? 1 / 3 : 1;
      epa[t] = get(t) + w * pct(count[t] || 0) * err / 3;
      if (!elim) count[t] = (count[t] || 0) + 1;
    }
  }
}
console.log(`EPA re-implementation, official quals: ${(100 * acc.c / acc.n).toFixed(1)}% / Brier ${(acc.b / acc.n).toFixed(4)} (n=${acc.n})`);
if (dumpArg) fs.writeFileSync(dumpArg.slice(7), JSON.stringify(preds));

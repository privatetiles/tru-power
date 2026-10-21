#!/usr/bin/env node
// Backtest the rating model on historical TBA match CSVs.
//   node tools/backtest.js <dir-with-*_matches.csv> [year]
// CSV rows (the-blue-alliance-data format): matchkey,r1,r2,r3,b1,b2,b3,redScore,blueScore
// Each qualification match is predicted using only matches played before it.
'use strict';
const fs = require('fs');
const path = require('path');
require('../js/linalg.js');
const Games = require('../js/games.js');
const Model = require('../js/model.js');

const dir = process.argv[2];
const year = +(process.argv[3] || 2019);
if (!dir) { console.error('usage: backtest.js <csv-dir> [year]'); process.exit(1); }
const game = Games.getGame(year);

function parseKey(k) {
  const mk = k.split('_')[1];
  let mm = /^qm(\d+)$/.exec(mk);
  if (mm) return { comp: 'qm', set: 1, num: +mm[1] };
  mm = /^(ef|qf|sf|f)(\d+)m(\d+)$/.exec(mk);
  if (mm) return { comp: mm[1], set: +mm[2], num: +mm[3] };
  return null;
}

function loadEvent(file) {
  const key = path.basename(file).replace('_matches.csv', '');
  const matches = [];
  const teams = new Set();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const f = line.trim().split(',');
    if (f.length < 9) continue;
    const p = parseKey(f[0]);
    const rs = +f[7], bs = +f[8];
    if (!p || !(rs >= 0) || !(bs >= 0)) continue;
    const red = f.slice(1, 4), blue = f.slice(4, 7);
    red.concat(blue).forEach(t => teams.add(t));
    matches.push({ key: f[0], ...p, red, blue, played: true, r: { score: rs, total: rs }, b: { score: bs, total: bs } });
  }
  return { key, year, teams: [...teams], matches: Model.sortMatches(matches), level: 'regional' };
}

const CHAMPS = /^2019(arc|cars|carv|cur|dal|dar|gal|hop|new|roe|tes|tur)$/;
const DCMP = /^2019(chcmp|gacmp|incmp|iscmp|micmp[1-4]|mrcmp|nccmp|necmp|oncmp[12]|pncmp)$/;
const SKIP = /^2019(ftcmp|cmpmi|cmptx|micmp|oncmp)$/;

const events = fs.readdirSync(dir).filter(f => f.endsWith('_matches.csv'))
  .map(f => loadEvent(path.join(dir, f)))
  .filter(e => !SKIP.test(e.key) && e.matches.some(m => m.comp === 'qm'));

// Score every qual match of an event sequentially.
function scoreEvent(ev, settings, acc) {
  const quals = ev.matches.filter(m => m.comp === 'qm');
  for (let k = 0; k < quals.length; k++) {
    const m = quals[k];
    if (m.r.score === m.b.score) continue;
    const before = new Set(quals.slice(0, k).map(x => x.key));
    const R = Model.fit(ev, game, settings, { include: x => before.has(x.key) });
    const p = Model.predictMatch(R, m.red, m.blue).pRed;
    const y = m.r.score > m.b.score ? 1 : 0;
    const bucket = k < quals.length / 3 ? 0 : k < 2 * quals.length / 3 ? 1 : 2;
    for (const b of [acc.all, acc.third[bucket]]) {
      b.n++; b.brier += (p - y) * (p - y); b.correct += (p > 0.5) === (y === 1) ? 1 : 0;
    }
    const bin = Math.min(9, Math.floor(p * 10));
    acc.cal[bin].n++; acc.cal[bin].p += p; acc.cal[bin].y += y;
  }
}

function newAcc() {
  const z = () => ({ n: 0, brier: 0, correct: 0 });
  return { all: z(), third: [z(), z(), z()], cal: Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 })) };
}
function fmt(b) { return b.n ? `${(100 * b.correct / b.n).toFixed(1)}% / ${(b.brier / b.n).toFixed(4)}` : '-'; }
function report(name, acc) {
  console.log(`${name.padEnd(34)} all ${fmt(acc.all)} | early ${fmt(acc.third[0])} | mid ${fmt(acc.third[1])} | late ${fmt(acc.third[2])}  (n=${acc.all.n})`);
}

// End-of-event ratings for each team at each event, used as priors for later events.
function endRatings(ev) {
  const R = Model.fit(ev, game, { lambda: 1.5, lambdaNew: 1.5, newFactor: 1 }, { include: m => m.comp === 'qm' });
  const out = {};
  R.teams.forEach((t, i) => { out[t] = R.comps.total.mean[i]; });
  return { out, s2: R.comps.total.s2 };
}

const mode = process.argv[4] || 'all';

if (mode === 'all' || mode === 'within') {
  console.log(`Within-event (no priors), ${events.length} events — accuracy / Brier`);
  const grid = [
    ['OPR-like (λ=0.05)', { lambda: 0.05, lambdaNew: 0.05, newFactor: 1 }],
    ['ridge λ=1', { lambda: 1, lambdaNew: 1, newFactor: 1 }],
    ['ridge λ=2', { lambda: 2, lambdaNew: 2, newFactor: 1 }],
    ['ridge λ=3', { lambda: 3, lambdaNew: 3, newFactor: 1 }],
    ['ridge λ=5', { lambda: 5, lambdaNew: 5, newFactor: 1 }],
  ];
  for (const [name, s] of grid) {
    const acc = newAcc();
    for (const ev of events) scoreEvent(ev, s, acc);
    report(name, acc);
  }
}

if (mode === 'all' || mode === 'priors') {
  // Priors for DCMP / champs from all earlier (non-DCMP, non-champs) events, plus DCMPs for champs.
  const regular = events.filter(e => !CHAMPS.test(e.key) && !DCMP.test(e.key));
  const dcmps = events.filter(e => DCMP.test(e.key));
  const champs = events.filter(e => CHAMPS.test(e.key));
  const hist = {}; const s2s = [];
  const addHist = evs => { for (const e of evs) { const { out, s2 } = endRatings(e); s2s.push(s2); for (const t in out) (hist[t] = hist[t] || []).push(out[t]); } };
  addHist(regular);
  const priorsFrom = (ev, mode2) => {
    const pri = {};
    for (const t of ev.teams) {
      const h = hist[t];
      if (!h || !h.length) continue;
      pri[t] = { total: mode2 === 'max' ? Math.max(...h) : mode2 === 'last' ? h[h.length - 1] : h.reduce((a, b) => a + b, 0) / h.length };
    }
    return pri;
  };
  const medS2 = s2s.slice().sort((a, b) => a - b)[s2s.length >> 1];
  const runSet = (label, evs) => {
    console.log(`\n${label}: ${evs.length} events — accuracy / Brier`);
    const grid = [
      ['no priors λ=2', { lambda: 2, lambdaNew: 2, newFactor: 1 }, null],
      ['priors(mean) λ=2', { lambda: 2 }, 'mean'],
      ['priors(mean) λ=3', { lambda: 3 }, 'mean'],
      ['priors(mean) λ=5', { lambda: 5 }, 'mean'],
      ['priors(mean) λ=8', { lambda: 8 }, 'mean'],
      ['priors(mean) λ=12', { lambda: 12 }, 'mean'],
      ['priors(mean) λ=4 +count', { lambda: 4, countAware: true }, 'mean'],
      ['priors(mean) λ=5 +count', { lambda: 5, countAware: true }, 'mean'],
      ['priors(last) λ=5', { lambda: 5 }, 'last'],
    ];
    for (const [name, s, pm] of grid) {
      const acc = newAcc();
      for (const ev of evs) {
        const count = {};
        if (s.countAware) for (const t of ev.teams) count[t] = (hist[t] || []).length;
        const e2 = Object.assign({}, ev, pm ? { priors: priorsFrom(ev, pm), priorMeta: { sigma2: { total: medS2 }, count } } : {});
        scoreEvent(e2, s, acc);
      }
      report(name, acc);
    }
  };
  runSet('District championships', dcmps);
  addHist(dcmps);
  runSet('Championship divisions', champs);

  // Calibration check for the recommended configuration.
  const acc = newAcc();
  for (const ev of champs) scoreEvent(Object.assign({}, ev, { priors: priorsFrom(ev, 'mean'), priorMeta: { sigma2: { total: medS2 } } }), { lambda: 3 }, acc);
  console.log('\nCalibration (champs, priors λ=3): predicted vs actual red-win rate');
  acc.cal.forEach((c, i) => { if (c.n) console.log(`  ${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}: pred ${(c.p / c.n).toFixed(3)} actual ${(c.y / c.n).toFixed(3)} n=${c.n}`); });
}

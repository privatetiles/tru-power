#!/usr/bin/env node
// Season backtest on raw TBA data, using exactly the app's import + model code.
//   node tools/backtest-tba.js <events.json> <dir-of-{eventkey}.json> ['{"lambda":5}'] [--luck]
// events.json = /events/{year}/simple; each {eventkey}.json = /event/{key}/matches.
// Events are processed in date order; priors come only from events that ended
// before the event starts, and each qual match is predicted from earlier matches only.
'use strict';
const fs = require('fs');
const path = require('path');
require('../js/linalg.js');
const Games = require('../js/games.js');
const Model = require('../js/model.js');
const Sim = require('../js/sim.js');
require('../js/tba.js');
const TBA = globalThis.TBA;

const [evFile, dir, cfgArg] = process.argv.slice(2);
const doLuck = process.argv.includes('--luck');
const settings = cfgArg && cfgArg.startsWith('{') ? JSON.parse(cfgArg) : {};
const events = JSON.parse(fs.readFileSync(evFile, 'utf8')).filter(e => e.event_type !== 100);
events.sort((a, b) => (a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : 0));
const year = events[0].year;
const game = Games.getGame(year);

// Optional --prev=<dir of {event}_oprs json>: last season's TBA OPRs give each team a
// relative strength (1 = average) used when it has no events yet this season.
let relPrev = null;
const prevArg = process.argv.find(a => a.startsWith('--prev='));
if (prevArg) {
  const pdir = prevArg.slice(7);
  const per = {}; let sum = 0, n = 0;
  for (const f of fs.readdirSync(pdir)) {
    let o; try { o = JSON.parse(fs.readFileSync(path.join(pdir, f), 'utf8')); } catch (e) { continue; }
    if (!o || !o.oprs) continue;
    for (const [t, v] of Object.entries(o.oprs)) { if (!isFinite(v)) continue; (per[t] = per[t] || []).push(v); sum += v; n++; }
  }
  const mean = sum / n;
  relPrev = {};
  for (const [t, vs] of Object.entries(per)) relPrev[t] = Math.max(0, Math.min(4, vs.reduce((a, b) => a + b, 0) / vs.length / mean));
}

const dumped = {};
const history = {}; // team -> [{end, ratings}]
const s2hist = {};
const groups = { official: newAcc(), offseason: newAcc(), 'official, <50% teams with priors': newAcc(), 'official, ≥50% teams with priors': newAcc() };
const luckStats = { n: 0, absLuck: 0, top8Changed: 0, events: 0, rsSpread: 0 };

function newAcc() {
  const z = () => ({ n: 0, brier: 0, correct: 0 });
  return {
    all: z(), third: [z(), z(), z()],
    cal: Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 })),
    bonus: {}, scoreErr: 0, scoreN: 0, events: 0,
    cover: 0, coverN: 0,                  // alliance score inside the predicted 80% range
    rankIn: 0, rankN: 0, rankErr: 0,      // final rank inside the forecast's 80% range (from halfway)
  };
}

for (const info of events) {
  const f = path.join(dir, info.key + '.json');
  if (!fs.existsSync(f)) continue;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { continue; }
  if (!Array.isArray(raw) || !raw.length) continue;
  const matches = raw.filter(m => m.comp_level === 'qm').map(m => TBA.convertMatch(m, game));
  const teams = [...new Set(matches.flatMap(m => m.red.concat(m.blue)))];
  const quals = Model.sortMatches(matches).filter(Model.isPlayed);
  if (quals.length < 6) continue;

  // Priors from events that finished before this one started (mean, as in the app).
  const priors = {}, count = {};
  for (const t of teams) {
    const h = (history[t] || []).filter(x => x.end && info.start_date && x.end < info.start_date);
    if (!h.length) continue;
    // Most recent event first; weight priorDecay^age (1 = plain mean, as in the app).
    h.sort((a, b) => (a.end < b.end ? 1 : a.end > b.end ? -1 : 0));
    const pd = settings.priorDecay != null ? settings.priorDecay : 1;
    const acc = {};
    h.forEach((x, j) => { for (const [c, v] of Object.entries(x.ratings)) { const a = acc[c] = acc[c] || [0, 0]; a[0] += Math.pow(pd, j) * v; a[1] += Math.pow(pd, j); } });
    priors[t] = {};
    for (const [c, [sv, sw]] of Object.entries(acc)) priors[t][c] = sv / sw;
    count[t] = h.length;
  }
  const sigma2 = {};
  for (const [c, vs] of Object.entries(s2hist)) { const s = vs.slice().sort((a, b) => a - b); sigma2[c] = s[s.length >> 1]; }
  const ev = { key: info.key, year, teams, matches: Model.sortMatches(matches), level: Games.levelFromEventType(info.event_type), priors, priorMeta: { count, sigma2 }, relPriors: relPrev };

  const acc = info.event_type === 99 ? groups.offseason : groups.official;
  acc.events++;
  const cov = Object.keys(priors).length / teams.length;
  const acc2 = info.event_type === 99 ? null : cov < 0.5 ? groups['official, <50% teams with priors'] : groups['official, ≥50% teams with priors'];
  if (acc2) acc2.events++;
  quals.forEach((m, k) => {
    const before = new Set(quals.slice(0, k).map(x => x.key));
    const R = Model.fit(ev, game, settings, { include: x => before.has(x.key) });
    const p = Model.predictMatch(R, m.red, m.blue);
    if (info.event_type !== 99) dumped[m.key] = p.pRed;
    if (m.r.total != null && m.b.total != null) {
      acc.scoreErr += (p.red.score - m.r.total) ** 2 + (p.blue.score - m.b.total) ** 2; acc.scoreN += 2;
      for (const [teams, act] of [[m.red, m.r.total], [m.blue, m.b.total]]) {
        const d = Model.allianceDist(R, teams, 'total');
        acc.coverN++; if (Math.abs(act - d.mu) <= 1.2816 * d.sd) acc.cover++;
      }
    }
    for (const [side, pr] of [['r', p.red], ['b', p.blue]]) {
      for (const b of game.bonuses) {
        const got = m[side].bonus && m[side].bonus[b.key];
        if (typeof got !== 'boolean' || pr.bonus[b.key] == null) continue;
        const B = acc.bonus[b.key] = acc.bonus[b.key] || { n: 0, brier: 0, p: 0, y: 0, base: 0 };
        B.n++; B.brier += (pr.bonus[b.key] - (got ? 1 : 0)) ** 2; B.p += pr.bonus[b.key]; B.y += got ? 1 : 0;
      }
    }
    if (m.r.score === m.b.score) return;
    const y = m.r.score > m.b.score ? 1 : 0;
    const bucket = k < quals.length / 3 ? 0 : k < 2 * quals.length / 3 ? 1 : 2;
    for (const b of [acc.all, acc.third[bucket]].concat(acc2 ? [acc2.all, acc2.third[bucket]] : [])) { b.n++; b.brier += (p.pRed - y) ** 2; b.correct += (p.pRed > 0.5) === (y === 1) ? 1 : 0; }
    const bin = Math.min(9, Math.floor(p.pRed * 10));
    acc.cal[bin].n++; acc.cal[bin].p += p.pRed; acc.cal[bin].y += y;
  });

  // Forecast honesty: from the halfway point, is each team's final rank inside its 80% range?
  if (process.argv.includes('--ranks') && quals.length >= 20) {
    const half = new Set(quals.slice(0, Math.floor(quals.length / 2)).map(x => x.key));
    const evHalf = Object.assign({}, ev, { matches: ev.matches.map(x => (half.has(x.key) ? x : Object.assign({}, x, { played: false, r: undefined, b: undefined }))) });
    const Rh = Model.fit(evHalf, game, settings);
    const sim = Sim.simulateRankings(evHalf, Rh, { nSims: 600 });
    const final = Model.standings(ev, game);
    for (const st of final) {
      const f = sim.byTeam[st.team];
      if (!f || !st.rank) continue;
      acc.rankN++; acc.rankErr += Math.abs(f.expRank - st.rank);
      if (st.rank >= f.p10 && st.rank <= f.p90) acc.rankIn++;
    }
  }

  if (doLuck && info.event_type !== 99) {
    const R = Model.fit(ev, game, settings);
    const L = Sim.scheduleLuck(ev, R, null, { nRand: 150 });
    const st = Model.standings(ev, game).filter(s => s.n);
    const top8 = new Set(st.slice(0, 8).map(s => s.team));
    const adj = st.slice().sort((a, b) => L[b.team].adjRS - L[a.team].adjRS).slice(0, 8);
    luckStats.events++;
    luckStats.top8Changed += adj.filter(s => !top8.has(s.team)).length;
    for (const s of st) { luckStats.n++; luckStats.absLuck += Math.abs(L[s.team].luckPlayed || 0); }
  }

  // End-of-event ratings feed later events' priors (same as the app's import).
  const r = TBA.rateEvent(info.key, raw, game, year);
  if (r) {
    for (const [t, ratings] of Object.entries(r.ratings)) (history[t] = history[t] || []).push({ end: info.end_date, ratings });
    for (const [c, v] of Object.entries(r.s2)) (s2hist[c] = s2hist[c] || []).push(v);
  }
}

const fmt = b => (b.n ? `${(100 * b.correct / b.n).toFixed(1)}% / ${(b.brier / b.n).toFixed(4)}` : '-');
console.log('settings', JSON.stringify(settings));
for (const [name, acc] of Object.entries(groups)) {
  if (!acc.all.n) continue;
  console.log(`\n== ${name}: ${acc.events} events, ${acc.all.n} decided quals — accuracy / Brier`);
  console.log(`  all ${fmt(acc.all)} | early ${fmt(acc.third[0])} | mid ${fmt(acc.third[1])} | late ${fmt(acc.third[2])}`);
  console.log(`  score RMSE (no-foul alliance pts): ${Math.sqrt(acc.scoreErr / acc.scoreN).toFixed(1)}`);
  if (acc.coverN) console.log(`  alliance score inside predicted 80% range: ${(100 * acc.cover / acc.coverN).toFixed(1)}% (target 80%)`);
  if (acc.rankN) console.log(`  final rank inside halfway forecast's 80% range: ${(100 * acc.rankIn / acc.rankN).toFixed(1)}% (target 80%), avg rank error ${(acc.rankErr / acc.rankN).toFixed(2)}`);
  for (const [k, B] of Object.entries(acc.bonus)) {
    const rate = B.y / B.n;
    console.log(`  ${k.padEnd(13)} predicted ${(100 * B.p / B.n).toFixed(1)}% actual ${(100 * rate).toFixed(1)}%  Brier ${(B.brier / B.n).toFixed(4)} (always-guess-rate ${(rate * (1 - rate)).toFixed(4)})`);
  }
  console.log('  calibration:', acc.cal.filter(c => c.n).map(c => `${(c.p / c.n).toFixed(2)}→${(c.y / c.n).toFixed(2)}`).join('  '));
}
if (doLuck) {
  console.log(`\nSchedule luck (official events, full quals): mean |luck| ${(luckStats.absLuck / luckStats.n).toFixed(3)} RP/match; ` +
    `on average ${(luckStats.top8Changed / luckStats.events).toFixed(2)} of the top-8 seeds change when luck is removed (${luckStats.events} events).`);
}

const dumpArg = process.argv.find(a => a.startsWith('--dump='));
if (dumpArg) fs.writeFileSync(dumpArg.slice(7), JSON.stringify(dumped));

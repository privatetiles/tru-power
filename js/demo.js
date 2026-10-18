// Synthetic 2026 REBUILT event for trying the tool (and for tests).
// Teams get hidden "true" abilities; matches are simulated from them.
(function (root) {
  'use strict';
  const LA = root.LinAlg || (typeof require !== 'undefined' ? require('./linalg.js') : null);

  // Rounds of shuffled team orderings, cut into matches of 6. A team that would
  // appear twice in one match is swapped with a later slot. Teams past their
  // quota in the final partial round play as surrogates.
  function makeSchedule(teams, perTeam, rng) {
    const seq = [];
    const rounds = perTeam + 1;
    for (let r = 0; r < rounds; r++) {
      const p = teams.slice();
      for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(rng.uniform() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
      seq.push(...p);
    }
    const nMatches = Math.ceil(teams.length * perTeam / 6);
    for (let k = 0; k < nMatches * 6; k++) {
      const m0 = k - (k % 6);
      if (seq.slice(m0, k).includes(seq[k])) {
        for (let j = k + 1; j < seq.length; j++) if (!seq.slice(m0, k).includes(seq[j])) { [seq[k], seq[j]] = [seq[j], seq[k]]; break; }
      }
    }
    const count = Object.fromEntries(teams.map(t => [t, 0]));
    const matches = [];
    for (let k = 0; k < nMatches; k++) {
      const pick = seq.slice(k * 6, k * 6 + 6);
      const surr = pick.filter(t => count[t] >= perTeam);
      pick.forEach(t => { count[t]++; });
      const red = pick.slice(0, 3), blue = pick.slice(3, 6);
      matches.push({ red, blue, redSurr: red.filter(t => surr.includes(t)), blueSurr: blue.filter(t => surr.includes(t)) });
    }
    return matches;
  }

  function makeDemoEvent(opts) {
    opts = opts || {};
    const rng = LA.makeRng(opts.seed || 2026);
    const nTeams = opts.teams || 40;
    const nums = new Set();
    while (nums.size < nTeams) nums.add(1 + Math.floor(rng.uniform() * 10999));
    const teams = [...nums].sort((a, b) => a - b).map(n => 'frc' + n);
    const truth = {};
    for (const t of teams) {
      const skill = rng.normal();
      const fuel = Math.max(2, 32 + 22 * skill + 6 * rng.normal());
      const climb = Math.max(0, Math.min(1, 0.5 + 0.3 * skill + 0.2 * rng.normal()));
      truth[t] = { fuel, autoShare: 0.15 + 0.1 * rng.uniform(), climb, autoClimb: rng.uniform() < 0.3 + 0.3 * climb, foulRate: 0.3 + rng.uniform() };
    }
    const priors = {};
    const count = {};
    for (const t of teams) {
      if (rng.uniform() < 0.1) continue; // ~10% have no earlier event
      const tr = truth[t];
      const towerExp = 10 * tr.climb + 10 * tr.climb * tr.climb + 10 * Math.pow(tr.climb, 3) + (tr.autoClimb ? 9 : 0);
      const noisy = (v, f) => Math.max(0, v * (1 + f * rng.normal()));
      priors[t] = {
        total: noisy(tr.fuel + towerExp, 0.18), fuel: noisy(tr.fuel, 0.18), autoFuel: noisy(tr.fuel * tr.autoShare, 0.3),
        auto: noisy(tr.fuel * tr.autoShare + (tr.autoClimb ? 9 : 0), 0.3), tower: noisy(towerExp, 0.25), fouls: noisy(tr.foulRate * 5, 0.5),
      };
      count[t] = 1 + Math.floor(rng.uniform() * 3);
    }
    const sched = makeSchedule(teams, opts.perTeam || 12, rng);
    const playedN = Math.round(sched.length * (opts.playedFrac != null ? opts.playedFrac : 0.55));

    function playRobot(t) {
      const tr = truth[t];
      const f = Math.max(0, tr.fuel * Math.exp(0.35 * rng.normal() - 0.06));
      const af = Math.round(f * tr.autoShare);
      const fuel = Math.round(f);
      const u = rng.uniform();
      const c = tr.climb;
      const endLevel = u < c * c * c ? 'Level3' : u < c * c ? 'Level2' : u < c ? 'Level1' : 'None';
      const autoLevel = tr.autoClimb && rng.uniform() < 0.75 ? 'Level1' : 'None';
      const fouls = rng.uniform() < tr.foulRate / 3 ? 5 : 0;
      return { fuel, af, endLevel, autoLevel, fouls };
    }
    const G = root.Games || require('./games.js');
    const game = G.getGame(2026);
    const thr = game.levels.regional;
    const matches = sched.map((s, k) => {
      const m = { key: 'demo_qm' + (k + 1), comp: 'qm', set: 1, num: k + 1, red: s.red, blue: s.blue, redSurr: s.redSurr, blueSurr: s.blueSurr, redDQ: [], blueDQ: [], played: false, source: 'demo' };
      if (k >= playedN) return m;
      const side = teams3 => {
        const rs = teams3.map(playRobot);
        const fuel = rs.reduce((a, r) => a + r.fuel, 0);
        const autoFuel = rs.reduce((a, r) => a + r.af, 0);
        const robots = rs.map(r => ({ tower: game.robotTowerPoints(r.autoLevel, r.endLevel), autoLevel: r.autoLevel, endLevel: r.endLevel }));
        const tower = robots.reduce((a, r) => a + r.tower, 0);
        const autoTower = rs.reduce((a, r) => a + (r.autoLevel === 'Level1' ? 15 : 0), 0);
        return { fuel, autoFuel, tower, robots, auto: autoFuel + autoTower, total: fuel + tower, foulsCommitted: rs.reduce((a, r) => a + r.fouls, 0) };
      };
      const r = side(s.red), b = side(s.blue);
      r.foulRecv = b.foulsCommitted; b.foulRecv = r.foulsCommitted;
      r.fouls = r.foulsCommitted; b.fouls = b.foulsCommitted;
      r.score = r.total + r.foulRecv; b.score = b.total + b.foulRecv;
      for (const v of [r, b]) {
        v.bonus = { energized: v.fuel >= thr.energized, supercharged: v.fuel >= thr.supercharged, traversal: v.tower >= thr.traversal };
        delete v.foulsCommitted;
      }
      m.r = r; m.b = b; m.played = true;
      return m;
    });
    const names = ['Gearheads', 'Byte Force', 'Iron Owls', 'Circuit Breakers', 'Torque', 'Voltage', 'Steel Phoenix', 'Robo Raptors'];
    const teamNames = Object.fromEntries(teams.map((t, i) => [t, names[i % names.length] + ' ' + (i + 1)]));
    return {
      schema: 1, key: 'demo2026', name: 'Demo Regional (synthetic data)', year: 2026, level: 'regional',
      teams, teamNames, matches, priors, priorMeta: { count, source: 'synthetic' }, truth, demo: true,
      notes: {}, starred: {}, created: Date.now(),
    };
  }

  const api = { makeDemoEvent, makeSchedule };
  root.Demo = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

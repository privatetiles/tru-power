// Game definitions. Everything season-specific lives here so a new game
// (e.g. 2027) only needs a new entry in GAMES.
//
// A game defines:
//   comps       rating components (alliance-level quantities that add up across robots)
//   bonuses     bonus ranking points: which component drives them and per-level thresholds
//   tiebreakers component keys used (in order) after Ranking Score
//   fromTba     convert a TBA score_breakdown alliance into component values
//   manual      fields shown on the manual match-entry form
(function (root) {
  'use strict';

  const TOWER_AUTO = { Level1: 15 };
  const TOWER_TELEOP = { Level1: 10, Level2: 20, Level3: 30 };

  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }

  // Thresholds depend on the event level (Game Manual Table 6-5, Team Update 22).
  // TBA event_type: 0 regional, 1 district, 2 DCMP, 3 CMP division, 4 CMP finals,
  // 5 DCMP division, 6 FOC, 99 offseason, 100 preseason.
  function levelFromEventType(t) {
    if (t === 2 || t === 5) return 'dcmp';
    if (t === 3 || t === 4) return 'cmp';
    return 'regional';
  }

  const REBUILT_2026 = {
    year: 2026,
    name: 'REBUILT',
    winRP: 3,
    tieRP: 1,
    comps: [
      { key: 'total', label: 'Points (no fouls)', short: 'Pts', main: true },
      { key: 'auto', label: 'Auto points', short: 'Auto' },
      { key: 'fuel', label: 'Fuel scored (active hub)', short: 'Fuel' },
      { key: 'autoFuel', label: 'Auto fuel', short: 'A.Fuel' },
      { key: 'tower', label: 'Tower points', short: 'Tower', perRobot: true },
      { key: 'fouls', label: 'Foul points given away', short: 'Fouls', lowerBetter: true },
      { key: 'bonusRP', label: 'Bonus RP', short: 'BonusRP', hidden: true },
    ],
    levels: {
      regional: { energized: 100, supercharged: 360, traversal: 50 },
      dcmp: { energized: 240, supercharged: 360, traversal: 50 },
      cmp: { energized: 360, supercharged: 500, traversal: 50 },
    },
    bonuses: [
      { key: 'energized', label: 'Energized', comp: 'fuel', tbaField: 'energizedAchieved' },
      { key: 'supercharged', label: 'Supercharged', comp: 'fuel', tbaField: 'superchargedAchieved' },
      { key: 'traversal', label: 'Traversal', comp: 'tower', tbaField: 'traversalAchieved' },
    ],
    tiebreakers: ['total', 'autoFuel', 'tower'],
    tiebreakerLabels: ['Avg match pts (no fouls)', 'Avg auto fuel', 'Avg tower pts'],

    // bd = this alliance's breakdown, opp = opponent's breakdown, score = this alliance's score.
    fromTba(bd, opp, score) {
      const out = { score };
      if (!bd) return out;
      const foulRecv = num(bd.foulPoints);
      out.total = foulRecv !== null ? score - foulRecv : score;
      out.foulRecv = foulRecv;
      out.auto = num(bd.totalAutoPoints);
      const hub = bd.hubScore || {};
      out.fuel = num(hub.totalCount);
      out.autoFuel = num(hub.autoCount);
      out.tower = num(bd.totalTowerPoints);
      out.fouls = opp ? num(opp.foulPoints) : null;
      out.rp = num(bd.rp);
      out.bonus = {};
      for (const b of this.bonuses) if (typeof bd[b.tbaField] === 'boolean') out.bonus[b.key] = bd[b.tbaField];
      // Per-robot tower points, index = driver station - 1.
      const robots = [];
      for (let i = 1; i <= 3; i++) {
        const a = bd['autoTowerRobot' + i], e = bd['endGameTowerRobot' + i];
        if (a === undefined && e === undefined) { robots.length = 0; break; }
        robots.push({ tower: (TOWER_AUTO[a] || 0) + (TOWER_TELEOP[e] || 0), autoLevel: a || 'None', endLevel: e || 'None' });
      }
      if (robots.length === 3) out.robots = robots;
      return out;
    },

    manual: [
      { key: 'score', label: 'Final score', required: true },
      { key: 'foulRecv', label: 'Foul pts received' },
      { key: 'fuel', label: 'Fuel scored' },
      { key: 'autoFuel', label: 'Auto fuel' },
      { key: 'auto', label: 'Auto pts' },
      { key: 'tower', label: 'Tower pts' },
    ],
    robotLevels: { auto: ['None', 'Level1'], end: ['None', 'Level1', 'Level2', 'Level3'] },
    // Top-down field layout (inches) from FIRST's 2026 Field Dimension Drawings (FE-2026 Rev B)
    // and Game Manual §5, cross-checked with the WPILib 2026 AprilTag layout.
    // Frame: origin at the red alliance wall / scoring-table guardrail corner, +x toward blue,
    // +y toward the audience. Red elements are listed; blue ones are the same rotated 180°
    // about the field center. Driver station spans are estimates.
    field: {
      length: 651.22, width: 317.69, rotate180: true,
      red: [
        { kind: 'zone', x: 0, y: 0, w: 158.61, h: 317.69, label: 'Alliance zone' },
        { kind: 'line', x: 156.61, y: 0, w: 2, h: 317.69, label: 'Starting line' },
        { kind: 'depot', x: 0, y: 61.84, w: 27, h: 42, label: 'DEPOT' },
        { kind: 'tower', x: 0, y: 145.59, w: 45, h: 49.25, label: 'TOWER' },
        { kind: 'outpost', x: -37.6, y: 267.85, w: 37.6, h: 49.84, label: 'OUTPOST' },
        { kind: 'trench', x: 158.61, y: 0, w: 47, h: 65.65, post: [50.35, 62.35], label: 'TRENCH' },
        { kind: 'bump', x: 159.91, y: 62.34, w: 44.4, h: 73, label: 'BUMP' },
        { kind: 'hub', x: 158.61, y: 135.34, w: 47, h: 47, label: 'HUB' },
        { kind: 'bump', x: 159.91, y: 182.34, w: 44.4, h: 73, label: 'BUMP' },
        { kind: 'trench', x: 158.61, y: 252.04, w: 47, h: 65.65, post: [255.34, 267.34], label: 'TRENCH' },
        { kind: 'ds', x: -12.25, y: 0, w: 12.25, h: 72.8, label: 'DS1' },
        { kind: 'ds', x: -12.25, y: 72.8, w: 12.25, h: 72.79, label: 'DS2' },
        { kind: 'ds', x: -12.25, y: 194.85, w: 12.25, h: 73, label: 'DS3' },
      ],
      neutral: [
        { kind: 'center', x: 324.61, y: 0, w: 2, h: 317.69, label: 'Center line' },
        { kind: 'fuel', x: 289.66, y: 67.89, w: 71.9, h: 181.9, label: 'FUEL (start)' },
      ],
    },
    robotTowerPoints(autoLevel, endLevel) { return (TOWER_AUTO[autoLevel] || 0) + (TOWER_TELEOP[endLevel] || 0); },
  };

  // Fallback for any other season: total score only, bonus RP taken from the breakdown's rp field.
  function genericGame(year) {
    const winRP = year >= 2025 ? 3 : 2;
    return {
      year,
      name: 'Generic ' + year,
      generic: true,
      winRP,
      tieRP: 1,
      comps: [
        { key: 'total', label: 'Points (no fouls)', short: 'Pts', main: true },
        { key: 'fouls', label: 'Foul points given away', short: 'Fouls', lowerBetter: true },
        { key: 'bonusRP', label: 'Bonus RP', short: 'BonusRP', hidden: true },
      ],
      levels: { regional: {}, dcmp: {}, cmp: {} },
      bonuses: [],
      tiebreakers: ['total'],
      tiebreakerLabels: ['Avg match pts'],
      fromTba(bd, opp, score) {
        const out = { score };
        if (!bd) { out.total = score; return out; }
        const foulRecv = num(bd.foulPoints);
        out.total = foulRecv !== null ? score - foulRecv : score;
        out.foulRecv = foulRecv;
        out.fouls = opp ? num(opp.foulPoints) : null;
        out.rp = num(bd.rp);
        return out;
      },
      manual: [
        { key: 'score', label: 'Final score', required: true },
        { key: 'foulRecv', label: 'Foul pts received' },
      ],
    };
  }

  const GAMES = { 2026: REBUILT_2026 };

  function getGame(year) { return GAMES[year] || genericGame(year); }

  const api = { getGame, levelFromEventType, GAMES };
  root.Games = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

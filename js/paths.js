// Robot path geometry for the Scout tab. A traced route is one or more strokes (polylines)
// in field coordinates (x 0–FIELD_W along the field, y 0–FIELD_H across it). Strokes can be
// joined end to start, automatically when a new stroke begins where an earlier one ended,
// or by hand with the link tool. Markers sit exactly on a stroke, stored as
// (stroke p, segment index, fraction t along it), and are drawn along the tangent: the
// direction of the segment they lie on.
(function (root) {
  'use strict';

  const FIELD_W = 1000, FIELD_H = 500;
  const MIN_STEP = 4;      // drop points closer than this to the previous one (field units)
  const SNAP = 28;         // a click must be within this distance of the line to add a marker
  const JOIN = 30;         // a stroke starting/ending this close to another stroke's end/start joins it

  function addPoint(path, x, y) {
    x = Math.max(0, Math.min(FIELD_W, x)); y = Math.max(0, Math.min(FIELD_H, y));
    const last = path[path.length - 1];
    if (!last || Math.hypot(x - last[0], y - last[1]) >= MIN_STEP) path.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
    return path;
  }

  // Closest point on one polyline to (x, y): segment index, fraction t in [0, 1], distance.
  function project(path, x, y) {
    let best = null;
    for (let i = 0; i + 1 < path.length; i++) {
      const [ax, ay] = path[i], [bx, by] = path[i + 1];
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      if (len2 === 0) continue;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
      const px = ax + t * dx, py = ay + t * dy;
      const d = Math.hypot(x - px, y - py);
      if (!best || d < best.dist) best = { seg: i, t, dist: d, x: px, y: py };
    }
    return best;
  }

  // Closest point over several strokes; adds the stroke index p.
  function projectAll(strokes, x, y) {
    let best = null;
    strokes.forEach((s, p) => { const h = project(s, x, y); if (h && (!best || h.dist < best.dist)) best = Object.assign(h, { p }); });
    return best;
  }

  // Position and tangent angle (radians, direction of travel) of a marker on a polyline.
  function pose(path, seg, t) {
    if (!path || path.length < 2) return null;
    const i = Math.max(0, Math.min(path.length - 2, seg));
    // A zero-length segment has no direction: use the nearest non-degenerate one.
    let j = i;
    while (j < path.length - 1 && path[j][0] === path[j + 1][0] && path[j][1] === path[j + 1][1]) j++;
    if (j >= path.length - 1) { j = i; while (j > 0 && path[j][0] === path[j + 1][0] && path[j][1] === path[j + 1][1]) j--; }
    const [ax, ay] = path[i], [bx, by] = path[i + 1];
    const [cx, cy] = path[j], [ex, ey] = path[j + 1];
    return { x: ax + t * (bx - ax), y: ay + t * (by - ay), angle: Math.atan2(ey - cy, ex - cx) };
  }

  // Nearest stroke endpoint to (x, y) within maxDist: {p, end: 'start'|'end', dist}.
  function nearestEnd(strokes, x, y, maxDist, skip) {
    let best = null;
    strokes.forEach((s, p) => {
      if (p === skip || s.length < 2) return;
      for (const [end, q] of [['start', s[0]], ['end', s[s.length - 1]]]) {
        const d = Math.hypot(q[0] - x, q[1] - y);
        if (d <= maxDist && (!best || d < best.dist)) best = { p, end, dist: d };
      }
    });
    return best;
  }

  // Join stroke b onto the end of stroke a (a's last point connects to b's first point by a
  // straight segment). Markers on b move to a with their segment index shifted, so they keep
  // their exact position and direction. Returns the index a ends up at.
  function link(strokes, markers, a, b) {
    if (a === b) return a;
    const offset = strokes[a].length;   // b's segment k becomes segment offset + k (offset−1 is the connector)
    strokes[a] = strokes[a].concat(strokes[b]);
    for (const m of markers) if (m.p === b) { m.p = a; m.seg += offset; }
    strokes.splice(b, 1);
    for (const m of markers) if (m.p > b) m.p--;
    return a > b ? a - 1 : a;
  }

  // Reverse a stroke's direction; its markers stay at the same spot but now point the other way.
  function reverse(strokes, markers, p) {
    const n = strokes[p].length;
    strokes[p].reverse();
    for (const m of markers) if (m.p === p) { m.seg = n - 2 - m.seg; m.t = 1 - m.t; }
  }

  // Add a freshly drawn stroke. It continues an earlier stroke if it starts near that stroke's
  // end, and is joined in front of a stroke whose start is near its own end.
  // Returns {index, joined: [...descriptions]}.
  function addStroke(strokes, markers, stroke) {
    if (stroke.length < 2) return { index: -1, joined: [] };
    strokes.push(stroke);
    let p = strokes.length - 1;
    const joined = [];
    const s = stroke[0];
    const before = nearestEnd(strokes, s[0], s[1], JOIN, p);
    if (before && before.end === 'end') { p = link(strokes, markers, before.p, p); joined.push('continued the previous piece'); }
    const e = strokes[p][strokes[p].length - 1];
    const after = nearestEnd(strokes, e[0], e[1], JOIN, p);
    if (after && after.end === 'start') { p = link(strokes, markers, p, after.p); joined.push('joined the next piece'); }
    return { index: p, joined };
  }

  // Link tool: connect the two picked endpoints. The stroke whose END was picked leads; if
  // both picks are ends (or both starts) the second stroke is reversed so the route flows.
  function linkEnds(strokes, markers, A, B) {
    if (A.p === B.p) return { ok: false, why: 'Pick ends of two different pieces.' };
    let a = A, b = B;
    if (a.end === 'start' && b.end === 'end') [a, b] = [b, a];
    if (a.end === 'start' && b.end === 'start') { reverse(strokes, markers, a.p); a = { p: a.p, end: 'end' }; }
    if (a.end === 'end' && b.end === 'end') { reverse(strokes, markers, b.p); b = { p: b.p, end: 'start' }; }
    return { ok: true, index: link(strokes, markers, a.p, b.p) };
  }

  // Older saved entries had a single path; newer ones have strokes.
  function strokesOf(row) {
    if (!row) return [];
    if (row.paths) return row.paths.map(s => s.map(q => q.slice()));
    if (row.path && row.path.length > 1) return [row.path.map(q => q.slice())];
    return [];
  }

  const api = { FIELD_W, FIELD_H, SNAP, JOIN, addPoint, project, projectAll, pose, nearestEnd, link, reverse, addStroke, linkEnds, strokesOf };
  root.Paths = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

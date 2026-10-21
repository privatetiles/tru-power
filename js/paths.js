// Robot path geometry for the Scout tab: a traced route is a polyline in field
// coordinates (x 0–1000 along the field, y 0–500 across it). Markers sit exactly on the
// line, stored as (segment index, fraction along it), and are drawn along the tangent:
// the direction of the segment they lie on.
(function (root) {
  'use strict';

  const FIELD_W = 1000, FIELD_H = 500;
  const MIN_STEP = 4;      // drop points closer than this to the previous one (field units)
  const SNAP = 28;         // a click must be within this distance of the line to add a marker

  // Append a point unless it is too close to the last one.
  function addPoint(path, x, y) {
    x = Math.max(0, Math.min(FIELD_W, x)); y = Math.max(0, Math.min(FIELD_H, y));
    const last = path[path.length - 1];
    if (!last || Math.hypot(x - last[0], y - last[1]) >= MIN_STEP) path.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
    return path;
  }

  // Closest point on the polyline to (x, y): segment index, fraction t in [0, 1], distance.
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

  // Position and tangent angle (radians, direction of travel) of a marker on the path.
  function pose(path, seg, t) {
    if (!path || path.length < 2) return null;
    let i = Math.max(0, Math.min(path.length - 2, seg));
    // A zero-length segment has no direction: use the nearest non-degenerate one.
    let j = i;
    while (j < path.length - 1 && path[j][0] === path[j + 1][0] && path[j][1] === path[j + 1][1]) j++;
    if (j >= path.length - 1) { j = i; while (j > 0 && path[j][0] === path[j + 1][0] && path[j][1] === path[j + 1][1]) j--; }
    const [ax, ay] = path[i], [bx, by] = path[i + 1];
    const [cx, cy] = path[j], [ex, ey] = path[j + 1];
    return { x: ax + t * (bx - ax), y: ay + t * (by - ay), angle: Math.atan2(ey - cy, ex - cx) };
  }

  const api = { FIELD_W, FIELD_H, SNAP, addPoint, project, pose };
  root.Paths = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

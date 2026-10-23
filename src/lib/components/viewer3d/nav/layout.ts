/**
 * Nav preview layout helpers (pure, unit-tested):
 * - lightSpots: ceiling panel positions centred on corridors (one row on the medial line,
 *   even spacing) and an even centred grid in halls/rooms.
 * - centerRoute: slide straight route segments onto the corridor centreline (midpoint between
 *   the facing wall faces), then round the corners. Endpoints stay put.
 */
export type P2 = { x: number; y: number };
export type WallSeg = { start: P2; end: P2; thickness?: number };
export type LightSpot = { x: number; z: number; long: boolean };

const CORRIDOR_ASPECT = 2.2;
const CORRIDOR_MAX_WIDTH = 450;

export function lightSpots(rooms: { polygon: P2[] }[], step = 300): LightSpot[] {
  const spots: LightSpot[] = [];
  for (const room of rooms) {
    const xs = room.polygon.map(p => p.x), ys = room.polygon.map(p => p.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const w = x1 - x0, h = y1 - y0;
    if (Math.min(w, h) < 150) continue;
    const long = w >= h;
    const major = Math.max(w, h), minor = Math.min(w, h);
    const corridor = major / minor >= CORRIDOR_ASPECT && minor <= CORRIDOR_MAX_WIDTH;
    const nMajor = Math.max(1, Math.round(major / step));
    const nMinor = corridor ? 1 : Math.max(1, Math.round(minor / (step + 40)));
    for (let i = 0; i < nMajor; i++) for (let j = 0; j < nMinor; j++) {
      const a = (i + 0.5) / nMajor, b = (j + 0.5) / nMinor;
      const x = long ? x0 + a * w : x0 + b * w;
      const z = long ? y0 + b * h : y0 + a * h;
      if (inside({ x, y: z }, room.polygon)) spots.push({ x, z, long });
    }
  }
  return spots;
}

/**
 * Circulation that is not a room face (the corridor is usually the leftover between rooms):
 * sample the plan, keep enclosed points outside every room whose cross-section is corridor-narrow,
 * snap each to the midpoint between its facing walls and space them `step` apart along the run.
 */
export function corridorLightSpots(rooms: { polygon: P2[] }[], walls: WallSeg[], step = 300, align = true): LightSpot[] {
  if (!walls.length) return [];
  const xs = walls.flatMap(w => [w.start.x, w.end.x]), ys = walls.flatMap(w => [w.start.y, w.end.y]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const seen = new Map<string, LightSpot>();
  const halls = new Map<string, LightSpot>();
  const grid = 60;
  for (let x = x0 + grid / 2; x < x1; x += grid) for (let y = y0 + grid / 2; y < y1; y += grid) {
    const p = { x, y };
    if (rooms.some(r => inside(p, r.polygon))) continue;
    const e = rayToWall(p, { x: 1, y: 0 }, walls, 4000), w = rayToWall(p, { x: -1, y: 0 }, walls, 4000);
    const s = rayToWall(p, { x: 0, y: 1 }, walls, 4000), n = rayToWall(p, { x: 0, y: -1 }, walls, 4000);
    // Both cross-section rays must hit walls (outside the building one escapes); the run may be
    // open at an end (an entrance). Under 100 cm is a sample inside a wall's thickness.
    const wx = e + w, wy = s + n;
    if (wy >= 100 && wy <= CORRIDOR_MAX_WIDTH && wx >= wy * CORRIDOR_ASPECT && Math.min(e, w) < 4000) {
      const cy = y + (s - n) / 2, sx = Math.round(x / step) * step;
      if (Math.abs(sx - x) > grid / 2) continue;
      const key = `h${Math.round(cy / 30)}:${sx}`;
      if (!seen.has(key) && !rooms.some(r => inside({ x: sx, y: cy }, r.polygon))) seen.set(key, { x: sx, z: cy, long: true });
    } else if (wx >= 100 && wx <= CORRIDOR_MAX_WIDTH && wy >= wx * CORRIDOR_ASPECT && Math.min(s, n) < 4000) {
      const cx = x + (e - w) / 2, sy = Math.round(y / step) * step;
      if (Math.abs(sy - y) > grid / 2) continue;
      const key = `v${Math.round(cx / 30)}:${sy}`;
      if (!seen.has(key) && !rooms.some(r => inside({ x: cx, y: sy }, r.polygon))) seen.set(key, { x: cx, z: sy, long: false });
    } else if (wx > CORRIDOR_MAX_WIDTH && wy > CORRIDOR_MAX_WIDTH && [e, w, s, n].filter(d => d < 4000).length >= 3) {
      const sx = Math.round(x / step) * step, sy = Math.round(y / step) * step;
      if (Math.abs(sx - x) > grid / 2 || Math.abs(sy - y) > grid / 2) continue;
      if (sx < x0 + 64 || sx > x1 - 64 || sy < y0 + 64 || sy > y1 - 64) continue;
      if ([{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }].some(d => rayToWall({ x: sx, y: sy }, d, walls, 4000) < 64)) continue;
      const key = `hall:${sx}:${sy}`;
      if (!rooms.some(r => inside({ x: sx, y: sy }, r.polygon))) halls.set(key, { x: sx, z: sy, long: true });
    }
  }
  return [...(align ? alignRuns([...seen.values()], step) : seen.values()), ...halls.values()];
}

/**
 * Put every lamp of one straight corridor run on a single centre line: group spots by axis whose
 * cross position agrees within 45 cm and whose along-run gaps are at most ~1.5 steps, then snap the
 * cross coordinate to the run's median (wall jogs / door recesses no longer wiggle the line) and
 * drop near-duplicates left by the 30 cm keying.
 */
export function alignRuns(spots: LightSpot[], step = 300): LightSpot[] {
  const out: LightSpot[] = [];
  for (const long of [true, false]) {
    const along = (s: LightSpot) => long ? s.x : s.z, cross = (s: LightSpot) => long ? s.z : s.x;
    const pool = spots.filter(s => !!s.long === long).sort((a, b) => cross(a) - cross(b));
    const used = new Set<LightSpot>();
    for (const seed of pool) {
      if (used.has(seed)) continue;
      // grow a run: same line (±45 cm), connected along the axis
      let run = [seed]; used.add(seed);
      for (let grew = true; grew;) {
        grew = false;
        const mid = median(run.map(cross));
        for (const s of pool) if (!used.has(s) && Math.abs(cross(s) - mid) <= 45 && run.some(r => Math.abs(along(r) - along(s)) <= step * 1.5)) { run.push(s); used.add(s); grew = true; }
      }
      const c = median(run.map(cross));
      const byA = new Map<number, LightSpot>();
      for (const s of run) { const k = Math.round(along(s)); if (!byA.has(k)) byA.set(k, s); }
      for (const [k] of byA) out.push(long ? { x: k, z: c, long } : { x: c, z: k, long });
    }
  }
  return out;
}


/**
 * Drop circulation faces: a face whose bounding box holds other faces' centres is the leftover
 * corridor network (sometimes OCR-named, e.g. 护士站); corridorLightSpots lights it instead.
 */
export function enclosedRooms<T extends { polygon: P2[] }>(rooms: T[]): T[] {
  const centre = (poly: P2[]) => ({ x: poly.reduce((a, q) => a + q.x, 0) / poly.length, y: poly.reduce((a, q) => a + q.y, 0) / poly.length });
  const centres = rooms.map(r => centre(r.polygon));
  return rooms.filter((r, i) => {
    const xs = r.polygon.map(q => q.x), ys = r.polygon.map(q => q.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    return !centres.some((c, j) => j !== i && c.x > x0 && c.x < x1 && c.y > y0 && c.y < y1 && !inside(c, r.polygon));
  });
}

export function inside(p: P2, poly: P2[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

/** Distance along ray (o + t·d) to the nearest wall face (walls as thick rectangles). */
export function rayToWall(o: P2, d: P2, walls: WallSeg[], max = 800): number {
  let best = max;
  for (const w of walls) {
    const ux = w.end.x - w.start.x, uy = w.end.y - w.start.y, len = Math.hypot(ux, uy);
    if (len < 1) continue;
    const half = (w.thickness ?? 15) / 2;
    const nx = -uy / len * half, ny = ux / len * half;
    const c = [
      { x: w.start.x + nx, y: w.start.y + ny }, { x: w.end.x + nx, y: w.end.y + ny },
      { x: w.end.x - nx, y: w.end.y - ny }, { x: w.start.x - nx, y: w.start.y - ny },
    ];
    for (let i = 0; i < 4; i++) {
      const a = c[i], b = c[(i + 1) % 4];
      const ex = b.x - a.x, ey = b.y - a.y;
      const den = d.x * ey - d.y * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((a.x - o.x) * ey - (a.y - o.y) * ex) / den;
      const s = ((a.x - o.x) * d.y - (a.y - o.y) * d.x) / den;
      if (t > 0.01 && s >= 0 && s <= 1 && t < best) best = t;
    }
  }
  return best;
}

function median(v: number[]) { const s = v.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }

function lineIntersect(p: P2, d: P2, q: P2, e: P2): P2 | null {
  const den = d.x * e.y - d.y * e.x;
  if (Math.abs(den) < 1e-6) return null;
  const t = ((q.x - p.x) * e.y - (q.y - p.y) * e.x) / den;
  return { x: p.x + d.x * t, y: p.y + d.y * t };
}

/**
 * The planner string-pulls door→door runs into diagonals across a corridor. Re-route such a
 * diagonal as door → centreline → along the corridor → door, so the walk follows the medial line.
 */
export function orthogonalize(points: P2[], walls: WallSeg[], corridorMax = 700): P2[] {
  const out: P2[] = [points[0]];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    const off = Math.min(Math.abs(dx), Math.abs(dy)) / (len || 1);
    // Interior runs only: the first/last legs lead into a room destination and stay as drawn.
    if (i > 0 && i + 2 < points.length && len > 200 && off > 0.03 && Math.min(Math.abs(dx), Math.abs(dy)) > 40) {
      const horiz = Math.abs(dx) >= Math.abs(dy);
      const nrm = horiz ? { x: 0, y: 1 } : { x: 1, y: 0 };
      // Sample along the run; open sides (a lobby off the corridor) read wide, so take the
      // narrowest section as the corridor and use its centre.
      let best: { w: number; c: number } | null = null;
      for (const t of [0.2, 0.35, 0.5, 0.65, 0.8]) {
        const m = { x: a.x + dx * t, y: a.y + dy * t };
        const l = rayToWall(m, nrm, walls, 1200), r = rayToWall(m, { x: -nrm.x, y: -nrm.y }, walls, 1200);
        if (l + r <= corridorMax && (!best || l + r < best.w)) best = { w: l + r, c: (horiz ? m.y : m.x) + (l - r) / 2 };
      }
      if (best) {
        const c = best.c;
        const via = horiz
          ? [{ x: a.x, y: c }, { x: b.x, y: c }]
          : [{ x: c, y: a.y }, { x: c, y: b.y }];
        // Only the new centreline run is gated — elbows often start on a door jamb / wall face
        // where segment samples read as a clip even though the planner already committed to that door.
        if (!segmentClipsWall(via[0], via[1], walls)) out.push(...via);
      }
    }
    out.push(b);
  }
  return out.filter((p, i) => i === 0 || Math.hypot(p.x - out[i - 1].x, p.y - out[i - 1].y) > 1);
}

/** True when the open segment samples into a wall band (doors appear as gaps in wall data). */
function segmentClipsWall(a: P2, b: P2, walls: WallSeg[]): boolean {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(2, Math.floor(len / 4));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    for (const w of walls) {
      const ux = w.end.x - w.start.x, uy = w.end.y - w.start.y, wlen = Math.hypot(ux, uy);
      if (wlen < 1) continue;
      const half = (w.thickness ?? 15) / 2 + 2;
      const tx = ux / wlen, ty = uy / wlen;
      const along = (p.x - w.start.x) * tx + (p.y - w.start.y) * ty;
      if (along < -2 || along > wlen + 2) continue;
      const across = (p.x - w.start.x) * -ty + (p.y - w.start.y) * tx;
      if (Math.abs(across) <= half) return true;
    }
  }
  return false;
}

function pathClipsWall(pts: P2[], walls: WallSeg[]): boolean {
  for (let i = 0; i + 1 < pts.length; i++) if (segmentClipsWall(pts[i], pts[i + 1], walls)) return true;
  return false;
}

export function centerRoute(points: P2[], walls: WallSeg[], opts: { maxWidth?: number; radius?: number } = {}): P2[] {
  const raw = points.slice();
  if (points.length >= 2 && walls.length) points = orthogonalize(points, walls);
  if (points.length < 4 || !walls.length) return pathClipsWall(points, walls) ? raw : points.slice();
  // Wide halls are centred too (route must not hug a wall); door gaps give outlier widths.
  const maxWidth = opts.maxWidth ?? 1600;
  const n = points.length - 1;
  const shift: number[] = new Array(n).fill(0);
  const dirs: P2[] = [];
  for (let i = 0; i < n; i++) {
    const a = points[i], b = points[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const d = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    dirs.push(d);
    // First / last legs end at a room destination; door crossings are too short to matter.
    if (i === 0 || i === n - 1 || len < 120) continue;
    const nrm = { x: -d.y, y: d.x };
    const offs: number[] = [];
    for (const t of [0.2, 0.35, 0.5, 0.65, 0.8]) {
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      const l = rayToWall(p, nrm, walls), r = rayToWall(p, { x: -nrm.x, y: -nrm.y }, walls);
      if (l + r <= maxWidth) offs.push((l - r) / 2);
    }
    if (offs.length >= 3) shift[i] = median(offs);
  }
  const lineP = (i: number) => ({ x: points[i].x - dirs[i].y * shift[i], y: points[i].y + dirs[i].x * shift[i] });
  const out: P2[] = [points[0]];
  for (let k = 1; k < n; k++) {
    const hit = lineIntersect(lineP(k - 1), dirs[k - 1], lineP(k), dirs[k]);
    const orig = points[k];
    if (hit && Math.hypot(hit.x - orig.x, hit.y - orig.y) < 800) { out.push(hit); continue; }
    // Collinear neighbours (e.g. an unshifted end leg): ease onto the shifted run instead.
    if (shift[k]) out.push(lineP(k));
    else if (shift[k - 1]) out.push({ x: orig.x - dirs[k - 1].y * shift[k - 1], y: orig.y + dirs[k - 1].x * shift[k - 1] });
    else out.push(orig);
  }
  out.push(points[n]);
  // Rounding / centering must never invent a wall clip the planner did not have.
  if (pathClipsWall(out, walls)) return raw;
  const rounded = roundCorners(out, opts.radius ?? 70);
  return pathClipsWall(rounded, walls) ? out : rounded;
}

export function roundCorners(points: P2[], radius: number, steps = 6): P2[] {
  if (points.length < 3) return points.slice();
  const out: P2[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1], b = points[i], c = points[i + 1];
    const l1 = Math.hypot(b.x - a.x, b.y - a.y), l2 = Math.hypot(c.x - b.x, c.y - b.y);
    const r = Math.min(radius, l1 * 0.45, l2 * 0.45);
    const cross = Math.abs((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)) / (l1 * l2 || 1);
    if (r < 5 || cross < 0.05) { out.push(b); continue; }
    const p = { x: b.x + (a.x - b.x) / l1 * r, y: b.y + (a.y - b.y) / l1 * r };
    const q = { x: b.x + (c.x - b.x) / l2 * r, y: b.y + (c.y - b.y) / l2 * r };
    for (let s = 0; s <= steps; s++) {
      const t = s / steps, u = 1 - t; // quadratic Bézier p → b → q
      out.push({ x: u * u * p.x + 2 * u * t * b.x + t * t * q.x, y: u * u * p.y + 2 * u * t * b.y + t * t * q.y });
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

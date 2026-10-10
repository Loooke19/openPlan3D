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

export function centerRoute(points: P2[], walls: WallSeg[], opts: { maxWidth?: number; radius?: number } = {}): P2[] {
  if (points.length < 4 || !walls.length) return points.slice();
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
  return roundCorners(out, opts.radius ?? 70);
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

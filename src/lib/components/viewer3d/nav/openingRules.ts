/**
 * One hole, every wall: a door hole is an oriented box (along the host wall, wall-deep, door-high).
 * Every wall body that passes through that box gets the same hole — not just the host wall — so
 * a collinear duplicate wall, or a wall end poking into the doorway, can no longer re-fill the hole
 * (its faces were coplanar with the host's frame / reveal → z-fight). Collinear duplicate wall
 * bodies are also removed where they overlap (coplanar faces, double skirting).
 */
export type P = { x: number; y: number };
export type Hole = { door?: unknown; doorId: string; wallId: string; c: P; u: P; half: number; depth: number; top: number };
export type WallLike = { id: string; start: P; end: P; thickness: number; curvePoint?: unknown };
/** A pseudo door in the target wall's own parameters (position = centre fraction). */
export type Cut = { position: number; width: number; height: number; inside?: boolean };

const EPS = 0.5;

function frame(w: WallLike) {
  const dx = w.end.x - w.start.x, dy = w.end.y - w.start.y, L = Math.hypot(dx, dy) || 1;
  return { L, u: { x: dx / L, y: dy / L }, n: { x: -dy / L, y: dx / L } };
}

/** Interval [a,b] (cm along the wall) where the wall's body intersects the hole box. */
export function holeOnWall(w: WallLike, h: Hole, thickness: number, grow = 0): [number, number] | null {
  const { L, u } = frame(w);
  const hn = { x: -h.u.y, y: h.u.x };
  // clip the wall centre line (s in [0,L]) against the hole box grown by the wall half thickness
  // across the hole; a wall that only touches a hole face gives a zero-length span (ignored)
  const t = thickness / 2;
  let lo = 0, hi = L;
  const slab = (p0: number, dp: number, min: number, max: number) => {
    if (Math.abs(dp) < 1e-9) return p0 >= min && p0 <= max;
    let a = (min - p0) / dp, b = (max - p0) / dp; if (a > b) [a, b] = [b, a];
    lo = Math.max(lo, a); hi = Math.min(hi, b); return lo < hi;
  };
  const ox = w.start.x - h.c.x, oy = w.start.y - h.c.y;
  const along0 = ox * h.u.x + oy * h.u.y, alongD = u.x * h.u.x + u.y * h.u.y;
  const across0 = ox * hn.x + oy * hn.y, acrossD = u.x * hn.x + u.y * hn.y;
  // perpendicular-ish walls: their thickness spreads along the hole axis
  const tAlong = t * Math.abs(acrossD), tAcross = t * Math.abs(alongD);
  if (!slab(along0, alongD, -h.half - tAlong - grow, h.half + tAlong + grow)) return null;
  if (!slab(across0, acrossD, -h.depth / 2 - tAcross, h.depth / 2 + tAcross)) return null;
  return hi - lo > EPS ? [lo, hi] : null;
}

/** Cuts every hole makes in `w` (host holes included; caller drops duplicates of its own doors). */
/** `grow`: extra cm along the hole so a cut end sits just inside the host body, never on its reveal plane. */
export function holeCuts(w: WallLike, holes: Hole[], thickness: number, grow = 0.5): Cut[] {
  if (w.curvePoint) return [];
  const { L } = frame(w);
  const out: Cut[] = [];
  for (const h of holes) {
    if (h.wallId === w.id) continue; // host wall already has the real door
    const r = holeOnWall(w, h, thickness, grow);
    if (!r) continue;
    // inside: the body really enters the hole (it also overlaps the host lintel above → cut full
    // height); otherwise it only touches the hole edge and is just pulled back below the head.
    const inside = !!holeOnWall(w, h, thickness, 0);
    out.push({ position: (r[0] + r[1]) / 2 / L, width: r[1] - r[0], height: h.top, inside });
  }
  return out;
}

/**
 * Collinear duplicates: where wall `w` lies inside the body of another parallel wall, drop that
 * span from the thinner one (ties: the later one), so one body remains and no faces are shared.
 */
export function duplicateCuts(w: WallLike, index: number, walls: WallLike[], thick: (w: WallLike) => number, height: number): Cut[] {
  if (w.curvePoint) return [];
  const a = frame(w), tw = thick(w);
  const out: Cut[] = [];
  for (let j = 0; j < walls.length; j++) {
    const o = walls[j]; if (j === index || o.curvePoint) continue;
    const to = thick(o);
    if (to < tw - 0.01 || (Math.abs(to - tw) <= 0.01 && j > index)) continue; // only the thinner/later gives way
    const b = frame(o);
    if (Math.abs(a.u.x * b.u.y - a.u.y * b.u.x) > Math.sin(Math.PI / 180)) continue; // not parallel (1°)
    const off = Math.abs((w.start.x - o.start.x) * b.n.x + (w.start.y - o.start.y) * b.n.y);
    // w's cross-section mostly inside o's (≥ half of the thinner one overlaps)
    const overlap = Math.min(off + tw / 2, to / 2) - Math.max(off - tw / 2, -to / 2);
    if (overlap < Math.min(tw, to) / 2) continue;
    const s0 = (o.start.x - w.start.x) * a.u.x + (o.start.y - w.start.y) * a.u.y;
    const s1 = (o.end.x - w.start.x) * a.u.x + (o.end.y - w.start.y) * a.u.y;
    const lo = Math.max(0, Math.min(s0, s1)), hi = Math.min(a.L, Math.max(s0, s1));
    if (hi - lo > 1) out.push({ position: (lo + hi) / 2 / a.L, width: hi - lo, height });
  }
  return out;
}

/** Bridge solid slivers (< `min` cm) left between cuts / wall ends: they render as 1 cm posts. */
export function bridgeSlivers(L: number, cuts: Cut[], min = 2): Cut[] {
  const iv = cuts.map(c => [c.position * L - c.width / 2, c.position * L + c.width / 2, c.height] as [number, number, number]).sort((x, y) => x[0] - y[0]);
  const out: Cut[] = [];
  let prevEnd = 0, prevH = Infinity;
  for (const [lo, hi, h] of iv) {
    const gap = lo - prevEnd;
    if (gap > 0 && gap < min) out.push({ position: (prevEnd + lo) / 2 / L, width: gap + 0.02, height: Math.min(h, prevH === Infinity ? h : prevH) });
    if (hi > prevEnd) { prevEnd = hi; prevH = h; }
  }
  if (iv.length && L - prevEnd > 0 && L - prevEnd < min) out.push({ position: (prevEnd + L) / 2 / L, width: L - prevEnd + 0.02, height: prevH });
  return out;
}

/** Holes overlapping an earlier hole on the same line (duplicate door records) → index of the keeper. */
export function holeKeeper(holes: Hole[], i: number): number {
  const h = holes[i];
  for (let j = 0; j < i; j++) {
    const k = holes[j];
    if (Math.abs(h.u.x * k.u.y - h.u.y * k.u.x) > 0.02) continue;
    const dx = h.c.x - k.c.x, dy = h.c.y - k.c.y;
    const across = Math.abs(dx * -k.u.y + dy * k.u.x), along = Math.abs(dx * k.u.x + dy * k.u.y);
    if (across < (h.depth + k.depth) / 2 && along < h.half + k.half - 1) return j;
  }
  return i;
}

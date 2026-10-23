/**
 * First-person "kit" dressing from the licensed wu9777 Emergency Clinic kit (GLB, flat colours,
 * no textures). The wall cores stay the generated walls (paint #E9E6DF); the kit adds its wall
 * module trims (panel / skirting / bumper rail / pilaster) per wall face, cut at doors, at
 * other walls and at corner posts so nothing overlaps, plus rule-placed props per room type.
 * All geometry is planned in plan space first (planKit) so it can be audited without a GPU.
 * Assets live in static/nav-kit/ and are NOT redistributed in the repo (see LICENSE note).
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { inside, rayToWall } from './layout';

export type P = { x: number; y: number };
export type KitWall = { id?: string; start: P; end: P; thickness?: number; height?: number };
export type KitDoor = { wallId?: string; position?: number; width?: number };
export type KitRoom = { name: string; polygon: P[] };

// ---------- wall regularisation (front-end only; recognition data untouched) ----------
export const KIT_THICKNESS_BINS = [10, 15, 20, 25, 30, 40];
const SNAP_DEG = 4;

/** Near-orthogonal walls are squared, endpoints that touched stay touching, thickness is binned. */
export function regularizeWalls<T extends KitWall>(walls: T[]): { walls: T[]; squared: number; maxShift: number; binned: number } {
  const out = walls.map(w => ({ ...w, start: { ...w.start }, end: { ...w.end } }));
  // Record contacts (endpoint on another wall's centre line) before moving anything.
  const contacts: { w: number; e: 'start' | 'end'; on: number; t: number }[] = [];
  walls.forEach((w, i) => (['start', 'end'] as const).forEach(e => {
    const p = w[e];
    walls.forEach((o, j) => {
      if (j === i) return;
      const dx = o.end.x - o.start.x, dy = o.end.y - o.start.y, L2 = dx * dx + dy * dy;
      if (L2 < 1) return;
      const t = ((p.x - o.start.x) * dx + (p.y - o.start.y) * dy) / L2;
      if (t < -0.001 || t > 1.001) return;
      if (Math.hypot(p.x - o.start.x - t * dx, p.y - o.start.y - t * dy) < 2) contacts.push({ w: i, e, on: j, t });
    });
  }));
  let squared = 0, binned = 0;
  out.forEach(w => {
    const a = Math.atan2(w.end.y - w.start.y, w.end.x - w.start.x) * 180 / Math.PI;
    const off = ((a % 90) + 90) % 90, dev = Math.min(off, 90 - off);
    if (dev > 0.01 && dev < SNAP_DEG) {
      squared++;
      const horiz = Math.abs(Math.cos(a * Math.PI / 180)) > 0.7;
      if (horiz) { const m = (w.start.y + w.end.y) / 2; w.start.y = w.end.y = m; } else { const m = (w.start.x + w.end.x) / 2; w.start.x = w.end.x = m; }
    }
    const t = w.thickness ?? 15;
    const b = KIT_THICKNESS_BINS.reduce((x, y) => (Math.abs(y - t) < Math.abs(x - t) ? y : x));
    if (b !== t) binned++;
    w.thickness = b;
  });
  for (let pass = 0; pass < 2; pass++) for (const c of contacts) {
    const o = out[c.on], p = out[c.w][c.e];
    const q = { x: o.start.x + (o.end.x - o.start.x) * c.t, y: o.start.y + (o.end.y - o.start.y) * c.t };
    p.x = q.x; p.y = q.y;
  }
  let maxShift = 0;
  out.forEach((w, i) => (['start', 'end'] as const).forEach(e => { maxShift = Math.max(maxShift, Math.hypot(w[e].x - walls[i][e].x, w[e].y - walls[i][e].y)); }));
  return { walls: out as T[], squared, maxShift, binned };
}

// ---------- plan-space layout ----------
/** One oriented box in plan space: centre, unit axis u (length dir), half sizes, y range. */
export type KitBox = { kind: string; asset: string; c: P; u: P; hl: number; hd: number; y0: number; y1: number; wall?: number; room?: string; corner?: boolean };
const FACE = { panel: 1, skirt: 2, rail: 5, post: 5 };
const BAY = 240; // module length (cm)
const POST_W = 12;

function rectOf(w: KitWall, pad = 0): KitBox {
  const dx = w.end.x - w.start.x, dy = w.end.y - w.start.y, L = Math.hypot(dx, dy) || 1;
  return { kind: 'wall', asset: '', c: { x: (w.start.x + w.end.x) / 2, y: (w.start.y + w.end.y) / 2 }, u: { x: dx / L, y: dy / L }, hl: L / 2 + pad, hd: (w.thickness ?? 15) / 2 + pad, y0: 0, y1: w.height ?? 280 };
}
function corners(b: KitBox): P[] {
  const v = { x: -b.u.y, y: b.u.x };
  return [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([s, t]) => ({ x: b.c.x + b.u.x * b.hl * s + v.x * b.hd * t, y: b.c.y + b.u.y * b.hl * s + v.y * b.hd * t }));
}
/** Penetration depth of two oriented boxes in plan (SAT, >0 means overlap) — y ranges must overlap too. */
export function overlapDepth(a: KitBox, b: KitBox): number {
  const yo = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (yo <= 0) return 0;
  const ca = corners(a), cb = corners(b);
  let best = Infinity;
  for (const ax of [a.u, { x: -a.u.y, y: a.u.x }, b.u, { x: -b.u.y, y: b.u.x }]) {
    const pa = ca.map(p => p.x * ax.x + p.y * ax.y), pb = cb.map(p => p.x * ax.x + p.y * ax.y);
    const o = Math.min(Math.max(...pa), Math.max(...pb)) - Math.max(Math.min(...pa), Math.min(...pb));
    if (o <= 0) return 0;
    best = Math.min(best, o);
  }
  return Math.min(best, yo);
}
/** Interval [t0,t1] along a line p+t·d (|d|=1) covered by box b (expanded by pad). */
function lineHits(p: P, d: P, b: KitBox, pad: number): [number, number] | null {
  let t0 = -Infinity, t1 = Infinity;
  for (const [ax, h] of [[b.u, b.hl + pad], [{ x: -b.u.y, y: b.u.x }, b.hd + pad]] as const) {
    const o = (p.x - b.c.x) * ax.x + (p.y - b.c.y) * ax.y, s = d.x * ax.x + d.y * ax.y;
    if (Math.abs(s) < 1e-9) { if (Math.abs(o) > h) return null; continue; }
    let a = (-h - o) / s, c = (h - o) / s; if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, c);
  }
  return t1 > t0 ? [t0, t1] : null;
}
function subtract(iv: [number, number][], cut: [number, number]) {
  const out: [number, number][] = [];
  for (const [a, b] of iv) { if (cut[1] <= a || cut[0] >= b) { out.push([a, b]); continue; } if (cut[0] > a) out.push([a, cut[0]]); if (cut[1] < b) out.push([cut[1], b]); }
  return out;
}
const inAny = (p: P, rooms: KitRoom[]) => rooms.some(r => inside(p, r.polygon));

export type KitPlan = { boxes: KitBox[]; walls: KitBox[]; rooms?: KitRoom[]; footprint?: P[] | null; stats: Record<string, number> };

export function planKit(walls: KitWall[], doors: KitDoor[], rooms: KitRoom[], footprint: P[] | null, opts: { propsIn?: (r: KitRoom) => boolean; keep?: P[]; signs?: KitBox[] } = {}): KitPlan {
  const signs = opts.signs ?? [];
  const interior = (p: P) => (footprint && footprint.length > 2 ? inside(p, footprint) : true) || inAny(p, rooms);
  const wallBoxes = walls.map(w => rectOf(w));
  const boxes: KitBox[] = [];
  // Outer-corner posts: an endpoint shared by exactly two non-parallel walls.
  const ends: { p: P; w: number }[] = [];
  walls.forEach((w, i) => ends.push({ p: w.start, w: i }, { p: w.end, w: i }));
  const posts: KitBox[] = [];
  for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++) {
    const a = ends[i], b = ends[j];
    if (a.w === b.w || Math.hypot(a.p.x - b.p.x, a.p.y - b.p.y) > 1.5) continue;
    const ua = wallBoxes[a.w].u, ub = wallBoxes[b.w].u;
    if (Math.abs(ua.x * ub.y - ua.y * ub.x) < 0.5) continue;
    const s = Math.max(walls[a.w].thickness ?? 15, walls[b.w].thickness ?? 15) / 2 + FACE.post;
    posts.push({ kind: 'post', asset: 'post', c: { ...a.p }, u: ua, hl: s, hd: s, y0: 5, y1: 277, wall: a.w, corner: true });
  }
  // drop duplicate corner posts (3+ walls at a node)
  // Posts of nearby nodes that would overlap merge into one rectangular column cover.
  const cornerPosts: KitBox[] = [];
  for (const p of posts) {
    let cur = p;
    for (let i = cornerPosts.length - 1; i >= 0; i--) {
      if (overlapDepth({ ...cur, hl: cur.hl + 0.5, hd: cur.hd + 0.5 }, cornerPosts[i]) <= 0) continue;
      const pts = [...corners(cur), ...corners(cornerPosts[i])];
      const xs = pts.map(q => q.x), ys = pts.map(q => q.y);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      cur = { ...cur, c: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, u: { x: 1, y: 0 }, hl: (x1 - x0) / 2, hd: (y1 - y0) / 2 };
      cornerPosts.splice(i, 1);
      i = cornerPosts.length; // re-scan against the grown cover
    }
    cornerPosts.push(cur);
  }
  // A cover may only wrap the walls that end in it; one that would swallow a passing wall is dropped.
  for (let i = cornerPosts.length - 1; i >= 0; i--) {
    const cp = cornerPosts[i];
    const foreign = wallBoxes.some(w => overlapDepth(cp, w) > 0.1 && ![-1, 1].some(s => overlapDepth(cp, { ...cp, c: { x: w.c.x + w.u.x * w.hl * s, y: w.c.y + w.u.y * w.hl * s }, hl: 0.5, hd: 0.5 }) > 0));
    // door signs win: a cover that would touch a blade is dropped
    if (foreign || signs.some(sg => overlapDepth({ ...cp, hl: cp.hl + 1, hd: cp.hd + 1 }, sg) > 0)) cornerPosts.splice(i, 1);
  }
  // Wall-face strips.
  const laid: { p0: P; u: P; n: P; iv: [number, number][] }[] = [];
  walls.forEach((w, wi) => {
    const wb = wallBoxes[wi], L = wb.hl * 2;
    if (L < 30) return;
    const half = (w.thickness ?? 15) / 2;
    for (const side of [1, -1]) {
      const n = { x: -wb.u.y * side, y: wb.u.x * side };
      const probe = { x: wb.c.x + n.x * (half + 40), y: wb.c.y + n.y * (half + 40) };
      if (!interior(probe)) continue; // exterior face: no interior trim
      const off = half + FACE.rail / 2;
      const p0 = { x: w.start.x + n.x * off, y: w.start.y + n.y * off };
      let iv: [number, number][] = [[-half - FACE.post, L + half + FACE.post]];
      // a strip never runs past the wall unless it turns an outer corner (post covers it)
      const atPost = (q: P) => cornerPosts.some(cp => overlapDepth(cp, { ...cp, c: q, hl: 1, hd: 1 }) > 0);
      if (!atPost(w.start)) iv = subtract(iv, [-1e6, 0]);
      if (!atPost(w.end)) iv = subtract(iv, [L, 1e6]);
      for (const d of doors) if (d.wallId === w.id) { const t = (d.position ?? 0.5) * L, h = (d.width ?? 90) / 2 + 4; iv = subtract(iv, [t - h, t + h]); }
      // Other walls clip the strip at their faces. Their rects are stretched lengthwise so a wall
      // that stops a hair short of this face still cuts it; earlier walls also own the 5 cm trim
      // band at an inner corner (later strips start past it) so the two rails butt, never overlap.
      // A parallel wall closer than two trim depths leaves a dead slot: no trim in it.
      wallBoxes.forEach((o, oi) => { if (oi === wi) return; const h = lineHits(p0, wb.u, { ...o, hl: o.hl + FACE.post + 1, hd: o.hd + (Math.abs(o.u.x * wb.u.y - o.u.y * wb.u.x) < 0.05 ? 2 * FACE.post + 1 : oi < wi ? FACE.post : 0) }, 0); if (h) iv = subtract(iv, h); });
      // Collinear walls (split / duplicated in the source) share one face line: lay it once.
      for (const f of laid) {
        if (Math.abs(f.u.x * wb.u.y - f.u.y * wb.u.x) > 1e-3 || f.n.x * n.x + f.n.y * n.y < 0.99) continue;
        if (Math.abs((f.p0.x - p0.x) * n.x + (f.p0.y - p0.y) * n.y) > 0.6) continue;
        const dir = f.u.x * wb.u.x + f.u.y * wb.u.y, base = (f.p0.x - p0.x) * wb.u.x + (f.p0.y - p0.y) * wb.u.y;
        for (const [a, b] of f.iv) { const x = base + dir * a, y = base + dir * b; iv = subtract(iv, [Math.min(x, y), Math.max(x, y)]); }
      }
      for (const cp of cornerPosts) { const h = lineHits(p0, wb.u, cp, FACE.rail / 2 + 0.5); if (h) iv = subtract(iv, h); }
      for (const sg of signs) { const h = lineHits(p0, wb.u, sg, FACE.rail / 2 + 1); if (h) iv = subtract(iv, h); }
      laid.push({ p0, u: wb.u, n, iv: iv.slice() });
      for (const [a, b] of iv) {
        const len = b - a;
        if (len < 20) continue;
        // also make sure the strip is backed by this wall (not floating past a T)
        const nb = Math.max(1, Math.round(len / BAY));
        const bay = (len - POST_W * (nb - 1)) / nb;
        for (let k = 0; k < nb; k++) {
          const s0 = a + k * (bay + POST_W), mid = s0 + bay / 2;
          const at = (dz: number) => ({ x: w.start.x + wb.u.x * mid + n.x * (half + dz), y: w.start.y + wb.u.y * mid + n.y * (half + dz) });
          const u = { x: wb.u.x, y: wb.u.y };
          // (the kit's inset face panel is left out: flat-shaded it read darker than the painted wall)
          boxes.push({ kind: 'skirt', asset: 'skirt', c: at(FACE.skirt / 2), u, hl: bay / 2, hd: FACE.skirt / 2, y0: 0, y1: 12, wall: wi });
          boxes.push({ kind: 'rail', asset: 'rail', c: at(FACE.panel + (FACE.rail - FACE.panel) / 2), u, hl: bay / 2, hd: (FACE.rail - FACE.panel) / 2, y0: 72, y1: 84, wall: wi });
          if (k < nb - 1) {
            const pm = s0 + bay + POST_W / 2;
            boxes.push({ kind: 'post', asset: 'post', c: { x: w.start.x + wb.u.x * pm + n.x * (half + FACE.post / 2), y: w.start.y + wb.u.y * pm + n.y * (half + FACE.post / 2) }, u, hl: POST_W / 2, hd: FACE.post / 2, y0: 5, y1: 277, wall: wi });
          }
          for (let z = boxes.length - (k < nb - 1 ? 3 : 2); z < boxes.length; z++) (boxes[z] as any).n = n;
        }
      }
    }
  });
  boxes.push(...cornerPosts);
  const corridor: KitRoom = { name: '', polygon: [] };
  const inRoom = (p: P, r: KitRoom) => (r === corridor ? interior(p) && !inAny(p, rooms) : inside(p, r.polygon));
  const props = placeProps(walls, wallBoxes, doors, [...rooms, corridor], boxes, opts.propsIn ?? (() => true), inRoom, corridor, opts.keep ?? [], signs);
  boxes.push(...props);
  return { boxes, walls: wallBoxes, rooms, footprint, stats: { cornerPosts: cornerPosts.length, props: props.length } } as KitPlan;
}

// ---------- props ----------
type PropDef = { asset: string; w: number; d: number; h: number; mount?: number; isDest?: boolean };
// footprints in cm, from the GLB bounds (x = width along wall, z = depth)
export const KIT_PROPS: Record<string, PropDef> = {
  reception: { asset: 'MH20_Triage_Reception_Station', w: 192, d: 166, h: 167, isDest: true }, // the desk is the destination itself
  sink: { asset: 'MH17_Clinical_Handwash_Sink_Unit', w: 126, d: 75, h: 132 },
  aid: { asset: 'MH16_Wall_First_Aid_Cabinet', w: 102, d: 41, h: 130, mount: 95 },
  wheelchair: { asset: 'MH13_Wheelchair', w: 165, d: 99, h: 124 },
  crash: { asset: 'MH08_Defibrillator_Crash_Cart', w: 86, d: 78, h: 168 },
  gurney: { asset: 'MH14_Emergency_Stretcher_Gurney', w: 104, d: 208, h: 130 },
  monitor: { asset: 'MH07_Vital_Signs_Monitor_Cart', w: 86, d: 77, h: 154 },
  bed: { asset: 'MH04_Adjustable_Treatment_Bed', w: 116, d: 208, h: 132 },
  iv: { asset: 'MH06_IV_Stand_and_Fluid_Bag', w: 83, d: 80, h: 217 },
  exam: { asset: 'MH10_Examination_Table', w: 96, d: 181, h: 109 },
  trolley: { asset: 'MH09_Medicine_Trolley', w: 89, d: 70, h: 139 },
  shelf: { asset: 'MH19_Medical_Supply_Shelf', w: 125, d: 64, h: 210 },
  ultrasound: { asset: 'MH15_Portable_Ultrasound_Cart', w: 94, d: 87, h: 176 },
  oxygen: { asset: 'MH11_Oxygen_Cylinder_Rack', w: 118, d: 54, h: 164 },
  screen: { asset: 'MH05_Folding_Privacy_Screen', w: 172, d: 42, h: 200 },
};
/** Room-type rules (generic: matched on the room name, Chinese hospital vocabulary). */
export const KIT_RULES: { re: RegExp; items: string[] }[] = [
  { re: /检验|化验|采样/, items: ['shelf', 'sink'] },
  { re: /挂号|收费|服务台|导诊|分诊|护士站|问询/, items: ['reception', 'aid'] },
  { re: /候诊|门厅|大厅/, items: ['sink', 'aid', 'wheelchair'] },
  { re: /抢救/, items: ['crash', 'gurney', 'monitor', 'sink'] },
  { re: /急诊/, items: ['gurney', 'monitor', 'sink'] },
  { re: /留观|病房|输液室|观察/, items: ['bed', 'iv', 'screen'] },
  { re: /诊室|门诊$|门诊(?!办)/, items: ['exam', 'sink', 'screen'] },
  { re: /处置|治疗|注射|雾化|冲洗/, items: ['trolley', 'sink', 'shelf'] },
  { re: /超声|B超/, items: ['ultrasound', 'exam'] },
  { re: /氧疗/, items: ['oxygen', 'bed'] },
  { re: /储物|库房|药房/, items: ['shelf'] },
];
export const KIT_WHY: Record<string, number> = {};
const why = (k: string) => { KIT_WHY[k] = (KIT_WHY[k] || 0) + 1; return true; };
export const KIT_CORRIDOR_ITEMS = ['aid', 'sink', 'wheelchair'];
const CORRIDOR_EVERY = 1500; // cm between corridor wall items
export const CLEAR = 120; // free width in front of every prop
const DOOR_CLEAR = 60;
const PATH_HALF = 45;
const KEEP_R = 100; // around route end points (destinations / landings)
const CORNER_CLEAR = 60; // rooms
const CORNER_CLEAR_CIRC = 150; // corridors / halls: walkers and the route cut convex corners // keep this far (along wall) from any door jamb, 120 deep

function polyArea(p: P[]) { let a = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j].x + p[i].x) * (p[j].y - p[i].y); return Math.abs(a / 2); }
export function isCorridor(r: KitRoom) {
  if (/走廊|走道|过道|通道/.test(r.name)) return true;
  if (r.name) return false;
  const xs = r.polygon.map(p => p.x), ys = r.polygon.map(p => p.y);
  const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
  const area = polyArea(r.polygon);
  return area > 80000 && Math.max(w, h) / Math.max(1, area / Math.max(w, h)) > 3; // long and thin
}

function placeProps(walls: KitWall[], wallBoxes: KitBox[], doors: KitDoor[], rooms: KitRoom[], trims: KitBox[], allow: (r: KitRoom) => boolean, inRoom: (p: P, r: KitRoom) => boolean, corridor: KitRoom, keep: P[], signs: KitBox[]): KitBox[] {
  const placed: KitBox[] = [];
  const doorZones: KitBox[] = [];
  for (const d of doors) {
    const wi = walls.findIndex(w => w.id === d.wallId); if (wi < 0) continue;
    const w = walls[wi], wb = wallBoxes[wi], L = wb.hl * 2, t = (d.position ?? 0.5) * L;
    doorZones.push({ kind: 'door', asset: '', c: { x: w.start.x + wb.u.x * t, y: w.start.y + wb.u.y * t }, u: wb.u, hl: (d.width ?? 90) / 2 + DOOR_CLEAR, hd: (w.thickness ?? 15) / 2 + CLEAR, y0: 0, y1: 280 });
  }
  // Convex wall corners and free wall ends: people (and the route) cut these, keep props 60 cm off.
  const convex: P[] = [];
  walls.forEach((w, i) => [w.start, w.end].forEach(e => {
    const touching = wallBoxes.some((o, j) => j !== i && overlapDepth({ ...o, hl: o.hl + 2, hd: o.hd + 2 }, { ...o, c: e, hl: 0.5, hd: 0.5 }) > 0);
    if (!touching) convex.push(e);
  }));
  for (const t of trims) if (t.corner) convex.push(t.c);
  const nearConvex = (b: KitBox, r = CORNER_CLEAR) => convex.some(e => overlapDepth({ ...b, hl: b.hl + r, hd: b.hd + r, y0: 0, y1: 280 }, { ...b, c: e, hl: 0.5, hd: 0.5, y0: 0, y1: 280 }) > 0);
  const pathCache = new Map<KitRoom, P[]>();
  const roomPaths = (room: KitRoom): P[] => {
    if (pathCache.has(room)) return pathCache.get(room)!;
    const poly = room.polygon, cen = { x: poly.reduce((a, q) => a + q.x, 0) / poly.length, y: poly.reduce((a, q) => a + q.y, 0) / poly.length };
    const ends = keep.filter(k => inside(k, poly));
    const targets = ends.length ? ends : [cen];
    const pts: P[] = [];
    const mine = doorZones.filter(z => { const n = { x: -z.u.y, y: z.u.x }; return [1, -1].some(sg => inside({ x: z.c.x + n.x * sg * 30, y: z.c.y + n.y * sg * 30 }, poly)); }).map(z => z.c);
    // gaps in the room outline that no wall covers are walk-through openings too
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], L = Math.hypot(b.x - a.x, b.y - a.y);
      let run: P[] = [];
      const flush = () => { if (run.length * 10 >= 60) mine.push(run[Math.floor(run.length / 2)]); run = []; };
      for (let t = 5; t < L; t += 10) {
        const q = { x: a.x + (b.x - a.x) * t / L, y: a.y + (b.y - a.y) * t / L };
        const walled = wallBoxes.some(w => overlapDepth({ ...w, hl: w.hl + 2, hd: w.hd + 2 }, { ...w, c: q, hl: 0.5, hd: 0.5 }) > 0);
        if (walled) flush(); else run.push(q);
      }
      flush();
    }
    const seg = (a: P, b: P) => { const L = Math.hypot(b.x - a.x, b.y - a.y) || 1; for (let t = 0; t <= L; t += 5) pts.push({ x: a.x + (b.x - a.x) * t / L, y: a.y + (b.y - a.y) * t / L }); };
    // door -> centre (route end leg) and door -> door (rooms the planner walks through)
    mine.forEach((a, i) => { targets.forEach(c => seg(a, c)); mine.slice(i + 1).forEach(b => seg(a, b)); });
    pathCache.set(room, pts); return pts;
  };
  const obstacles = () => [...signs.map(sg => ({ ...sg, hl: sg.hl + 3, hd: sg.hd + 3 })), ...wallBoxes, ...trims.filter(t => t.kind === 'post'), ...placed];
  const tryPlace = (room: KitRoom, key: string, opts: { minGap?: number; anyGap?: number; open?: boolean } = {}): boolean => {
    const def = KIT_PROPS[key];
    // candidate: each wall face strip that faces into this room
    const cands: { box: KitBox; score: number }[] = [];
    for (const t of trims) {
      if (t.kind !== 'rail' || t.room) continue;
      const n = (t as any).n as P | undefined; if (!n) continue;
      const probe = { x: t.c.x + n.x * 30, y: t.c.y + n.y * 30 };
      if (!inRoom(probe, room)) continue;
      const bayLen = t.hl * 2;
      if (bayLen < def.w + 2 && why(key + ':bay')) continue;
      const back = def.mount ? FACE.panel + 0.5 : FACE.rail + 1 - (FACE.panel + (FACE.rail - FACE.panel) / 2) + FACE.rail / 2; // from rail centre plane
      const depthFromRail = def.mount ? -((FACE.rail - FACE.panel) / 2) + 0.5 : (FACE.rail - FACE.panel) / 2 + 1;
      void back;
      const c = { x: t.c.x + n.x * (depthFromRail + def.d / 2), y: t.c.y + n.y * (depthFromRail + def.d / 2) };
      const box: KitBox = { kind: 'prop', asset: def.asset, c, u: t.u, hl: def.w / 2, hd: def.d / 2, y0: def.mount ?? 0, y1: (def.mount ?? 0) + def.h, room: room.name || 'corridor' };
      (box as any).n = n;
      // inside room
      if (![...corners(box), c].every(p => inRoom(p, room)) && why(key + ':room')) continue;
      if (obstacles().some(o => overlapDepth(box, o) > 0) && why(key + ':obst')) continue;
      if (doorZones.some(z => overlapDepth({ ...box, y0: 0, y1: 280 }, z) > 0) && why(key + ':door')) continue;
      // free width in front: a 120 cm deep box in front must be clear of walls / posts / props
      const front: KitBox = { kind: 'clear', asset: '', c: { x: c.x + n.x * (def.d / 2 + CLEAR / 2 + 0.5), y: c.y + n.y * (def.d / 2 + CLEAR / 2 + 0.5) }, u: t.u, hl: def.w / 2, hd: CLEAR / 2, y0: 0, y1: 280 };
      if (obstacles().some(o => overlapDepth(front, o) > 0) && why(key + ':front')) continue;
      if (doorZones.some(z => overlapDepth(front, z) > 0)) continue; // never narrow a door approach
      if (!def.isDest && keep.some(k => overlapDepth({ ...box, hl: box.hl + KEEP_R, hd: box.hd + KEEP_R, y0: 0, y1: 280 }, { ...box, c: k, hl: 0.5, hd: 0.5, y0: 0, y1: 280 }) > 0)) continue;
      if (nearConvex(box, room === corridor ? CORNER_CLEAR_CIRC : CORNER_CLEAR)) continue;
      // in a room keep the walk from each of its doors to the room centre free (route end leg)
      if (room !== corridor && roomPaths(room).some(q => overlapDepth({ ...box, hl: box.hl + PATH_HALF, hd: box.hd + PATH_HALF, y0: 0, y1: 280 }, { ...box, c: q, hl: 0.5, hd: 0.5, y0: 0, y1: 280 }) > 0)) continue;
      if (placed.some(o => overlapDepth({ ...o, c: { x: o.c.x + ((o as any).n.x) * (o.hd + CLEAR / 2), y: o.c.y + ((o as any).n.y) * (o.hd + CLEAR / 2) }, hd: CLEAR / 2, y0: 0, y1: 280 }, box) > 0)) continue;
      if (opts.minGap && placed.some(o => o.asset === def.asset && Math.hypot(o.c.x - c.x, o.c.y - c.y) < opts.minGap!)) continue;
      if (opts.anyGap && placed.some(o => o.room === 'corridor' && Math.hypot(o.c.x - c.x, o.c.y - c.y) < opts.anyGap!)) continue;
      const free = rayToWall({ x: c.x + n.x * (def.d / 2 + 1), y: c.y + n.y * (def.d / 2 + 1) }, n, walls, 3000);
      if (free >= 3000 && why(key + ':open-to-outside')) continue; // faces nothing: outside the building
      // circulation: the walk line runs mid-corridor, so leave 120 cm + a person's width
      if (room === corridor && free < CLEAR + 2 * PATH_HALF && why(key + ':narrow')) continue;
      // open: prefer the face looking into the widest open floor (a hall), e.g. the triage desk
      const score = opts.open ? -Math.min(free, 1500) : -bayLen;
      cands.push({ box, score });
    }
    if (!cands.length) return false;
    cands.sort((a, b) => a.score - b.score);
    placed.push(cands[0].box);
    return true;
  };
  for (const room of rooms) {
    if (!allow(room)) continue;
    if (room === corridor || isCorridor(room)) {
      // corridor / hall circulation: wall items cycled along the faces, spaced apart
      // a hall (open circulation) gets one triage / reception desk facing its widest side
      if (!placed.some(p => p.asset === KIT_PROPS.reception.asset)) tryPlace(room, 'reception', { open: true });
      let k = 0;
      for (let tries = 0; tries < 60; tries++) {
        if (!tryPlace(room, KIT_CORRIDOR_ITEMS[k % KIT_CORRIDOR_ITEMS.length], { minGap: CORRIDOR_EVERY, anyGap: CORRIDOR_EVERY / 2 })) { if (++k > 3 * KIT_CORRIDOR_ITEMS.length + tries) break; continue; }
        k++;
      }
      continue;
    }
    const rule = KIT_RULES.find(r => r.re.test(room.name));
    if (!rule) continue;
    for (const k of rule.items) tryPlace(room, k);
  }
  return placed;
}

// ---------- GPU side ----------
/** Kit palette mapped onto the approved nav look (#E9E6DF matte walls, blue-grey, no teal/green). */
export const KIT_PALETTE: Record<string, string> = {
  MAT_WHITE: '#eceae4', MAT_CREAM: '#d9d6cf', MAT_TEAL: '#7f93a3', MAT_TEAL_DARK: '#55636e',
  MAT_STEEL: '#b9c0c4', MAT_STEEL_DARK: '#646d72', MAT_RUBBER: '#2a2e31', MAT_GLASS: '#b9cdd8',
  MAT_RED: '#c8414a', MAT_BLUE: '#4d7fa6', MAT_CYAN: '#9fd6e0', MAT_YELLOW: '#e2c25a', MAT_GREEN: '#9cc3dd', // CN oxygen cylinders are light blue
};
/** Room floor slabs sit at +3 cm; the kit tile goes just above them, props stand on it. */
const KIT_FLOOR_Y = 3.3;
const TRIM_COLORS: Record<string, string> = { panel: '#e9e6df', skirt: '#7d817f', rail: '#8a98a4', post: '#dcdedf' };

let kitCache: Promise<Map<string, THREE.BufferGeometry>> | null = null;
function loadKit(base: string, names: string[]) {
  if (kitCache) return kitCache;
  const loader = new GLTFLoader();
  kitCache = Promise.all(names.map(async n => {
    const g = await loader.loadAsync(`${base}/${n}.glb`);
    g.scene.updateMatrixWorld(true);
    const parts: THREE.BufferGeometry[] = [];
    g.scene.traverse(o => {
      const m = o as THREE.Mesh; if (!m.isMesh) return;
      const name = ((m.material as THREE.Material).name || '').replace(/\.\d+$/, '');
      const col = new THREE.Color(KIT_PALETTE[name] ?? '#cccccc');
      const geo = new THREE.BufferGeometry();
      const src = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry;
      geo.setAttribute('position', src.getAttribute('position').clone());
      geo.setAttribute('normal', src.getAttribute('normal').clone());
      const c = new Float32Array(geo.getAttribute('position').count * 3);
      for (let i = 0; i < c.length; i += 3) { c[i] = col.r; c[i + 1] = col.g; c[i + 2] = col.b; }
      geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
      geo.applyMatrix4(m.matrixWorld);
      bakeVertexAo(geo, 0, 0.01); // metres here: contact shade toward the floor + warm tint
      parts.push(geo);
    });
    const merged = mergeGeometries(parts)!;
    merged.scale(100, 100, 100); // m -> cm
    merged.computeBoundingBox();
    return [n, merged] as const;
  })).then(e => new Map(e));
  return kitCache;
}

export class NavKitDressing {
  readonly group = new THREE.Group();
  readonly plan: KitPlan;
  private disposables: { dispose(): void }[] = [];
  ready: Promise<void>;
  constructor(walls: KitWall[], doors: KitDoor[], rooms: KitRoom[], footprint: P[] | null, floorY: number, base = '/nav-kit', onReady?: () => void, keep: P[] = [], signs: KitBox[] = []) {
    this.group.userData.navDressing = true;
    this.group.userData.navKit = true;
    this.plan = planKit(walls, doors, rooms, footprint, { keep, signs });
    this.group.position.y = floorY;
    this.buildTrims();
    if (footprint && footprint.length > 2) this.buildFloor(footprint);
    const assets = [...new Set(this.plan.boxes.filter(b => b.kind === 'prop').map(b => b.asset))];
    this.ready = loadKit(base, Object.values(KIT_PROPS).map(p => p.asset)).then(geos => { this.buildProps(geos, assets); onReady?.(); });
  }
  private material(color?: string) {
    const m = new THREE.MeshStandardMaterial({ color: color ?? '#ffffff', vertexColors: !color, roughness: 0.82, metalness: 0 });
    this.disposables.push(m); return m;
  }
  private buildTrims() {
    const unit = new THREE.BoxGeometry(1, 1, 1); this.disposables.push(unit);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    for (const kind of ['panel', 'skirt', 'rail', 'post']) {
      const list = this.plan.boxes.filter(b => b.kind === kind);
      if (!list.length) continue;
      const im = new THREE.InstancedMesh(unit, this.material(TRIM_COLORS[kind]), list.length);
      list.forEach((b, i) => {
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.atan2(b.u.y, b.u.x));
        p.set(b.c.x, (b.y0 + b.y1) / 2, b.c.y); s.set(b.hl * 2, b.y1 - b.y0, b.hd * 2);
        im.setMatrixAt(i, m4.compose(p, q, s));
      });
      im.receiveShadow = true; im.userData.navDressing = true; im.name = 'kit-' + kind;
      this.group.add(im);
    }
  }
  private buildProps(geos: Map<string, THREE.BufferGeometry>, assets: string[]) {
    const mat = this.material();
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
    for (const a of assets) {
      const geo = geos.get(a); if (!geo) continue;
      const list = this.plan.boxes.filter(b => b.kind === 'prop' && b.asset === a);
      const bb = geo.boundingBox!;
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((b, i) => {
        const n = (b as any).n as P;
        // asset front faces +Z: rotate so +Z points along the wall normal n (into the room)
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(n.x, n.y));
        // centre the asset footprint on the planned box (GLB origins are not always centred)
        const cx = (bb.min.x + bb.max.x) / 2, cz = (bb.min.z + bb.max.z) / 2;
        const off = new THREE.Vector3(-cx, 0, -cz).applyQuaternion(q);
        p.set(b.c.x + off.x, b.y0 + (b.y0 > 0 ? 0 : KIT_FLOOR_Y) - bb.min.y, b.c.y + off.z);
        im.setMatrixAt(i, m4.compose(p, q, one));
      });
      im.castShadow = true; im.receiveShadow = true; im.userData.navDressing = true; im.name = 'kit-' + a;
      this.group.add(im);
    }
  }
  /** MH01 2 m clinic floor module as a world-space tile (cream joint band, pale inset, slim
   * blue-grey key line): one draw call over the footprint, tiles never scaled or cut visibly. */
  private buildFloor(footprint: P[]) {
    const S = 512, c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d')!; const px = (cm: number) => cm / 200 * S;
    g.fillStyle = '#e2e0da'; g.fillRect(0, 0, S, S); // joint band only a shade off the tile
    g.fillStyle = KIT_PALETTE.MAT_WHITE; g.fillRect(px(11), px(11), S - 2 * px(11), S - 2 * px(11));
    g.strokeStyle = '#ccd0d1'; g.lineWidth = px(1.2); g.strokeRect(px(10), px(10), S - 2 * px(10), S - 2 * px(10)); // hairline joint, not a drawn grid
    const tex = new THREE.CanvasTexture(c); tex.generateMipmaps = true; tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    const shape = new THREE.Shape(footprint.map(p => new THREE.Vector2(p.x, p.y)));
    const geo = new THREE.ShapeGeometry(shape);
    const pos = geo.getAttribute('position'), uv = geo.getAttribute('uv');
    for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / 200, pos.getY(i) / 200);
    geo.rotateX(Math.PI / 2); // plan y -> world z
    const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    m.side = THREE.DoubleSide;
    const mesh = new THREE.Mesh(geo, m); mesh.position.y = KIT_FLOOR_Y; mesh.receiveShadow = true; mesh.name = 'kit-floor'; mesh.userData.navDressing = true;
    this.disposables.push(tex, m, geo); this.group.add(mesh);
  }
  dispose() { this.group.removeFromParent(); this.disposables.forEach(d => d.dispose()); }
}

/** Door-sign footprints (from planSigns, floor-relative Y) as kit obstacles. */
export function signBoxes(signs: { a: P; b: P; center: P; y0: number; y1: number }[], floorY = 0): KitBox[] {
  return signs.map(s => { const L = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) || 1; return { kind: 'sign', asset: '', c: s.center, u: { x: (s.b.x - s.a.x) / L, y: (s.b.y - s.a.y) / L }, hl: L / 2, hd: 1.5, y0: s.y0 - floorY - 3, y1: s.y1 - floorY + 2 }; });
}

/** Baked light (no runtime cost): warm fill tint + contact/height AO into vertex colours.
 * floorY / unit: geometry's floor height and units per cm. */
const WARM = [1, 1, 1]; // neutral: no warm multiplier (Luke: avoid yellow cast)
export function bakeVertexAo(geo: THREE.BufferGeometry, floorY: number, unit = 1, corner?: (x: number, z: number) => number) {
  const pos = geo.getAttribute('position');
  let col = geo.getAttribute('color') as THREE.BufferAttribute | undefined;
  if (!col) { col = new THREE.BufferAttribute(new Float32Array(pos.count * 3).fill(1), 3); geo.setAttribute('color', col); }
  const ss = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  for (let i = 0; i < pos.count; i++) {
    const hy = (pos.getY(i) - floorY) / unit;
    let ao = 0.78 + 0.22 * ss(0, 90, hy);          // floor contact
    ao *= 1 - 0.06 * ss(230, 285, hy);              // ceiling junction
    if (corner) ao *= corner(pos.getX(i), pos.getZ(i));
    col.setXYZ(i, col.getX(i) * ao * WARM[0], col.getY(i) * ao * WARM[1], col.getZ(i) * ao * WARM[2]);
  }
  col.needsUpdate = true;
}

/** Split non-indexed triangles by plane dot(n,p)=c (attributes linearly interpolated). */
function slice(geo: THREE.BufferGeometry, n: THREE.Vector3, c: number): THREE.BufferGeometry {
  const names = Object.keys(geo.attributes);
  const src = names.map(k => geo.getAttribute(k) as THREE.BufferAttribute);
  const out: number[][] = names.map(() => []);
  const pos = geo.getAttribute('position');
  const vtx = (i: number) => src.map(a => Array.from({ length: a.itemSize }, (_, j) => a.array[i * a.itemSize + j] as number));
  const lerp = (a: number[][], b: number[][], t: number) => a.map((x, k) => x.map((v, j) => v + (b[k][j] - v) * t));
  const emit = (...vs: number[][][]) => vs.forEach(v => v.forEach((x, k) => out[k].push(...x)));
  const P = new THREE.Vector3();
  for (let t = 0; t < pos.count; t += 3) {
    const v = [vtx(t), vtx(t + 1), vtx(t + 2)];
    const d = [0, 1, 2].map(i => P.fromBufferAttribute(pos, t + i).dot(n) - c);
    const above = d.map(x => x > 1e-4), below = d.map(x => x < -1e-4);
    if (!above.some(Boolean) || !below.some(Boolean)) { emit(...v); continue; }
    // rotate so vertex 0 is the lone one on its side
    let r = 0;
    for (let i = 0; i < 3; i++) { const o = above[i] ? above : below; if (o.filter(Boolean).length === 1 && o[i]) r = i; }
    if (above.filter(Boolean).length === 2 && below.filter(Boolean).length === 1) r = below.indexOf(true);
    else if (below.filter(Boolean).length === 2 && above.filter(Boolean).length === 1) r = above.indexOf(true);
    else { // one vertex on the plane: split into two
      const z = d.findIndex(x => Math.abs(x) <= 1e-4); const a = (z + 1) % 3, b = (z + 2) % 3;
      const m = lerp(v[a], v[b], d[a] / (d[a] - d[b])); emit(v[z], v[a], m, v[z], m, v[b]); continue;
    }
    const a = r, b = (r + 1) % 3, cc = (r + 2) % 3;
    const ab = lerp(v[a], v[b], d[a] / (d[a] - d[b])), ac = lerp(v[a], v[cc], d[a] / (d[a] - d[cc]));
    emit(v[a], ab, ac, ab, v[b], v[cc], ab, v[cc], ac);
  }
  const g = new THREE.BufferGeometry();
  names.forEach((k, i) => g.setAttribute(k, new THREE.Float32BufferAttribute(out[i], src[i].itemSize)));
  return g;
}

/** Bake wall AO (floor contact + inside corners + warm fill) into vertex colours once. Walls are
 * sliced into bands near the floor / top / ends so the shading stays local (~40-50 cm). */
export function bakeWallAo(root: THREE.Object3D, walls: KitWall[], floorY: number) {
  const segs = walls.map(w => ({ a: w.start, b: w.end, t: (w.thickness ?? 15) / 2 }));
  const ss = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const shade = (x: number, y: number, z: number, top: number) => {
    let d = Infinity, touching = 0;
    for (const s of segs) {
      const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y, L = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - s.a.x) * dx + (z - s.a.y) * dy) / L));
      const e = Math.hypot(s.a.x + dx * t - x, s.a.y + dy * t - z) - s.t;
      if (Math.abs(e) <= 1) { touching++; continue; }
      if (e > 1) d = Math.min(d, e);
    }
    if (touching >= 2) d = 0;
    const hy = y - floorY;
    let ao = 1 - 0.34 * (1 - ss(0, 50, d));          // inside corner, within ~50 cm
    ao *= 1 - 0.30 * (1 - ss(0, 40, hy));            // floor contact, within ~40 cm
    ao *= 1 - 0.10 * (1 - ss(0, 25, top - y));       // ceiling junction
    return ao;
  };
  const mats = new Set<THREE.Material>();
  const N = new THREE.Vector3();
  root.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !(m.userData.renderMaterial === 'wall' || m.userData.wallId) || m.userData.navDressing || m.userData.kitBaked) return;
    m.updateWorldMatrix(true, false);
    let g = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()).applyMatrix4(m.matrixWorld);
    g.deleteAttribute('color');
    g.computeBoundingBox();
    const bb = g.boundingBox!, y0 = bb.min.y, y1 = bb.max.y;
    // principal horizontal direction from the footprint
    const pos = g.getAttribute('position');
    let best = 0, dir = new THREE.Vector3(1, 0, 0);
    for (let k = 0; k < 16; k++) {
      const v = new THREE.Vector3(Math.cos(k * Math.PI / 16), 0, Math.sin(k * Math.PI / 16));
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < pos.count; i++) { const q = pos.getX(i) * v.x + pos.getZ(i) * v.z; lo = Math.min(lo, q); hi = Math.max(hi, q); }
      if (hi - lo > best) { best = hi - lo; dir = v; }
    }
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < pos.count; i++) { const q = pos.getX(i) * dir.x + pos.getZ(i) * dir.z; lo = Math.min(lo, q); hi = Math.max(hi, q); }
    const cuts: [THREE.Vector3, number][] = [];
    for (const h of [15, 40]) if (y0 + h < y1 - 30) cuts.push([N.set(0, 1, 0).clone(), floorY + h]);
    for (const h of [25]) if (y1 - h > y0 + 45) cuts.push([N.set(0, 1, 0).clone(), y1 - h]);
    for (const e of [20, 50]) if (2 * e + 10 < hi - lo) { cuts.push([dir.clone(), lo + e]); cuts.push([dir.clone(), hi - e]); }
    // slice each material group on its own so multi-material walls keep their groups
    const groups = g.groups.length ? g.groups.map(x => ({ ...x })) : [{ start: 0, count: g.getAttribute('position').count, materialIndex: 0 }];
    const pieces = groups.map(gr => {
      let part = new THREE.BufferGeometry();
      for (const k of Object.keys(g.attributes)) { const at = g.getAttribute(k) as THREE.BufferAttribute; part.setAttribute(k, new THREE.BufferAttribute((at.array as Float32Array).slice(gr.start * at.itemSize, (gr.start + gr.count) * at.itemSize), at.itemSize)); }
      for (const [n, c] of cuts) part = slice(part, n, c);
      return { part, mi: gr.materialIndex ?? 0 };
    });
    const merged = new THREE.BufferGeometry();
    let off = 0;
    for (const k of Object.keys(g.attributes)) {
      const size = g.getAttribute(k).itemSize, total = pieces.reduce((a, p) => a + p.part.getAttribute(k).count, 0);
      const arr = new Float32Array(total * size); let o = 0;
      for (const p of pieces) { const src = p.part.getAttribute(k).array as Float32Array; arr.set(src, o); o += src.length; }
      merged.setAttribute(k, new THREE.BufferAttribute(arr, size));
    }
    if (g.groups.length) for (const p of pieces) { const n = p.part.getAttribute('position').count; merged.addGroup(off, n, p.mi); off += n; }
    g = merged;
    const p2 = g.getAttribute('position'), col = new Float32Array(p2.count * 3);
    for (let i = 0; i < p2.count; i++) {
      const ao = shade(p2.getX(i), p2.getY(i), p2.getZ(i), y1);
      col.set([ao * WARM[0], ao * WARM[1], ao * WARM[2]], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.applyMatrix4(m.matrixWorld.clone().invert());
    m.geometry.dispose(); m.geometry = g;
    m.userData.kitBaked = true;
    for (const mt of ([] as THREE.Material[]).concat(m.material)) mats.add(mt);
  });
  mats.forEach(mt => {
    const m = mt as THREE.MeshStandardMaterial;
    m.vertexColors = true;
    m.needsUpdate = true;
  });
}

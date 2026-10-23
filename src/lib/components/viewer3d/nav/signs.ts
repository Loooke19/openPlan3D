import { NAV_FONT } from '$lib/utils/navFonts';
/**
 * First-person wayfinding signage for the nav preview: for every door between a named room and a
 * corridor, one projecting double-sided blade above the door (readable looking up/down the corridor).
 * Flat wall plates were removed — they duplicated the blade text and read as stacked signs.
 */
import * as THREE from 'three';
import { toiletKind } from '$lib/utils/placeSearch';

type P = { x: number; y: number };
export type SignDoor = { center: P; along: P; normal: P; width: number; wallThickness: number; height: number; wallHeight?: number };
export type SignRoom = { name: string; displayName?: string; polygon: P[] };

/** Auto-generated placeholder labels (「Room 12」) are not names: corridors on upper floors carry them. */
export function isPlaceholderRoomName(name?: string | null) {
  return !name || /^\s*(room|房间)\s*\d+\s*$/i.test(name);
}

function inside(p: P, poly: P[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

/**
 * Corridor-outward normal for a door into exactly one named room.
 * Returns null when both/neither sides are named rooms (skip sign).
 */
export function corridorOutward(door: SignDoor, rooms: SignRoom[]): { room: SignRoom; outward: P } | null {
  const probe = (k: number) => ({ x: door.center.x + door.normal.x * k * 70, y: door.center.y + door.normal.y * k * 70 });
  const sideRoom = (k: number) => rooms.find((r) => inside(probe(k), r.polygon));
  const a = sideRoom(1), b = sideRoom(-1);
  const room = a && !b ? a : b && !a ? b : null;
  if (!room) return null;
  const k = room === a ? -1 : 1;
  return { room, outward: { x: door.normal.x * k, y: door.normal.y * k } };
}

/**
 * Right-handed basis for a projecting blade: X = into corridor, Y = up, Z = x×y (along wall).
 * Textured ±Z faces look up/down the corridor. Z is derived from X×Y — never from wall
 * winding — so a left-handed (n, up, along) triple cannot flatten the blade onto the wall.
 * `along` is unused for orientation (kept for call-site compatibility / door-side offsets).
 */
export function bladeBasis(outward: P, _along?: P): { x: THREE.Vector3; y: THREE.Vector3; z: THREE.Vector3 } {
  const x = new THREE.Vector3(outward.x, 0, outward.y);
  if (x.lengthSq() < 1e-8) x.set(1, 0, 0);
  else x.normalize();
  const y = new THREE.Vector3(0, 1, 0);
  const z = new THREE.Vector3().crossVectors(x, y).normalize();
  return { x, y, z };
}

/** Keep one door per opening cluster (twin walls / stacked doors → one blade). */
export function dedupeSignDoors(doors: SignDoor[], pad = 45): SignDoor[] {
  const out: SignDoor[] = [];
  for (const d of doors) {
    if (out.some((o) => Math.hypot(o.center.x - d.center.x, o.center.y - d.center.y) <= pad)) continue;
    out.push(d);
  }
  return out;
}

function drawIcon(g: CanvasRenderingContext2D, name: string, x: number, y: number, s: number) {
  g.fillStyle = '#ffffff';
  g.beginPath(); g.roundRect(x, y, s, s, s * 0.16); g.fill();
  g.fillStyle = '#0e5f58'; g.strokeStyle = '#0e5f58'; g.lineWidth = s * 0.09; g.lineCap = 'round';
  const cx = x + s / 2, cy = y + s / 2;
  if (/电梯/.test(name)) {
    for (const [dx, up] of [[-0.17, true], [0.17, false]] as const) {
      const ax = cx + dx * s; g.beginPath();
      if (up) { g.moveTo(ax - s * 0.13, cy); g.lineTo(ax, cy - s * 0.22); g.lineTo(ax + s * 0.13, cy); }
      else { g.moveTo(ax - s * 0.13, cy); g.lineTo(ax, cy + s * 0.22); g.lineTo(ax + s * 0.13, cy); }
      g.closePath(); g.fill();
    }
  } else if (/楼梯/.test(name)) {
    g.beginPath(); g.moveTo(x + s * 0.18, y + s * 0.8);
    for (let i = 0; i < 3; i++) { g.lineTo(x + s * (0.18 + i * 0.22), y + s * (0.58 - i * 0.2)); g.lineTo(x + s * (0.4 + i * 0.22), y + s * (0.58 - i * 0.2)); }
    g.stroke();
  } else if (toiletKind(name) && toiletKind(name) !== 'any') {
    drawToiletPictogram(g, toiletKind(name)!, cx, cy, s);
  } else if (/卫生间|洗手间|厕/.test(name)) {
    g.font = `800 ${s * 0.46}px ${NAV_FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('WC', cx, cy + s * 0.03);
  } else {
    const a = s * 0.14, b = s * 0.34;
    g.fillStyle = '#d6453d';
    g.fillRect(cx - a, cy - b, a * 2, b * 2); g.fillRect(cx - b, cy - a, b * 2, a * 2);
  }
}

/** Standard toilet pictograms so 男 / 女 / 无障碍 doors in a shared anteroom read apart at a glance. */
function drawToiletPictogram(g: CanvasRenderingContext2D, kind: 'male' | 'female' | 'accessible', cx: number, cy: number, s: number) {
  g.fillStyle = kind === 'female' ? '#c8324a' : kind === 'male' ? '#1f5fbf' : '#0e5f58';
  g.strokeStyle = g.fillStyle;
  const head = (x: number, y: number) => { g.beginPath(); g.arc(x, y, s * 0.075, 0, Math.PI * 2); g.fill(); };
  if (kind === 'male') {
    head(cx, cy - s * 0.28);
    g.fillRect(cx - s * 0.11, cy - s * 0.18, s * 0.22, s * 0.24);
    g.fillRect(cx - s * 0.11, cy + s * 0.06, s * 0.09, s * 0.3); g.fillRect(cx + s * 0.02, cy + s * 0.06, s * 0.09, s * 0.3);
  } else if (kind === 'female') {
    head(cx, cy - s * 0.28);
    g.beginPath(); g.moveTo(cx - s * 0.06, cy - s * 0.18); g.lineTo(cx + s * 0.06, cy - s * 0.18);
    g.lineTo(cx + s * 0.17, cy + s * 0.14); g.lineTo(cx - s * 0.17, cy + s * 0.14); g.closePath(); g.fill();
    g.fillRect(cx - s * 0.08, cy + s * 0.14, s * 0.06, s * 0.22); g.fillRect(cx + s * 0.02, cy + s * 0.14, s * 0.06, s * 0.22);
  } else {
    // ISO 7001 style wheelchair user
    g.lineWidth = s * 0.07; g.lineCap = 'round'; g.lineJoin = 'round';
    head(cx - s * 0.04, cy - s * 0.32);
    g.beginPath(); g.moveTo(cx - s * 0.06, cy - s * 0.2); g.lineTo(cx - s * 0.06, cy + s * 0.02); g.lineTo(cx + s * 0.16, cy + s * 0.02);
    g.lineTo(cx + s * 0.24, cy + s * 0.24); g.stroke();
    g.beginPath(); g.moveTo(cx - s * 0.06, cy - s * 0.12); g.lineTo(cx + s * 0.12, cy - s * 0.12); g.stroke();
    g.lineWidth = s * 0.055;
    g.beginPath(); g.arc(cx - s * 0.04, cy + s * 0.12, s * 0.2, Math.PI * 1.15, Math.PI * 2.85); g.stroke();
  }
}

function signTexture(name: string) {
  const c = document.createElement('canvas'); c.width = 768; c.height = 240;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0e5f58'; g.beginPath(); g.roundRect(0, 0, 768, 240, 26); g.fill();
  g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 6; g.beginPath(); g.roundRect(10, 10, 748, 220, 20); g.stroke();
  drawIcon(g, name, 36, 40, 160);
  g.fillStyle = '#ffffff'; g.textBaseline = 'middle'; g.textAlign = 'left';
  const fit = (text: string, max: number, from: number) => {
    let size = from;
    do { g.font = `800 ${size}px ${NAV_FONT}`; size -= 4; } while (g.measureText(text).width > 520 && size > max);
    return g.measureText(text).width <= 520;
  };
  // Long department names (狂犬病暴露预防处置门诊) wrap onto two lines rather than shrinking to dust.
  if (fit(name, 78, 118)) g.fillText(name, 222, 126);
  else {
    const cut = Math.ceil(name.length / 2);
    const [l1, l2] = [name.slice(0, cut), name.slice(cut)];
    fit(l1.length >= l2.length ? l1 : l2, 40, 84);
    g.fillText(l1, 222, 80); g.fillText(l2, 222, 168);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}


export type SignWall = { start: P; end: P; thickness?: number; height?: number };
const HUB_DOORS = 3;

/** A named room with no door row but a gap in its outline (no wall over ≥ 60 cm) is entered
 * through that gap: sign it like a door (open counters, waiting bays, halls). */
export function outlineOpenings(rooms: SignRoom[], doors: SignDoor[], walls: SignWall[]): SignDoor[] {
  const out: SignDoor[] = [];
  const covered = (q: P) => walls.some((w) => segDist(q, q, w.start, w.end) < (w.thickness || 15) / 2 + 2);
  for (const r of rooms) {
    const poly = r.polygon;
    if (doors.some((d) => [1, -1].some((k) => inside({ x: d.center.x + d.normal.x * k * 40, y: d.center.y + d.normal.y * k * 40 }, poly)))) continue;
    let best: { a: P; b: P; len: number } | null = null;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], L = Math.hypot(b.x - a.x, b.y - a.y);
      let s0 = -1;
      for (let t = 5; t <= L; t += 10) {
        const q = { x: a.x + (b.x - a.x) * t / L, y: a.y + (b.y - a.y) * t / L };
        const open = !covered(q) && t < L - 4;
        if (open && s0 < 0) s0 = t;
        if ((!open || t + 10 > L) && s0 >= 0) {
          const e = open ? t : t - 10, len = e - s0;
          if (len >= 60 && (!best || len > best.len)) best = { a: { x: a.x + (b.x - a.x) * s0 / L, y: a.y + (b.y - a.y) * s0 / L }, b: { x: a.x + (b.x - a.x) * e / L, y: a.y + (b.y - a.y) * e / L }, len };
          s0 = -1;
        }
      }
    }
    if (!best) continue;
    const ux = (best.b.x - best.a.x) / best.len, uy = (best.b.y - best.a.y) / best.len;
    // blade hangs from the wall end next to the gap, so the opening width is the gap (capped)
    const w = Math.min(best.len, 160);
    const c = { x: best.a.x + ux * w / 2, y: best.a.y + uy * w / 2 };
    const near = walls.reduce((m, wl) => Math.min(m, segDist(best!.a, best!.a, wl.start, wl.end) < 30 ? wl.thickness || 15 : m), 999);
    out.push({ center: c, along: { x: ux, y: uy }, normal: { x: -uy, y: ux }, width: w, wallThickness: near < 999 ? near : 15, height: 210, wallHeight: 280 });
  }
  return out;
}
/** Plan-view footprint of a sign: thin segment a→b at a height band. */
export type SignPlacement = {
  kind: 'blade' | 'hang'; name: string; key: string;
  center: P; normal: P; jamb: P; a: P; b: P; y0: number; y1: number;
  /** Uniform size factor (1 = full size); wallTop is the storey's wall top (world Y). */
  scale: number; wallTop: number; doorCenter?: P;
};

const SIGN_TOP_CLEAR = 10; // sign top stays this far under the wall top / ceiling
const ARM_TOP = 12; // arm top above blade centre (original: arm at +11, 2cm thick)

const BLADE_LEN = 64, BLADE_H = 20, HANG_LEN = 90, HANG_H = 28, SIGN_GAP = 4;

function segDist(p1: P, p2: P, q1: P, q2: P) {
  const d = (p: P, a: P, b: P) => {
    const vx = b.x - a.x, vy = b.y - a.y, L = vx * vx + vy * vy || 1e-9;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / L));
    return Math.hypot(a.x + vx * t - p.x, a.y + vy * t - p.y);
  };
  const cross = (o: P, a: P, b: P) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const hit = cross(p1, p2, q1) * cross(p1, p2, q2) < 0 && cross(q1, q2, p1) * cross(q1, q2, p2) < 0;
  return hit ? 0 : Math.min(d(p1, q1, q2), d(p2, q1, q2), d(q1, p1, p2), d(q2, p1, p2));
}

/** Sign top above its limit: blades must clear the wall top by SIGN_TOP_CLEAR; hanging boards
 * (rod included) may reach the ceiling but not pass it. */
export function signAboveWall(s: SignPlacement) {
  return s.kind === 'blade' ? s.y1 > s.wallTop - SIGN_TOP_CLEAR + 1e-6 : s.y1 > s.wallTop + 1e-6;
}

/** Sign footprint enters a wall body (thin-sign half thickness included). */
export function signHitsWall(s: SignPlacement, walls: SignWall[]) {
  return walls.some((w) => segDist(s.a, s.b, w.start, w.end) < (w.thickness || 15) / 2 + 1.5);
}

/** Two signs share space: footprints closer than the gap and height bands overlap. */
export function signsOverlap(s: SignPlacement, t: SignPlacement) {
  return s.y0 < t.y1 && t.y0 < s.y1 && segDist(s.a, s.b, t.a, t.b) < SIGN_GAP;
}

function freeRun(p: P, dir: P, walls: SignWall[], limit = 2000) {
  let best = limit;
  for (const w of walls) {
    const ex = w.end.x - w.start.x, ey = w.end.y - w.start.y;
    const den = dir.x * ey - dir.y * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((w.start.x - p.x) * ey - (w.start.y - p.y) * ex) / den;
    const u = ((w.start.x - p.x) * dir.y - (w.start.y - p.y) * dir.x) / den;
    if (t > 0 && u >= 0 && u <= 1) best = Math.min(best, t);
  }
  return best;
}

/**
 * Where every sign goes, before any mesh is built. One blade per room (its widest corridor
 * door), hung on the jamb, normal into the corridor. A blade that would cut a wall or touch an
 * already placed sign tries the other jamb, then slides along the wall; if nothing fits it is
 * dropped (the room keeps its other door's sign, or none rather than a clash). Stair/lift
 * banners are one board facing along the passage, never a crossed pair.
 */
export function planSigns(doors: SignDoor[], rooms: SignRoom[], floorY: number, links: { x: number; y: number; name: string }[] = [], walls: SignWall[] = []): SignPlacement[] {
  const placed: SignPlacement[] = [];
  const fits = (s: SignPlacement) => !signHitsWall(s, walls) && !placed.some((t) => signsOverlap(s, t));
  const byRoom = new Map<SignRoom, { d: SignDoor; outward: P; rank: number }[]>();
  const unique = dedupeSignDoors([...doors, ...outlineOpenings(rooms, doors, walls)]);
  // Doors per room: a named face with many doors is circulation (named hall / waiting area /
  // corridor). A door between it and an ordinary room signs the ordinary room, facing the hub.
  const side = (d: SignDoor, k: number) => rooms.find((r) => inside({ x: d.center.x + d.normal.x * k * 70, y: d.center.y + d.normal.y * k * 70 }, r.polygon));
  const doorCount = new Map<SignRoom, number>();
  for (const d of unique) for (const k of [1, -1]) { const r = side(d, k); if (r) doorCount.set(r, (doorCount.get(r) || 0) + 1); }
  const area = (r: SignRoom) => { let a = 0; const q = r.polygon; for (let i = 0, j = q.length - 1; i < q.length; j = i++) a += (q[j].x + q[i].x) * (q[j].y - q[i].y); return Math.abs(a / 2); };
  const hubOutward = (d: SignDoor): { room: SignRoom; outward: P; rank?: number } | null => {
    const a = side(d, 1), b = side(d, -1);
    if (!a || !b || a === b) return null;
    const ca = doorCount.get(a) || 0, cb = doorCount.get(b) || 0;
    const hubA = ca >= HUB_DOORS && (ca > cb || (ca === cb && area(a) > area(b) * 2));
    const hubB = cb >= HUB_DOORS && (cb > ca || (ca === cb && area(b) > area(a) * 2));
    if (hubA === hubB) {
      // suite door (both ordinary rooms): sign the inner one (fewer doors, then smaller)
      const innerA = ca < cb || (ca === cb && area(a) < area(b));
      return innerA ? { room: a, outward: { x: -d.normal.x, y: -d.normal.y }, rank: 2 } : { room: b, outward: { x: d.normal.x, y: d.normal.y }, rank: 2 };
    }
    return hubA ? { room: b, outward: { x: d.normal.x, y: d.normal.y } } : { room: a, outward: { x: -d.normal.x, y: -d.normal.y } };
  };
  for (const d of unique) {
    const cor = corridorOutward(d, rooms);
    const hit = cor ? { ...cor, rank: 0 } : hubOutward(d);
    if (!hit) continue;
    if (!byRoom.has(hit.room)) byRoom.set(hit.room, []);
    byRoom.get(hit.room)!.push({ d, outward: hit.outward, rank: hit.rank ?? 1 });
  }
  let roomNo = 0;
  for (const [room, list] of byRoom) {
    const label = room.displayName || room.name;
    const key = `room${roomNo++}:${label}`;
    list.sort((a, b) => a.rank - b.rank || b.d.width - a.d.width); // corridor doors first, then hub, then suite
    let done = false;
    for (const { d, outward } of list) {
      const jl = Math.hypot(d.along.x, d.along.y) || 1;
      const jamb = { x: d.along.x / jl, y: d.along.y / jl };
      // Original projecting blade (5f77cdc look): full size, centre at max(door+10, 218) above the
      // floor, hung beside the jamb, sticking out into the corridor. Only lowered if its arm would
      // come within SIGN_TOP_CLEAR of the wall top.
      const wallTop = floorY + (d.wallHeight || 280);
      const yc = Math.min(floorY + Math.max(d.height + 10, 218), wallTop - SIGN_TOP_CLEAR - ARM_TOP);
      // full size first; a 3/4 blade only where a narrow slot cannot take the full one
      for (const sc of [1, 0.75]) { if (done) break;
      for (const slide of [0, 24, 48, 72, 96, 130, 170]) {
        for (const side of [1, -1]) {
          const off = side * (d.width / 2 + 14 + slide);
          const root = { x: d.center.x + jamb.x * off + outward.x * (d.wallThickness / 2 + 6), y: d.center.y + jamb.y * off + outward.y * (d.wallThickness / 2 + 6) };
          const tip = { x: root.x + outward.x * BLADE_LEN * sc, y: root.y + outward.y * BLADE_LEN * sc };
          const s: SignPlacement = {
            kind: 'blade', name: label, key,
            center: { x: (root.x + tip.x) / 2, y: (root.y + tip.y) / 2 }, normal: outward, jamb: { x: jamb.x * side, y: jamb.y * side },
            a: root, b: tip, y0: yc - BLADE_H * sc / 2, y1: yc + ARM_TOP * sc, scale: sc, wallTop, doorCenter: d.center,
          };
          if (fits(s)) { placed.push(s); done = true; break; }
        }
        if (done) break;
      }
      }
      if (done) break;
    }
  }
  // Rooms still without a blade (no usable door in the data, e.g. a stair core or an open bay
  // whose door was not recognised): hang it on the outline edge that faces circulation.
  const signedRooms = new Set(placed.map((p) => p.key.replace(/^room\d+:/, '')));
  for (const room of rooms) {
    const label = room.displayName || room.name;
    if (signedRooms.has(label)) continue;
    const poly = room.polygon;
    const cands: { d: SignDoor; outward: P; len: number }[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], L = Math.hypot(b.x - a.x, b.y - a.y);
      if (L < 80) continue;
      const u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L }, n = { x: -u.y, y: u.x };
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      for (const k of [1, -1]) {
        const out = { x: m.x + n.x * k * 70, y: m.y + n.y * k * 70 }, inn = { x: m.x - n.x * k * 40, y: m.y - n.y * k * 40 };
        if (!inside(inn, poly) || rooms.some((r) => inside(out, r.polygon))) continue;
        if (freeRun(out, { x: n.x * k, y: n.y * k }, walls) >= 2000) continue; // exterior
        const wl = walls.find((w) => segDist(m, m, w.start, w.end) < 30);
        cands.push({ d: { center: m, along: u, normal: n, width: Math.min(L - 40, 90), wallThickness: wl?.thickness || 15, height: 210, wallHeight: wl?.height || 280 }, outward: { x: n.x * k, y: n.y * k }, len: L });
      }
    }
    cands.sort((x, y) => y.len - x.len);
    const key = `room${roomNo++}:${label}`;
    outer: for (const { d, outward } of cands) {
      const wallTop = floorY + (d.wallHeight || 280);
      const yc = Math.min(floorY + Math.max(d.height + 10, 218), wallTop - SIGN_TOP_CLEAR - ARM_TOP);
      for (const slide of [0, 24, 48, 72, 96, 130, 170]) for (const side of [1, -1]) {
        const off = side * (d.width / 2 + 14 + slide);
        const root = { x: d.center.x + d.along.x * off + outward.x * (d.wallThickness / 2 + 6), y: d.center.y + d.along.y * off + outward.y * (d.wallThickness / 2 + 6) };
        const tip = { x: root.x + outward.x * BLADE_LEN, y: root.y + outward.y * BLADE_LEN };
        const s: SignPlacement = { kind: 'blade', name: label, key, center: { x: (root.x + tip.x) / 2, y: (root.y + tip.y) / 2 }, normal: outward, jamb: { x: d.along.x * side, y: d.along.y * side }, a: root, b: tip, y0: yc - BLADE_H / 2, y1: yc + ARM_TOP, scale: 1, wallTop, doorCenter: d.center };
        if (fits(s)) { placed.push(s); signedRooms.add(label); break outer; }
      }
    }
  }
  const heights = walls.map((w) => w.height || 280).sort((a, b) => a - b);
  const storeyTop = floorY + (heights.length ? heights[heights.length >> 1] : 280);
  for (const l of links) {
    // Board hangs under the ceiling on a rod that ends at the ceiling, never above it.
    const hsc = Math.min(1, Math.max(0.8, (storeyTop - SIGN_TOP_CLEAR - (floorY + 212)) / HANG_H));
    const boardTop = Math.min(floorY + 232 + HANG_H / 2, storeyTop - SIGN_TOP_CLEAR);
    // Board spans across the passage (the shorter free axis) so both faces read along it.
    const across = [{ x: 1, y: 0 }, { x: 0, y: 1 }]
      .map((dir) => ({ dir, w: freeRun(l, dir, walls) + freeRun(l, { x: -dir.x, y: -dir.y }, walls) }))
      .sort((a, b) => a.w - b.w);
    for (const { dir } of across) {
      const s: SignPlacement = {
        kind: 'hang', name: l.name, key: `link:${l.name}`,
        center: { x: l.x, y: l.y }, normal: { x: -dir.y, y: dir.x }, jamb: dir,
        a: { x: l.x - dir.x * HANG_LEN * hsc / 2, y: l.y - dir.y * HANG_LEN * hsc / 2 }, b: { x: l.x + dir.x * HANG_LEN * hsc / 2, y: l.y + dir.y * HANG_LEN * hsc / 2 },
        y0: boardTop - HANG_H * hsc, y1: storeyTop, scale: hsc, wallTop: storeyTop,
      };
      if (fits(s)) { placed.push(s); break; }
    }
  }
  return placed;
}

export class NavSigns {
  readonly group = new THREE.Group();
  placements: SignPlacement[] = [];
  private disposables: { dispose(): void }[] = [];

  constructor(doors: SignDoor[], rooms: SignRoom[], floorY: number, links: { x: number; y: number; name: string }[] = [], walls: SignWall[] = []) {
    this.group.userData.navDressing = true;
    const edge = new THREE.MeshStandardMaterial({ color: '#cfd4d2', metalness: 0.6, roughness: 0.35 });
    const bracketMat = new THREE.MeshStandardMaterial({ color: '#9aa2a0', metalness: 0.7, roughness: 0.3 });
    this.disposables.push(edge, bracketMat);
    const textures = new Map<string, THREE.Material[]>();
    const faceMats = (name: string) => {
      if (!textures.has(name)) {
        const make = () => {
          const map = signTexture(name);
          const m = new THREE.MeshStandardMaterial({ map, emissiveMap: map, emissive: new THREE.Color(0.5, 0.5, 0.5), roughness: 0.5 });
          this.disposables.push(map, m);
          return m;
        };
        // BoxGeometry maps both ±z faces readable from outside; no mirroring needed.
        textures.set(name, [make(), make()]);
      }
      const [front, back] = textures.get(name)!;
      return [edge, edge, edge, edge, front, back];
    };
    this.placements = planSigns(doors, rooms, floorY, links, walls);
    for (const p of this.placements) {
      const up = new THREE.Vector3(0, 1, 0);
      if (p.kind === 'blade') {
        const { x: n, y: yb, z: faceDir } = bladeBasis(p.normal);
        const blade = new THREE.Mesh(this.box(BLADE_LEN, BLADE_H, 2.5), faceMats(p.name));
        blade.scale.set(p.scale, p.scale, 1);
        blade.position.set(p.center.x, p.y0 + BLADE_H * p.scale / 2, p.center.y);
        blade.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(n, yb, faceDir));
        blade.userData.navSign = { kind: 'blade', name: p.name };
        const arm = new THREE.Mesh(this.box(42 * p.scale, 2, 2), bracketMat);
        arm.position.set(p.a.x + p.normal.x * 14 * p.scale, blade.position.y + 11 * p.scale, p.a.y + p.normal.y * 14 * p.scale);
        arm.quaternion.copy(blade.quaternion);
        for (const m of [blade, arm]) { m.userData.navDressing = true; this.group.add(m); }
      } else {
        const along = new THREE.Vector3(p.jamb.x, 0, p.jamb.y), face = new THREE.Vector3(p.normal.x, 0, p.normal.y);
        const sign = new THREE.Mesh(this.box(HANG_LEN, HANG_H, 3), faceMats(p.name));
        sign.scale.setScalar(p.scale);
        sign.position.set(p.center.x, p.y0 + HANG_H * p.scale / 2, p.center.y);
        sign.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(along, up, face));
        sign.userData.navSign = { kind: 'hang', name: p.name };
        const boardTop = p.y0 + HANG_H * p.scale, rodLen = Math.max(1, p.wallTop - boardTop);
        const rod = new THREE.Mesh(this.box(1.5, rodLen, 1.5), bracketMat);
        rod.position.set(p.center.x, boardTop + rodLen / 2, p.center.y);
        for (const m of [sign, rod]) { m.userData.navDressing = true; this.group.add(m); }
      }
    }
  }

  private box(w: number, h: number, d: number) {
    const g = new THREE.BoxGeometry(w, h, d);
    this.disposables.push(g);
    return g;
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.group.removeFromParent();
  }
}

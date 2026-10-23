/**
 * One hole, every wall: a door hole is an oriented box (along the host wall, wall-deep, door-high).
 * Every wall body that passes through that box gets the same hole — not just the host wall — so
 * a collinear duplicate wall, or a wall end poking into the doorway, can no longer re-fill the hole
 * (its faces were coplanar with the host's frame / reveal → z-fight). Collinear duplicate wall
 * bodies are also removed where they overlap (coplanar faces, double skirting).
 */
import * as THREE from 'three';
import { getWallStartHeight, getWallEndHeight, type Floor } from '$lib/models/types';
import { wallThicknessCm } from '$lib/utils/doorWallFit';
import { pathOpening, wallPathProfile } from '$lib/utils/wallProfiles';

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

export function normalizeOpeningFloor(floor: Floor): { floor: Floor; wallIds: Map<string, string> } {
  const groups = floor.walls.map(w => ({ wall: { ...w, start: { ...w.start }, end: { ...w.end }, thickness: wallThicknessCm(w) }, ids: [w.id] }));
  for (let i = 0; i < groups.length; i++) {
    const a = groups[i];
    if (a.wall.curvePoint) continue;
    for (let j = i + 1; j < groups.length; j++) {
      const b = groups[j];
      if (b.wall.curvePoint) continue;
      const { L, u, n } = frame(a.wall), bf = frame(b.wall);
      if (L < 1 || bf.L < 1 || Math.abs(u.x * bf.u.y - u.y * bf.u.x) > 1e-6) continue;
      const project = (p: P) => (p.x - a.wall.start.x) * u.x + (p.y - a.wall.start.y) * u.y;
      const offset = (p: P) => (p.x - a.wall.start.x) * n.x + (p.y - a.wall.start.y) * n.y;
      if (Math.max(Math.abs(offset(b.wall.start)), Math.abs(offset(b.wall.end))) > 0.05) continue;
      const s0 = project(b.wall.start), s1 = project(b.wall.end);
      if (Math.min(L, Math.max(s0, s1)) - Math.max(0, Math.min(s0, s1)) <= 0.05) continue;
      const h0 = getWallStartHeight(a.wall), slope = (getWallEndHeight(a.wall) - h0) / L;
      if (Math.abs(h0 + slope * s0 - getWallStartHeight(b.wall)) > 0.05 || Math.abs(h0 + slope * s1 - getWallEndHeight(b.wall)) > 0.05) continue;
      const lo = Math.min(0, s0, s1), hi = Math.max(L, s0, s1), origin = a.wall.start;
      a.wall = { ...a.wall, start: { x: origin.x + u.x * lo, y: origin.y + u.y * lo }, end: { x: origin.x + u.x * hi, y: origin.y + u.y * hi }, thickness: Math.max(a.wall.thickness, b.wall.thickness), startHeight: h0 + slope * lo, endHeight: h0 + slope * hi };
      a.ids.push(...b.ids);
      groups.splice(j, 1);
      j = i; // An extended union can reach an earlier disjoint interval.
    }
  }
  const wallIds = new Map(groups.flatMap(g => g.ids.map(id => [id, g.wall.id] as const)));
  const originals = new Map(floor.walls.map(w => [w.id, w]));
  const walls = groups.map(g => g.wall), targets = new Map(walls.map(w => [w.id, w]));
  const reproject = <T extends { wallId: string; position: number; width: number }>(opening: T): T => {
    const old = originals.get(opening.wallId), wall = targets.get(wallIds.get(opening.wallId)!);
    if (!old || !wall || old.curvePoint) return opening;
    const path = wallPathProfile(old), cut = pathOpening(path, path.distanceAt(opening.position), opening.width, 0, Math.max(getWallStartHeight(old), getWallEndHeight(old)));
    if (!cut) return opening;
    const { L, u } = frame(wall), c = path.sample((cut.left + cut.right) / 2).point;
    const position = ((c.x - wall.start.x) * u.x + (c.y - wall.start.y) * u.y) / L;
    return { ...opening, wallId: wall.id, position, width: cut.right - cut.left };
  };
  const doors = floor.doors.map(d => {
    const out = reproject(d), old = originals.get(d.wallId), wall = targets.get(out.wallId);
    if (old && wall && (old.end.x - old.start.x) * (wall.end.x - wall.start.x) + (old.end.y - old.start.y) * (wall.end.y - wall.start.y) < 0) {
      return { ...out, swingDirection: d.swingDirection === 'left' ? 'right' as const : 'left' as const, flipSide: !d.flipSide };
    }
    return out;
  });
  const rooms = floor.rooms.map(r => ({ ...r, walls: [...new Set(r.walls.map(id => wallIds.get(id) ?? id))] }));
  return { floor: { ...floor, walls, doors, windows: floor.windows.map(reproject), rooms }, wallIds };
}

export function unionWallSurfaces(root: THREE.Group): void {
  const tolerance = 0.05;
  root.updateWorldMatrix(true, true);
  const bodies = root.children.filter((o): o is THREE.Mesh => !!(o as THREE.Mesh).isMesh && !!(o.userData.wallId || o.userData.wallJoint || o.userData.navPart === 'baseboard' || o.userData.navPart === 'frame')).map(mesh => {
    const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
    const pos = geometry.getAttribute('position');
    const planes: THREE.Plane[] = [];
    for (let i = 0; i < pos.count; i += 3) {
      const points = [0, 1, 2].map(j => new THREE.Vector3().fromBufferAttribute(pos, i + j).applyMatrix4(mesh.matrixWorld));
      const plane = new THREE.Plane().setFromCoplanarPoints(...points as [THREE.Vector3, THREE.Vector3, THREE.Vector3]);
      if (plane.normal.lengthSq() > 0 && !planes.some(p => p.normal.dot(plane.normal) > 1 - 1e-6 && Math.abs(p.constant - plane.constant) < tolerance)) planes.push(plane);
    }
    geometry.computeBoundingBox();
    return { mesh, geometry, planes, bounds: geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld).expandByScalar(tolerance) };
  });
  type Vertex = { point: THREE.Vector3; attrs: number[][] };
  const clip = (poly: Vertex[], plane: THREE.Plane, inside: boolean): Vertex[] => {
    const out: Vertex[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const da = plane.distanceToPoint(a.point), db = plane.distanceToPoint(b.point);
      const ai = inside ? da <= tolerance : da > tolerance, bi = inside ? db <= tolerance : db > tolerance;
      if (ai) out.push(a);
      if (ai !== bi) {
        const t = da / (da - db);
        out.push({ point: a.point.clone().lerp(b.point, t), attrs: a.attrs.map((v, k) => v.map((x, j) => x + (b.attrs[k][j] - x) * t)) });
      }
    }
    return out;
  };
  bodies.forEach(({ mesh, geometry, bounds }, index) => {
    const cutters = bodies.filter((b, j) => j !== index && bounds.intersectsBox(b.bounds));
    const names = Object.keys(geometry.attributes), attrs = names.map(n => geometry.getAttribute(n));
    const values: number[][] = names.map(() => []), out = new THREE.BufferGeometry();
    const pos = geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i += 3) {
      const triangle = [0, 1, 2].map(j => ({ point: new THREE.Vector3().fromBufferAttribute(pos, i + j).applyMatrix4(mesh.matrixWorld), attrs: attrs.map(a => Array.from({ length: a.itemSize }, (_, k) => a.array[(i + j) * a.itemSize + k])) }));
      const normal = triangle[1].point.clone().sub(triangle[0].point).cross(triangle[2].point.clone().sub(triangle[0].point)).normalize();
      let polygons = [triangle];
      for (const cutter of cutters) {
        if (bodies.indexOf(cutter) > index && cutter.planes.some(p => p.normal.dot(normal) > 1 - 1e-6 && triangle.every(v => Math.abs(p.distanceToPoint(v.point)) < tolerance))) continue;
        polygons = polygons.flatMap(poly => {
          const outside: Vertex[][] = [];
          for (const plane of cutter.planes) {
            const piece = clip(poly, plane, false);
            if (piece.length >= 3) outside.push(piece);
            poly = clip(poly, plane, true);
            if (poly.length < 3) break;
          }
          return outside;
        });
      }
      const start = values[0].length / attrs[0].itemSize;
      for (const poly of polygons) for (let j = 1; j + 1 < poly.length; j++) {
        const tri = [poly[0], poly[j], poly[j + 1]];
        if (tri[1].point.clone().sub(tri[0].point).cross(tri[2].point.clone().sub(tri[0].point)).lengthSq() < 1e-8) continue;
        tri.forEach(v => v.attrs.forEach((a, k) => values[k].push(...a)));
      }
      const count = values[0].length / attrs[0].itemSize - start;
      const material = geometry.groups.find(g => i >= g.start && i < g.start + g.count)?.materialIndex ?? 0;
      const last = out.groups[out.groups.length - 1];
      if (count && last?.materialIndex === material) last.count += count;
      else if (count) out.addGroup(start, count, material);
    }
    names.forEach((n, k) => out.setAttribute(n, new THREE.Float32BufferAttribute(values[k], attrs[k].itemSize)));
    mesh.geometry.dispose(); mesh.geometry = out;
    if (!values[0].length) root.remove(mesh);
  });
  bodies.forEach(b => b.geometry.dispose());
}

/** Interval [a,b] (cm along the wall) where the wall's body intersects the hole box. */
export function holeOnWall(w: WallLike, h: Hole, thickness: number, grow = 0): [number, number] | null {
  const { L, u } = frame(w);
  const hn = { x: -h.u.y, y: h.u.x };
  const project = (p: P, axis: P) => (p.x - h.c.x) * axis.x + (p.y - h.c.y) * axis.y;
  const normal = { x: -u.y, y: u.x };
  let poly: P[] = [[0, -1], [L, -1], [L, 1], [0, 1]].map(([s, side]) => ({ x: w.start.x + u.x * s + normal.x * thickness / 2 * side, y: w.start.y + u.y * s + normal.y * thickness / 2 * side }));
  for (const [axis, half] of [[h.u, h.half + grow], [hn, h.depth / 2]] as [P, number][]) for (const side of [-1, 1]) {
    const input = poly; poly = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[i], b = input[(i + 1) % input.length];
      const da = project(a, axis) * side - half, db = project(b, axis) * side - half;
      if (da <= 0) poly.push(a);
      if ((da <= 0) !== (db <= 0)) { const t = da / (da - db); poly.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }); }
    }
  }
  if (!poly.length) return null;
  let area = 0;
  for (let i = 1; i + 1 < poly.length; i++) area += Math.abs((poly[i].x - poly[0].x) * (poly[i + 1].y - poly[0].y) - (poly[i].y - poly[0].y) * (poly[i + 1].x - poly[0].x));
  if (area < 1e-6) return null;
  const distances = poly.map(p => (p.x - w.start.x) * u.x + (p.y - w.start.y) * u.y);
  const lo = Math.max(0, Math.min(...distances)), hi = Math.min(L, Math.max(...distances));
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

/** Only coincident openings are duplicate records; overlapping passages retain their frames. */
export function holeKeeper(holes: Hole[], i: number): number {
  const h = holes[i];
  for (let j = 0; j < i; j++) {
    const k = holes[j];
    if (Math.abs(h.u.x * k.u.y - h.u.y * k.u.x) > 0.02) continue;
    const dx = h.c.x - k.c.x, dy = h.c.y - k.c.y;
    const across = Math.abs(dx * -k.u.y + dy * k.u.x), along = Math.abs(dx * k.u.x + dy * k.u.y);
    if (across < 0.05 && along < 0.05 && Math.abs(h.half - k.half) < 0.05 && Math.abs(h.top - k.top) < 0.05) return j;
  }
  return i;
}

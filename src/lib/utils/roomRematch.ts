import type { Floor, Point, Room } from '$lib/models/types';
import { roomFaces } from './roomDetection';

/** A saved room record together with the polygon it covered before an edit. */
export type RoomSnapshot = { record: Room; polygon: Point[] };

type FloorRooms = Pick<Floor, 'walls' | 'rooms'>;

function polygonArea(poly: Point[]): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    sum += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
  }
  return Math.abs(sum) / 2;
}

function contains(poly: Point[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function bounds(poly: Point[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  return { minX, minY, maxX, maxY };
}

/** Approximate intersection area of two simple polygons by sampling their common bounding box. */
export function overlapArea(a: Point[], b: Point[], samples = 48): number {
  const ba = bounds(a), bb = bounds(b);
  const minX = Math.max(ba.minX, bb.minX), maxX = Math.min(ba.maxX, bb.maxX);
  const minY = Math.max(ba.minY, bb.minY), maxY = Math.min(ba.maxY, bb.maxY);
  if (!(maxX > minX && maxY > minY)) return 0;
  const dx = (maxX - minX) / samples, dy = (maxY - minY) / samples;
  let hits = 0;
  for (let i = 0; i < samples; i++) {
    const x = minX + (i + 0.5) * dx;
    for (let j = 0; j < samples; j++) {
      const y = minY + (j + 0.5) * dy;
      if (contains(a, x, y) && contains(b, x, y)) hits++;
    }
  }
  return hits * dx * dy;
}

/** Saved room records and the faces they resolve to on this floor (before an edit). */
export function snapshotRoomRecords(floor: FloorRooms, lastKnown?: Map<string, Point[]>): RoomSnapshot[] {
  const records = new Map((floor.rooms ?? []).map(room => [room.id, room]));
  const live = roomFaces(floor)
    .filter(item => records.has(item.room.id) && item.polygon.length >= 3)
    .map(item => ({ record: records.get(item.room.id)!, polygon: item.polygon }));
  if (!lastKnown) return live;
  // Remember where every live record sat, and fall back to that for records an earlier edit
  // already orphaned, so a multi-step edit (delete a wall, then close the gap) keeps names.
  for (const snap of live) lastKnown.set(snap.record.id, snap.polygon);
  const liveIds = new Set(live.map(snap => snap.record.id));
  const stale = [...records.values()]
    .filter(room => !liveIds.has(room.id) && (lastKnown.get(room.id)?.length ?? 0) >= 3)
    .map(room => ({ record: room, polygon: lastKnown.get(room.id)! }));
  return [...live, ...stale];
}

export type RoomRematch = { id: string; name: string; walls: string[]; area: number; overlap: number };

/**
 * After a wall edit, saved records whose wall set no longer resolves to a face are matched to
 * the new faces by geometric overlap instead of exact wall-set identity. Each record goes to at
 * most one face and each face takes at most one record (largest overlap first), and a match
 * needs the shared area to cover at least `minRatio` of the smaller of the two polygons and at
 * least `swallowRatio` of the new face. Split
 * rooms keep their record on the larger part; the other part stays unnamed.
 */
export function rematchRoomRecords(before: RoomSnapshot[], after: FloorRooms, minRatio = 0.5, swallowRatio = 0.25): RoomRematch[] {
  const savedIds = new Set((after.rooms ?? []).map(room => room.id));
  const faces = roomFaces(after);
  const matchedRecords = new Set(faces.filter(item => savedIds.has(item.room.id)).map(item => item.room.id));
  const freeFaces = faces.filter(item => !savedIds.has(item.room.id) && item.polygon.length >= 3);
  const orphans = before.filter(snap => savedIds.has(snap.record.id) && !matchedRecords.has(snap.record.id));
  const pairs: { overlap: number; snap: RoomSnapshot; face: (typeof freeFaces)[number] }[] = [];
  for (const snap of orphans) {
    const oldArea = polygonArea(snap.polygon);
    for (const face of freeFaces) {
      const overlap = overlapArea(snap.polygon, face.polygon);
      if (overlap <= 0) continue;
      // The shared area must cover most of the old room, and the new face must not be mostly
      // something else: a small room swallowed by a corridor does not hand its name to the corridor.
      const newArea = polygonArea(face.polygon);
      if (overlap >= minRatio * Math.min(oldArea, newArea) && overlap >= swallowRatio * newArea) pairs.push({ overlap, snap, face });
    }
  }
  pairs.sort((a, b) => b.overlap - a.overlap);
  const usedRecords = new Set<string>(), usedFaces = new Set<string>();
  const result: RoomRematch[] = [];
  for (const { overlap, snap, face } of pairs) {
    if (usedRecords.has(snap.record.id) || usedFaces.has(face.room.id)) continue;
    usedRecords.add(snap.record.id); usedFaces.add(face.room.id);
    result.push({ id: snap.record.id, name: snap.record.name, walls: [...face.room.walls], area: face.room.area, overlap: Math.round(overlap / 100) / 100 });
  }
  return result;
}

/** Saved records that no longer resolve to any face (and are not explicit polygon floors). */
export function orphanRoomRecords(floor: FloorRooms): Room[] {
  const live = new Set(roomFaces(floor).map(item => item.room.id));
  return (floor.rooms ?? []).filter(room => !live.has(room.id) && !(room.floorPolygon && room.floorPolygon.length >= 3));
}

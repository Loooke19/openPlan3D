import { describe, expect, it } from 'vitest';
import type { Wall, Room } from '../src/lib/models/types';
import { orphanRoomRecords, rematchRoomRecords, snapshotRoomRecords } from '../src/lib/utils/roomRematch';
import { roomFaces } from '../src/lib/utils/roomDetection';

const w = (id: string, x1: number, y1: number, x2: number, y2: number): Wall =>
  ({ id, start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 10, height: 280, color: '#444444' } as Wall);

const box = [w('n', 0, 0, 600, 0), w('e', 600, 0, 600, 400), w('s', 600, 400, 0, 400), w('wv', 0, 400, 0, 0)];

function floorWithNamed() {
  const floor = { walls: [...box], rooms: [] as Room[] };
  const face = roomFaces(floor)[0];
  floor.rooms = [{ id: 'r-big', name: '抢救室', walls: face.room.walls, floorTexture: 'none', area: face.room.area, roomType: 'indoor' } as Room];
  return floor;
}

describe('room record rematch after wall edits', () => {
  it('keeps the name on the larger part when a wall splits a room', () => {
    const floor = floorWithNamed();
    const before = snapshotRoomRecords(floor);
    const after = { ...floor, walls: [...floor.walls, w('split', 450, 0, 450, 400)] };
    expect(roomFaces(after).some(f => f.room.id === 'r-big')).toBe(false);
    const matches = rematchRoomRecords(before, after);
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe('r-big');
    expect(matches[0].walls).toContain('split');
    expect(matches[0].area).toBeCloseTo(18, 0);
  });

  it('carries the name when an interior partition is removed (merge)', () => {
    const floor = { walls: [...box, w('split', 300, 0, 300, 400)], rooms: [] as Room[] };
    const faces = roomFaces(floor);
    floor.rooms = faces.map((f, i) => ({ id: `r${i}`, name: '卫生间', walls: f.room.walls, floorTexture: 'none', area: f.room.area } as Room));
    const before = snapshotRoomRecords(floor);
    const after = { ...floor, walls: box };
    const matches = rematchRoomRecords(before, after);
    expect(matches).toHaveLength(1);
    expect(matches[0].name).toBe('卫生间');
    expect(matches[0].area).toBeCloseTo(24, 0);
  });

  it('does not rename unrelated faces and reports orphans', () => {
    const floor = floorWithNamed();
    const before = snapshotRoomRecords(floor);
    const far = [w('a', 2000, 0, 2300, 0), w('b', 2300, 0, 2300, 300), w('c', 2300, 300, 2000, 300), w('d', 2000, 300, 2000, 0)];
    const after = { rooms: floor.rooms, walls: [...far] };
    expect(rematchRoomRecords(before, after)).toHaveLength(0);
    expect(orphanRoomRecords(after).map(r => r.id)).toEqual(['r-big']);
  });

  it('keeps names across a two-step edit (open a gap, then close it)', () => {
    const floor = floorWithNamed();
    const known = new Map();
    snapshotRoomRecords(floor, known);
    // step 1: drop the south wall, the room opens and its record is orphaned
    const open = { rooms: floor.rooms, walls: box.filter(x => x.id !== 's') };
    const step1 = snapshotRoomRecords(open, known);
    expect(rematchRoomRecords(step1, open)).toHaveLength(0);
    // step 2: close it again a bit further north; the remembered polygon still matches
    const closed = { rooms: floor.rooms, walls: [w('n', 0, 0, 600, 0), w('e', 600, 0, 600, 300), w('s2', 600, 300, 0, 300), w('wv', 0, 300, 0, 0)] };
    const step2 = snapshotRoomRecords(open, known);
    const matches = rematchRoomRecords(step2, closed);
    expect(matches.map(m => m.id)).toEqual(['r-big']);
    expect(matches[0].walls).toContain('s2');
  });

  it('does not give a small room name to a corridor that swallowed it', () => {
    const corridor = [w('n', 0, 0, 2000, 0), w('e', 2000, 0, 2000, 600), w('s', 2000, 600, 0, 600), w('wv', 0, 600, 0, 0)];
    const closet = [w('c1', 100, 0, 100, 150), w('c2', 100, 150, 0, 150)];
    const floor = { walls: [...corridor, ...closet], rooms: [] as Room[] };
    const small = roomFaces(floor).find(f => f.room.area < 3)!;
    floor.rooms = [{ id: 'r-wc', name: '卫', walls: small.room.walls, floorTexture: 'none', area: small.room.area } as Room];
    const before = snapshotRoomRecords(floor);
    const after = { rooms: floor.rooms, walls: corridor };
    expect(rematchRoomRecords(before, after)).toHaveLength(0);
  });
});

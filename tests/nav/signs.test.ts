import { describe, expect, it } from 'vitest';
import { bladeBasis, corridorOutward, dedupeSignDoors, type SignDoor, type SignRoom } from '$lib/components/viewer3d/nav/signs';

function handed(x: { x: number; y: number; z: number }, y: { x: number; y: number; z: number }, z: { x: number; y: number; z: number }) {
  const cx = x.y * y.z - x.z * y.y;
  const cy = x.z * y.x - x.x * y.z;
  const cz = x.x * y.y - x.y * y.x;
  return cx * z.x + cy * z.y + cz * z.z;
}

describe('bladeBasis', () => {
  it('keeps right-handed basis when along already matches n�up', () => {
    const { x, y, z } = bladeBasis({ x: 1, y: 0 }, { x: 0, y: 1 });
    expect(x.x).toBeCloseTo(1);
    expect(z.z).toBeCloseTo(1);
    expect(handed(x, y, z)).toBeGreaterThan(0.9);
  });

  it('derives Z from X�Y so wall winding cannot flatten the blade', () => {
    const { x, y, z } = bladeBasis({ x: -1, y: 0 }, { x: 0, y: 1 });
    expect(x.x).toBeCloseTo(-1);
    expect(z.z).toBeCloseTo(-1);
    expect(handed(x, y, z)).toBeGreaterThan(0.9);
    // Even if caller passes an antiparallel along, orientation stays right-handed.
    const again = bladeBasis({ x: -1, y: 0 }, { x: 0, y: -1 });
    expect(handed(again.x, again.y, again.z)).toBeGreaterThan(0.9);
    expect(again.z.z).toBeCloseTo(-1);
  });
});

describe('corridorOutward', () => {
  const room: SignRoom = {
    name: '??CT',
    polygon: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ],
  };
  const door: SignDoor = {
    center: { x: 50, y: 0 },
    along: { x: 1, y: 0 },
    normal: { x: 0, y: 1 },
    width: 90,
    wallThickness: 15,
    height: 210,
  };

  it('points outward into the corridor (opposite the named room)', () => {
    const hit = corridorOutward(door, [room]);
    expect(hit?.room.name).toBe('??CT');
    expect(hit?.outward.y).toBeLessThan(0);
  });
});

describe('dedupeSignDoors', () => {
  it('keeps one door per nearby cluster', () => {
    const a: SignDoor = {
      center: { x: 0, y: 0 },
      along: { x: 1, y: 0 },
      normal: { x: 0, y: 1 },
      width: 90,
      wallThickness: 12,
      height: 210,
    };
    const b = { ...a, center: { x: 10, y: 5 } };
    const c = { ...a, center: { x: 200, y: 0 } };
    expect(dedupeSignDoors([a, b, c])).toHaveLength(2);
  });
});

describe('isCirculationRoom', async () => {
  const { isCirculationRoom, corridorOutward } = await import('$lib/components/viewer3d/nav/signs');
  it('treats corridors/lobbies as circulation, rooms as destinations', () => {
    for (const n of ['走廊', '公共过道', '门厅·公共过道·休息等候区', '候诊区', '门厅']) expect(isCirculationRoom(n)).toBe(true);
    for (const n of ['诊室（一）', '输液室大厅/夜间输液室', '放射科', '楼梯 A', '卫生间']) expect(isCirculationRoom(n)).toBe(false);
    expect(isCirculationRoom('X', 'corridor')).toBe(true);
  });
  it('a door between a named corridor and a room gets a sign once the corridor is filtered out', () => {
    const sq = (x0: number) => [{ x: x0, y: 0 }, { x: x0 + 300, y: 0 }, { x: x0 + 300, y: 300 }, { x: x0, y: 300 }];
    const rooms = [{ name: '走廊', polygon: sq(-300) }, { name: '放射科', polygon: sq(0) }];
    const door = { center: { x: 0, y: 150 }, along: { x: 0, y: 1 }, normal: { x: 1, y: 0 }, width: 90, wallThickness: 15, height: 210 };
    expect(corridorOutward(door, rooms)).toBeNull();
    const hit = corridorOutward(door, rooms.filter(r => !isCirculationRoom(r.name)));
    expect(hit?.room.name).toBe('放射科');
    expect(hit?.outward.x).toBe(-1);
  });
});

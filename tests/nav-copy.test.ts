import { beforeEach, describe, expect, it } from 'vitest';
import { disambiguate, floorOption, floorSpoken, pinText, setNavNorth, sideOf, transferText } from '../src/lib/utils/navCopy';
beforeEach(() => setNavNorth(0));

const box = { minX: 0, minY: 0, maxX: 3000, maxY: 1000 };

describe('nav copy', () => {
  it('speaks floors as 「N楼」 and keeps 1F only in the compact selector', () => {
    expect(floorSpoken('1F')).toBe('1楼');
    expect(floorSpoken('2f')).toBe('2楼');
    expect(floorSpoken('B1')).toBe('地下1楼');
    expect(floorSpoken('门诊楼')).toBe('门诊楼');
    expect(floorOption('1F')).toBe('1F（1楼）');
    expect(floorOption('门诊楼')).toBe('门诊楼');
  });

  it('derives sides from the floor bounds', () => {
    expect(sideOf({ x: 2800, y: 500 }, box)).toBe('东');
    expect(sideOf({ x: 100, y: 500 }, box)).toBe('西');
    expect(sideOf({ x: 1500, y: 950 }, box)).toBe('南');
    expect(sideOf({ x: 1500, y: 30 }, box)).toBe('北');
    expect(sideOf({ x: 1500, y: 500 }, box)).toBe('中');
  });

  it('rewrites transfer steps in plain words', () => {
    expect(transferText({ kind: 'stairs', direction: 'up', from: { x: 2800, y: 500 }, toFloorName: '2F' }, box)).toBe('走楼梯（东）上到 2楼');
    expect(transferText({ kind: 'elevator', direction: 'down', from: { x: 100, y: 500 }, toFloorName: '1F' }, box)).toBe('乘电梯（西）下到 1楼');
    expect(transferText({ kind: 'elevator', direction: 'up', toFloorName: '3F' })).toBe('乘电梯上到 3楼');
  });

  it('disambiguates duplicate places by side, else by letter', () => {
    const names = disambiguate([
      { id: 'a', name: '卫生间', floorId: 'f1', x: 100, y: 500 },
      { id: 'b', name: '卫生间', floorId: 'f1', x: 2900, y: 500 },
      { id: 'c', name: '卫生间', floorId: 'f2', x: 100, y: 500 },
      { id: 'd', name: '药房', floorId: 'f1', x: 1500, y: 500 },
    ], { f1: box, f2: box });
    expect(names.get('a')).toBe('卫生间（西）');
    expect(names.get('b')).toBe('卫生间（东）');
    expect(names.get('c')).toBe('卫生间');
    expect(names.get('d')).toBe('药房');
    const same = disambiguate([
      { id: 'x', name: '楼梯', floorId: 'f1', x: 2700, y: 400 },
      { id: 'y', name: '楼梯', floorId: 'f1', x: 2900, y: 600 },
    ], { f1: box });
    expect([same.get('x'), same.get('y')]).toEqual(['楼梯（东A）', '楼梯（东B）']);
  });

  it('labels pins in full words', () => {
    expect(pinText.start('门诊大厅')).toBe('出发地：门诊大厅');
    expect(pinText.end('康复室')).toBe('目的地：康复室');
    expect(pinText.transfer('电梯')).toBe('在此换乘：电梯');
  });
});

import { mapLabels, nearRoute } from '../src/lib/utils/navCopy';
describe('3D map labels', () => {
  const sq = (x: number, y: number) => [{ x, y }, { x: x + 100, y }, { x: x + 100, y: y + 100 }, { x, y: y + 100 }];
  it('adds the side to duplicate names and leaves unique ones', () => {
    expect(mapLabels([{ name: '楼梯', polygon: sq(0, 450) }, { name: '楼梯', polygon: sq(1900, 450) }, { name: '药房', polygon: sq(900, 0) }]))
      .toEqual(['楼梯（西）', '楼梯（东）', '药房']);
  });
  it('letters duplicates on the same side', () => {
    expect(mapLabels([{ name: '楼梯', polygon: sq(1900, 300) }, { name: '楼梯', polygon: sq(1900, 600) }, { name: 'x', polygon: sq(0, 450) }]).slice(0, 2))
      .toEqual(['楼梯（东A）', '楼梯（东B）']);
  });
  it('nearRoute only keeps rooms along the path', () => {
    const route = [{ x: 0, y: 0 }, { x: 1000, y: 0 }];
    expect(nearRoute(sq(400, 200), route)).toBe(true);
    expect(nearRoute(sq(400, 2000), route)).toBe(false);
  });
});

describe('orientation from the north arrow', () => {
  const box = { minX: 0, maxX: 3000, minY: 0, maxY: 1000 };
  it('north pointing plan-left (P1) turns plan-top into 东', () => {
    setNavNorth(270);
    expect(sideOf({ x: 1500, y: 30 }, box)).toBe('东');
    expect(sideOf({ x: 100, y: 500 }, box)).toBe('北');
  });
  it('unknown north: no cardinal words, duplicates lettered 楼梯 A/B', () => {
    setNavNorth(null);
    expect(sideOf({ x: 2800, y: 500 }, box)).toBe('');
    const out = disambiguate([
      { id: 'a', name: '楼梯', floorId: 'f', x: 100, y: 500 },
      { id: 'b', name: '楼梯', floorId: 'f', x: 2800, y: 500 },
    ], { f: box });
    expect([out.get('a'), out.get('b')]).toEqual(['楼梯 A', '楼梯 B']);
    expect(mapLabels([{ name: '楼梯', polygon: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] }, { name: '楼梯', polygon: [{ x: 2900, y: 0 }, { x: 3000, y: 0 }, { x: 3000, y: 10 }] }])).toEqual(['楼梯 A', '楼梯 B']);
    expect(transferText({ kind: 'stairs', from: { x: 2800, y: 500 }, direction: 'up', toFloorName: '2F' }, box)).toBe('走楼梯上到 2楼');
    const one = disambiguate([{ id: 'e', name: '电梯', floorId: 'f', x: 5, y: 5 }], { f: box });
    expect(one.get('e')).toBe('电梯 A');
    expect(mapLabels([{ name: '电梯', polygon: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] }])).toEqual(['电梯 A']);
  });
});

describe('transfer landmarks and span', () => {
  it('names a nearby landmark and the floor count', () => {
    const t = transferText({ kind: 'elevator', direction: 'up', toFloorName: '3F', landmark: '护士站', floors: 2 } as never);
    expect(t).toContain('护士站旁');
    expect(t).toContain('（共 2 层）');
  });
});

import { transferText as tt } from '../src/lib/utils/navCopy';
import { it as it2, expect as ex2 } from 'vitest';
it2('lettered stair name first, only-this-stair note (P3)', () => {
  ex2(tt({ kind: 'stairs', display: '楼梯 A', direction: 'up', toFloorName: '4F', onlyTo: ['4F'] })).toBe('走楼梯 A 上到 4楼（只有这部能到 4楼）');
});

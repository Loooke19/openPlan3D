import { describe, expect, it } from 'vitest';
import { setNavNorth, sideOf, disambiguate } from '../src/lib/utils/navCopy';

// P1 门诊楼: north arrow points to drawing-left (northBearing 270.1 detected at import).
// Truth: west-top stair (图左上) = 楼梯（北）, east-bottom stair (图右下) = 楼梯（南）; entrance side is north.
describe('step directions use the drawing north bearing (P1)', () => {
  const box = { minX: -2200, maxX: 2200, minY: -1100, maxY: 1100 };
  it('plan-left is north, plan-right south, plan-up east, plan-down west', () => {
    setNavNorth(270.1);
    expect(sideOf({ x: -2000, y: 0 }, box)).toBe('北');
    expect(sideOf({ x: 2000, y: 0 }, box)).toBe('南');
    expect(sideOf({ x: 0, y: -1000 }, box)).toBe('东');
    expect(sideOf({ x: 0, y: 1000 }, box)).toBe('西');
  });
  it('the two P1 stairs are 楼梯（北）/（南）', () => {
    setNavNorth(270.1);
    const names = disambiguate([
      { id: 'a', name: '楼梯', floorId: 'f1', x: -1900, y: -900 },
      { id: 'b', name: '楼梯', floorId: 'f1', x: 1900, y: 900 },
    ], { f1: box });
    expect(names.get('a')).toBe('楼梯（北）');
    expect(names.get('b')).toBe('楼梯（南）');
  });
  it('no north arrow → never 东西南北, letters instead', () => {
    setNavNorth(null);
    const names = disambiguate([
      { id: 'a', name: '楼梯', floorId: 'f1', x: -1900, y: 0 },
      { id: 'b', name: '楼梯', floorId: 'f1', x: 1900, y: 0 },
    ], { f1: box });
    expect([...names.values()].join()).not.toMatch(/[东西南北]/);
  });
});

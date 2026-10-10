import { describe, expect, it } from 'vitest';
import { disambiguate, floorOption, floorSpoken, pinText, sideOf, transferText } from '../src/lib/utils/navCopy';

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
    expect(transferText({ kind: 'stairs', direction: 'up', from: { x: 2800, y: 500 }, toFloorName: '2F' }, box)).toBe('走东侧楼梯上到 2楼');
    expect(transferText({ kind: 'elevator', direction: 'down', from: { x: 100, y: 500 }, toFloorName: '1F' }, box)).toBe('乘西侧电梯下到 1楼');
    expect(transferText({ kind: 'elevator', direction: 'up', toFloorName: '3F' })).toBe('乘电梯上到 3楼');
  });

  it('disambiguates duplicate places by side, else by letter', () => {
    const names = disambiguate([
      { id: 'a', name: '卫生间', floorId: 'f1', x: 100, y: 500 },
      { id: 'b', name: '卫生间', floorId: 'f1', x: 2900, y: 500 },
      { id: 'c', name: '卫生间', floorId: 'f2', x: 100, y: 500 },
      { id: 'd', name: '药房', floorId: 'f1', x: 1500, y: 500 },
    ], { f1: box, f2: box });
    expect(names.get('a')).toBe('西侧卫生间');
    expect(names.get('b')).toBe('东侧卫生间');
    expect(names.get('c')).toBe('卫生间');
    expect(names.get('d')).toBe('药房');
    const same = disambiguate([
      { id: 'x', name: '楼梯', floorId: 'f1', x: 2700, y: 400 },
      { id: 'y', name: '楼梯', floorId: 'f1', x: 2900, y: 600 },
    ], { f1: box });
    expect([same.get('x'), same.get('y')]).toEqual(['楼梯 A', '楼梯 B']);
  });

  it('labels pins in full words', () => {
    expect(pinText.start('门诊大厅')).toBe('出发地：门诊大厅');
    expect(pinText.end('康复室')).toBe('目的地：康复室');
    expect(pinText.transfer('电梯')).toBe('在此换乘：电梯');
  });
});

import { describe, expect, it } from 'vitest';
import { indexPlaces, searchPlaces } from '../src/lib/utils/placeSearch';
const L = indexPlaces([
  { key: 'a', name: '狂犬病暴露预防处置门诊', floorId: 'f1', floorLabel: '1楼' },
  { key: 'b', name: '心理咨询室', originalName: '心里咨询室', floorId: 'f3', floorLabel: '3楼' },
  { key: 'c', name: '西药房', aliases: ['药房'], floorId: 'f1', floorLabel: '1楼' },
  { key: 'd', name: '门厅', floorId: 'f1', floorLabel: '1楼' },
]);
describe('place search', () => {
  it('pinyin initials and full pinyin', () => {
    expect(searchPlaces(L, 'kqb')[0].key).toBe('a');
    expect(searchPlaces(L, 'xinli')[0].key).toBe('b');
  });
  it('original printed name and aliases', () => {
    expect(searchPlaces(L, '心里').map(p => p.key)).toEqual(['b']);
    expect(searchPlaces(L, '药房')[0].key).toBe('c');
  });
  it('common places first when empty', () => { expect(['c', 'd']).toContain(searchPlaces(L, '')[0].key); });
});

import { searchExample, commonRank } from '../src/lib/utils/placeSearch';
it('normalises spaces/letters, hides unnamed rooms, building-specific hint', () => {
  const list = indexPlaces([
    { key: 'a', name: '病房 A', floorId: '3', floorLabel: '3F' },
    { key: 'u', name: '未命名房间', floorId: '3', floorLabel: '3F' },
    { key: 'e', name: '出入口', floorId: '1', floorLabel: '1F' },
  ]);
  expect(list.map(p => p.key)).toEqual(['a', 'e']);
  expect(searchPlaces(list, '病房A').map(p => p.key)).toEqual(['a']);
  expect(searchPlaces(list, 'bfa').map(p => p.key)).toEqual(['a']);
  expect(searchExample(list)).toContain('病房 A');
  expect(commonRank(list[1])).toBe(0);
});

import { nearestToilets, toiletKind, toiletLabel, floorShort } from '../src/lib/utils/placeSearch';
describe('toilets', () => {
  it('labels gender, sorts nearest (same floor first), prefers accessible when asked', () => {
    expect(toiletLabel(toiletKind('女卫')!)).toBe('卫生间（女）');
    expect(toiletLabel(toiletKind('残卫')!)).toBe('无障碍卫生间');
    expect(floorShort('1楼')).toBe('1F');
    const L = [
      { name: '男卫', floorId: 'f1', x: 3000, y: 0 },
      { name: '女卫', floorId: 'f1', x: 1000, y: 0 },
      { name: '残卫', floorId: 'f1', x: 2000, y: 0 },
      { name: '女卫', floorId: 'f2', x: 0, y: 0 },
      { name: '诊室', floorId: 'f1', x: 0, y: 0 },
    ];
    const idx = (id: string) => (id === 'f1' ? 0 : 1);
    const from = { x: 0, y: 0, floorId: 'f1' };
    expect(nearestToilets(L, from, idx).map(t => t.p.name)).toEqual(['女卫', '残卫', '男卫', '女卫']);
    expect(nearestToilets(L, from, idx, true)[0].p.name).toBe('残卫');
  });
});

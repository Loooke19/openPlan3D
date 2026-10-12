import { describe, expect, it } from 'vitest';
import type { Door, Floor, Room, Wall } from '$lib/models/types';
import {
  doorVerticalFacilityKind,
  navSuppressDoorLeaf,
  roomVerticalKind,
} from '$lib/utils/verticalFacility';

const wall = (id: string): Wall =>
  ({ id, start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, thickness: 15, height: 280 }) as Wall;

const room = (id: string, name: string, walls: string[], labelIcon?: Room['labelIcon']): Room =>
  ({ id, name, walls, labelIcon }) as Room;

const door = (id: string, wallId: string): Door =>
  ({ id, wallId, position: 0.5, width: 90, height: 210, type: 'single' }) as Door;

function floor(rooms: Room[], doors: Door[], walls: Wall[]): Floor {
  return { id: 'f', name: '1F', walls, doors, windows: [], rooms, furniture: [] } as Floor;
}

describe('roomVerticalKind', () => {
  it('matches shaft names and icons, not 靠电梯 restrooms', () => {
    expect(roomVerticalKind({ name: '电梯' })).toBe('elevator');
    expect(roomVerticalKind({ name: '楼梯（西南）' })).toBe('stairs');
    expect(roomVerticalKind({ name: '电梯 A' })).toBe('elevator');
    expect(roomVerticalKind({ name: '卫生间（靠电梯）' })).toBeNull();
    expect(roomVerticalKind({ name: '卫生间（靠楼梯B）' })).toBeNull();
    expect(roomVerticalKind({ name: '诊室', labelIcon: 'elevator' })).toBe('elevator');
  });
});

describe('doorVerticalFacilityKind / navSuppressDoorLeaf', () => {
  it('keeps shaft openings (no wood leaf) for elevator and stairs', () => {
    const w = wall('w1');
    const elev = room('r1', '电梯', ['w1']);
    const stair = room('r2', '楼梯', ['w1']);
    const rest = room('r3', '卫生间（靠电梯）', ['w1']);
    const d = door('d1', 'w1');
    expect(navSuppressDoorLeaf(doorVerticalFacilityKind(floor([elev], [d], [w]), d))).toBe('opening');
    expect(navSuppressDoorLeaf(doorVerticalFacilityKind(floor([stair], [d], [w]), d))).toBe('opening');
    expect(navSuppressDoorLeaf(doorVerticalFacilityKind(floor([rest], [d], [w]), d))).toBeNull();
  });
});

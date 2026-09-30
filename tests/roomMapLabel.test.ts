import { describe, expect, it } from 'vitest';
import {
  resolveRoomLabelStyle,
  resolveRoomLabelIcon,
  roomLabelIconColor,
  ROOM_LABEL_ICONS,
  ROOM_LABEL_STYLES,
} from '../src/lib/utils/roomMapLabel';

describe('roomMapLabel', () => {
  it('defaults unknown style to stroke', () => {
    expect(resolveRoomLabelStyle(undefined)).toBe('stroke');
    expect(resolveRoomLabelStyle('nope')).toBe('stroke');
    expect(resolveRoomLabelStyle('mapPoi')).toBe('mapPoi');
    expect(resolveRoomLabelStyle('hidden')).toBe('hidden');
  });

  it('resolves icon presets and colours', () => {
    expect(resolveRoomLabelIcon('elevator')).toBe('elevator');
    expect(resolveRoomLabelIcon('missing')).toBe('general');
    expect(roomLabelIconColor('clinic')).toBe('#F97316');
    expect(roomLabelIconColor('clinic', '#112233')).toBe('#112233');
    expect(ROOM_LABEL_ICONS.length).toBeGreaterThanOrEqual(6);
    expect(ROOM_LABEL_STYLES.map((s) => s.id)).toEqual(['stroke', 'mapPoi', 'mapPoiSoft', 'hidden']);
  });
});

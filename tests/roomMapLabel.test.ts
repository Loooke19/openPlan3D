import { describe, expect, it } from 'vitest';
import {
  resolveRoomLabelStyle,
  resolveRoomLabelIcon,
  roomLabelIconColor,
  ROOM_LABEL_ICONS,
  ROOM_LABEL_STYLES,
  worldScaleFromCanvasSize,
} from '../src/lib/utils/roomMapLabel';

describe('roomMapLabel', () => {
  it('defaults unknown style to stroke', () => {
    expect(resolveRoomLabelStyle(undefined)).toBe('stroke');
    expect(resolveRoomLabelStyle('nope')).toBe('stroke');
    expect(resolveRoomLabelStyle('mapPoi')).toBe('mapPoi');
    expect(resolveRoomLabelStyle('mapPoiSoft')).toBe('mapPoiSoft');
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

  it('keeps sprite world scale aspect equal to canvas aspect', () => {
    // Short label canvas (电梯-like) — must not force legacy 5:1 world size.
    const short = worldScaleFromCanvasSize(200, 180, 44);
    expect(short.scaleX / short.scaleY).toBeCloseTo(200 / 180, 6);
    expect(short.scaleY).toBe(44);

    // Wide label canvas
    const wide = worldScaleFromCanvasSize(800, 160, 44);
    expect(wide.scaleX / wide.scaleY).toBeCloseTo(800 / 160, 6);

    // Fixed 220×44 would stretch short canvas by ~2.25× on X — guard against regression.
    expect(short.scaleX / short.scaleY).toBeLessThan(2);
  });
});

import { lookupRoomLabelFields } from '../src/lib/utils/roomMapLabel';

describe('lookupRoomLabelFields', () => {
  it('finds saved map style by containment', () => {
    const saved = [{
      id: 'a',
      name: '电梯',
      labelStyle: 'mapPoi' as const,
      labelIcon: 'elevator' as const,
      floorPolygon: [
        { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
      ],
    }];
    const hit = lookupRoomLabelFields(saved, { id: 'other', name: 'Room' }, { x: 50, y: 50 });
    expect(hit.labelStyle).toBe('mapPoi');
    expect(hit.labelIcon).toBe('elevator');
  });
});

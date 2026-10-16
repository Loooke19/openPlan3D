import { describe, expect, it } from 'vitest';
import { shaftRects } from '$lib/components/viewer3d/nav/dressing';

describe('shaftRects (ceiling openings over stairs/lifts)', () => {
  const sq = (x: number, y: number, w: number, h: number) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  it('merges overlapping footprints so ShapeGeometry holes never overlap', () => {
    const r = shaftRects([sq(0, 0, 200, 300), sq(150, 100, 200, 100), sq(1000, 0, 100, 100)]);
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({ x0: 0, y0: 0, x1: 350, y1: 300 });
  });
  it('clips to the ceiling outline and drops slivers', () => {
    const r = shaftRects([sq(-100, -100, 200, 200), sq(500, 500, 20, 20)], sq(0, 0, 400, 400));
    expect(r).toEqual([{ x0: 2, y0: 2, x1: 100, y1: 100 }]);
  });
});

import { describe, expect, it } from 'vitest';
import { kitFloorGeometry } from '$lib/components/viewer3d/nav/kitDressing';

const footprint = [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }];

describe('kit floor exclusions', () => {
  it.each([
    ['no exclusions', [], 1_000_000],
    ['interior hole', [{ x0: 100, y0: 100, x1: 300, y1: 300 }], 960_000],
    ['multiple holes', [{ x0: 100, y0: 100, x1: 300, y1: 300 }, { x0: 500, y0: 500, x1: 700, y1: 700 }], 920_000],
    ['overlapping holes', [{ x0: 100, y0: 100, x1: 300, y1: 300 }, { x0: 200, y0: 200, x1: 400, y1: 400 }], 930_000],
    ['crosses boundary', [{ x0: 800, y0: -100, x1: 1200, y1: 300 }], 940_000],
    ['outside footprint', [{ x0: 1100, y0: 100, x1: 1200, y1: 300 }], 1_000_000],
    ['entire footprint', [{ x0: -100, y0: -100, x1: 1200, y1: 1200 }], 0],
  ] as const)('%s: triangle area equals the remaining floor', (_, boxes, expected) => {
    for (const polygon of [footprint, [...footprint].reverse()]) {
      const geometry = kitFloorGeometry(polygon, [...boxes]);
      const pos = geometry.getAttribute('position'), index = geometry.index;
      let area = 0;
      for (let i = 0; i < (index?.count ?? pos.count); i += 3) {
        const [a, b, c] = [0, 1, 2].map(j => index ? index.getX(i + j) : i + j);
        area += Math.abs((pos.getX(b) - pos.getX(a)) * (pos.getY(c) - pos.getY(a))
          - (pos.getY(b) - pos.getY(a)) * (pos.getX(c) - pos.getX(a))) / 2;
        const x = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3;
        const y = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3;
        expect(boxes.some(box => x > box.x0 && x < box.x1 && y > box.y0 && y < box.y1)).toBe(false);
      }
      expect(area).toBeCloseTo(expected, 1);
      geometry.dispose();
    }
  });
});

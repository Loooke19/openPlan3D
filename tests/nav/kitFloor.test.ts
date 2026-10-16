import { describe, expect, it } from 'vitest';
import { kitFloorGeometry, planKit } from '$lib/components/viewer3d/nav/kitDressing';

const footprint = [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }];

describe('kit floor exclusions', () => {
  it('keeps corner posts and wall trims below their host walls of different heights', () => {
    const walls = [
      { start: { x: 0, y: 0 }, end: { x: 1000, y: 0 }, height: 90 },
      { start: { x: 0, y: 0 }, end: { x: 0, y: 1000 }, height: 120 },
    ];
    const plan = planKit(walls, [], [], null);
    const trims = plan.boxes.filter(b => b.kind !== 'prop');
    expect(trims.filter(b => b.kind === 'post').length).toBeGreaterThan(0);
    for (const b of trims) expect(b.y1).toBeLessThanOrEqual(walls[b.wall!].height);
    expect(trims.find(b => b.corner)?.y1).toBe(90);
  });
  it('tiles only supplied room/corridor regions and keeps their holes', () => {
    const polygon = [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 300 }, { x: 0, y: 300 }];
    const hole = [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 200 }, { x: 100, y: 200 }];
    const geometry = kitFloorGeometry(footprint, [], [{ polygon, holes: [hole] }]);
    const pos = geometry.getAttribute('position'), idx = geometry.index!;
    let area = 0;
    for (let i = 0; i < idx.count; i += 3) {
      const [a, b, c] = [0, 1, 2].map(j => idx.getX(i + j));
      area += Math.abs((pos.getX(b) - pos.getX(a)) * (pos.getY(c) - pos.getY(a))
        - (pos.getY(b) - pos.getY(a)) * (pos.getX(c) - pos.getX(a))) / 2;
      for (const v of [a, b, c]) { expect(pos.getX(v)).toBeLessThanOrEqual(600); expect(pos.getY(v)).toBeLessThanOrEqual(300); }
    }
    expect(area).toBe(170_000);
    geometry.dispose();
  });
  it('does not tile an uncovered footprint when there are no regions', () => {
    const geometry = kitFloorGeometry(footprint, [], []);
    expect(geometry.getAttribute('position').count).toBe(0);
    geometry.dispose();
  });
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

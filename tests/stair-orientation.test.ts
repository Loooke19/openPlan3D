import { expect, it } from 'vitest';
import type { Stair } from '$lib/models/types';
import {
  normalizeStairFootprint,
  stairGlbYawRadians,
  stairMisalignedWithLegacy3d,
  stairPlanRunAxis,
  stairWorldYawRadians,
  STAIR_GLB_RUN_AXIS_YAW,
} from '$lib/utils/stairOrientation';

const base: Stair = {
  id: 's',
  position: { x: 0, y: 0 },
  rotation: 0,
  width: 120,
  depth: 300,
  riserCount: 14,
  direction: 'up',
  stairType: 'straight',
};

it('normalises swapped width/depth and adds 90°', () => {
  const n = normalizeStairFootprint({ ...base, width: 300, depth: 120, rotation: 15 });
  expect(n.width).toBe(120);
  expect(n.depth).toBe(300);
  expect(n.rotation).toBe(105);
});

it('flags straight stairs with width > depth as legacy-misaligned', () => {
  expect(stairMisalignedWithLegacy3d({ ...base, width: 280, depth: 110 })).toBe(true);
  expect(stairMisalignedWithLegacy3d(base)).toBe(false);
});

it('GLB yaw includes Kenney +X→+Z offset', () => {
  expect(stairGlbYawRadians(base)).toBeCloseTo(stairWorldYawRadians(base) + STAIR_GLB_RUN_AXIS_YAW);
});

it('plan run axis rotates with stair rotation', () => {
  const a0 = stairPlanRunAxis(base);
  const a90 = stairPlanRunAxis({ ...base, rotation: 90 });
  expect(Math.hypot(a0.x, a0.y)).toBeCloseTo(1);
  expect(Math.hypot(a90.x, a90.y)).toBeCloseTo(1);
  const dot = a0.x * a90.x + a0.y * a90.y;
  expect(Math.abs(dot)).toBeLessThan(0.2);
});

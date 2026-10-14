import type { Stair } from '$lib/models/types';

/** Plan footprint after normalising so run (depth) is never shorter than width. */
export type NormalizedStair = Stair & { width: number; depth: number; rotation: number };

/**
 * Editor plan space: width along local +X, run (depth) along local +Y.
 * Canvas rotation is clockwise in screen space; 3D uses rotation.y = −rotation° and maps plan Y → world +Z.
 */
export function normalizeStairFootprint(stair: Stair): NormalizedStair {
  let { width, depth, rotation } = stair;
  if (depth < width) {
    [width, depth] = [depth, width];
    rotation += 90;
  }
  return { ...stair, width, depth, rotation };
}

/** Unit vector in plan (x,y) for the climbing direction (toward “up” treads). */
export function stairPlanRunAxis(stair: Stair): { x: number; y: number } {
  const s = normalizeStairFootprint(stair);
  const rad = (-s.rotation * Math.PI) / 180;
  const c = Math.cos(rad);
  const sn = Math.sin(rad);
  const sign = s.direction === 'down' ? -1 : 1;
  // Local “up” run is −Y in plan; same transform as hitTesting world→local, inverted.
  return { x: sn * sign, y: -c * sign };
}

/** World-space Y rotation (radians) for procedural meshes: run along +Z before parent rotation. */
export function stairWorldYawRadians(stair: Stair): number {
  const s = normalizeStairFootprint(stair);
  let yaw = -(s.rotation * Math.PI) / 180;
  if (s.direction === 'down') yaw += Math.PI;
  return yaw;
}

/**
 * Kenney stair GLBs are authored with the flight run along +X and width along +Z (height +Y).
 * After fitting, apply this constant offset so the run aligns with plan depth → world +Z.
 */
export const STAIR_GLB_RUN_AXIS_YAW = -Math.PI / 2;

export function stairGlbYawRadians(stair: Stair): number {
  return stairWorldYawRadians(stair) + STAIR_GLB_RUN_AXIS_YAW;
}

/**
 * True when saved width/depth are reversed relative to plan convention (run = depth).
 * Legacy 3D treated depth as run along +Z; with width > depth the flight looked ~90° off in nav.
 */
export function stairMisalignedWithLegacy3d(stair: Stair): boolean {
  if ((stair.stairType || 'straight') !== 'straight') return false;
  return stair.width > stair.depth + 0.5;
}

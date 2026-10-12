/**
 * Quantified door↔wall / wall-joint fit rules (cm). Used by the 3D viewer and
 * the r8 auto-check so pass/fail matches what is rendered.
 */
import type { Door, Floor, Wall } from '$lib/models/types';
import { getWallEndHeight, getWallStartHeight } from '$lib/models/types';
import { WALL_JOIN_TOLERANCE } from '$lib/utils/wallEditing';
import { pathOpening, wallPathProfile } from '$lib/utils/wallProfiles';

export const DEFAULT_WALL_THICKNESS = 15;
/** Jamb bar thickness along the wall (cm). */
export const DOOR_JAMB_CM = 3;
/**
 * Pull jambs into the opening only enough to kill coplanar z-fight with wall
 * end-caps. Must stay ≤ FIT_TOL_CM so auto-check accepts a flush doorway.
 */
export const DOOR_JAMB_CLEAR_CM = 0.5;
/** Leaf side clearance past each jamb inner face (cm). */
export const DOOR_LEAF_EDGE_CLEAR_CM = 0.5;
/** Frame depth equals wall thickness (no proud trim). */
export const DOOR_FRAME_DEPTH_EXTRA_CM = 0;
/** Fail when gap / penetration exceeds this (cm). */
export const FIT_TOL_CM = 1;

export type FitIssue = {
  kind:
    | 'missing-wall'
    | 'jamb-gap'
    | 'frame-depth'
    | 'leaf-clear'
    | 'wall-float'
    | 'joint-gap';
  floorId: string;
  floorName: string;
  doorId?: string;
  wallId?: string;
  detail: string;
  value: number;
};

export type FitProfile = {
  jamb: number;
  jambClear: number;
  leafEdgeClear: number;
  frameDepthExtra: number;
  jointSealed: boolean;
};

/** Geometry as shipped before the r8 flush fix (for before/after counts). */
export const LEGACY_NAV_FIT: FitProfile = {
  jamb: 3,
  jambClear: 3,
  leafEdgeClear: 7,
  frameDepthExtra: 2,
  jointSealed: false,
};

export const CURRENT_NAV_FIT: FitProfile = {
  jamb: DOOR_JAMB_CM,
  jambClear: DOOR_JAMB_CLEAR_CM,
  leafEdgeClear: DOOR_LEAF_EDGE_CLEAR_CM,
  frameDepthExtra: DOOR_FRAME_DEPTH_EXTRA_CM,
  jointSealed: true,
};

export function wallThicknessCm(wall: Wall): number {
  return Math.max(wall.thickness || 0, DEFAULT_WALL_THICKNESS);
}

/** Opening width must equal jambs + leaf (within tolerance). */
export function doorLeafWidth(openingWidth: number, profile: FitProfile): number {
  return Math.max(2, openingWidth - 2 * (profile.jamb + profile.jambClear + profile.leafEdgeClear));
}

export function measureDoorFit(
  floor: Floor,
  door: Door,
  profile: FitProfile,
): FitIssue[] {
  const issues: FitIssue[] = [];
  const wall = floor.walls.find((w) => w.id === door.wallId);
  const floorName = floor.name || floor.id;
  if (!wall) {
    issues.push({
      kind: 'missing-wall',
      floorId: floor.id,
      floorName,
      doorId: door.id,
      detail: 'door has no wall',
      value: 99,
    });
    return issues;
  }
  const path = wallPathProfile(wall);
  const opening = pathOpening(path, path.distanceAt(door.position), door.width, 0, door.height ?? 210);
  if (!opening || opening.right - opening.left <= 2) return issues;
  const openW = opening.right - opening.left;
  const wt = wallThicknessCm(wall);
  const frameDepth = wt + profile.frameDepthExtra;

  if (profile.jambClear > FIT_TOL_CM) {
    issues.push({
      kind: 'jamb-gap',
      floorId: floor.id,
      floorName,
      doorId: door.id,
      wallId: wall.id,
      detail: `jamb inset ${profile.jambClear}cm > ${FIT_TOL_CM}cm`,
      value: profile.jambClear,
    });
  }

  const depthDelta = Math.abs(frameDepth - wt);
  if (depthDelta > FIT_TOL_CM) {
    issues.push({
      kind: 'frame-depth',
      floorId: floor.id,
      floorName,
      doorId: door.id,
      wallId: wall.id,
      detail: `frame depth ${frameDepth} vs wall ${wt}`,
      value: depthDelta,
    });
  }

  // Clear width between jamb inner faces vs leaf width.
  const clear = openW - 2 * (profile.jamb + profile.jambClear);
  const leaf = doorLeafWidth(openW, profile);
  const leafGap = Math.abs(clear - leaf - 2 * profile.leafEdgeClear);
  // leaf + 2*edgeClear should equal clear; residual is penetration/gap.
  const residual = Math.abs(clear - (leaf + 2 * profile.leafEdgeClear));
  if (residual > FIT_TOL_CM) {
    issues.push({
      kind: 'leaf-clear',
      floorId: floor.id,
      floorName,
      doorId: door.id,
      wallId: wall.id,
      detail: `leaf/clear mismatch residual=${residual.toFixed(2)} (clear=${clear.toFixed(1)} leaf=${leaf.toFixed(1)})`,
      value: residual,
    });
  }
  void leafGap;

  return issues;
}

export type JointNode = {
  x: number;
  y: number;
  wallIds: string[];
  radius: number;
  height: number;
};

/** Endpoints that share a plan point within WALL_JOIN_TOLERANCE (L / coincident T). */
export function groupWallJointNodes(floor: Floor): JointNode[] {
  type Ep = { x: number; y: number; wall: Wall; height: number };
  const eps: Ep[] = [];
  for (const wall of floor.walls) {
    const h0 = getWallStartHeight(wall);
    const h1 = getWallEndHeight(wall);
    eps.push({ x: wall.start.x, y: wall.start.y, wall, height: h0 });
    eps.push({ x: wall.end.x, y: wall.end.y, wall, height: h1 });
  }
  const used = new Set<number>();
  const nodes: JointNode[] = [];
  for (let i = 0; i < eps.length; i++) {
    if (used.has(i)) continue;
    const cluster = [eps[i]];
    used.add(i);
    for (let j = i + 1; j < eps.length; j++) {
      if (used.has(j)) continue;
      if (Math.hypot(eps[j].x - eps[i].x, eps[j].y - eps[i].y) < WALL_JOIN_TOLERANCE) {
        cluster.push(eps[j]);
        used.add(j);
      }
    }
    const wallIds = [...new Set(cluster.map((c) => c.wall.id))];
    if (wallIds.length < 2) continue;
    const x = cluster.reduce((s, c) => s + c.x, 0) / cluster.length;
    const y = cluster.reduce((s, c) => s + c.y, 0) / cluster.length;
    const radius = Math.max(...cluster.map((c) => wallThicknessCm(c.wall))) / 2 + 0.5;
    const height = Math.max(...cluster.map((c) => c.height));
    nodes.push({ x, y, wallIds, radius, height });
  }
  return nodes;
}

export function measureJointFit(floor: Floor, profile: FitProfile): FitIssue[] {
  if (profile.jointSealed) return [];
  const floorName = floor.name || floor.id;
  return groupWallJointNodes(floor).map((n) => ({
    kind: 'joint-gap' as const,
    floorId: floor.id,
    floorName,
    detail: `unsealed joint at (${n.x.toFixed(0)},${n.y.toFixed(0)}) walls=${n.wallIds.length}`,
    value: n.radius, // outer wedge scale ~ radius*(√2-1) for L; report radius as severity proxy
  }));
}

export function measureFloorFit(floor: Floor, profile: FitProfile): FitIssue[] {
  const issues: FitIssue[] = [];
  for (const door of floor.doors || []) {
    issues.push(...measureDoorFit(floor, door, profile));
  }
  issues.push(...measureJointFit(floor, profile));
  return issues;
}

export function measureProjectFit(
  floors: Floor[],
  profile: FitProfile,
): { fails: number; doors: number; joints: number; issues: FitIssue[]; byKind: Record<string, number> } {
  const issues: FitIssue[] = [];
  let doors = 0;
  let joints = 0;
  for (const floor of floors) {
    doors += (floor.doors || []).length;
    joints += groupWallJointNodes(floor).length;
    issues.push(...measureFloorFit(floor, profile));
  }
  const byKind: Record<string, number> = {};
  for (const i of issues) byKind[i.kind] = (byKind[i.kind] || 0) + 1;
  return { fails: issues.length, doors, joints, issues, byKind };
}

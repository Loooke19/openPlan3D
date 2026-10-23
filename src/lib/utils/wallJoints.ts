import * as THREE from 'three';
import type { Floor } from '$lib/models/types';
import { groupWallJointNodes } from '$lib/utils/doorWallFit';

/** Seal L / coincident-endpoint T joints with a vertical cylinder (mirrors 2D drawWallJoints). */
export function addWallJointCaps(
  floor: Floor,
  group: THREE.Group,
  material: THREE.Material,
  holes: { c: { x: number; y: number }; u: { x: number; y: number }; half: number; depth: number; top: number }[] = [],
): number {
  const nodes = groupWallJointNodes(floor);
  for (const n of nodes) {
    if (n.height < 1 || n.radius < 0.5) continue;
    // A cap whose footprint reaches into a door hole would stand in the doorway (curved faces
    // inside the reveal, coplanar with the frame): seal only the part above the hole.
    let bottom = 0;
    for (const h of holes) {
      const dx = n.x - h.c.x, dy = n.y - h.c.y;
      const along = Math.abs(dx * h.u.x + dy * h.u.y), across = Math.abs(-dx * h.u.y + dy * h.u.x);
      if (along < h.half + n.radius + 1 && across < h.depth / 2 + n.radius + 1) bottom = Math.max(bottom, h.top + 0.2);
    }
    const height = n.height - bottom;
    if (height < 1) continue;
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(n.radius, n.radius, height, 16),
      material,
    );
    mesh.position.set(n.x, bottom + height / 2, n.y);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.wallJoint = true;
    group.add(mesh);
  }
  return nodes.length;
}

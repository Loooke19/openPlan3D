import * as THREE from 'three';
import type { Floor } from '$lib/models/types';
import { groupWallJointNodes } from '$lib/utils/doorWallFit';

/** Seal L / coincident-endpoint T joints with a vertical cylinder (mirrors 2D drawWallJoints). */
export function addWallJointCaps(
  floor: Floor,
  group: THREE.Group,
  material: THREE.Material,
): number {
  const nodes = groupWallJointNodes(floor);
  for (const n of nodes) {
    if (n.height < 1 || n.radius < 0.5) continue;
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(n.radius, n.radius, n.height, 16),
      material,
    );
    mesh.position.set(n.x, n.height / 2, n.y);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.wallJoint = true;
    group.add(mesh);
  }
  return nodes.length;
}

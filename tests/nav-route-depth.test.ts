// Handoff known issue "斜线/路径悬空，压在墙房之上": the nav route must lie on the floor and be
// depth-tested, so walls in front of it hide it (no whole-route depthTest:false / lifting).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { NavRouteVisual } from '../src/lib/components/viewer3d/nav/route';

describe('nav route ribbon', () => {
  const route = new NavRouteVisual([{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 400 }], { y: 4.6 });
  const meshes: THREE.Mesh[] = [];
  route.group.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });

  it('builds meshes', () => expect(meshes.length).toBeGreaterThan(0));

  it('every part is depth-tested', () => {
    for (const m of meshes) for (const mat of ([] as THREE.Material[]).concat(m.material)) expect(mat.depthTest).toBe(true);
  });

  it('sits on the floor, well below door height', () => {
    const box = new THREE.Box3().setFromObject(route.group);
    expect(box.min.y).toBeGreaterThanOrEqual(0);
    // Ribbon and markers hug the floor; only the destination beacon may rise.
    for (const m of meshes) if (!m.userData.beacon) expect(m.getWorldPosition(new THREE.Vector3()).y).toBeLessThan(20);
  });
});

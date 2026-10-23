// Handoff known issue "斜线/路径悬空，压在墙房之上": the nav route must lie on the floor and be
// depth-tested, so walls in front of it hide it (no whole-route depthTest:false / lifting).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { NavRouteVisual, transferStepPose } from '../src/lib/components/viewer3d/nav/route';

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

describe('floor transfer approach', () => {
  it('walks three short steps along the route, regardless of destination stop coordinates', () => {
    const from = { x: 1984.2, y: 1187.7 };
    for (const direction of ['up', 'down'] as const) {
      const poses = Array.from({ length: 31 }, (_, i) => transferStepPose(from, Math.PI / 2, i / 30, direction, true));
      expect(poses[0]).toMatchObject(from);
      expect(poses[0].rise).toBeCloseTo(0);
      expect(poses[30].x).toBeCloseTo(from.x);
      expect(poses[30].y - from.y).toBeCloseTo(84);
      expect(poses[30].rise).toBe(direction === 'up' ? 48 : -48);
      expect(poses.every((p, i) => !i || Math.abs(p.rise - poses[i - 1].rise) < 8)).toBe(true);
    }
  });

  it('keeps elevator approaches level', () => {
    expect(transferStepPose({ x: 0, y: 0 }, Math.PI, 1, 'down', false)).toMatchObject({ x: -84, rise: 0 });
  });

  it('stops at the approach endpoints when progress is outside the animation interval', () => {
    const from = { x: -1312.3, y: 144.8 };
    expect(transferStepPose(from, 0, -0.5, 'up', true)).toEqual({ ...from, rise: 0 });
    expect(transferStepPose(from, 0, 1.5, 'up', true)).toEqual({ x: from.x + 84, y: from.y, rise: 48 });
  });

  it('reaches each of the three treads in both directions', () => {
    for (const direction of ['up', 'down'] as const) {
      for (let step = 1; step <= 3; step++) {
        const pose = transferStepPose({ x: 0, y: 0 }, -Math.PI / 2, step / 3, direction, true);
        expect(pose.x).toBeCloseTo(0);
        expect(pose.y).toBeCloseTo(-28 * step);
        expect(pose.rise).toBe((direction === 'up' ? 16 : -16) * step);
      }
    }
  });
});

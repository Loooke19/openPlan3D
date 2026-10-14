import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import type { Door, Floor, Wall } from '$lib/models/types';
import { normalizeOpeningFloor, unionWallSurfaces, holeCuts, holeOnWall, holeKeeper, type Hole } from '$lib/components/viewer3d/nav/openingRules';
import { auditOpenings, type OpeningBox } from '$lib/components/viewer3d/nav/openingAudit';
import { addWallJointCaps } from '$lib/utils/wallJoints';
import { buildWallSegments, doorPanelPose } from '$lib/utils/wallProfiles';
import { regularizeWalls } from '$lib/components/viewer3d/nav/kitDressing';

const wall = (id: string, x0 = 0, x1 = 300): Wall => ({ id, start: { x: x0, y: 0 }, end: { x: x1, y: 0 }, height: 280, thickness: 15, color: '#fff' });
const door = (wallId: string, position = 0.5): Door => ({ id: `door-${wallId}`, wallId, position, width: 90, height: 210, type: 'single', swingDirection: 'left', flipSide: false });
const floor = (walls: Wall[], doors: Door[] = []): Floor => ({ id: 'f', name: '1F', level: 0, walls, doors, windows: [], rooms: [], furniture: [], stairs: [], columns: [], guides: [], measurements: [], annotations: [], textAnnotations: [], groups: [] });
const hole: Hole = { doorId: 'd', wallId: 'host', c: { x: 150, y: 0 }, u: { x: 1, y: 0 }, half: 45, depth: 15, top: 210 };
const box: OpeningBox = { id: 'd', c: { x: 0, y: 0 }, u: { x: 1, y: 0 }, half: 45, depth: 15, top: 210 };
const audit = (meshes: THREE.Object3D[], opening = box) => auditOpenings(new THREE.Group().add(...meshes), [opening], () => false);
const solid = (width: number, height: number, depth: number, x = 0) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth));
  m.position.set(x, height / 2, 0); m.userData.wallId = 'wall'; return m;
};

describe('physical wall and opening normalization', () => {
  it('merges a transitive union and keeps every original wall ID', () => {
    const input = floor([wall('a', 0, 100), wall('b', 200, 300), wall('c', 80, 220)], [door('b')]);
    const { floor: out, wallIds } = normalizeOpeningFloor(input);
    expect(out.walls).toHaveLength(1);
    expect(out.walls[0].end.x).toBe(300);
    expect([...wallIds.values()]).toEqual(['a', 'a', 'a']);
    expect(out.doors[0].position).toBeCloseTo(250 / 300);
    expect(input.walls).toHaveLength(3);
  });
  it('preserves clipped opening width, world location and reversed hinge pose', () => {
    const input = floor([wall('a'), wall('b', 250, 50)], [door('b', 0.9)]);
    const before = doorPanelPose(input.walls[1], { ...input.doors[0], position: 167.5 / 200, width: 65 });
    const out = normalizeOpeningFloor(input).floor;
    const after = doorPanelPose(out.walls[0], out.doors[0]);
    expect(out.doors[0].width).toBe(65);
    expect(out.doors[0].position).toBeCloseTo(82.5 / 300);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.z).toBeCloseTo(before.z);
    expect(Math.cos(after.yaw)).toBeCloseTo(Math.cos(before.yaw));
    expect(Math.sin(after.yaw)).toBeCloseTo(Math.sin(before.yaw));
  });
  it('reprojects windows and room references and applies one effective thickness', () => {
    const input = floor([wall('a', 0, 150), { ...wall('b', 100, 300), thickness: 10 }]);
    input.windows = [{ id: 'w', wallId: 'b', position: 0.5, width: 80, height: 100, sillHeight: 90, type: 'standard' }];
    input.rooms = [{ id: 'r', name: 'room', walls: ['a', 'b'], area: 10, color: '#fff', floorTexture: 'none' }];
    const out = normalizeOpeningFloor(input).floor;
    expect(out.windows[0].position).toBeCloseTo(200 / 300);
    expect(out.windows[0].wallId).toBe('a');
    expect(out.rooms[0].walls).toEqual(['a']);
    expect(out.walls[0].thickness).toBe(15);
  });
  it('retains curves, intentional diagonals, parallel separated walls and different height profiles', () => {
    const input = floor([wall('a'), { ...wall('b'), start: { x: 0, y: 2 }, end: { x: 300, y: 2 } }, { ...wall('c'), curvePoint: { x: 150, y: 30 } }, { ...wall('d'), startHeight: 210 }, { ...wall('e'), end: { x: 300, y: 30 } }]);
    expect(normalizeOpeningFloor(input).floor.walls).toHaveLength(5);
  });
  it('cuts a crossing wall to door height and retains its lintel', () => {
    const crossing = { ...wall('cross'), start: { x: 150, y: -100 }, end: { x: 150, y: 100 } };
    const cuts = holeCuts(crossing, [hole], 15, 0);
    expect(cuts).toHaveLength(1);
    expect(cuts[0].height).toBe(210);
    const segments = buildWallSegments(200, 280, 280, cuts as Door[], []);
    const head = segments.find(s => s.bottomY === 210)!;
    expect(head.width).toBeCloseTo(15);
    expect(head.topYLeft).toBe(280);
  });
  it('uses polygon intersection for oblique corners and ignores mere contact', () => {
    const touching = { ...wall('touch'), start: { x: 150, y: 15 }, end: { x: 300, y: 15 } };
    expect(holeOnWall(touching, hole, 15)).toBeNull();
    const cross = { ...wall('cross'), start: { x: 100, y: -50 }, end: { x: 200, y: 50 } };
    expect(holeOnWall(cross, hole, 15)).not.toBeNull();
  });
  it('cuts skirting even when only its extra thickness intersects the hole', () => {
    const adjacent = { ...wall('adjacent'), start: { x: 0, y: 15.5 }, end: { x: 300, y: 15.5 } };
    expect(holeCuts(adjacent, [hole], 15, 0)).toHaveLength(0);
    expect(holeCuts(adjacent, [hole], 17, 0)).toHaveLength(1);
  });
  it('deduplicates coincident doors while retaining overlapping distinct doors', () => {
    expect(holeKeeper([hole, { ...hole, c: { x: 187.5, y: 0 } }], 1)).toBe(1);
    expect(holeKeeper([hole, { ...hole, doorId: 'duplicate' }], 1)).toBe(0);
  });
  it('removes joint caps below a hole while retaining the part above it', () => {
    const input = floor([wall('host', 0, 150), { ...wall('cross'), start: { x: 150, y: 0 }, end: { x: 150, y: 100 } }]);
    const group = new THREE.Group(); addWallJointCaps(input, group, new THREE.MeshBasicMaterial(), [hole]);
    expect(group.children).toHaveLength(1);
    const bounds = new THREE.Box3().setFromObject(group);
    expect(bounds.min.y).toBeGreaterThan(210);
    expect(bounds.max.y).toBeCloseTo(280);
  });
});

describe('opening volume audit', () => {
  it('keeps a crossing lintel solid while eliminating its shared surfaces', () => {
    const host = solid(90, 70, 15), crossing = solid(15, 70, 90);
    host.position.y = crossing.position.y = 245;
    expect(audit([host, crossing]).coplanar).toBeGreaterThan(0);
    const group = new THREE.Group().add(host, crossing);
    unionWallSurfaces(group);
    const res = auditOpenings(group, [box], () => false);
    expect(res.coplanar).toBe(0);
    expect(res.blocked).toBe(0);
    const bounds = new THREE.Box3().setFromObject(group);
    expect(bounds.min.y).toBe(210);
    expect(bounds.max.y).toBe(280);
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 300, 0), new THREE.Vector3(0, -1, 0));
    expect(ray.intersectObject(group).length).toBeGreaterThan(0);
  });
  it('retains one exterior surface for coincident walls', () => {
    const group = new THREE.Group().add(solid(1000, 280, 15), solid(1000, 280, 15));
    unionWallSurfaces(group);
    expect(auditOpenings(group, [box], () => false).coplanar).toBe(0);
    const positions = group.children.map(o => (o as THREE.Mesh).geometry.getAttribute('position').count);
    expect(positions).toEqual([36]);
  });
  it('does not report a wall top against a ceiling rendered only from below', () => {
    const wall = solid(1000, 280, 15);
    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(1000, 1000), new THREE.MeshBasicMaterial({ side: THREE.BackSide }));
    ceiling.rotation.x = -Math.PI / 2;
    ceiling.position.y = 280;
    expect(audit([wall, ceiling], { ...box, top: 280 }).coplanar).toBe(0);
  });
  it('detects a 1000 cm wall whose triangle centroids are outside the doorway', () => {
    expect(audit([solid(1000, 280, 15)]).blocked).toBe(1);
  });
  it('detects a solid enclosing the entire opening without any surface in it', () => {
    expect(audit([solid(1000, 1000, 1000)]).blocked).toBe(1);
  });
  it('detects coplanar overlap at a hole edge even with both centroids outside', () => {
    expect(audit([solid(1000, 280, 15), solid(1000, 280, 15)]).coplanar).toBeGreaterThan(0);
  });
  it('uses instance transforms when checking static trim meshes', () => {
    const trim = new THREE.InstancedMesh(new THREE.BoxGeometry(20, 100, 15), new THREE.MeshBasicMaterial(), 2);
    trim.setMatrixAt(0, new THREE.Matrix4().makeTranslation(100, 50, 0));
    trim.setMatrixAt(1, new THREE.Matrix4().makeTranslation(0, 50, 0));
    expect(audit([trim]).blocked).toBe(1);
  });
  it('detects clipped oblique triangles and ignores surfaces entirely outside', () => {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([-200, 0, 0, 400, 280, 0, -200, 280, 30], 3)));
    expect(audit([mesh]).offAxis).toBeGreaterThan(0);
    expect(audit([solid(20, 280, 15, 100)]).blocked).toBe(0);
  });
  it('accepts walls, jambs, an inset header and skirting outside the clear opening', () => {
    const left = solid(255, 280, 15, -172.5), right = solid(255, 280, 15, 172.5);
    const head = solid(90, 70, 15); head.position.y = 245;
    const frame = solid(83, 3, 15); frame.position.y = 208.5;
    const res = audit([left, right, head, frame]);
    expect(res.blocked).toBe(0);
    expect(res.offAxis).toBe(0);
    expect(res.coplanar).toBe(0);
  });
});

it('normalizes floor fixtures without dropping doors or invalidating references', () => {
  const project = JSON.parse(readFileSync('tests/fixtures/multifloor-plan.openplan.json', 'utf8'));
  project.floors.forEach((f: Floor) => {
    const input = { ...f, walls: regularizeWalls(f.walls).walls };
    const out = normalizeOpeningFloor(input).floor;
    expect(out.doors).toHaveLength(f.doors.length);
    expect(out.windows).toHaveLength(f.windows.length);
    expect(out.doors.every(d => out.walls.some(w => w.id === d.wallId))).toBe(true);
    expect(normalizeOpeningFloor(out).floor.walls).toHaveLength(out.walls.length);
  });
});

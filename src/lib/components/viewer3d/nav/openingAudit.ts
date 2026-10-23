/**
 * Door-opening geometry audit (nav QA): for every door hole, every triangle of every static mesh
 * inside the hole's box must be axis-aligned to the wall frame (along / across / up, < 1° off),
 * reveal faces must face into the hole, and no two meshes may put visible faces on the same plane
 * over the same area (coplanar z-fight).
 */
import * as THREE from 'three';

export type OpeningBox = { id: string; wallId?: string; c: { x: number; y: number }; u: { x: number; y: number }; half: number; depth: number; top: number };
export type OpeningAudit = { openings: number; offAxis: number; offAxisArea: number; coplanar: number; inwardReveal: number; blocked: number; byKind: Record<string, number>; samples: string[] };

const COS1 = Math.cos(THREE.MathUtils.degToRad(1));

function clipVolume(poly: THREE.Vector3[], box: THREE.Box3): THREE.Vector3[] {
  for (const axis of ['x', 'y', 'z'] as const) for (const side of [-1, 1]) {
    const bound = side < 0 ? box.min[axis] : box.max[axis], input = poly;
    poly = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[i], b = input[(i + 1) % input.length];
      const da = (a[axis] - bound) * side, db = (b[axis] - bound) * side;
      if (da <= 0) poly.push(a);
      if ((da <= 0) !== (db <= 0)) poly.push(a.clone().lerp(b, da / (da - db)));
    }
  }
  return poly;
}

function polygonArea(poly: THREE.Vector3[]): number {
  let area = 0;
  for (let i = 1; i + 1 < poly.length; i++) area += poly[i].clone().sub(poly[0]).cross(poly[i + 1].clone().sub(poly[0])).length() / 2;
  return area;
}

function clipArea(a: THREE.Vector2[], b: THREE.Vector2[]) {
  // convex polygon intersection (Sutherland–Hodgman), returns area
  let out = a;
  const cross = (p: THREE.Vector2, q: THREE.Vector2, r: THREE.Vector2) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const orient = b.reduce((sum, p, i) => { const q = b[(i + 1) % b.length]; return sum + p.x * q.y - q.x * p.y; }, 0) >= 0 ? 1 : -1;
  for (let i = 0; i < b.length && out.length; i++) {
    const p = b[i], q = b[(i + 1) % b.length], inp = out; out = [];
    for (let j = 0; j < inp.length; j++) {
      const s = inp[j], e = inp[(j + 1) % inp.length];
      const si = cross(p, q, s) * orient >= -1e-6, ei = cross(p, q, e) * orient >= -1e-6;
      const hit = () => { const d1 = cross(p, q, s), d2 = cross(p, q, e); const t = d1 / (d1 - d2); return new THREE.Vector2(s.x + (e.x - s.x) * t, s.y + (e.y - s.y) * t); };
      if (si && ei) out.push(e); else if (si && !ei) out.push(hit()); else if (!si && ei) { out.push(hit()); out.push(e); }
    }
  }
  let A = 0; for (let i = 0; i < out.length; i++) { const p = out[i], q = out[(i + 1) % out.length]; A += p.x * q.y - q.x * p.y; }
  return Math.abs(A) / 2;
}

export function auditOpenings(root: THREE.Object3D | THREE.Object3D[], openings: OpeningBox[], skip: (o: THREE.Object3D) => boolean): OpeningAudit {
  const res: OpeningAudit = { openings: openings.length, offAxis: 0, offAxisArea: 0, coplanar: 0, inwardReveal: 0, blocked: 0, byKind: {}, samples: [] };
  const kind = (m: THREE.Object3D) => m.userData.navPart || (m.userData.wallJoint ? 'joint' : m.userData.wallId ? 'wall' : m.userData.navRole || (m as THREE.Mesh).geometry?.type || m.type);
  const per: Record<string, number> = {};
  const bump = (k: string, why?: () => string) => { res.byKind[k] = (res.byKind[k] ?? 0) + 1; per[k] = (per[k] ?? 0) + 1; if (why && per[k] <= 3) res.samples.push(k + ' | ' + why()); };
  const who = (m: THREE.Object3D) => `${kind(m)}${m.userData.wallId || m.userData.bbWall ? '#' + (m.userData.wallId || m.userData.bbWall) : ''}`;
  const meshes: THREE.Mesh[] = [];
  for (const part of Array.isArray(root) ? root : [root]) {
    part.updateWorldMatrix(true, true);
    part.traverse(o => {
      if (!(o as THREE.Mesh).isMesh || !o.visible || skip(o)) return;
      if ((o as THREE.InstancedMesh).isInstancedMesh) {
        const source = o as THREE.InstancedMesh, instance = new THREE.Matrix4();
        for (let i = 0; i < source.count; i++) {
          source.getMatrixAt(i, instance);
          const mesh = new THREE.Mesh(source.geometry, source.material);
          mesh.matrixWorld.multiplyMatrices(source.matrixWorld, instance); mesh.userData = source.userData;
          meshes.push(mesh);
        }
      } else meshes.push(o as THREE.Mesh);
    });
  }
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (const op of openings) {
    const U = new THREE.Vector3(op.u.x, 0, op.u.y), N = new THREE.Vector3(-op.u.y, 0, op.u.x);
    const O = new THREE.Vector3(op.c.x, 0, op.c.y);
    const loc = (p: THREE.Vector3) => { const d = p.clone().sub(O); return new THREE.Vector3(d.dot(U), d.y, d.dot(N)); };
    const volume = new THREE.Box3(new THREE.Vector3(-op.half - 1, -1, -op.depth / 2 - 1), new THREE.Vector3(op.half + 1, op.top + 1, op.depth / 2 + 1));
    const holeVolume = new THREE.Box3(new THREE.Vector3(-op.half, 0, -op.depth / 2), new THREE.Vector3(op.half, op.top, op.depth / 2));
    const clear = new THREE.Box3(new THREE.Vector3(-op.half + 7, 4, -op.depth / 2 + 0.2), new THREE.Vector3(op.half - 7, op.top - 3.51, op.depth / 2 - 0.2));
    const probe = clear.getCenter(new THREE.Vector3()), ray = new THREE.Ray(probe, new THREE.Vector3(0, 0, 1));
    type T = { mesh: THREE.Mesh; axis: number; sign: number; off: number; poly: THREE.Vector2[]; area: number; cen: THREE.Vector3 };
    const tris: T[] = [];
    for (const m of meshes) {
      const g = m.geometry, pos = g.getAttribute('position'); if (!pos) continue;
      const idx = g.index; const count = idx ? idx.count : pos.count;
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox!.clone().applyMatrix4(m.matrixWorld);
      const localBounds = new THREE.Box3();
      for (const x of [bb.min.x, bb.max.x]) for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z]) localBounds.expandByPoint(loc(new THREE.Vector3(x, y, z)));
      if (!localBounds.intersectsBox(volume)) continue;
      let blocked = false;
      const hits: number[] = [];
      for (let t = 0; t < count; t += 3) {
        const i0 = idx ? idx.getX(t) : t, i1 = idx ? idx.getX(t + 1) : t + 1, i2 = idx ? idx.getX(t + 2) : t + 2;
        a.fromBufferAttribute(pos, i0).applyMatrix4(m.matrixWorld); b.fromBufferAttribute(pos, i1).applyMatrix4(m.matrixWorld); c.fromBufferAttribute(pos, i2).applyMatrix4(m.matrixWorld);
        const la = loc(a), lb = loc(b), lc = loc(c);
        const triangle = [la, lb, lc];
        if (!clear.isEmpty() && localBounds.intersectsBox(clear)) {
          if (polygonArea(clipVolume(triangle, clear)) > 1e-4) blocked = true;
          const hit = ray.intersectTriangle(la, lb, lc, false, new THREE.Vector3());
          if (hit && hit.z > probe.z + 1e-5 && !hits.some(z => Math.abs(z - hit.z) < 1e-4)) hits.push(hit.z);
        }
        const clipped = clipVolume(triangle, volume), area = polygonArea(clipped);
        if (area < 1e-4) continue;
        const cen = clipped.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(clipped.length);
        n.subVectors(lb, la).cross(new THREE.Vector3().subVectors(lc, la));
        n.normalize();
        const material = Array.isArray(m.material) ? m.material[g.groups.find(group => t >= group.start && t < group.start + group.count)?.materialIndex ?? 0] : m.material;
        if (material.side === THREE.BackSide) n.negate();
        const comps = [Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)], axis = comps.indexOf(Math.max(...comps));
        if (comps[axis] < COS1) {
          const insideArea = polygonArea(clipVolume(triangle, holeVolume));
          if (insideArea < 1e-4) continue;
          res.offAxis++; if (insideArea > 1) { res.offAxisArea++; bump('offAxis:' + kind(m), () => `${op.id}/${op.wallId} ${who(m)} c=${cen.toArray().map(v => v.toFixed(0))} A=${insideArea.toFixed(0)}`); }
          continue;
        }
        const sign = material.side === THREE.DoubleSide ? 0 : Math.sign([n.x, n.y, n.z][axis]);
        if (axis === 1 && n.y < 0 && cen.y <= 0.5) continue; // under-floor bottoms: never visible
        const k = [[1, 2], [0, 2], [0, 1]][axis];
        const P = (v: THREE.Vector3) => { const arr = [v.x, v.y, v.z]; return new THREE.Vector2(arr[k[0]], arr[k[1]]); };
        tris.push({ mesh: m, axis, sign, off: [cen.x, cen.y, cen.z][axis], poly: clipped.map(P), area, cen });
        // reveal faces (along-axis normals on the hole's side planes) must face into the hole
        if (axis === 0 && cen.y > 0.05 && cen.y < op.top - 0.05 && polygonArea(clipVolume(triangle, holeVolume)) > 1e-4 && Math.abs(Math.abs(cen.x) - op.half) < 1.5 && Math.sign(cen.x) === sign && m.userData.wallId) {
          res.inwardReveal++; bump('reveal:' + kind(m), () => `${op.id}/${op.wallId} ${who(m)} x=${cen.x.toFixed(1)} half=${op.half.toFixed(1)}`);
        }
      }
      if (blocked || (localBounds.containsPoint(probe) && hits.length % 2 === 1)) { res.blocked++; bump('blocked:' + kind(m), () => `${op.id}/${op.wallId} ${who(m)}`); }
    }
    // coplanar overlap between different meshes, same facing
    for (let i = 0; i < tris.length; i++) for (let j = i + 1; j < tris.length; j++) {
      const p = tris[i], q = tris[j];
      if (p.mesh === q.mesh || p.axis !== q.axis || (p.sign !== q.sign && p.sign !== 0 && q.sign !== 0) || Math.abs(p.off - q.off) > 0.05) continue;
      const A = clipArea(p.poly, q.poly);
      if (A > 1) { res.coplanar++; bump(`coplanar:${kind(p.mesh)}x${kind(q.mesh)}:${'xyz'[p.axis]}`, () => `${op.id}/${op.wallId} ${who(p.mesh)} × ${who(q.mesh)} ${'xyz'[p.axis]}${p.sign > 0 ? '+' : '-'}@${p.off.toFixed(1)} bb=${[p.mesh, q.mesh].map(mm => { const b = mm.geometry.boundingBox!.clone().applyMatrix4(mm.matrixWorld); return [b.min, b.max].map(v => loc(v).toArray().map(x => x.toFixed(0)).join(',')).join('~'); }).join(' | ')} c=${p.cen.toArray().map(v => v.toFixed(0))} A=${A.toFixed(0)}`); }
    }
  }
  return res;
}

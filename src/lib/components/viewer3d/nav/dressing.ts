/**
 * Scene dressing for the nav preview, built from whatever the shared floor builder produced:
 * capped wall tops (architectural-model read), a baked floor AO mask from the wall footprints,
 * first-person ceiling light panels with soft light pools, and the per-view light rig.
 */
import * as THREE from 'three';
import { lightSpots } from './layout';
import type { NavLook } from './pipeline';

const box = new THREE.BoxGeometry(1, 1, 1);

/**
 * World-space footprint of a wall mesh, whatever local axis its geometry uses for height
 * (some walls are extruded shapes rotated onto their side). Returns the 4 bottom corners, the top
 * world Y, the world height, and a unit-cube matrix for a thin cap on the top face.
 */
function wallFootprint(mesh: THREE.Mesh) {
  const g = mesh.geometry;
  if (!g.boundingBox) g.computeBoundingBox();
  const b = g.boundingBox!;
  mesh.updateWorldMatrix(true, false);
  const e = mesh.matrixWorld.elements;
  const axes = [0, 1, 2].map(i => new THREE.Vector3(e[i * 4], e[i * 4 + 1], e[i * 4 + 2]));
  const h = axes.reduce((best, v, i) => (Math.abs(v.y) > Math.abs(axes[best].y) ? i : best), 0);
  const [u, w] = [0, 1, 2].filter(i => i !== h);
  const lo = b.min.toArray(), hi = b.max.toArray();
  const up = axes[h].y >= 0;
  const bottom = up ? lo[h] : hi[h], topLocal = up ? hi[h] : lo[h];
  const corner = (cu: number, cw: number, ch: number) => {
    const v = [0, 0, 0]; v[u] = cu; v[w] = cw; v[h] = ch;
    return new THREE.Vector3(...v).applyMatrix4(mesh.matrixWorld);
  };
  const corners = [corner(lo[u], lo[w], bottom), corner(hi[u], lo[w], bottom), corner(hi[u], hi[w], bottom), corner(lo[u], hi[w], bottom)];
  const top = corner(lo[u], lo[w], topLocal).y;
  const height = Math.abs(top - corners[0].y);
  const scaleH = axes[h].length() || 1;
  const c = [0, 0, 0], sz = [0, 0, 0];
  c[u] = (lo[u] + hi[u]) / 2; c[w] = (lo[w] + hi[w]) / 2; c[h] = topLocal + (up ? 1 : -1) * (1.5 / scaleH);
  sz[u] = hi[u] - lo[u] + 0.6; sz[w] = hi[w] - lo[w] + 0.6; sz[h] = 3 / scaleH;
  const cap = mesh.matrixWorld.clone().multiply(new THREE.Matrix4().compose(new THREE.Vector3(...c), new THREE.Quaternion(), new THREE.Vector3(...sz)));
  return { corners, top, height, cap };
}

export function wallMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse(o => {
    const m = o as THREE.Mesh;
    if (m.isMesh && (m.userData.renderMaterial === 'wall' || m.userData.wallId) && !m.userData.navDressing) out.push(m);
  });
  return out;
}

export type DressingOptions = { look: NavLook; floorY: number; rooms: { polygon: { x: number; y: number }[] }[]; ceilings: { polygon: { x: number; y: number }[]; height: number }[] };

export class NavDressing {
  readonly group = new THREE.Group();
  private walkOnly = new THREE.Group();
  private overviewOnly = new THREE.Group();
  private resources: { dispose(): void }[] = [];

  constructor(root: THREE.Object3D, opts: DressingOptions) {
    this.group.userData.navDressing = true;
    this.group.add(this.walkOnly, this.overviewOnly);
    const walls = wallMeshes(root).filter(m => wallFootprint(m).height > 60);
    this.buildCaps(walls);
    this.bakeAo(walls, opts);
    // Every room gets a first-person ceiling (corridors often have none from the editor).
    const top = walls.length ? Math.max(...walls.map(w => wallFootprint(w).top)) - opts.floorY : 280;
    // One ceiling over the whole plan (corridors are usually not rooms); exterior walls hide it.
    const corners = walls.flatMap(w => wallFootprint(w).corners);
    const ceilings = corners.length ? [{ height: top, polygon: (() => {
      const xs = corners.map(c => c.x), zs = corners.map(c => c.z);
      const [x0, x1, z0, z1] = [Math.min(...xs) + 15, Math.max(...xs) - 15, Math.min(...zs) + 15, Math.max(...zs) - 15];
      return [{ x: x0, y: z0 }, { x: x1, y: z0 }, { x: x1, y: z1 }, { x: x0, y: z1 }];
    })() }] : [];
    this.buildCeilings(ceilings, opts.floorY);
    this.buildCeilingLights({ ...opts, ceilings: ceilings.length ? ceilings : opts.ceilings });
    this.setLook(opts.look);
  }

  private track<T extends { dispose(): void }>(r: T) { this.resources.push(r); return r; }

  /**
   * Dark caps on wall tops: crisp cut-away model edges from above. Box walls carry one material per
   * face (+x, -x, +y, -y, +z, -z); the +y slot is the top, so swap only that slot.
   */
  private buildCaps(walls: THREE.Mesh[]) {
    const cap = this.track(new THREE.MeshStandardMaterial({ color: '#34403c', roughness: 0.8 }));
    for (const w of walls) {
      if (w.geometry.type !== 'BoxGeometry') continue;
      const mats = Array.isArray(w.material) ? w.material.slice() : [0, 1, 2, 3, 4, 5].map(() => w.material as THREE.Material);
      if (mats.length !== 6) continue;
      w.userData.navTopMaterial = mats[2];
      mats[2] = cap;
      w.material = mats;
      this.capped.push(w);
    }
  }
  private capped: THREE.Mesh[] = [];

  /** Static "lightmap" AO: wall footprints rasterised, blurred twice, multiplied over the floors. */
  private bakeAo(walls: THREE.Mesh[], opts: DressingOptions) {
    if (typeof document === 'undefined' || !walls.length || !opts.rooms.length) return;
    const pts = opts.rooms.flatMap(r => r.polygon);
    const minX = Math.min(...pts.map(p => p.x)), maxX = Math.max(...pts.map(p => p.x));
    const minZ = Math.min(...pts.map(p => p.y)), maxZ = Math.max(...pts.map(p => p.y));
    const size = 1024, sx = size / (maxX - minX), sz = size / (maxZ - minZ);
    const px = (x: number, z: number): [number, number] => [(x - minX) * sx, (z - minZ) * sz];
    const mask = document.createElement('canvas'); mask.width = mask.height = size;
    const mctx = mask.getContext('2d')!;
    mctx.fillStyle = '#fff'; mctx.fillRect(0, 0, size, size);
    mctx.fillStyle = '#000';
    for (const w of walls) {
      const f = wallFootprint(w);
      mctx.beginPath();
      f.corners.forEach((c, i) => { const [x, y] = px(c.x, c.z); i ? mctx.lineTo(x, y) : mctx.moveTo(x, y); });
      mctx.closePath(); mctx.fill();
    }
    const out = document.createElement('canvas'); out.width = out.height = size;
    const o = out.getContext('2d')!;
    o.fillStyle = '#fff'; o.fillRect(0, 0, size, size);
    // Only darken inside rooms (no floating shadow over the ground outside).
    o.save();
    o.beginPath();
    for (const r of opts.rooms) r.polygon.forEach((p, i) => { const [x, y] = px(p.x, p.y); i ? o.lineTo(x, y) : o.moveTo(x, y); }), o.closePath();
    o.clip();
    o.globalAlpha = 0.55; o.filter = `blur(${Math.max(2, 22 * sx)}px)`; o.drawImage(mask, 0, 0);
    o.globalCompositeOperation = 'multiply';
    o.globalAlpha = 0.5; o.filter = `blur(${Math.max(4, 70 * sx)}px)`; o.drawImage(mask, 0, 0);
    o.restore();
    const tex = this.track(new THREE.CanvasTexture(out));
    tex.colorSpace = THREE.NoColorSpace;
    const mat = this.track(new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.DstColorFactor, blendDst: THREE.ZeroFactor,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, toneMapped: false,
    }));
    const geo = this.track(new THREE.PlaneGeometry(maxX - minX, maxZ - minZ).rotateX(-Math.PI / 2));
    const plane = new THREE.Mesh(geo, mat);
    plane.position.set((minX + maxX) / 2, opts.floorY + 3.5, (minZ + maxZ) / 2);
    plane.renderOrder = 1;
    plane.userData.navDressing = true;
    this.group.add(plane);
  }

  private buildCeilings(ceilings: { polygon: { x: number; y: number }[]; height: number }[], floorY: number) {
    if (!ceilings.length) return;
    const mat = this.track(new THREE.MeshStandardMaterial({ color: '#b9bcb6', roughness: 0.95, side: THREE.DoubleSide }));
    for (const c of ceilings) {
      const shape = new THREE.Shape(c.polygon.map(p => new THREE.Vector2(p.x, -p.y)));
      const geo = this.track(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2));
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.y = floorY + c.height - 0.5;
      mesh.userData.navDressing = true;
      this.walkOnly.add(mesh);
    }
  }

  /** First person: emissive panels on a grid inside every ceiling, each with a soft pool below. */
  private buildCeilingLights(opts: DressingOptions) {
    // Panels follow the room/corridor layout (centred row on corridors, grid in halls), not the
    // building bounding box, so they sit on the corridor's centreline.
    const h = opts.ceilings[0]?.height ?? 280;
    const spots = lightSpots(opts.rooms).map(sp => ({ ...sp, h }));
    if (!spots.length) return;
    const panelMat = this.track(new THREE.MeshBasicMaterial({ color: new THREE.Color('#fff4e2').multiplyScalar(1.5) }));
    const panels = new THREE.InstancedMesh(box, panelMat, spots.length);
    const frameMat = this.track(new THREE.MeshStandardMaterial({ color: '#9aa09c', roughness: 0.5, metalness: 0.3 }));
    const frames = new THREE.InstancedMesh(box, frameMat, spots.length);
    const m = new THREE.Matrix4(), dummy = new THREE.Object3D();
    spots.forEach((s, i) => {
      dummy.position.set(s.x, opts.floorY + s.h - 1.2, s.z);
      dummy.scale.set(s.long ? 120 : 30, 1.5, s.long ? 30 : 120); dummy.updateMatrix(); panels.setMatrixAt(i, dummy.matrix);
      dummy.position.y = opts.floorY + s.h - 0.8; dummy.scale.set(s.long ? 128 : 38, 1.2, s.long ? 38 : 128); dummy.updateMatrix(); frames.setMatrixAt(i, dummy.matrix);
    });
    void m;
    // Light pools: additive radial gradient on the floor below each panel.
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,240,215,1)'); grad.addColorStop(0.45, 'rgba(255,236,205,.45)'); grad.addColorStop(1, 'rgba(255,230,200,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
    const poolTex = this.track(new THREE.CanvasTexture(c));
    const poolMat = this.track(new THREE.MeshBasicMaterial({ map: poolTex, color: new THREE.Color(0.2, 0.18, 0.15), transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    const poolGeo = this.track(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
    const pools = new THREE.InstancedMesh(poolGeo, poolMat, spots.length);
    spots.forEach((s, i) => {
      dummy.position.set(s.x, opts.floorY + 3.8, s.z);
      dummy.scale.set(s.long ? 330 : 240, 1, s.long ? 240 : 330); dummy.updateMatrix(); pools.setMatrixAt(i, dummy.matrix);
    });
    pools.renderOrder = 2;
    for (const o of [panels, frames, pools]) { o.userData.navDressing = true; o.frustumCulled = false; this.walkOnly.add(o); }
  }

  setLook(look: NavLook) {
    this.walkOnly.visible = look === 'walk';
    this.overviewOnly.visible = look === 'overview';
  }

  /** Put the original top faces back (the editor never sees nav caps). */
  restoreCaps() {
    for (const w of this.capped) {
      if (!Array.isArray(w.material) || !w.userData.navTopMaterial) continue;
      const mats = w.material.slice(); mats[2] = w.userData.navTopMaterial; w.material = mats;
    }
    this.capped = [];
  }

  dispose() {
    this.restoreCaps();
    this.group.traverse(o => { if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose(); });
    for (const r of this.resources) r.dispose();
    this.group.removeFromParent();
  }
}

export type LightRig = { ambient: THREE.AmbientLight; hemi: THREE.HemisphereLight; sun: THREE.DirectionalLight; fill: THREE.DirectionalLight; rim: THREE.DirectionalLight };

/** Per-view lighting for the nav shell; balanced so nothing but emissive guides exceeds 1.0 (bloom threshold). */
export function applyNavLightRig(rig: LightRig, look: NavLook, bounds: THREE.Box3 | null, quality: string) {
  const { ambient, hemi, sun, fill, rim } = rig;
  const size = bounds && !bounds.isEmpty() ? bounds.getSize(new THREE.Vector3()) : new THREE.Vector3(3000, 300, 3000);
  const center = bounds && !bounds.isEmpty() ? bounds.getCenter(new THREE.Vector3()) : new THREE.Vector3();
  const span = Math.max(size.x, size.z) * 0.62 + 200;
  if (look === 'overview') {
    ambient.intensity = 0.05;
    hemi.color.set('#e6eef6'); hemi.groundColor.set('#b8b2a8'); hemi.intensity = 0.34;
    sun.color.set('#fff0db'); sun.intensity = 1.08;
    sun.position.set(center.x + span * 0.75, center.y + span * 1.0, center.z + span * 0.7);
    sun.target.position.copy(center);
    fill.color.set('#cfdcf0'); fill.intensity = 0.12;
    rim.intensity = 0.0;
  } else {
    ambient.intensity = 0.04;
    hemi.color.set('#f1ece2'); hemi.groundColor.set('#8c8a84'); hemi.intensity = 0.36;
    sun.intensity = 0.0;
    fill.color.set('#f3e7d6'); fill.intensity = 0.1;
    rim.intensity = 0.0;
  }
  sun.castShadow = quality !== 'low' && look === 'overview';
  const cam = sun.shadow.camera as THREE.OrthographicCamera;
  cam.left = cam.bottom = -span; cam.right = cam.top = span;
  cam.near = 10; cam.far = span * 5;
  cam.updateProjectionMatrix();
  sun.shadow.mapSize.set(quality === 'ultra' ? 4096 : 2048, quality === 'ultra' ? 4096 : 2048);
  sun.shadow.map?.dispose(); (sun.shadow as any).map = null;
  sun.shadow.radius = 4;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 2;
  if (!sun.target.parent && sun.parent) sun.parent.add(sun.target);
}

/** Soft studio backdrop for the overview (no sky dome, no grid). */
export function navBackdrop(look: NavLook): THREE.Texture {
  const c = document.createElement('canvas'); c.width = 16; c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  if (look === 'overview') { grad.addColorStop(0, '#eef1f2'); grad.addColorStop(1, '#d6dbdc'); }
  else { grad.addColorStop(0, '#d9dcd8'); grad.addColorStop(1, '#b9bdb8'); }
  g.fillStyle = grad; g.fillRect(0, 0, 16, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Visual polish TRIAL for first-person nav (opt-in, single floor): `?visualTrial=<floor name|id>`
 * (e.g. `visualTrial=2F`). Nothing here runs unless the flag names the floor being viewed, so the
 * default look of every floor is unchanged.
 *
 * (1) Lighting: cool-white hospital light, lighter ceiling + panels, satin floor sheen, lighter
 *     walls over a slightly deeper floor for wall/floor contrast.
 * (2) Route: more vivid band, pre-turn floor arrows ~1.3 m before each turn.
 * (3) Signs: near blades/lintels enlarged (one palette/font is already shared by all signs).
 */
import * as THREE from 'three';
import type { NavRouteVisual } from './route';

export function navVisualTrialFloor(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('visualTrial');
}

export function navVisualTrialActive(floor?: { id?: string; name?: string } | null): boolean {
  const want = navVisualTrialFloor();
  if (!want || !floor) return false;
  const norm = (s?: string) => (s || '').replace(/\s+/g, '').toLowerCase();
  return norm(floor.id) === norm(want) || norm(floor.name) === norm(want);
}

type LightRig = { ambient: THREE.AmbientLight; hemi: THREE.HemisphereLight; fill: THREE.DirectionalLight };

export function applyTrialLights(rig: LightRig, walk: boolean) {
  if (!walk) return;
  rig.ambient.intensity = 0.1;
  rig.hemi.color.set('#f3f7ff'); rig.hemi.groundColor.set('#9ea4a8'); rig.hemi.intensity = 0.74;
  rig.fill.color.set('#eef4ff'); rig.fill.intensity = 0.24;
}

const TRIAL_TAG = '__navTrial';

/** Materials are cloned per mesh on first touch so the trial never leaks into shared materials. */
function own<T extends THREE.Material>(mesh: THREE.Mesh): T {
  if (!mesh.userData[TRIAL_TAG]) {
    const src = mesh.material as THREE.Material;
    const copy = src.clone();
    // Material.clone() drops onBeforeCompile/customProgramCacheKey — keep the hospital PBR shader.
    copy.onBeforeCompile = src.onBeforeCompile;
    copy.customProgramCacheKey = src.customProgramCacheKey;
    mesh.material = copy;
    mesh.userData[TRIAL_TAG] = true;
  }
  return mesh.material as T;
}

export function applyTrialSurfaces(walls: THREE.Object3D, dressing: THREE.Object3D | null) {
  walls.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || Array.isArray(m.material) || m.userData[TRIAL_TAG]) return;
    // Floors keep the default asset look exactly (terrazzo PBR maps untouched).
    if (m.userData.wallId) {
      const mat = own<THREE.MeshStandardMaterial>(m);
      mat.color?.lerp(new THREE.Color('#ffffff'), 0.3);
    }
  });
  dressing?.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || Array.isArray(m.material) || m.userData[TRIAL_TAG]) return;
    if (m.geometry?.type === 'ShapeGeometry' || m.userData.navShaft) {
      const mat = own<THREE.MeshStandardMaterial>(m);
      mat.color.set('#f2f4f5'); mat.roughness = 0.8;
    } else if ((m as unknown as THREE.InstancedMesh).isInstancedMesh && (m.material as THREE.MeshBasicMaterial).isMeshBasicMaterial && !(m.material as THREE.Material).transparent) {
      const mat = own<THREE.MeshBasicMaterial>(m);
      mat.color.set('#f4f8ff').multiplyScalar(1.7);
    }
  });
}

export function applyTrialRoute(route: NavRouteVisual | null) {
  if (!route) return;
  route.uniforms.uAccent.value.set('#0a7cff').multiplyScalar(1.15);
  route.uniforms.uGlowColor.value.set('#58c2ff');
}

/** Bent-arrow floor decals ~1.3 m before each turn > 35°, pointing the new way. */
export function buildTurnHints(points: { x: number; y: number }[], floorY: number): THREE.Group {
  const g = new THREE.Group();
  g.userData.navTrial = true;
  if (points.length < 3) return g;
  const tex = arrowTexture();
  const segs: { b: { x: number; y: number }; len: number; yaw: number }[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > 1) segs.push({ b, len, yaw: Math.atan2(b.y - a.y, b.x - a.x) });
  }
  for (let i = 1; i < segs.length; i++) {
    let d = segs[i].yaw - segs[i - 1].yaw;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    if (Math.abs(d) < THREE.MathUtils.degToRad(35) || segs[i - 1].len < 90) continue;
    const s = segs[i - 1];
    const back = Math.min(130, s.len * 0.6);
    const p = { x: s.b.x - Math.cos(s.yaw) * back, y: s.b.y - Math.sin(s.yaw) * back };
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(64, 64), mat);
    mesh.rotation.x = -Math.PI / 2;
    // Arrow art points up (+v) and bends right; rotate to the travel direction, mirror for left.
    mesh.rotation.z = -(s.yaw + Math.PI / 2);
    if (d < 0) mesh.scale.x = -1;
    mesh.position.set(p.x, floorY + 6, p.y);
    mesh.renderOrder = 7;
    g.add(mesh);
  }
  return g;
}

let arrowTex: THREE.CanvasTexture | null = null;
function arrowTexture() {
  if (arrowTex) return arrowTex;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d')!;
  x.fillStyle = 'rgba(10,124,255,0.92)';
  x.beginPath(); x.arc(64, 64, 60, 0, Math.PI * 2); x.fill();
  x.strokeStyle = '#ffffff'; x.lineWidth = 14; x.lineCap = 'round'; x.lineJoin = 'round';
  x.beginPath(); x.moveTo(46, 104); x.lineTo(46, 56); x.quadraticCurveTo(46, 44, 58, 44); x.lineTo(92, 44); x.stroke();
  x.fillStyle = '#ffffff';
  x.beginPath(); x.moveTo(104, 44); x.lineTo(84, 26); x.lineTo(84, 62); x.closePath(); x.fill();
  arrowTex = new THREE.CanvasTexture(c);
  arrowTex.colorSpace = THREE.SRGBColorSpace;
  return arrowTex;
}

/**
 * Door blade signs 20% smaller (×0.8), bracket arm scaled with them and still meeting the wall:
 * the blade keeps its wall-side edge distance and hangs just under the (shortened) arm.
 */
export function applyTrialSigns(signs: THREE.Object3D | null) {
  const k = 0.8;
  signs?.traverse(o => {
    if (o.userData.navSign?.kind !== 'blade' || o.userData.__trialScaled) return;
    const arm = o.userData.arm as THREE.Object3D | undefined;
    const wallX = o.userData.wallX as number | undefined; // blade inner edge offset from the wall face (cm)
    const x = new THREE.Vector3(1, 0, 0).applyQuaternion(o.quaternion); // into the corridor
    o.scale.setScalar(k);
    if (arm && wallX !== undefined) {
      // Blade: inner edge stays wallX from the wall; centre moves in by half the width lost.
      o.position.addScaledVector(x, -(64 * (1 - k)) / 2);
      // Arm: from the wall face to the blade's outer edge, at the blade's new top.
      const armLen = (wallX + 64 * k) + 2;
      const armStart = (arm.userData.wallFace as THREE.Vector3).clone();
      arm.scale.set(armLen / 42, 1, 1);
      arm.position.copy(armStart).addScaledVector(x, armLen / 2);
      arm.position.y = o.position.y + (20 * k) / 2 + 1;
    }
    o.userData.__trialScaled = true;
  });
}

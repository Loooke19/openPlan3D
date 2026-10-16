/**
 * First-person floor look from the wu9777 "Emergency Clinic & Medical Equipment Kit",
 * module MH01_Clinic_Floor_Module_2m. The GLB itself is not shipped (no licence file in the
 * kit zip); its layout and material factors were read from the GLB and are reproduced here:
 *  - Floor_Base   2.00 m square, MAT_CREAM  (linear 0.54,0.58,0.55; rough 0.48)
 *  - Floor_Inset  1.78 m square, MAT_WHITE  (linear 0.78,0.82,0.80; rough 0.36)
 *  - edge strips centred 0.90 m from tile centre, 1.86 m long:
 *      ±X sides 6.0 cm MAT_TEAL (0.02,0.42,0.38), ±Z sides 5.5 cm MAT_TEAL_DARK (0.018,0.15,0.15)
 * One canvas tile = one 2 m module; UVs are world-aligned so modules line up across rooms.
 */
import * as THREE from 'three';

/** Module drawn at 0.8 m (user choice: 60% smaller than the kit's 2 m); pattern scales with it. */
export const MH01_TILE_CM = 80;
const KIT_CM = 200; // pattern is authored in the kit's 2 m module units
const lin = (r: number, g: number, b: number) => '#' + new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace).getHexString(THREE.SRGBColorSpace);
export const MH01 = {
  cream: lin(0.54, 0.58, 0.55),
  white: lin(0.78, 0.82, 0.8),
  // Kit strips are teal (#27ada6 / #246c6c); recoloured to light blue-grey accents per user.
  teal: '#c4ced7',
  tealDark: '#b3c0cb', // lightened outline (was #7f93a6, read too dark)
};

let tex: THREE.CanvasTexture | null = null;
export function mh01Texture(): THREE.CanvasTexture {
  if (tex) return tex;
  const S = 1024, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d')!; const px = (cm: number) => (cm / KIT_CM) * S;
  g.fillStyle = MH01.cream; g.fillRect(0, 0, S, S);
  g.fillStyle = MH01.white; g.fillRect(px(11), px(11), S - 2 * px(11), S - 2 * px(11));
  // strips: centre 10 cm from the tile edge, 186 cm long (7 cm short of each corner)
  g.fillStyle = MH01.teal; // ±X (left/right)
  g.fillRect(px(10 - 3), px(7), px(6), px(186)); g.fillRect(S - px(10 + 3), px(7), px(6), px(186));
  g.fillStyle = MH01.tealDark; // ±Z (top/bottom)
  g.fillRect(px(7), px(10 - 2.75), px(186), px(5.5)); g.fillRect(px(7), S - px(10 + 2.75), px(186), px(5.5));
  tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  return tex;
}

/** Material for a room floor in the nav preview; caller sets UVs with mh01WorldUv. */
export function createClinicFloorMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ map: mh01Texture(), roughness: 0.4, metalness: 0.02 });
  m.userData.clinicFloor = true; // shared map: not owned by the mesh
  return m;
}

/** Plan-space (cm) shape coords -> world-aligned 2 m module UVs. */
export function mh01WorldUv(geo: THREE.BufferGeometry) {
  const pos = geo.getAttribute('position'), uv = geo.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) / MH01_TILE_CM, pos.getY(i) / MH01_TILE_CM);
  uv.needsUpdate = true;
}

// ---------- Homogeneous PVC sheet (default nav floor) ----------
/**
 * Hospital homogeneous ("同质透心") PVC sheet: seamless, cool grey-white base with fine multi-tone
 * flecks, low-gloss satin sheen. Generated procedurally (seeded noise, no third-party asset), one
 * 100 cm repeat with a separate roughness map (flecks slightly matter, soft mottling) and a very
 * shallow normal map (micro orange-peel) so highlights break up like a real vinyl surface.
 */
export const PVC_TILE_CM = 100;
let pvcMaps: { map: THREE.CanvasTexture; rough: THREE.CanvasTexture; normal: THREE.CanvasTexture } | null = null;
function rng(seed: number) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296); }
function pvcTextures() {
  if (pvcMaps) return pvcMaps;
  const S = 1024, r = rng(20261016);
  // tileable value noise (mottling)
  const N = 32, grid = Array.from({ length: N * N }, () => r());
  const vn = (x: number, y: number) => {
    const gx = (x / S) * N, gy = (y / S) * N, x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
    const g = (i: number, j: number) => grid[((j + N) % N) * N + ((i + N) % N)];
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    return (g(x0, y0) * (1 - sx) + g(x0 + 1, y0) * sx) * (1 - sy) + (g(x0, y0 + 1) * (1 - sx) + g(x0 + 1, y0 + 1) * sx) * sy;
  };
  const mk = () => { const c = document.createElement('canvas'); c.width = c.height = S; return c; };
  const cA = mk(), cR = mk(), cN = mk();
  const a = cA.getContext('2d')!, ro = cR.getContext('2d')!, no = cN.getContext('2d')!;
  const img = a.createImageData(S, S), rimg = ro.createImageData(S, S), height = new Float32Array(S * S);
  const base = [214, 219, 222]; // cool grey-white, a touch of blue
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const m = vn(x, y) * 0.6 + vn(x * 3.1, y * 3.1) * 0.4; // soft mottling
    const fine = (r() - 0.5) * 5;
    const k = (y * S + x) * 4, d = (m - 0.5) * 10 + fine;
    img.data[k] = base[0] + d; img.data[k + 1] = base[1] + d; img.data[k + 2] = base[2] + d * 0.9; img.data[k + 3] = 255;
    const rv = 150 + (m - 0.5) * 30 + (r() - 0.5) * 10; // ~0.59 roughness, mottled
    rimg.data[k] = rimg.data[k + 1] = rimg.data[k + 2] = rv; rimg.data[k + 3] = 255;
    height[y * S + x] = vn(x * 9, y * 9) * 0.7 + r() * 0.3;
  }
  // flecks: mostly 1-3 px chips in light/mid greys, some blue-grey, a few darker and white
  const palette: [number, number, number, number][] = [ // r,g,b,weight
    [184, 190, 196, 5], [160, 168, 176, 3], [236, 239, 241, 4], [132, 142, 152, 1.5], [150, 165, 182, 1.5], [104, 110, 118, 0.6], [196, 192, 186, 0.8],
  ];
  const wsum = palette.reduce((s, p) => s + p[3], 0);
  const flecks = 26000;
  for (let i = 0; i < flecks; i++) {
    let w = r() * wsum, p = palette[0];
    for (const q of palette) { if ((w -= q[3]) <= 0) { p = q; break; } }
    const cx = r() * S, cy = r() * S, rad = 0.6 + r() * r() * 2.4, ang = r() * Math.PI, el = 0.45 + r() * 0.55;
    const R = Math.ceil(rad) + 1;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const u = dx * Math.cos(ang) + dy * Math.sin(ang), v = (-dx * Math.sin(ang) + dy * Math.cos(ang)) / el;
      const cov = Math.max(0, Math.min(1, rad + 0.5 - Math.hypot(u, v)));
      if (cov <= 0) continue;
      const X = ((Math.floor(cx) + dx) % S + S) % S, Y = ((Math.floor(cy) + dy) % S + S) % S, k = (Y * S + X) * 4;
      for (let c = 0; c < 3; c++) img.data[k + c] = img.data[k + c] * (1 - cov) + p[c] * cov;
      rimg.data[k] = rimg.data[k + 1] = rimg.data[k + 2] = rimg.data[k] * (1 - cov) + 172 * cov; // chips a bit matter
    }
  }
  a.putImageData(img, 0, 0); ro.putImageData(rimg, 0, 0);
  const nimg = no.createImageData(S, S), at = (x: number, y: number) => height[((y + S) % S) * S + ((x + S) % S)];
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * 0.6, dy = (at(x, y + 1) - at(x, y - 1)) * 0.6;
    const l = Math.hypot(dx, dy, 1), k = (y * S + x) * 4;
    nimg.data[k] = (-dx / l * 0.5 + 0.5) * 255; nimg.data[k + 1] = (-dy / l * 0.5 + 0.5) * 255; nimg.data[k + 2] = (1 / l * 0.5 + 0.5) * 255; nimg.data[k + 3] = 255;
  }
  no.putImageData(nimg, 0, 0);
  const tex = (c: HTMLCanvasElement, srgb: boolean) => { const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t; };
  pvcMaps = { map: tex(cA, true), rough: tex(cR, false), normal: tex(cN, false) };
  return pvcMaps;
}



export function createPvcFloorMaterial(): THREE.MeshStandardMaterial {
  const t = pvcTextures();
  const m = new THREE.MeshStandardMaterial({ map: t.map, roughnessMap: t.rough, normalMap: t.normal, roughness: 1, metalness: 0, envMapIntensity: 0.6 });
  m.normalScale.set(0.12, 0.12);
  m.userData.clinicFloor = true;
  return m;
}

/** Plan-space shape coords -> world-aligned UVs for the selected nav floor. */
export function navFloorUv(geo: THREE.BufferGeometry) {
  const st = navFloorStyle(), tile = st === 'grid' ? MH01_TILE_CM : st === 'stone' ? STONE_TILE_CM * 2 : PVC_TILE_CM;
  const pos = geo.getAttribute('position'), uv = geo.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) / tile, pos.getY(i) / tile);
  uv.needsUpdate = true;
}
export function createNavFloorMaterial(): THREE.MeshStandardMaterial {
  const st = navFloorStyle();
  return st === 'grid' ? createClinicFloorMaterial() : st === 'stone' ? createStoneFloorMaterial() : createPvcFloorMaterial();
}

// ---------- Large-format light stone (?floorFinish=stone) ----------
/**
 * Polished light grey-white stone / marble-look porcelain, 120 cm squares with ~2 mm grout.
 * Procedural (seeded fbm + domain-warped veins, no third-party asset). One texture holds a
 * 2x2 block of differently veined tiles (240 cm repeat) so neighbours never look identical.
 * Mild sheen only (roughness ~0.3, low env) - no mirror reflections.
 */
export const STONE_TILE_CM = 120;
let stoneMaps: { map: THREE.CanvasTexture; rough: THREE.CanvasTexture } | null = null;
function stoneTextures() {
  if (stoneMaps) return stoneMaps;
  const S = 2048, r = rng(7151016), half = S / 2;
  const N = 64, grid = Array.from({ length: N * N }, () => r());
  const vn = (x: number, y: number) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const g = (i: number, j: number) => grid[(((j % N) + N) % N) * N + (((i % N) + N) % N)];
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    return (g(x0, y0) * (1 - sx) + g(x0 + 1, y0) * sx) * (1 - sy) + (g(x0, y0 + 1) * (1 - sx) + g(x0 + 1, y0 + 1) * sx) * sy;
  };
  const fbm = (x: number, y: number) => { let s = 0, a = 0.5, f = 1; for (let o = 0; o < 5; o++) { s += a * vn(x * f, y * f); a *= 0.5; f *= 2.03; } return s; };
  const mk = () => { const c = document.createElement('canvas'); c.width = c.height = S; return c; };
  const cA = mk(), cR = mk();
  const a = cA.getContext('2d')!, ro = cR.getContext('2d')!;
  const img = a.createImageData(S, S), rimg = ro.createImageData(S, S);
  const tiles = [0, 1, 2, 3].map(() => ({ ox: r() * 40, oy: r() * 40, ang: r() * Math.PI, tone: (r() - 0.5) * 5, freq: 2.2 + r() * 1.6 }));
  const grout = Math.max(1, Math.round((0.2 / STONE_TILE_CM) * half)); // ~2 mm
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const ti = (y < half ? 0 : 2) + (x < half ? 0 : 1), t = tiles[ti];
    const lx = (x % half) / half, ly = (y % half) / half;
    const ca = Math.cos(t.ang), sa = Math.sin(t.ang);
    const u = (lx * ca - ly * sa) * 4 + t.ox, v = (lx * sa + ly * ca) * 4 + t.oy;
    const w = fbm(u * 0.8, v * 0.8);
    const vein = Math.pow(1 - Math.abs(Math.sin((u + w * 3.2) * t.freq)), 18) * fbm(u * 1.7 + 9, v * 1.7);   // thin soft veins
    const cloud = fbm(u * 1.3 + 3, v * 1.3 + 7);
    const k = (y * S + x) * 4;
    let L = 236 + t.tone + (cloud - 0.5) * 9 - vein * 34;
    const edge = x % half < grout || y % half < grout;
    if (edge) L = 196;
    img.data[k] = L - 1; img.data[k + 1] = L + 0.5; img.data[k + 2] = L + 2; img.data[k + 3] = 255; // faint cool cast
    const rv = edge ? 200 : 72 + (cloud - 0.5) * 20 + vein * 25; // ~0.28 polished, grout matte
    rimg.data[k] = rimg.data[k + 1] = rimg.data[k + 2] = rv; rimg.data[k + 3] = 255;
  }
  a.putImageData(img, 0, 0); ro.putImageData(rimg, 0, 0);
  const tex = (c: HTMLCanvasElement, srgb: boolean) => { const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t; };
  stoneMaps = { map: tex(cA, true), rough: tex(cR, false) };
  return stoneMaps;
}
export function createStoneFloorMaterial(): THREE.MeshStandardMaterial {
  const t = stoneTextures();
  const m = new THREE.MeshStandardMaterial({ map: t.map, roughnessMap: t.rough, roughness: 1, metalness: 0, envMapIntensity: 0.5 });
  m.userData.clinicFloor = true;
  return m;
}

/** Nav floor finish: 'pvc' (default, homogeneous PVC sheet), 'stone' (?floorFinish=stone), 'grid' (kit MH01 0.8 m, ?floorFinish=grid). */
export function navFloorStyle(): 'pvc' | 'grid' | 'stone' {
  if (typeof location === 'undefined') return 'pvc';
  const f = new URLSearchParams(location.search).get('floorFinish');
  return f === 'grid' || f === 'stone' ? f : 'pvc';
}

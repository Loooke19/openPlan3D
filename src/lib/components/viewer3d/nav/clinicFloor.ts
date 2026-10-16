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

export const MH01_TILE_CM = 200;
const lin = (r: number, g: number, b: number) => '#' + new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace).getHexString(THREE.SRGBColorSpace);
export const MH01 = {
  cream: lin(0.54, 0.58, 0.55),
  white: lin(0.78, 0.82, 0.8),
  teal: lin(0.02, 0.42, 0.38),
  tealDark: lin(0.018, 0.15, 0.15),
};

let tex: THREE.CanvasTexture | null = null;
export function mh01Texture(): THREE.CanvasTexture {
  if (tex) return tex;
  const S = 1024, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d')!; const px = (cm: number) => (cm / MH01_TILE_CM) * S;
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

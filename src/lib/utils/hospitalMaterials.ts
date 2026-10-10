/**
 * Hospital corridor materials ported from Maker preview/scene3d.js:
 * matte wall with grain + skirt + baseboard, tiled floor with grout.
 * Used as openPlan material presets (hospital-wall / hospital-floor).
 */
import * as THREE from 'three';

export const HOSPITAL_WALL_ID = 'hospital-wall';
export const HOSPITAL_FLOOR_ID = 'hospital-floor';
export const HOSPITAL_WALL_COLOR = '#e2e6e3';
export const HOSPITAL_FLOOR_COLOR = '#fbfcfa';

/** World-space cm (openPlan). Matches Maker skirt ratio ≈ 7/19 of wall height. */
const BASEBOARD_CM = 12;
const SKIRT_CM = 100;
const TILE_CM = 60;

export function isHospitalWallTexture(id: string | undefined | null): boolean {
  return id === HOSPITAL_WALL_ID;
}

export function isHospitalFloorTexture(id: string | undefined | null): boolean {
  return id === HOSPITAL_FLOOR_ID;
}

/**
 * Optional CC0 PBR detail (static/nav-textures, ambientCG Terrazzo009 / PaintedPlaster017 /
 * Plastic010). The nav preview turns it on; the editor never does. Maps are luminance detail
 * centred on mid-grey plus roughness, sampled in world space (cm) so long walls never stretch.
 */
type PbrSet = { detail: THREE.Texture; rough: THREE.Texture };
let pbr: { wall: PbrSet; wainscot: PbrSet; floor: PbrSet } | null = null;

export function enableHospitalPbr(base = '/nav-textures') {
  if (pbr || typeof document === 'undefined') return;
  const loader = new THREE.TextureLoader();
  const load = (name: string) => {
    const t = loader.load(`${base}/${name}.jpg`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.NoColorSpace;
    t.anisotropy = 4;
    return t;
  };
  const set = (k: string) => ({ detail: load(`${k}-detail`), rough: load(`${k}-rough`) });
  pbr = { wall: set('wall'), wainscot: set('wainscot'), floor: set('floor') };
}

export function createHospitalSurfaceMaterial(
  kind: 'wall' | 'floor',
  color: string,
  own?: (mat: THREE.MeshStandardMaterial) => THREE.MeshStandardMaterial,
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color || (kind === 'wall' ? HOSPITAL_WALL_COLOR : HOSPITAL_FLOOR_COLOR)),
    roughness: kind === 'wall' ? 0.88 : 0.65,
    metalness: 0,
  });
  const uniforms = {
    hospitalGrain: { value: 1 },
    hospitalTileSize: { value: TILE_CM },
    hospitalSkirt: { value: SKIRT_CM },
    hospitalBaseboard: { value: BASEBOARD_CM },
  };
  const usePbr = !!pbr;
  material.customProgramCacheKey = () => `openplan-hospital-${kind}-v1${usePbr ? '-pbr' : ''}`;
  if (usePbr && kind === 'floor') { material.roughness = 0.42; material.envMapIntensity = 1.1; }
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = 'varying vec3 hospitalPosition;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <worldpos_vertex>',
      `
        #include <worldpos_vertex>
        vec4 hospitalWorld = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          hospitalWorld = instanceMatrix * hospitalWorld;
        #endif
        hospitalPosition = (modelMatrix * hospitalWorld).xyz;
      `,
    );
    Object.assign(shader.uniforms ||= {}, uniforms);
    shader.fragmentShader =
      'varying vec3 hospitalPosition;\nuniform float hospitalGrain;\nuniform float hospitalTileSize;\nuniform float hospitalSkirt;\nuniform float hospitalBaseboard;\n' +
      shader.fragmentShader;
    const surface =
      kind === 'wall'
        ? `
        float grain = sin(hospitalPosition.x * 0.42 + hospitalPosition.z * 0.37) * sin(hospitalPosition.y * 0.51);
        diffuseColor.rgb *= 0.97 + grain * 0.025 * hospitalGrain;
        if (hospitalPosition.y < hospitalBaseboard) diffuseColor.rgb *= vec3(0.39, 0.47, 0.45);
        else if (hospitalPosition.y < hospitalSkirt) diffuseColor.rgb *= vec3(0.80, 0.88, 0.85);
        if (hospitalPosition.y > hospitalSkirt - 4.0 && hospitalPosition.y < hospitalSkirt + 3.0) diffuseColor.rgb *= vec3(0.54, 0.66, 0.59);
      `
        : `
        vec2 tile = hospitalPosition.xz / hospitalTileSize;
        vec2 edge = abs(fract(tile - 0.5) - 0.5);
        vec2 aa = max(fwidth(tile), vec2(0.001));
        vec2 seam = 1.0 - smoothstep(vec2(0.018), vec2(0.018) + aa, edge);
        float grout = max(seam.x, seam.y);
        float grain = sin(hospitalPosition.x * 0.31) * sin(hospitalPosition.z * 0.39);
        diffuseColor.rgb *= 1.0 - grout * 0.18 + grain * 0.012 * hospitalGrain;
      `;
    let pbrCode = '', roughCode = '';
    if (usePbr && pbr) {
      Object.assign(shader.uniforms, {
        pbrDetailA: { value: kind === 'wall' ? pbr.wall.detail : pbr.floor.detail },
        pbrRoughA: { value: kind === 'wall' ? pbr.wall.rough : pbr.floor.rough },
        pbrDetailB: { value: pbr.wainscot.detail },
        pbrRoughB: { value: pbr.wainscot.rough },
      });
      shader.fragmentShader = 'uniform sampler2D pbrDetailA, pbrRoughA, pbrDetailB, pbrRoughB;\n' + shader.fragmentShader;
      pbrCode = kind === 'wall'
        ? `
        vec3 pbrN = normalize(cross(dFdx(hospitalPosition), dFdy(hospitalPosition)));
        vec2 pbrUv = (abs(pbrN.x) > abs(pbrN.z) ? hospitalPosition.zy : hospitalPosition.xy);
        bool pbrLow = hospitalPosition.y < hospitalSkirt;
        float pbrD = pbrLow ? texture2D(pbrDetailB, pbrUv / 90.0).r : texture2D(pbrDetailA, pbrUv / 140.0).r;
        float pbrR = pbrLow ? texture2D(pbrRoughB, pbrUv / 90.0).r : texture2D(pbrRoughA, pbrUv / 140.0).r;
        diffuseColor.rgb *= 0.8 + pbrD * 0.4;
      `
        : `
        float pbrD = texture2D(pbrDetailA, hospitalPosition.xz / 160.0).r;
        float pbrR = texture2D(pbrRoughA, hospitalPosition.xz / 160.0).r;
        diffuseColor.rgb *= 0.84 + pbrD * 0.32;
      `;
      roughCode = 'roughnessFactor = clamp(roughnessFactor * (0.65 + pbrR * 0.7), 0.08, 1.0);';
    }
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      '#include <color_fragment>\n' + surface + pbrCode,
    );
    if (roughCode) shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + roughCode);
  };
  return own ? own(material) : material;
}

/** 2D / picker swatch: vertical wall bands. */
export function drawHospitalWallSwatch(cx: CanvasRenderingContext2D, size: number, color: string) {
  const base = color || HOSPITAL_WALL_COLOR;
  cx.fillStyle = base;
  cx.fillRect(0, 0, size, size);
  // y grows down on canvas; baseboard at bottom
  const baseH = size * 0.06;
  const skirtH = size * 0.36;
  cx.fillStyle = 'rgba(99,120,115,0.45)';
  cx.fillRect(0, size - baseH, size, baseH);
  cx.fillStyle = 'rgba(204,224,217,0.35)';
  cx.fillRect(0, size - skirtH, size, skirtH - baseH);
  cx.fillStyle = 'rgba(138,168,150,0.35)';
  cx.fillRect(0, size - skirtH - size * 0.02, size, size * 0.035);
  for (let i = 0; i < 400; i++) {
    const x = (i * 47) % size;
    const y = (i * 91) % size;
    const g = 0.97 + Math.sin(x * 0.4) * Math.sin(y * 0.5) * 0.025;
    cx.fillStyle = `rgba(0,0,0,${(1 - g) * 0.35})`;
    cx.fillRect(x, y, 1, 1);
  }
}

/** 2D / picker swatch: light tile with grout. */
export function drawHospitalFloorSwatch(cx: CanvasRenderingContext2D, size: number, color: string) {
  const base = color || HOSPITAL_FLOOR_COLOR;
  cx.fillStyle = base;
  cx.fillRect(0, 0, size, size);
  const tiles = 6;
  const step = size / tiles;
  cx.strokeStyle = 'rgba(120,120,118,0.28)';
  cx.lineWidth = Math.max(1, size * 0.012);
  for (let i = 0; i <= tiles; i++) {
    const p = i * step;
    cx.beginPath();
    cx.moveTo(p, 0);
    cx.lineTo(p, size);
    cx.stroke();
    cx.beginPath();
    cx.moveTo(0, p);
    cx.lineTo(size, p);
    cx.stroke();
  }
}

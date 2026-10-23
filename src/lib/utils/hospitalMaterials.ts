/**
 * Hospital corridor materials ported from Maker preview/scene3d.js:
 * matte wall with grain + skirt + baseboard, tiled floor with grout.
 * Used as openPlan material presets (hospital-wall / hospital-floor).
 */
import * as THREE from 'three';

export const HOSPITAL_WALL_ID = 'hospital-wall';
export const HOSPITAL_FLOOR_ID = 'hospital-floor';
export const HOSPITAL_WALL_COLOR = '#e2e6e3';
export const NAV_WALL_PAINT = '#e5eae7';
export const HOSPITAL_FLOOR_COLOR = '#fbfcfa';

/** Nav door leaf: cool blue-grey HPL / bakelite (matte), no wood grain. */
export const HOSPITAL_DOOR_LEAF_COLOR = '#d2d9e2';
/** Nav door frame / jamb: light grey in the same cool family (never dept green). */
export const HOSPITAL_DOOR_FRAME_COLOR = '#c4cad2';
/** Leaf edge / stile (slightly darker than face). */
export const HOSPITAL_DOOR_EDGE_COLOR = '#b0b7c0';

/** Shared nav door materials — one set for all buildings (not per-door / per-dept). */
export function createHospitalDoorLeafMaterial(
  own?: (mat: THREE.MeshStandardMaterial) => THREE.MeshStandardMaterial,
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(HOSPITAL_DOOR_LEAF_COLOR),
    roughness: 0.82,
    metalness: 0.02,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  return own ? own(material) : material;
}

export function createHospitalDoorEdgeMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(HOSPITAL_DOOR_EDGE_COLOR),
    roughness: 0.88,
    metalness: 0.02,
  });
}

export function createHospitalDoorFrameMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(HOSPITAL_DOOR_FRAME_COLOR),
    roughness: 0.72,
    metalness: 0.08,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    depthWrite: true,
  });
}

/** World-space cm (openPlan). Matches Maker skirt ratio ≈ 7/19 of wall height. */
const BASEBOARD_CM = 12;
const SKIRT_CM = 120; // 1.2 m wainscot (CN outpatient practice: 木纹抗菌板 lower, 鸽白 upper)
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
/** World Y of the floor being shown; materials measure wainscot height from it. */
export const hospitalFloorY = { value: 0 };

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
  const usePbr = !!pbr;
  if (usePbr && kind === 'wall') {
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0.78, 0.82, 0.8),
      roughness: 0.36,
      metalness: 0.03,
      side: THREE.DoubleSide,
    });
    return own ? own(material) : material;
  }
  const usePbrLook = usePbr;
  if (usePbr && (!color || color.toLowerCase() === HOSPITAL_FLOOR_COLOR) && kind === 'floor') color = '#e3dfd6';
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color || (kind === 'wall' ? HOSPITAL_WALL_COLOR : HOSPITAL_FLOOR_COLOR)),
    roughness: kind === 'wall' ? 0.88 : 0.65,
    metalness: 0,
  });
  const uniforms = {
    hospitalFloorY: hospitalFloorY,
    hospitalModern: { value: usePbrLook ? 1 : 0 },
    hospitalGrain: { value: 1 },
    hospitalTileSize: { value: TILE_CM },
    hospitalSkirt: { value: SKIRT_CM },
    hospitalBaseboard: { value: BASEBOARD_CM },
  };
  material.customProgramCacheKey = () => `openplan-hospital-${kind}-v5${usePbr ? '-pbr' : ''}`;
  if (usePbr && kind === 'floor') { material.roughness = 0.6; material.envMapIntensity = 0.7; } // low-gloss PVC
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
      'varying vec3 hospitalPosition;\nuniform float hospitalFloorY;\nuniform float hospitalModern;\nuniform float hospitalGrain;\nuniform float hospitalTileSize;\nuniform float hospitalSkirt;\nuniform float hospitalBaseboard;\n' +
      'float hospitalHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }\n' +
      'float hospitalNoise(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);\n' +
      '  return mix(mix(mix(hospitalHash(i), hospitalHash(i + vec3(1,0,0)), f.x), mix(hospitalHash(i + vec3(0,1,0)), hospitalHash(i + vec3(1,1,0)), f.x), f.y),\n' +
      '             mix(mix(hospitalHash(i + vec3(0,0,1)), hospitalHash(i + vec3(1,0,1)), f.x), mix(hospitalHash(i + vec3(0,1,1)), hospitalHash(i + vec3(1,1,1)), f.x), f.y), f.z); }\n' +
      shader.fragmentShader;
    const surface =
      kind === 'wall'
        ? `
        float hy = hospitalPosition.y - hospitalFloorY; // height above this floor (any storey)
        if (hospitalModern > 0.5) {
          // Nav look: flat clinic-kit wall finish (solid colour, no grain / mottle / texture).
          if (hy < hospitalBaseboard) diffuseColor.rgb = vec3(0.36, 0.36, 0.35);
          else if (hy < hospitalBaseboard + 0.8) diffuseColor.rgb *= 0.8; // skirting top shadow line
        } else {
          float grain = sin(hospitalPosition.x * 0.42 + hospitalPosition.z * 0.37) * sin(hospitalPosition.y * 0.51);
          diffuseColor.rgb *= 0.97 + grain * 0.025 * hospitalGrain;
          if (hy < hospitalBaseboard) diffuseColor.rgb *= vec3(0.39, 0.47, 0.45);
          else if (hy < hospitalSkirt) diffuseColor.rgb *= vec3(0.80, 0.88, 0.85);
          if (hy > hospitalSkirt - 4.0 && hy < hospitalSkirt + 3.0) diffuseColor.rgb *= vec3(0.54, 0.66, 0.59);
        }
      `
        : `
        vec2 tile = hospitalPosition.xz / hospitalTileSize;
        vec2 edge = abs(fract(tile - 0.5) - 0.5);
        vec2 aa = max(fwidth(tile), vec2(0.001));
        vec2 seam = 1.0 - smoothstep(vec2(0.018), vec2(0.018) + aa, edge);
        // Homogeneous PVC sheet (heat-welded): seams barely visible in the nav look.
        float grout = max(seam.x, seam.y) * (hospitalModern > 0.5 ? 0.25 : 1.0);
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
      // walls: no detail/roughness texture (that was the visible chequer); floors keep theirs
      pbrCode = kind === 'wall' ? '' : `
        float pbrD = texture2D(pbrDetailA, hospitalPosition.xz / 160.0).r;
        float pbrR = texture2D(pbrRoughA, hospitalPosition.xz / 160.0).r;
        diffuseColor.rgb *= 0.84 + pbrD * 0.32;
      `;
      if (kind !== 'wall') roughCode = 'roughnessFactor = clamp(roughnessFactor * (0.65 + pbrR * 0.7), 0.08, 1.0);';
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

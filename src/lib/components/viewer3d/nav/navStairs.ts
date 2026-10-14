/**
 * Nav first-person stair meshes from bundled Kenney GLBs (not the 15-clinic kit props).
 * Model run axis is +X; plan/Three run axis is +Z — see stairOrientation.STAIR_GLB_RUN_AXIS_YAW.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Stair } from '$lib/models/types';
import { normalizeStairFootprint, stairGlbYawRadians, STAIR_GLB_RUN_AXIS_YAW } from '$lib/utils/stairOrientation';
import { bakeVertexAo, KIT_PALETTE } from './kitDressing';

const loader = new GLTFLoader();
const cache = new Map<string, Promise<THREE.BufferGeometry | null>>();

function stairAsset(stair: Stair): string {
  const type = stair.stairType || 'straight';
  if (type === 'l-shaped' || type === 'u-shaped') return 'stairsCorner';
  if (type === 'spiral') return 'stairsOpen';
  return 'stairsOpenSingle';
}

async function loadStairGeometry(base: string, asset: string): Promise<THREE.BufferGeometry | null> {
  const key = `${base}/${asset}`;
  if (!cache.has(key)) {
    const prefix = base.replace(/\/$/, '');
    cache.set(key, fetch(`${prefix}/models/${asset}.glb`)
      .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))))
      .then(buf => loader.parseAsync(buf, ''))
      .then(gltf => {
        const parts: THREE.BufferGeometry[] = [];
        gltf.scene.updateMatrixWorld(true);
        gltf.scene.traverse(o => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          const geo = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
          geo.applyMatrix4(m.matrixWorld);
          parts.push(geo);
        });
        if (!parts.length) return null;
        const merged = mergeGeometries(parts, false)!;
        merged.computeBoundingBox();
        return merged;
      })
      .catch(() => null));
  }
  return cache.get(key)!;
}

function fitStairGeometry(geo: THREE.BufferGeometry, width: number, depth: number, height: number) {
  const bb = geo.boundingBox!;
  const size = bb.getSize(new THREE.Vector3());
  const sx = depth / size.x;
  const sy = height / size.y;
  const sz = width / size.z;
  geo.scale(sx, sy, sz);
  geo.computeBoundingBox();
  const b2 = geo.boundingBox!;
  const cx = (b2.min.x + b2.max.x) / 2;
  const cz = (b2.min.z + b2.max.z) / 2;
  geo.translate(-cx, -b2.min.y, -cz);
}

function stairMaterials() {
  const kitColor = new THREE.Color(KIT_PALETTE.MAT_WHITE);
  const neutral = (kitColor.r + kitColor.g + kitColor.b) / 3;
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(neutral, neutral, neutral), roughness: 0.55, metalness: 0, vertexColors: true });
  mat.vertexColors = true;
  const sideMat = new THREE.MeshStandardMaterial({ color: 0xc7c7c7, roughness: 0.55, metalness: 0, vertexColors: true });
  return [sideMat, sideMat, mat, sideMat, sideMat, sideMat];
}

export function addNavStair(
  parent: THREE.Group,
  stair: Stair,
  totalHeight: number,
  modelBase: string,
  onReady?: () => void,
): void {
  const norm = normalizeStairFootprint(stair);
  const asset = stairAsset(stair);
  const group = new THREE.Group();
  group.name = stair.id;
  group.position.set(stair.position.x, 0, stair.position.y);
  group.rotation.y = stairGlbYawRadians(stair);
  parent.add(group);

  void loadStairGeometry(modelBase, asset).then(geo => {
    if (!geo || !group.parent) return;
    fitStairGeometry(geo, norm.width, norm.depth, totalHeight);
    bakeVertexAo(geo, 0);
    const mesh = new THREE.Mesh(geo, stairMaterials());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    onReady?.();
  });
}

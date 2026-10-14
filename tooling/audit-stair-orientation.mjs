/**
 * List stairs whose legacy 3D run disagrees with the plan (typically width>depth → ~90° in nav).
 * Usage: IMPORT_API=http://127.0.0.1:8884 node tooling/audit-stair-orientation.mjs
 */
import { readFileSync } from 'node:fs';

const API = (process.env.IMPORT_API || 'http://127.0.0.1:8884').replace(/\/$/, '');
const PROJECTS = {
  P1: '6f538da2b53e4ee19ae6bf57e06d0ce1',
  P2: '4a87b204fb564d1689764b226ef99312',
  P3: 'cd830b42fc044d578b438687ace23369',
};

function planRun(stair) {
  let { width, depth, rotation } = stair;
  if (depth < width) {
    [width, depth] = [depth, width];
    rotation += 90;
  }
  const rad = (-rotation * Math.PI) / 180;
  const sign = stair.direction === 'down' ? -1 : 1;
  return { x: Math.sin(rad) * sign, y: -Math.cos(rad) * sign, width, depth };
}

function misaligned(stair) {
  if ((stair.stairType || 'straight') !== 'straight') return false;
  return stair.width > stair.depth + 0.5;
}

async function loadProject(id) {
  const res = await fetch(`${API}/api/projects/${id}.json`);
  if (!res.ok) throw new Error(`${id}: HTTP ${res.status}`);
  return res.json();
}

async function auditLabel(label, id) {
  const doc = await loadProject(id);
  const affected = [];
  for (const floor of doc.floors || []) {
    for (const stair of floor.stairs || []) {
      if (!misaligned(stair)) continue;
      const run = planRun(stair);
      affected.push({
        floorId: floor.id,
        floorName: floor.name,
        stairId: stair.id,
        width: stair.width,
        depth: stair.depth,
        rotation: stair.rotation,
        direction: stair.direction,
        stairType: stair.stairType || 'straight',
        position: stair.position,
        planRun: run,
      });
    }
  }
  return { label, projectId: id, affected };
}

const localFixture = process.env.FIXTURE;
if (localFixture) {
  const doc = JSON.parse(readFileSync(localFixture, 'utf8'));
  const out = [];
  for (const floor of doc.floors || []) {
    for (const stair of floor.stairs || []) {
      if (misaligned(stair)) out.push({ floor: floor.name, stair });
    }
  }
  console.log(JSON.stringify({ fixture: localFixture, affected: out }, null, 2));
  process.exit(0);
}

const results = [];
for (const [label, id] of Object.entries(PROJECTS)) {
  try {
    results.push(await auditLabel(label, id));
  } catch (e) {
    results.push({ label, projectId: id, error: String(e), affected: [] });
  }
}
console.log(JSON.stringify(results, null, 2));

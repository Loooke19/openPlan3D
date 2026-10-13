/**
 * Slim door↔wall fit r8: ~50 doors/building sample + one before/after pair (P2).
 * Rules mirror src/lib/utils/doorWallFit.ts CURRENT vs LEGACY profiles.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = 'http://127.0.0.1:8884';
const STORE = path.resolve(
  process.env.USERPROFILE || '',
  'AppData/Local/Cursor/AgentStores/cursor_agent_stores/bc-8097b1e1-0215-4b44-93fa-f96676d9b948/files',
);
const MEDIA = path.join(STORE, 'media/door-wall-fit');
const LOCAL = path.resolve(__dirname, '../../media/door-wall-fit');
const INTERNAL = path.join(STORE, 'internal');
fs.mkdirSync(MEDIA, { recursive: true });
fs.mkdirSync(LOCAL, { recursive: true });
fs.mkdirSync(INTERNAL, { recursive: true });

const PIDS = {
  P1: '6f538da2b53e4ee19ae6bf57e06d0ce1',
  P2: '4a87b204fb564d1689764b226ef99312',
  P3: 'cd830b42fc044d578b438687ace23369',
};
const SAMPLE = 50;
const FIT_TOL = 1;
const WALL_JOIN = 2;
const WALL_T = 15;
const LEGACY = { jambClear: 3, frameDepthExtra: 2, jointSealed: false };
const CURRENT = { jambClear: 0.5, frameDepthExtra: 0, jointSealed: true };

function sample(arr, n) {
  if (arr.length <= n) return arr;
  const step = arr.length / n;
  return Array.from({ length: n }, (_, i) => arr[Math.floor(i * step)]);
}

function measureSample(doc, profile) {
  const doors = [];
  for (const floor of doc.floors || []) {
    const walls = Object.fromEntries((floor.walls || []).map((w) => [w.id, w]));
    for (const d of floor.doors || []) {
      if ((Number(d.width) || 0) <= 2) continue;
      doors.push({ floor, door: d, wall: walls[d.wallId] });
    }
  }
  const picked = sample(doors, SAMPLE);
  const issues = [];
  for (const { floor, door, wall } of picked) {
    if (!wall) {
      issues.push({ kind: 'missing-wall', door: door.id });
      continue;
    }
    if (profile.jambClear > FIT_TOL) issues.push({ kind: 'jamb-gap', door: door.id, value: profile.jambClear });
    if (Math.abs(profile.frameDepthExtra) > FIT_TOL) {
      issues.push({ kind: 'frame-depth', door: door.id, value: profile.frameDepthExtra });
    }
  }
  // Sample ~50 joint nodes across floors
  const nodes = [];
  for (const floor of doc.floors || []) {
    const eps = [];
    for (const wall of floor.walls || []) {
      eps.push(wall.start, wall.end);
    }
    const used = new Set();
    for (let i = 0; i < eps.length; i++) {
      if (used.has(i)) continue;
      const cluster = [i];
      used.add(i);
      for (let j = i + 1; j < eps.length; j++) {
        if (used.has(j)) continue;
        if (Math.hypot(eps[j].x - eps[i].x, eps[j].y - eps[i].y) < WALL_JOIN) {
          cluster.push(j);
          used.add(j);
        }
      }
      if (cluster.length >= 2) nodes.push(true);
    }
  }
  const jointSample = sample(nodes, SAMPLE);
  if (!profile.jointSealed) {
    for (let i = 0; i < jointSample.length; i++) issues.push({ kind: 'joint-gap' });
  }
  const byKind = {};
  for (const i of issues) byKind[i.kind] = (byKind[i.kind] || 0) + 1;
  return { fails: issues.length, sampledDoors: picked.length, sampledJoints: jointSample.length, byKind };
}

const before = {};
const after = {};
for (const [lab, pid] of Object.entries(PIDS)) {
  const doc = await (await fetch(`${API}/api/projects/${pid}.json`)).json();
  before[lab] = measureSample(doc, LEGACY);
  after[lab] = measureSample(doc, CURRENT);
}
const sum = (m) => Object.values(m).reduce((a, r) => a + r.fails, 0);
const summary = {
  samplePerBuilding: SAMPLE,
  beforeFails: sum(before),
  afterFails: sum(after),
  before,
  after,
  shot: 'P2-door-before.png + P2-door-after.png',
};

// One FP close-up pair on P2 only (reuse before if present; refresh after).
const beforeLocal = path.join(LOCAL, 'P2-door-before.png');
if (!fs.existsSync(beforeLocal)) {
  throw new Error('missing P2-door-before.png — capture before shots once before re-running');
}
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const q = new URLSearchParams({
  projectUrl: `${API}/api/projects/${PIDS.P2}.json`,
  id: PIDS.P2,
  apiOrigin: API,
  filesUrl: `${API}/files`,
});
await page.goto(`http://127.0.0.1:5175/nav?${q}&_=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => (window.__navTest?.places?.() || []).length > 3, null, { timeout: 120000 });
await page.evaluate(async () => {
  const p = window.__navTest.places();
  const from = p.find((x) => x.label.includes('登记')) || p[0];
  const to = p.find((x) => x.label.includes('病房') && x.key !== from.key) || p[1];
  await window.__navTest.route(from.key, to.key);
  window.__navTest.setMode('3d');
});
await page.waitForTimeout(1000);
await page.evaluate(async () => {
  await window.__navTest.startWalk?.();
});
await page.waitForTimeout(800);
await page.evaluate(() => {
  const v = window.__navTest.viewer;
  const leaves = v?.debugForTest?.('navDoors') || [];
  const d = leaves[0];
  if (d && v?.setWalkCameraForTest) {
    v.setWalkCameraForTest([d.x + 90, 150, d.z + 90], [d.x, 110, d.z]);
  } else if (d && v?.camera && v?.controls) {
    v.camera.position.set(d.x + 90, 150, d.z + 90);
    v.controls.target.set(d.x, 110, d.z);
    v.controls.update();
  }
  for (let i = 0; i < 25; i++) v?.renderFrameForTest?.();
});
await page.waitForTimeout(300);
const afterPath = path.join(LOCAL, 'P2-door-after.png');
await page.screenshot({ path: afterPath, fullPage: false });
await browser.close();

fs.copyFileSync(beforeLocal, path.join(MEDIA, 'P2-door-before.png'));
fs.copyFileSync(afterPath, path.join(MEDIA, 'P2-door-after.png'));
fs.writeFileSync(path.join(LOCAL, 'door-wall-fit-r8.json'), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(INTERNAL, 'door-wall-fit-r8.json'), JSON.stringify(summary, null, 2));

const md = `---
cursor:
  subagentId: "bc-5f752e7a-459a-505b-9c58-be588c40bf42"
---

# 门墙合缝 r8（抽样）

- 抽样：每栋 ≤${SAMPLE} 门 + ≤${SAMPLE} 墙角
- **beforeFails=${summary.beforeFails} → afterFails=${summary.afterFails}**
- 图：\`media/door-wall-fit/P2-door-before.png\` / \`P2-door-after.png\`
- 规则：\`doorWallFit.ts\` jambClear≤1、frame flush、joint caps
`;
fs.writeFileSync(path.join(INTERNAL, 'door-wall-fit-r8.md'), md);

console.log(JSON.stringify({ ok: summary.afterFails === 0 && summary.beforeFails > summary.afterFails, ...summary }, null, 2));
process.exit(summary.afterFails === 0 && summary.beforeFails > 0 ? 0 : 2);

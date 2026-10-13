/**
 * 6 door close-ups (2 per building) before/after — same orbit pose; door frame + wall junction visible.
 * before = ?fitLegacy=1 (jambClear=3, frameDepthExtra=2, no joint caps)
 * after  = current flush fit
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = 'http://127.0.0.1:8884';
const LOCAL = path.resolve(__dirname, '../../media/door-wall-fit');
const STORE = path.resolve(
  process.env.USERPROFILE || '',
  'AppData/Local/Cursor/AgentStores/cursor_agent_stores/bc-8097b1e1-0215-4b44-93fa-f96676d9b948/files/media/door-wall-fit',
);
fs.mkdirSync(LOCAL, { recursive: true });
fs.mkdirSync(STORE, { recursive: true });

const BUILDINGS = [
  {
    label: 'P1',
    pid: '6f538da2b53e4ee19ae6bf57e06d0ce1',
    // Prefer named clinic doors on 1F
    doorIds: null, // filled from API: first two doors with width>=80 on floor-0
  },
  { label: 'P2', pid: '4a87b204fb564d1689764b226ef99312', doorIds: null },
  { label: 'P3', pid: 'cd830b42fc044d578b438687ace23369', doorIds: null },
];

function doorPose(floor, door) {
  const wall = floor.walls.find((w) => w.id === door.wallId);
  if (!wall) return null;
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;
  const t = door.position ?? 0.5;
  const cx = wall.start.x + ux * t * len;
  const cy = wall.start.y + uy * t * len;
  // Prefer corridor side: pick normal pointing toward map origin-ish / denser open space
  // Use +normal first; camera stands on that side looking at door.
  const dist = 160;
  const eyeY = 145;
  const lookY = 115;
  return {
    id: door.id,
    cx,
    cy,
    // Camera on +normal side of wall
    cam: [cx + nx * dist, eyeY, cy + ny * dist],
    look: [cx, lookY, cy],
    // Alternate if first is inside a room (shot script may flip)
    camAlt: [cx - nx * dist, eyeY, cy - ny * dist],
  };
}

async function pickDoors(pid) {
  const doc = await (await fetch(`${API}/api/projects/${pid}.json`)).json();
  const floor = doc.floors.find((f) => f.id === 'floor-0') || doc.floors[0];
  const doors = (floor.doors || [])
    .filter((d) => (d.width || 0) >= 70 && d.wallId)
    .slice(0, 12);
  const poses = [];
  for (const d of doors) {
    const p = doorPose(floor, d);
    if (p) poses.push(p);
    if (poses.length >= 2) break;
  }
  if (poses.length < 2) throw new Error(`${pid}: need 2 doors, got ${poses.length}`);
  return poses;
}

const browser = await chromium.launch({ headless: true });
const results = [];

for (const b of BUILDINGS) {
  const poses = await pickDoors(b.pid);
  for (let i = 0; i < 2; i++) {
    const pose = poses[i];
    const doorNum = i + 1;
    for (const tag of ['before', 'after']) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const qs = new URLSearchParams({
        projectUrl: `${API}/api/projects/${b.pid}.json`,
        id: b.pid,
        apiOrigin: API,
        filesUrl: `${API}/files`,
        _: String(Date.now()),
      });
      if (tag === 'before') qs.set('fitLegacy', '1');
      await page.goto(`http://127.0.0.1:5175/nav?${qs}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForFunction(() => (window.__navTest?.places?.() || []).length > 2, null, {
        timeout: 120000,
      });
      // Stay in orbit 3D — do NOT enter walk (camera into wall).
      await page.evaluate(async () => {
        window.__navTest.setMode('3d');
      });
      await page.waitForTimeout(1500);

      const used = await page.evaluate((p) => {
        const v = window.__navTest.viewer;
        const tryPose = (cam, look) => {
          v.setOrbitPoseForTest?.(cam, look);
          for (let k = 0; k < 35; k++) v.renderFrameForTest?.();
        };
        tryPose(p.cam, p.look);
        // If we somehow got black/inside wall, flip to alternate side.
        const mid = (() => {
          const c = document.querySelector('[data-plan3d-canvas="true"]') || document.querySelector('canvas');
          if (!c) return 0;
          const t = document.createElement('canvas');
          t.width = 64;
          t.height = 64;
          const ctx = t.getContext('2d');
          ctx.drawImage(c, 0, 0, 64, 64);
          const d = ctx.getImageData(28, 28, 8, 8).data;
          let s = 0;
          for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
          return s / (64 * 3);
        })();
        if (mid < 40) {
          tryPose(p.camAlt, p.look);
          return 'alt';
        }
        return 'main';
      }, pose);
      await page.waitForTimeout(200);

      const file = `${b.label}-door${doorNum}-${tag}.png`;
      const out = path.join(LOCAL, file);
      await page.screenshot({ path: out, fullPage: false });
      fs.copyFileSync(out, path.join(STORE, file));
      results.push({ file, door: pose.id, side: used, tag });
      console.log('shot', file, pose.id, used);
      await page.close();
    }
  }
}

await browser.close();
fs.writeFileSync(path.join(LOCAL, 'shots-manifest.json'), JSON.stringify(results, null, 2));
fs.copyFileSync(path.join(LOCAL, 'shots-manifest.json'), path.join(STORE, 'shots-manifest.json'));
console.log(JSON.stringify({ ok: results.length === 12, count: results.length, results }, null, 2));

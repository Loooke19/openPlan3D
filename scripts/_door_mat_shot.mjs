/**
 * One P1-door1 closeup for hospital door materials (after).
 * Before = previous wood+green shot copied into look-quality/.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = 'http://127.0.0.1:8884';
const P1 = '6f538da2b53e4ee19ae6bf57e06d0ce1';
const LOCAL = path.resolve(__dirname, '../../media/look-quality');
const DOOR_FIT = path.resolve(__dirname, '../../media/door-wall-fit');
const STORE = path.resolve(
  process.env.USERPROFILE || '',
  'AppData/Local/Cursor/AgentStores/cursor_agent_stores/bc-8097b1e1-0215-4b44-93fa-f96676d9b948/files/media/look-quality',
);
fs.mkdirSync(LOCAL, { recursive: true });
fs.mkdirSync(STORE, { recursive: true });

// Before: wood leaf + green frame from prior door-wall fit capture
const beforeSrc = path.join(DOOR_FIT, 'P1-door1-after.png');
const beforeName = 'before-p1-door1.png';
if (fs.existsSync(beforeSrc)) {
  fs.copyFileSync(beforeSrc, path.join(LOCAL, beforeName));
  fs.copyFileSync(beforeSrc, path.join(STORE, beforeName));
}

const doc = await (await fetch(`${API}/api/projects/${P1}.json`)).json();
const floor = doc.floors.find((f) => f.id === 'floor-0') || doc.floors[0];
const door = (floor.doors || []).find((d) => (d.width || 0) >= 70 && d.wallId) || floor.doors?.[0];
const wall = floor.walls.find((w) => w.id === door.wallId);
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
const dist = 160;
const cam = [cx + nx * dist, 145, cy + ny * dist];
const look = [cx, 115, cy];
const camAlt = [cx - nx * dist, 145, cy - ny * dist];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const qs = new URLSearchParams({
  projectUrl: `${API}/api/projects/${P1}.json`,
  id: P1,
  apiOrigin: API,
  filesUrl: `${API}/files`,
  _: String(Date.now()),
});
await page.goto(`http://127.0.0.1:5175/nav?${qs}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => (window.__navTest?.places?.() || []).length > 2, null, { timeout: 120000 });
await page.evaluate(() => window.__navTest.setMode('3d'));
await page.waitForTimeout(1500);
await page.evaluate(
  ({ cam, look, camAlt }) => {
    const v = window.__navTest.viewer;
    const tryPose = (c, l) => {
      v.setOrbitPoseForTest?.(c, l);
      for (let k = 0; k < 40; k++) v.renderFrameForTest?.();
    };
    tryPose(cam, look);
    const cnv = document.querySelector('[data-plan3d-canvas="true"]') || document.querySelector('canvas');
    if (!cnv) return;
    const t = document.createElement('canvas');
    t.width = 64;
    t.height = 64;
    const ctx = t.getContext('2d');
    ctx.drawImage(cnv, 0, 0, 64, 64);
    const d = ctx.getImageData(28, 28, 8, 8).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
    if (s / (64 * 3) < 40) tryPose(camAlt, look);
  },
  { cam, look, camAlt },
);
await page.waitForTimeout(300);
const afterName = 'after-p1-door1.png';
await page.screenshot({ path: path.join(LOCAL, afterName), fullPage: false });
fs.copyFileSync(path.join(LOCAL, afterName), path.join(STORE, afterName));
await browser.close();
console.log(JSON.stringify({ before: beforeName, after: afterName, door: door.id }, null, 2));

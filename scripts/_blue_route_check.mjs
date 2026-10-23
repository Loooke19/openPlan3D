import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const API = 'http://127.0.0.1:8884';
const P2 = '4a87b204fb564d1689764b226ef99312';
const q = new URLSearchParams({
  projectUrl: `${API}/api/projects/${P2}.json`,
  id: P2,
  apiOrigin: API,
  filesUrl: `${API}/files`,
});
const STORE = path.resolve(
  process.env.USERPROFILE || '',
  'AppData/Local/Cursor/AgentStores/cursor_agent_stores/bc-8097b1e1-0215-4b44-93fa-f96676d9b948/files/media/nav-four-fixes',
);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
let errs = 0;
page.on('pageerror', () => {
  errs += 1;
});

await page.goto(`http://127.0.0.1:5175/nav?${q}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => (window.__navTest?.places?.() || []).length > 5, null, { timeout: 120000 });
await page.evaluate(async () => {
  const p = window.__navTest.places();
  await window.__navTest.route(
    p.find((x) => x.label.startsWith('1楼') && x.label.includes('登记')).key,
    p.find((x) => x.label.startsWith('2楼') && x.label.includes('护士办公')).key,
  );
  window.__navTest.setMode('3d');
});
await page.waitForTimeout(3000);
await page.evaluate(() => {
  try {
    window.__navTest.viewer.nudgeOrbitForTest?.({ polar: 0.45, radiusScale: 1.2 });
  } catch {
    /* */
  }
});
await page.waitForTimeout(800);

const info = await page.evaluate(() => {
  const v = window.__navTest.viewer;
  const routes = v.debugForTest('routes');
  const shaders = v.debugForTest('shaders');
  const c = document.querySelector('[data-plan3d-canvas="true"]');
  const gl = c && (c.getContext('webgl2') || c.getContext('webgl'));
  let pixel = null;
  if (gl) {
    const buf = new Uint8Array(4);
    gl.readPixels((gl.drawingBufferWidth / 2) | 0, (gl.drawingBufferHeight / 2) | 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    pixel = [...buf];
  }
  return {
    kidsVis: (routes?.out || []).map((o) => ({ vis: o.vis, kids: o.kids })),
    usesPost: typeof v !== 'undefined' ? 'n/a' : null,
    pipeline: shaders.pipeline,
    pixel,
    bad: shaders.bad,
  };
});

const shot = path.resolve('../media/nav-four-fixes/blue-route-ok.png');
await page.screenshot({ path: shot });
fs.mkdirSync(STORE, { recursive: true });
fs.copyFileSync(shot, path.join(STORE, 'blue-route-ok.png'));
console.log(JSON.stringify({ errs, info }, null, 2));
await browser.close();
process.exit(errs < 5 && info.pixel && info.pixel[0] + info.pixel[1] + info.pixel[2] > 30 ? 0 : 2);

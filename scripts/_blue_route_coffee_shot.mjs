import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = 'http://127.0.0.1:8884';
const P2 = '4a87b204fb564d1689764b226ef99312';
const q = new URLSearchParams({
  projectUrl: `${API}/api/projects/${P2}.json`,
  id: P2,
  apiOrigin: API,
  filesUrl: `${API}/files`,
});
const MEDIA = path.resolve(__dirname, '../../media/nav-four-fixes');
const STORE = path.resolve(
  process.env.USERPROFILE || '',
  'AppData/Local/Cursor/AgentStores/cursor_agent_stores/bc-8097b1e1-0215-4b44-93fa-f96676d9b948/files/media/nav-four-fixes',
);
fs.mkdirSync(MEDIA, { recursive: true });
fs.mkdirSync(STORE, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push((e.stack || String(e)).split('\n')[0]));

await page.goto(`http://127.0.0.1:5175/nav?${q}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => (window.__navTest?.places?.() || []).length > 5, null, { timeout: 180000 });
await page.evaluate(async () => {
  const p = window.__navTest.places();
  await window.__navTest.route(
    p.find((x) => x.label.startsWith('1楼') && x.label.includes('登记')).key,
    p.find((x) => x.label.startsWith('2楼') && x.label.includes('护士办公')).key,
  );
  window.__navTest.setMode('3d');
});
await page.waitForTimeout(4500);
await page.evaluate(() => {
  try {
    window.__navTest.viewer.nudgeOrbitForTest?.({ polar: 0.55, radiusScale: 1.05 });
  } catch {
    /* */
  }
});
await page.waitForTimeout(1200);

const info = await page.evaluate(() => {
  const v = window.__navTest.viewer;
  const shaders = v.debugForTest?.('shaders') || {};
  const routes = v.debugForTest?.('routes') || {};
  const c = document.querySelector('[data-plan3d-canvas="true"]');
  let mid = null;
  if (c) {
    const tmp = document.createElement('canvas');
    tmp.width = c.width;
    tmp.height = c.height;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const x = (tmp.width / 2) | 0;
    const y = (tmp.height / 2) | 0;
    const d = ctx.getImageData(x, y, 1, 1).data;
    mid = [d[0], d[1], d[2], d[3]];
  }
  return {
    pipeline: shaders?.pipeline,
    quality: shaders?.quality,
    bad: shaders?.bad || [],
    kids: (routes?.out || []).slice(0, 3),
    mid,
    black: mid && mid[0] + mid[1] + mid[2] < 12,
  };
});

const shot = path.join(MEDIA, 'blue-route-coffee-restored.png');
await page.screenshot({ path: shot, fullPage: false });
fs.copyFileSync(shot, path.join(STORE, 'blue-route-coffee-restored.png'));

await page.getByRole('button', { name: '第一人称', exact: true }).click();
await page.waitForTimeout(2000);
const fp = await page.evaluate(() => ({ walking: !!window.__navTest.viewer?.isNavWalking?.() }));

console.log(JSON.stringify({ errs: errs.length, unique: [...new Set(errs)].slice(0, 6), info, fp, shot }, null, 2));
await browser.close();
process.exit(info.black || errs.length > 5 || (info.bad || []).length ? 2 : 0);

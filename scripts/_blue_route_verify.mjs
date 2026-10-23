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
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push((e.stack || String(e)).split('\n')[0]));

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
await page.waitForTimeout(4000);
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
  // Count blue pixels via 2d copy of WebGL canvas (preserveDrawingBuffer may be false).
  const c = document.querySelector('[data-plan3d-canvas="true"]');
  let bluePx = 0;
  let totalPx = 0;
  if (c) {
    const tmp = document.createElement('canvas');
    tmp.width = c.width;
    tmp.height = c.height;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const data = ctx.getImageData(0, 0, tmp.width, tmp.height).data;
    totalPx = tmp.width * tmp.height;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (b > 130 && b > r + 35 && b >= g && r < 140) bluePx += 1;
    }
  }
  return {
    usesPost: shaders?.usesPost ?? null,
    pipeline: shaders?.pipeline || null,
    quality: shaders?.quality || null,
    bad: shaders?.bad || [],
    underlays: routes?.underlays ?? 0,
    strokes: routes?.strokes ?? 0,
    kids: (routes?.out || []).slice(0, 4),
    bluePx,
    totalPx,
    blueRatio: totalPx ? bluePx / totalPx : 0,
  };
});

const shot = path.join(MEDIA, 'blue-route-ok.png');
await page.screenshot({ path: shot, fullPage: false });
fs.copyFileSync(shot, path.join(STORE, 'blue-route-ok.png'));

await page.getByRole('button', { name: '第一人称', exact: true }).click();
await page.waitForTimeout(2500);
const fp = await page.evaluate(() => ({
  walking: !!window.__navTest.viewer?.isNavWalking?.(),
}));
const fpShot = path.join(MEDIA, 'fp-enter-ok.png');
await page.screenshot({ path: fpShot, fullPage: false });
fs.copyFileSync(fpShot, path.join(STORE, 'fp-enter-ok.png'));

const out = {
  errs: pageErrors.length,
  uniqueErrs: [...new Set(pageErrors)].slice(0, 8),
  info,
  fp,
  shot,
};
console.log(JSON.stringify(out, null, 2));
await browser.close();

const okBlue = info.bluePx > 1200 && (info.underlays > 0 || info.strokes > 0);
const okFp = fp.walking && pageErrors.length < 5 && !(info.bad || []).length;
process.exit(okBlue && okFp ? 0 : 2);

import { chromium } from 'playwright';

const API = 'http://127.0.0.1:8884';
const P2 = '4a87b204fb564d1689764b226ef99312';
const q = new URLSearchParams({
  projectUrl: `${API}/api/projects/${P2}.json`,
  id: P2,
  apiOrigin: API,
  filesUrl: `${API}/files`,
});
const url = `http://127.0.0.1:5175/nav?${q}`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
// Bypass HTTP cache so Vite optimize-deps hash cannot go stale mid-session.
await page.route('**/*', (route) => route.continue());
const logs = [];
page.on('console', (m) => logs.push({ t: m.type(), m: m.text().slice(0, 500) }));
page.on('pageerror', (e) => logs.push({ t: 'pageerror', m: (e.stack || String(e)).slice(0, 900) }));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => (window.__navTest?.places?.() || []).length > 5, null, { timeout: 120000 });

// Probe THREE ShaderChunk + patch resolveIncludes once viewer/three is loaded
await page.evaluate(async () => {
  const places = window.__navTest.places();
  const a = places.find((p) => p.label.startsWith('1楼') && p.label.includes('登记'));
  const b = places.find((p) => p.label.startsWith('2楼') && p.label.includes('护士办公'));
  await window.__navTest.route(a.key, b.key);
});
await page.waitForTimeout(500);
await page.getByRole('button', { name: '第一人称', exact: true }).click();
await page.waitForTimeout(3500);

const state = await page.evaluate(() => {
  const v = window.__navTest.viewer;
  return {
    isNavWalking: v?.isNavWalking?.(),
    isSimulating: v?.isSimulating?.(),
    canvasOk: !!document.querySelector('[data-plan3d-canvas="true"]'),
    hasExit: [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === '退出'),
  };
});

// Sample center pixel of canvas (blackout?)
const pixel = await page.evaluate(async () => {
  const c = document.querySelector('[data-plan3d-canvas="true"]');
  if (!c) return null;
  // WebGL canvas - read via drawImage
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  if (!gl) return { err: 'no-gl' };
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const buf = new Uint8Array(4);
  gl.readPixels((w / 2) | 0, (h / 2) | 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  return { rgba: [...buf], w, h };
});

console.log('STATE', JSON.stringify(state));
console.log('PIXEL', JSON.stringify(pixel));
const errs = logs.filter((l) => l.t === 'pageerror' || l.t === 'error');
console.log('ERR_COUNT', errs.length);
console.log('ERR0', errs[0]?.m?.slice(0, 600));
console.log('ERR_TYPES', [...new Set(errs.map((e) => (e.m || '').split('\n')[0]))].slice(0, 8));

await page.screenshot({ path: '../media/nav-four-fixes/fp-enter-ok.png' });
await browser.close();
process.exit(state.isNavWalking && state.hasExit ? 0 : 2);

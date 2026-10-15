/**
 * Nav 3D stair close-up before/after (test stack)
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = process.env.API_ORIGIN || 'http://127.0.0.1:8886';
const VITE = process.env.VITE_ORIGIN || 'http://127.0.0.1:5176';
const OUT = process.env.OUT_DIR || path.resolve(__dirname, '../internal/test-env-1015-stair-rotation-screenshots');
const PID = process.env.PROJECT_ID || '6981c5f7bf464bc4a8fed87880780ebc';
const LABEL = process.env.VARIANT || 'P1-cleaned';
const PHASE = process.env.PHASE || 'before';

fs.mkdirSync(OUT, { recursive: true });

const qs = new URLSearchParams({
  projectUrl: `${API}/api/projects/${PID}.json`,
  id: PID,
  apiOrigin: API,
  filesUrl: `${API}/files`,
  floor: 'floor-0',
});
const url = `${VITE}/nav?${qs}`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => (window.__navTest?.places?.() || []).length > 2, null, { timeout: 180000 });
const mode3d = page.locator('button', { hasText: '3D' });
if (await mode3d.count()) await mode3d.first().click();
await page.waitForTimeout(3000);
// West stair area P1-cleaned ~(-900, 200)
await page.evaluate(() => {
  const o = window.__openPlan3dOrbit;
  if (!o?.set) return;
  o.set({ target: [-920, 0, 280], position: [-920, 400, 680], zoom: 1.2 });
});
await page.waitForTimeout(2000);
const file = path.join(OUT, `${LABEL}-west-stair-1F-${PHASE}.png`);
await page.screenshot({ path: file, fullPage: false });
await browser.close();
console.log(JSON.stringify({ file, phase: PHASE }));

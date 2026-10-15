/**
 * Nav 3D close-up: route through a corridor door (test stack 8886/5176).
 * Usage: node scripts/nav-door-center-shot.mjs [before|after]
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = process.env.API_ORIGIN || 'http://127.0.0.1:8886';
const VITE = process.env.VITE_ORIGIN || 'http://127.0.0.1:5176';
const OUT =
  process.env.OUT_DIR ||
  path.resolve(__dirname, '../../gifu-test-env-1015-wt/internal/test-env-1015-nav-door-screenshots');
const PID = process.env.PROJECT_ID || '6981c5f7bf464bc4a8fed87880780ebc';
const LABEL = process.env.VARIANT || 'P1-cleaned';
const PHASE = process.argv[2] || process.env.PHASE || 'after';

fs.mkdirSync(OUT, { recursive: true });

const FROM = { x: 143.34, y: 223.89, floor: 'floor-0' };
const TO = { x: 117.82, y: -486.55, floor: 'floor-0' };

const routeRes = await fetch(`${API}/api/projects/${PID}/route`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ floor: 'floor-0', from: FROM, to: TO }),
});
const route = await routeRes.json();
const proof = {
  phase: PHASE,
  ok: route.ok,
  usedDoorIds: route.usedDoorIds || [],
  polyline: route.polyline || [],
};

const qs = new URLSearchParams({
  projectUrl: `${API}/api/projects/${PID}.json`,
  id: PID,
  apiOrigin: API,
  filesUrl: `${API}/files`,
});
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(`${VITE}/nav?${qs}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => (window.__navTest?.places?.() || []).length > 3, null, {
  timeout: 180000,
});

await page.evaluate(
  async ({ from, to }) => {
    await window.__navTest.route(
      { key: `raw:${from.x},${from.y},${from.floor}`, x: from.x, y: from.y, floor: from.floor },
      { key: `raw:${to.x},${to.y},${to.floor}`, x: to.x, y: to.y, floor: to.floor },
    );
    window.__navTest.setMode('3d');
  },
  { from: FROM, to: TO },
);
await page.waitForTimeout(3000);

const mid = route.polyline?.[Math.floor((route.polyline.length || 1) / 2)] || { x: 400, y: -200 };
await page.evaluate((focus) => {
  const v = window.__navTest.viewer;
  v?.setOrbitPoseForTest?.([focus.x, 220, focus.y + 320], [focus.x, 90, focus.y]);
  for (let i = 0; i < 40; i++) v?.renderFrameForTest?.();
}, mid);
await page.waitForTimeout(800);

const file = path.join(OUT, `${LABEL}-1F-door-crossing-${PHASE}.png`);
await page.screenshot({ path: file, fullPage: false });
await browser.close();

fs.writeFileSync(path.join(OUT, `${LABEL}-1F-door-route-${PHASE}.json`), JSON.stringify(proof, null, 2));
console.log(JSON.stringify({ file, phase: PHASE, usedDoorIds: proof.usedDoorIds }));

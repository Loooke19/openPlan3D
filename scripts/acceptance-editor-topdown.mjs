/**
 * Editor 2D top-down acceptance shots (test stack 8886/5176).
 * Reads jobs from MANIFEST_PATH (pairs with projectId, floorId, editorTopdown, width, height).
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = process.env.API_ORIGIN || 'http://127.0.0.1:8886';
const VITE = process.env.VITE_ORIGIN || 'http://127.0.0.1:5176';
const MANIFEST = process.env.MANIFEST_PATH;
if (!MANIFEST || !fs.existsSync(MANIFEST)) {
  console.error('MANIFEST_PATH required');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const pairs = manifest.pairs || [];

function viewportForTarget(width, height) {
  const maxDim = 2000;
  const w = Math.max(1, Number(width) || 1600);
  const h = Math.max(1, Number(height) || 1200);
  if (w >= h) {
    return { width: maxDim, height: Math.max(400, Math.round(maxDim * h / w)) };
  }
  return { width: Math.max(400, Math.round(maxDim * w / h)), height: maxDim };
}

function editorUrl(projectId, floorId) {
  const qs = new URLSearchParams({
    projectUrl: `${API}/api/projects/${projectId}.json`,
    id: projectId,
    apiOrigin: API,
    filesUrl: `${API}/files`,
    floor: floorId,
  });
  return `${VITE}/editor?${qs}`;
}

async function captureFloor(page, job) {
  const target = job.editorTopdown;
  const raw = target.replace(/\.png$/, '.raw.png');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const vp = viewportForTarget(job.width, job.height);
  await page.setViewportSize(vp);
  await page.goto(editorUrl(job.projectId, job.floorId), {
    waitUntil: 'domcontentloaded',
    timeout: 180000,
  });
  await page.waitForSelector('canvas[data-plan2d-canvas="true"]', { timeout: 180000 });
  await page.waitForTimeout(3500);
  const canvas = page.locator('canvas[data-plan2d-canvas="true"]').first();
  await canvas.click({ position: { x: 80, y: 80 }, force: true }).catch(() => {});
  await page.keyboard.press('f');
  await page.waitForTimeout(1200);
  await canvas.screenshot({ path: raw, type: 'png' });
  return raw;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const results = [];
for (const job of pairs) {
  if (!job.projectId || !job.floorId) continue;
  try {
    const file = await captureFloor(page, job);
    results.push({ floor: job.floorName, building: job.building, file, ok: true });
    console.log(JSON.stringify({ ok: true, building: job.building, floor: job.floorName, file }));
  } catch (error) {
    results.push({
      floor: job.floorName,
      building: job.building,
      ok: false,
      error: String(error?.message || error),
    });
    console.error(JSON.stringify({ ok: false, building: job.building, floor: job.floorName, error: String(error) }));
  }
}
await browser.close();
const fail = results.some((r) => !r.ok);
if (fail) process.exitCode = 1;

/**
 * Editor 2D top-down acceptance shots (test stack 8886/5176).
 * Switches floor via TopBar <select> (editor ignores ?floor= query param).
 */
import { chromium } from 'playwright';
import crypto from 'node:crypto';
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

const manifestDir = path.dirname(path.resolve(MANIFEST));
const WT_ROOT = process.env.WT_ROOT || path.resolve(manifestDir, '..', '..', '..');

function assetPath(relOrAbs) {
  if (!relOrAbs) return relOrAbs;
  if (path.isAbsolute(relOrAbs)) return relOrAbs;
  return path.join(WT_ROOT, relOrAbs.split('/').join(path.sep));
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

function editorUrl(projectId) {
  const qs = new URLSearchParams({
    projectUrl: `${API}/api/projects/${projectId}.json`,
    id: projectId,
    apiOrigin: API,
    filesUrl: `${API}/files`,
  });
  return `${VITE}/editor?${qs}`;
}

function floorSelect(page) {
  return page.locator('select[aria-label]').first();
}

async function apiFloorStats(projectId, floorId) {
  const res = await fetch(`${API}/api/projects/${projectId}.json`);
  const project = await res.json();
  const floor = (project.floors || []).find((f) => f.id === floorId);
  if (!floor) return null;
  return {
    floorId: floor.id,
    floorName: floor.name,
    wallCount: (floor.walls || []).length,
    roomCount: (floor.rooms || []).length,
  };
}

async function switchFloor(page, floorId) {
  const select = floorSelect(page);
  await select.waitFor({ state: 'visible', timeout: 120000 });
  await select.selectOption(floorId);
  await page.waitForFunction(
    (fid) => document.querySelector('select[aria-label]')?.value === fid,
    floorId,
    { timeout: 30000 },
  );
  await page.waitForTimeout(2000);
}

async function captureFloor(browser, job) {
  const target = assetPath(job.editorTopdown);
  const raw = target.replace(/\.png$/, '.raw.png');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const page = await browser.newPage();
  const vp = viewportForTarget(job.width, job.height);
  await page.setViewportSize(vp);
  await page.goto(editorUrl(job.projectId), { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForSelector('canvas[data-plan2d-canvas="true"]', { timeout: 180000 });
  await page.waitForTimeout(2500);
  await switchFloor(page, job.floorId);
  const canvas = page.locator('canvas[data-plan2d-canvas="true"]').first();
  await canvas.click({ position: { x: 80, y: 80 }, force: true }).catch(() => {});
  await page.keyboard.press('f');
  await page.waitForTimeout(1200);
  const uiFloorId = await page.evaluate(
    () => document.querySelector('select[aria-label]')?.value || null,
  );
  await canvas.screenshot({ path: raw, type: 'png' });
  await page.close();
  const buf = fs.readFileSync(raw);
  const md5 = crypto.createHash('md5').update(buf).digest('hex');
  const apiStats = await apiFloorStats(job.projectId, job.floorId);
  return {
    raw,
    md5,
    uiFloorId,
    apiStats,
    floorSwitchOk: uiFloorId === job.floorId,
  };
}

const browser = await chromium.launch({ headless: true });
const captureByKey = new Map();
for (const job of pairs) {
  if (!job.projectId || !job.floorId) continue;
  const key = `${job.building}:${job.floorName}`;
  try {
    const cap = await captureFloor(browser, job);
    captureByKey.set(key, cap);
    console.log(
      JSON.stringify({
        ok: true,
        building: job.building,
        floor: job.floorName,
        floorId: job.floorId,
        uiFloorId: cap.uiFloorId,
        wallCount: cap.apiStats?.wallCount,
        roomCount: cap.apiStats?.roomCount,
        md5: cap.md5,
        file: cap.raw,
      }),
    );
  } catch (error) {
    captureByKey.set(key, { error: String(error?.message || error) });
    console.error(
      JSON.stringify({ ok: false, building: job.building, floor: job.floorName, error: String(error) }),
    );
  }
}
await browser.close();

for (const job of pairs) {
  const key = `${job.building}:${job.floorName}`;
  const cap = captureByKey.get(key);
  if (!cap || cap.error) {
    job.editorCaptureError = cap?.error || 'missing capture';
    continue;
  }
  job.editorMd5 = cap.md5;
  job.editorUiFloorId = cap.uiFloorId;
  job.floorSwitchOk = cap.floorSwitchOk;
  if (cap.apiStats) {
    job.wallCount = cap.apiStats.wallCount;
    job.roomCount = cap.apiStats.roomCount;
    job.apiFloorName = cap.apiStats.floorName;
  }
}

manifest.editorCapturedAt = new Date().toISOString();
fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2), 'utf8');
const fail = [...captureByKey.values()].some((c) => c.error);
if (fail) process.exitCode = 1;

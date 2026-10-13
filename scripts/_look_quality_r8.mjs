/**
 * Look-quality r8 acceptance:
 * - mean luminance before(low) / after(high)
 * - P2: 1F overview, FP corridor, stacked top-down — one before/after pair each
 * - FPS (ms/frame) + orbit-drag blackout smoke
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = 'http://127.0.0.1:8884';
const PID = '4a87b204fb564d1689764b226ef99312';
const LOCAL = path.resolve(__dirname, '../../media/look-quality');
const STORE = path.resolve(
  process.env.USERPROFILE || '',
  'AppData/Local/Cursor/AgentStores/cursor_agent_stores/bc-8097b1e1-0215-4b44-93fa-f96676d9b948/files',
);
fs.mkdirSync(LOCAL, { recursive: true });
fs.mkdirSync(path.join(STORE, 'media/look-quality'), { recursive: true });
fs.mkdirSync(path.join(STORE, 'internal'), { recursive: true });

function q(extra = {}) {
  return new URLSearchParams({
    projectUrl: `${API}/api/projects/${PID}.json`,
    id: PID,
    apiOrigin: API,
    filesUrl: `${API}/files`,
    ...extra,
  });
}

async function prepRoute(page) {
  await page.waitForFunction(() => (window.__navTest?.places?.() || []).length > 5, null, { timeout: 180000 });
  await page.evaluate(async () => {
    const p = window.__navTest.places();
    const a = p.find((x) => x.label.includes('1楼') && x.label.includes('登记'));
    const b = p.find((x) => x.label.includes('2楼') && x.label.includes('护士'));
    await window.__navTest.route(a.key, b.key);
    window.__navTest.setMode('3d');
  });
  await page.waitForTimeout(2800);
}

async function stats(page) {
  return page.evaluate(() => {
    const c = document.querySelector('[data-plan3d-canvas="true"]') || document.querySelector('canvas');
    const tmp = document.createElement('canvas');
    tmp.width = c.width;
    tmp.height = c.height;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(0, 0, tmp.width, tmp.height).data;
    let black = 0;
    let blue = 0;
    let sum = 0;
    const n = tmp.width * tmp.height;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += L;
      if (r + g + b < 18) black += 1;
      if (b > 140 && b > r + 25 && b >= g) blue += 1;
    }
    const bench = window.__navTest.viewer?.benchmarkForTest?.(24) || null;
    const probe = window.__postProbeResult || null;
    return {
      meanLum: Math.round(sum / n),
      blackFrac: +(black / n).toFixed(4),
      bluePx: blue,
      msPerFrame: bench?.msPerFrame != null ? +bench.msPerFrame.toFixed(2) : null,
      fps: bench?.msPerFrame ? +(1000 / bench.msPerFrame).toFixed(1) : null,
      postMode: probe?.mode || null,
      ssao: probe?.ssao ?? null,
      wantBloom: probe?.wantBloom ?? null,
    };
  });
}

async function poseOverview(page) {
  await page.evaluate(() => {
    const v = window.__navTest.viewer;
    v.nudgeOrbitForTest?.({ polar: 0.72, radiusScale: 1.15 });
    for (let i = 0; i < 40; i++) v.renderFrameForTest?.();
  });
  await page.waitForTimeout(400);
}

async function poseFp(page) {
  await page.getByRole('button', { name: '第一人称', exact: true }).click();
  await page.waitForTimeout(2200);
  await page.evaluate(() => {
    const v = window.__navTest.viewer;
    for (let i = 0; i < 40; i++) v.renderFrameForTest?.();
  });
}

async function poseStack(page) {
  // Leave FP if active, then high oblique for stacked floors.
  await page.evaluate(() => {
    window.__navTest.setMode('3d');
  });
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const v = window.__navTest.viewer;
    v.nudgeOrbitForTest?.({ polar: 0.35, radiusScale: 1.45 });
    for (let i = 0; i < 40; i++) v.renderFrameForTest?.();
  });
  await page.waitForTimeout(400);
}

async function dragSmoke(page) {
  const canvas = page.locator('[data-plan3d-canvas="true"], canvas').first();
  const box = await canvas.boundingBox();
  if (!box) return { ok: false, reason: 'no-canvas' };
  const x = box.x + box.width * 0.45;
  const y = box.y + box.height * 0.45;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 0; i < 8; i++) {
    await page.mouse.move(x + (i + 1) * 18, y + (i % 2) * 10);
    await page.waitForTimeout(40);
  }
  await page.mouse.up();
  await page.waitForTimeout(500);
  const after = await stats(page);
  return {
    ok: after.blackFrac < 0.45 && after.meanLum > 25,
    blackFrac: after.blackFrac,
    meanLum: after.meanLum,
  };
}

async function captureTag(browser, quality, tag) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`http://127.0.0.1:5175/nav?${q({ quality, _: String(Date.now()) })}`, {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  });
  await prepRoute(page);
  const out = {};

  await poseOverview(page);
  const overview = await stats(page);
  const overviewFile = `${tag}-p2-1f-overview.png`;
  await page.screenshot({ path: path.join(LOCAL, overviewFile), fullPage: false });
  out.overview = { file: overviewFile, ...overview };

  await poseFp(page);
  const fp = await stats(page);
  const fpFile = `${tag}-p2-fp-corridor.png`;
  await page.screenshot({ path: path.join(LOCAL, fpFile), fullPage: false });
  out.fp = { file: fpFile, ...fp };

  await poseStack(page);
  const stack = await stats(page);
  const stackFile = `${tag}-p2-stack-top.png`;
  await page.screenshot({ path: path.join(LOCAL, stackFile), fullPage: false });
  out.stack = { file: stackFile, ...stack };

  let drag = { ok: true, skipped: true };
  if (tag === 'after') {
    drag = await dragSmoke(page);
  }

  await page.close();
  return { shots: out, drag };
}

const browser = await chromium.launch({ headless: true });
const before = await captureTag(browser, 'low', 'before');
const after = await captureTag(browser, 'high', 'after');
await browser.close();

const files = [
  before.shots.overview.file,
  before.shots.fp.file,
  before.shots.stack.file,
  after.shots.overview.file,
  after.shots.fp.file,
  after.shots.stack.file,
];
for (const f of files) {
  fs.copyFileSync(path.join(LOCAL, f), path.join(STORE, 'media/look-quality', f));
}

const ok =
  after.shots.overview.blackFrac < 0.35 &&
  after.shots.overview.meanLum > 40 &&
  after.shots.overview.bluePx > 80 &&
  after.shots.fp.blackFrac < 0.55 &&
  after.shots.fp.meanLum > 28 &&
  after.drag.ok !== false &&
  (after.shots.overview.msPerFrame == null ||
    before.shots.overview.msPerFrame == null ||
    after.shots.overview.msPerFrame < Math.max(80, before.shots.overview.msPerFrame * 2.8));

const summary = {
  ok,
  before: {
    overview: before.shots.overview,
    fp: before.shots.fp,
    stack: before.shots.stack,
  },
  after: {
    overview: after.shots.overview,
    fp: after.shots.fp,
    stack: after.shots.stack,
    drag: after.drag,
  },
  files,
};

fs.writeFileSync(path.join(LOCAL, 'look-quality-r8.json'), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(STORE, 'media/look-quality/look-quality-r8.json'), JSON.stringify(summary, null, 2));

console.log(JSON.stringify(summary, null, 2));
process.exit(ok ? 0 : 2);

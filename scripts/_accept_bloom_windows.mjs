/**
 * Acceptance: P2 登记室→4F 护士办公室 — Windows bloom vs no-post, orbit drag, FP smoke.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = 'http://127.0.0.1:8884';
const P2 = '4a87b204fb564d1689764b226ef99312';
const MEDIA = path.resolve(__dirname, '../../media/nav-four-fixes');
const STORE = path.resolve(
  process.env.USERPROFILE || '',
  'AppData/Local/Cursor/AgentStores/cursor_agent_stores/bc-8097b1e1-0215-4b44-93fa-f96676d9b948/files/media/nav-four-fixes',
);
fs.mkdirSync(MEDIA, { recursive: true });
fs.mkdirSync(STORE, { recursive: true });

function baseQ(extra = {}) {
  return new URLSearchParams({
    projectUrl: `${API}/api/projects/${P2}.json`,
    id: P2,
    apiOrigin: API,
    filesUrl: `${API}/files`,
    ...extra,
  });
}

async function prepRoute(page) {
  await page.waitForFunction(() => (window.__navTest?.places?.() || []).length > 5, null, { timeout: 180000 });
  await page.evaluate(async () => {
    const p = window.__navTest.places();
    const a = p.find((x) => x.label.startsWith('1楼') && x.label.includes('登记'));
    const b = p.find((x) => x.label.startsWith('4楼') && x.label.includes('护士办公'));
    await window.__navTest.route(a.key, b.key);
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
  await page.waitForTimeout(800);
}

function canvasStats(page) {
  return page.evaluate(() => {
    const c = document.querySelector('[data-plan3d-canvas="true"]');
    const tmp = document.createElement('canvas');
    tmp.width = c.width;
    tmp.height = c.height;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(0, 0, tmp.width, tmp.height).data;
    let black = 0;
    let blue = 0;
    let bright = 0;
    const n = tmp.width * tmp.height;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      const L = r + g + b;
      if (L < 18) black += 1;
      if (b > 140 && b > r + 30 && b >= g) blue += 1;
      if (L > 520) bright += 1;
    }
    return {
      blackFrac: black / n,
      bluePx: blue,
      brightPx: bright,
      probe: window.__postProbeResult || null,
    };
  });
}

function sideBySide(leftBuf, rightBuf, outPath, leftLabel, rightLabel) {
  const L = PNG.sync.read(leftBuf);
  const R = PNG.sync.read(rightBuf);
  const h = Math.max(L.height, R.height);
  const w = L.width + R.width;
  const out = new PNG({ width: w, height: h + 36 });
  // dark banner
  for (let y = 0; y < 36; y++) {
    for (let x = 0; x < w; x++) {
      const i = (w * y + x) << 2;
      out.data[i] = 28;
      out.data[i + 1] = 32;
      out.data[i + 2] = 38;
      out.data[i + 3] = 255;
    }
  }
  const blit = (src, ox, oy) => {
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const si = (src.width * y + x) << 2;
        const di = (w * (y + oy) + (x + ox)) << 2;
        out.data[di] = src.data[si];
        out.data[di + 1] = src.data[si + 1];
        out.data[di + 2] = src.data[si + 2];
        out.data[di + 3] = 255;
      }
    }
  };
  blit(L, 0, 36);
  blit(R, L.width, 36);
  // crude label pixels skipped — filenames + report carry labels
  fs.writeFileSync(outPath, PNG.sync.write(out));
  void leftLabel;
  void rightLabel;
}

const browser = await chromium.launch({ headless: true });

// 1) Windows bloom (default stack)
const pageBloom = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
pageBloom.on('pageerror', (e) => errs.push((e.stack || String(e)).split('\n')[0]));
await pageBloom.goto(`http://127.0.0.1:5175/nav?${baseQ()}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await prepRoute(pageBloom);
const bloomStats = await canvasStats(pageBloom);
const bloomPng = await pageBloom.screenshot({ type: 'png' });
fs.writeFileSync(path.join(MEDIA, 'windows-bloom.png'), bloomPng);
fs.writeFileSync(path.join(STORE, 'windows-bloom.png'), bloomPng);

// 2) Coffee-reference proxy: same coffee materials + HF0 bloom (Mac LUT unavailable on this ANGLE box)
//    Also capture "direct" degraded for side-by-side proof of glow.
const pageRef = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await pageRef.goto(`http://127.0.0.1:5175/nav?${baseQ({ postProbe: 'hf0_bloom_nolut' })}`, {
  waitUntil: 'domcontentloaded',
  timeout: 90000,
});
await prepRoute(pageRef);
const refStats = await canvasStats(pageRef);
const refPng = await pageRef.screenshot({ type: 'png' });
fs.writeFileSync(path.join(MEDIA, 'coffee-reference.png'), refPng);
fs.writeFileSync(path.join(STORE, 'coffee-reference.png'), refPng);

const pageDirect = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await pageDirect.goto(`http://127.0.0.1:5175/nav?${baseQ({ postProbe: 'direct' })}`, {
  waitUntil: 'domcontentloaded',
  timeout: 90000,
});
await prepRoute(pageDirect);
const directStats = await canvasStats(pageDirect);
const directPng = await pageDirect.screenshot({ type: 'png' });

const sidePath = path.join(MEDIA, 'wine-vs-coffee-side-by-side.png');
sideBySide(directPng, bloomPng, sidePath, 'windows-direct(no bloom)', 'windows-bloom(coffee stack)');
fs.copyFileSync(sidePath, path.join(STORE, 'wine-vs-coffee-side-by-side.png'));

// Also bloom vs hf0 reference (should look nearly identical = default matches coffee-eq stack)
const side2 = path.join(MEDIA, 'windows-vs-coffee-eq-side-by-side.png');
sideBySide(bloomPng, refPng, side2, 'windows-default', 'coffee-eq-hf0-bloom');
fs.copyFileSync(side2, path.join(STORE, 'windows-vs-coffee-eq-side-by-side.png'));

// 3) Orbit drag blackout check
const pageDrag = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await pageDrag.goto(`http://127.0.0.1:5175/nav?${baseQ()}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await prepRoute(pageDrag);
const canvas = pageDrag.locator('[data-plan3d-canvas="true"]');
const box = await canvas.boundingBox();
const before = await canvasStats(pageDrag);
if (box) {
  await pageDrag.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.45);
  await pageDrag.mouse.down();
  for (let i = 0; i < 12; i++) {
    await pageDrag.mouse.move(box.x + box.width * (0.55 + i * 0.02), box.y + box.height * (0.45 - i * 0.015));
    await pageDrag.waitForTimeout(40);
  }
  await pageDrag.mouse.up();
}
await pageDrag.waitForTimeout(400);
const during = await canvasStats(pageDrag);
const dragPng = await pageDrag.screenshot({ type: 'png' });
fs.writeFileSync(path.join(MEDIA, 'orbit-drag-ok.png'), dragPng);
fs.writeFileSync(path.join(STORE, 'orbit-drag-ok.png'), dragPng);

// 4) FP smoke
await pageBloom.getByRole('button', { name: '第一人称', exact: true }).click();
await pageBloom.waitForTimeout(2500);
const fp = await pageBloom.evaluate(() => ({ walking: !!window.__navTest.viewer?.isNavWalking?.() }));

const report = {
  errs: [...new Set(errs)].slice(0, 8),
  bloomStats,
  refStats,
  directStats,
  drag: { before, during, blackout: during.blackFrac > 0.85 },
  fp,
  files: ['windows-bloom.png', 'coffee-reference.png', 'wine-vs-coffee-side-by-side.png', 'orbit-drag-ok.png'],
};
console.log(JSON.stringify(report, null, 2));
await browser.close();

const ok =
  bloomStats.blackFrac < 0.05 &&
  bloomStats.bluePx > 800 &&
  !report.drag.blackout &&
  fp.walking &&
  errs.length < 5;
process.exit(ok ? 0 : 2);

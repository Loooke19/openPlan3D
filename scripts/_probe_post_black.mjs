/**
 * Isolate which post stack blacks the Windows canvas.
 * Modes via ?postProbe=N after forcing post on.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = 'http://127.0.0.1:8884';
const P2 = '4a87b204fb564d1689764b226ef99312';
const OUT = path.resolve(__dirname, '../../media/nav-four-fixes/post-probe');
fs.mkdirSync(OUT, { recursive: true });

const MODES = [
  'direct',           // no composer
  'rp',               // RenderPass only → screen
  'rp_final_nolut',   // RenderPass + Final without LUT sample
  'rp_final',         // RenderPass + FinalShader (texture3D lut)
  'rp_bloom',         // RenderPass + UnrealBloom (no final)
  'rp_bloom_final',   // coffee-like, UnsignedByte samples=0
  'rp_bloom_final_hf',// coffee HalfFloat samples=4
];

async function runMode(mode) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push((e.stack || String(e)).split('\n')[0]));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errs.push(`console:${msg.text().slice(0, 160)}`);
  });

  const q = new URLSearchParams({
    projectUrl: `${API}/api/projects/${P2}.json`,
    id: P2,
    apiOrigin: API,
    filesUrl: `${API}/files`,
    postProbe: mode,
  });
  await page.goto(`http://127.0.0.1:5175/nav?${q}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => (window.__navTest?.places?.() || []).length > 5, null, { timeout: 180000 });
  await page.evaluate(async () => {
    const p = window.__navTest.places();
    await window.__navTest.route(
      p.find((x) => x.label.startsWith('1楼') && x.label.includes('登记')).key,
      p.find((x) => x.label.startsWith('4楼') && x.label.includes('护士办公')).key,
    );
    window.__navTest.setMode('3d');
  });
  await page.waitForTimeout(4500);

  const info = await page.evaluate(() => {
    const c = document.querySelector('[data-plan3d-canvas="true"]');
    let stats = { mid: null, mean: 0, nonzero: 0, blackFrac: 1, w: 0, h: 0 };
    if (c) {
      const tmp = document.createElement('canvas');
      tmp.width = c.width;
      tmp.height = c.height;
      const ctx = tmp.getContext('2d');
      ctx.drawImage(c, 0, 0);
      const data = ctx.getImageData(0, 0, tmp.width, tmp.height).data;
      let sum = 0;
      let black = 0;
      const n = tmp.width * tmp.height;
      for (let i = 0; i < data.length; i += 4) {
        const L = data[i] + data[i + 1] + data[i + 2];
        sum += L;
        if (L < 18) black += 1;
      }
      const mx = (tmp.width / 2) | 0;
      const my = (tmp.height / 2) | 0;
      const o = (my * tmp.width + mx) * 4;
      stats = {
        mid: [data[o], data[o + 1], data[o + 2], data[o + 3]],
        mean: sum / n,
        nonzero: n - black,
        blackFrac: black / n,
        w: tmp.width,
        h: tmp.height,
      };
    }
    const dbg = window.__navTest.viewer?.debugForTest?.('shaders') || {};
    const glInfo = window.__navTest.viewer?.debugForTest?.('gl') || null;
    return { stats, dbg, glInfo, probe: window.__postProbeResult || null };
  });

  const shot = path.join(OUT, `${mode}.png`);
  await page.screenshot({ path: shot, fullPage: false });
  await browser.close();
  return { mode, errs: [...new Set(errs)].slice(0, 8), ...info, shot };
}

const results = [];
for (const mode of MODES) {
  console.log('MODE', mode);
  try {
    results.push(await runMode(mode));
  } catch (e) {
    results.push({ mode, error: String(e).slice(0, 200) });
  }
}
const summary = path.join(OUT, 'summary.json');
fs.writeFileSync(summary, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results.map((r) => ({
  mode: r.mode,
  blackFrac: r.stats?.blackFrac,
  mean: r.stats?.mean,
  mid: r.stats?.mid,
  errs: r.errs?.length,
  probe: r.probe,
  error: r.error,
})), null, 2));
console.log('wrote', summary);

/**
 * Cross-floor nav smoke + screenshot (stairs / elevator) on test stack :5176/:8886
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = process.env.API_ORIGIN || 'http://127.0.0.1:8886';
const VITE = process.env.VITE_ORIGIN || 'http://127.0.0.1:5176';
const OUT = process.env.OUT_DIR || path.resolve(__dirname, '../../internal/test-env-1015-vertical-screenshots');
const PID = process.env.PROJECT_ID || '72a0489830e44ec19f2e6b7bcedbc950';
const LABEL = process.env.VARIANT || 'P3-cleaned';
const MODE = process.env.MODE || 'stairs'; // stairs | elevator

fs.mkdirSync(OUT, { recursive: true });

function navUrl() {
  const qs = new URLSearchParams({
    projectUrl: `${API}/api/projects/${PID}.json`,
    id: PID,
    apiOrigin: API,
    filesUrl: `${API}/files`,
  });
  return `${VITE}/nav?${qs}`;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(navUrl(), { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => (window.__navTest?.places?.() || []).length > 3, null, { timeout: 180000 });

const places = await page.evaluate(() => window.__navTest.places());
const low = places.find((p) => /1F|一楼|1层/.test(p.floorName || p.name || '')) || places[0];
const high = [...places].reverse().find((p) => /5F|4F|3F|2F/.test(p.floorName || '')) || places[places.length - 1];

await page.evaluate(
  ({ mode }) => {
    window.__navTest.setAccessible(mode === 'elevator');
    window.__navTest.setStairsOnly(mode === 'stairs');
  },
  { mode: MODE },
);

const routed = await page.evaluate(async ({ from, to }) => {
  try {
    await window.__navTest.route(from.key, to.key);
    return {
      ok: true,
      transfers: window.__navTest.transfers(),
      legs: (window.__navTest.legs() || []).map((l) => l.floorName || l.floorId),
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}, { from: low, to: high });

await page.waitForTimeout(2500);
const file = path.join(OUT, `${LABEL}-crossfloor-${MODE}.png`);
await page.screenshot({ path: file, fullPage: false });
await browser.close();
console.log(JSON.stringify({ label: LABEL, mode: MODE, from: low?.name, to: high?.name, routed, file }));

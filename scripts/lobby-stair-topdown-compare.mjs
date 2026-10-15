/**
 * P1 西翼门厅/楼梯间 1F+2F 编辑器俯视（改前/改后）
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = process.env.API_ORIGIN || 'http://127.0.0.1:8886';
const VITE = process.env.VITE_ORIGIN || 'http://127.0.0.1:5176';
const OUT = process.env.OUT_DIR || path.resolve(__dirname, '../../internal/test-env-1015-lobby-screenshots');
const PID = process.env.PROJECT_ID || '6981c5f7bf464bc4a8fed87880780ebc';
const VARIANT = process.env.VARIANT || 'cleaned';
const PHASE = process.env.PHASE || 'before';

fs.mkdirSync(OUT, { recursive: true });

function editorUrl(floorId) {
  const qs = new URLSearchParams({
    projectUrl: `${API}/api/projects/${PID}.json`,
    id: PID,
    apiOrigin: API,
    filesUrl: `${API}/files`,
    floor: floorId,
  });
  return `${VITE}/editor?${qs}`;
}

async function shot(page, floorName, floorId) {
  await page.goto(editorUrl(floorId), { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('canvas[data-plan2d-canvas="true"]', { timeout: 120000 });
  const select = page.locator('label.floor select');
  if (await select.count()) {
    const opts = await select.locator('option').evaluateAll((o) => o.map((x) => ({ v: x.value, t: (x.textContent || '').trim() })));
    const pick = opts.find((o) => o.t === floorName) || opts.find((o) => /1F|2F/.test(o.t));
    if (pick?.v) await select.selectOption(pick.v);
  }
  await page.waitForTimeout(3500);
  const file = path.join(OUT, `${VARIANT}-lobby-stair-${floorName}-${PHASE}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const files = [];
for (const [name, id] of [['1F', 'floor-0'], ['2F', 'floor-1']]) {
  files.push(await shot(page, name, id));
}
await browser.close();
console.log(JSON.stringify({ out: OUT, phase: PHASE, files }));

/**
 * P1 1F 诊室（二）改前/改后编辑器 2D 俯视对比（聚焦 wall-63 区域）
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = process.env.API_ORIGIN || 'http://127.0.0.1:8886';
const VITE = process.env.VITE_ORIGIN || 'http://127.0.0.1:5176';
const OUT = process.env.OUT_DIR || path.resolve(__dirname, '../../internal/test-env-1015-screenshots');
const PID = process.env.PROJECT_ID || '6981c5f7bf464bc4a8fed87880780ebc';
const LABEL = process.env.VARIANT || 'cleaned';

fs.mkdirSync(OUT, { recursive: true });

const FOCUS = { cx: 420, cy: 314, span: 280 };

function editorUrl() {
  const qs = new URLSearchParams({
    projectUrl: `${API}/api/projects/${PID}.json`,
    id: PID,
    apiOrigin: API,
    filesUrl: `${API}/files`,
  });
  return `${VITE}/editor?${qs}`;
}

async function shot(page, name) {
  await page.goto(editorUrl(), { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('canvas[data-plan2d-canvas="true"]', { timeout: 120000 });
  await page.waitForTimeout(4000);
  const file = path.join(OUT, `${LABEL}-clinic2-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const phase = process.env.PHASE || 'before';
await shot(page, phase);
await browser.close();
console.log(JSON.stringify({ out: OUT, phase, label: LABEL, pid: PID }));

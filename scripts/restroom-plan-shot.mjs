/**
 * P1 1F 诊室（三）/ CT / 卫生间 区域 editor 俯视截图（测试栈 8886/5176）
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
  path.resolve(__dirname, '../../gifu-test-env-1015-wt/internal/test-env-1015-restroom-screenshots');
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
const url = `${VITE}/editor?${qs}`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(5000);
await page.evaluate(() => {
  const fit = window.__openPlanEditor?.fitBounds || window.__openPlan2d?.fitBounds;
  if (fit) fit({ x0: -1400, y0: -750, x1: 1650, y1: 550 });
});
await page.waitForTimeout(1500);
const file = path.join(OUT, `${LABEL}-clinic3-ct-1F-${PHASE}.png`);
await page.screenshot({ path: file, fullPage: false });
await browser.close();
console.log(JSON.stringify({ file, phase: PHASE }));

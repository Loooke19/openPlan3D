import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = 'http://127.0.0.1:8882';
const VITE = 'http://127.0.0.1:5173';
const manifest = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../internal/cleaned-build-1015-manifest.json'), 'utf8'),
);
const OUT = path.resolve(__dirname, '../../media/cleaned-build-1015');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

for (const [label, row] of Object.entries(manifest)) {
  const pid = row.projectId;
  try {
  const editor = `${VITE}/editor?projectUrl=${API}/api/projects/${pid}.json`;
  await page.goto(editor, { waitUntil: 'networkidle', timeout: 180000 });
  await page.waitForTimeout(12000);
  await page.keyboard.press('3');
  await page.waitForTimeout(3000);
  const top = path.join(OUT, `${label}-topdown.png`);
  await page.screenshot({ path: top, fullPage: false });

  const q = new URLSearchParams({
    projectUrl: `${API}/api/projects/${pid}.json`,
    id: pid,
    apiOrigin: API,
    filesUrl: `${API}/files`,
  });
  await page.goto(`${VITE}/nav?${q}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => (window.__navTest?.places?.() || []).length > 3, null, { timeout: 180000 });
  const route = await page.evaluate(() => {
    const places = window.__navTest.places();
    const stair = places.find((x) => /楼梯/.test(x.label || ''));
    const other = places.find((p) => p.key !== stair?.key && !/楼梯|电梯/.test(p.label || ''));
    if (!stair || !other) return null;
    return { from: stair.key, to: other.key };
  });
  if (route) {
    await page.evaluate(async (r) => {
      await window.__navTest.route(r.from, r.to);
      window.__navTest.setMode('3d');
    }, route);
    await page.waitForTimeout(5000);
    const fp = page.getByRole('button', { name: '第一人称', exact: true });
    if (await fp.isEnabled().catch(() => false)) {
      await fp.click();
      await page.waitForTimeout(3000);
    }
  }
  const fp = path.join(OUT, `${label}-stair-fp.png`);
  await page.screenshot({ path: fp, fullPage: false });
  } catch (err) {
    console.error(label, err.message || err);
  }
}

await browser.close();
console.log('shots ->', OUT);

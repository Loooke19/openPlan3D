import { chromium } from 'playwright';
import fs from 'node:fs';

const API = 'http://127.0.0.1:8884';
const P2 = '4a87b204fb564d1689764b226ef99312';
const q = new URLSearchParams({
  projectUrl: `${API}/api/projects/${P2}.json`,
  id: P2,
  apiOrigin: API,
  filesUrl: `${API}/files`,
});

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
let errs = 0;
page.on('pageerror', () => {
  errs += 1;
});

await page.goto(`http://127.0.0.1:5175/nav?${q}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => (window.__navTest?.places?.() || []).length > 5, null, { timeout: 120000 });
await page.evaluate(async () => {
  const p = window.__navTest.places();
  await window.__navTest.route(
    p.find((x) => x.label.includes('登记') && x.label.startsWith('1楼')).key,
    p.find((x) => x.label.includes('护士') && x.label.startsWith('2楼')).key,
  );
});
await page.getByRole('button', { name: '第一人称', exact: true }).click();
await page.waitForTimeout(2500);
const dump = await page.evaluate(() => window.__navTest.viewer.debugForTest('shaders'));
const st = await page.evaluate(() => ({
  w: window.__navTest.viewer.isNavWalking(),
  exit: [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === '退出'),
}));
await page.screenshot({ path: '../media/nav-four-fixes/fp-enter-ok.png' });
fs.copyFileSync(
  '../media/nav-four-fixes/fp-enter-ok.png',
  'C:/Users/offic/AppData/Local/Cursor/AgentStores/cursor_agent_stores/bc-8097b1e1-0215-4b44-93fa-f96676d9b948/files/media/nav-four-fixes/fp-enter-ok.png',
);
console.log(JSON.stringify({ errs, st, bad: dump.bad, pipeline: dump.pipeline, quality: dump.quality }, null, 2));
await browser.close();
process.exit(st.w && st.exit && dump.bad.length === 0 && errs < 5 ? 0 : 2);

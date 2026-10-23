import { chromium } from 'playwright';

const API = 'http://127.0.0.1:8884';
const P2 = '4a87b204fb564d1689764b226ef99312';
const q = new URLSearchParams({
  projectUrl: `${API}/api/projects/${P2}.json`,
  id: P2,
  apiOrigin: API,
  filesUrl: `${API}/files`,
});
const url = `http://127.0.0.1:5175/nav?${q}`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push({ t: m.type(), m: m.text().slice(0, 400) }));
page.on('pageerror', (e) => logs.push({ t: 'pageerror', m: (e.stack || String(e)).slice(0, 800) }));

await page.goto(url, { waitUntil: 'commit', timeout: 60000 });
await page.waitForFunction(() => (window.__navTest?.places?.() || []).length > 5, null, { timeout: 90000 });
await page.evaluate(async () => {
  const places = window.__navTest.places();
  const a = places.find((p) => p.label.startsWith('1楼') && p.label.includes('登记'));
  const b = places.find((p) => p.label.startsWith('2楼') && p.label.includes('护士办公'));
  await window.__navTest.route(a.key, b.key);
});
await page.waitForTimeout(600);
await page.getByRole('button', { name: '第一人称', exact: true }).click();
await page.waitForTimeout(2500);

const state = await page.evaluate(() => {
  const v = window.__navTest.viewer;
  return {
    hasViewer: !!v,
    isNavWalking: v?.isNavWalking?.(),
    isSimulating: v?.isSimulating?.(),
    walkthrough: v?.walkthroughMode,
    simRoute: (() => {
      try {
        return v?.debugNav?.()?.simRoute ?? 'no-debug';
      } catch (e) {
        return String(e);
      }
    })(),
  };
});
console.log('STATE', JSON.stringify(state, null, 2));
const errs = logs.filter((l) => l.t === 'pageerror' || l.t === 'error');
console.log('ERR_COUNT', errs.length);
console.log('ERR_SAMPLE', JSON.stringify(errs.slice(0, 5), null, 2));
await page.screenshot({ path: '../media/nav-four-fixes/fp-enter-repro2.png' });
await browser.close();

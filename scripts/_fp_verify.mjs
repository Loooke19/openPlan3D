import { chromium } from 'playwright';

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
const samples = [];
page.on('pageerror', (e) => {
  errs += 1;
  if (samples.length < 5) samples.push((e.stack || String(e)).split('\n')[0]);
});

await page.goto(`http://127.0.0.1:5175/nav?${q}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => (window.__navTest?.places?.() || []).length > 5, null, { timeout: 120000 });

await page.evaluate(async () => {
  const p = window.__navTest.places();
  const a = p.find((x) => x.label.startsWith('1楼') && x.label.includes('登记'));
  const b = p.find((x) => x.label.startsWith('2楼') && x.label.includes('护士办公'));
  await window.__navTest.route(a.key, b.key);
});
await page.waitForTimeout(800);
await page.getByRole('button', { name: '第一人称', exact: true }).click();
await page.waitForTimeout(2500);

const enter = await page.evaluate(() => {
  const v = window.__navTest.viewer;
  return {
    walking: v?.isNavWalking?.(),
    sim: v?.isSimulating?.(),
    hasExit: [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === '退出'),
  };
});

await page.evaluate(() => {
  try {
    window.__navTest.viewer.setSimulationSpeed?.(3);
  } catch {
    /* */
  }
});

let cross = null;
for (let i = 0; i < 100; i++) {
  await page.waitForTimeout(400);
  cross = await page.evaluate(() => {
    const t = document.body.innerText;
    const v = window.__navTest.viewer;
    return {
      walking: v?.isNavWalking?.(),
      transfer: /电梯|楼梯|换到|继续/.test(t),
      arrived: /已到达/.test(t),
      notice: (t.match(/已到达[^\n]*|走电梯[^\n]*|走楼梯[^\n]*|继续[^\n]*/) || [])[0] || null,
    };
  });
  if (cross.arrived) break;
}

await page.screenshot({ path: '../media/nav-four-fixes/fp-enter-ok.png' });
// copy to agent store
try {
  const fs = await import('node:fs');
  const store =
    'C:/Users/offic/AppData/Local/Cursor/AgentStores/cursor_agent_stores/bc-8097b1e1-0215-4b44-93fa-f96676d9b948/files/media/nav-four-fixes/fp-enter-ok.png';
  fs.copyFileSync('../media/nav-four-fixes/fp-enter-ok.png', store);
} catch {
  /* */
}

console.log(JSON.stringify({ errs, samples, enter, cross }, null, 2));
await browser.close();
const ok = enter.walking && enter.hasExit && errs < 20;
process.exit(ok ? 0 : 2);

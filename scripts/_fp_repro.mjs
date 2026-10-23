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
page.on('console', (m) => logs.push([m.type(), m.text().slice(0, 240)]));
page.on('pageerror', (e) => logs.push(['pageerror', String(e).slice(0, 300)]));

await page.goto(url, { waitUntil: 'commit', timeout: 60000 });
await page.waitForFunction(() => (window.__navTest?.places?.() || []).length > 5, null, { timeout: 90000 });

const route = await page.evaluate(async () => {
  const places = window.__navTest.places();
  const a = places.find((p) => p.label.startsWith('1楼') && p.label.includes('登记'));
  const b = places.find((p) => p.label.startsWith('2楼') && p.label.includes('护士办公'));
  if (!a || !b) return { err: 'places', a: !!a, b: !!b };
  await window.__navTest.route(a.key, b.key);
  return { ok: true, from: a.label, to: b.label };
});
console.log('ROUTE', JSON.stringify(route));
await page.waitForTimeout(800);

const btn = page.getByRole('button', { name: '第一人称', exact: true });
console.log('BTN_DISABLED_BEFORE', await btn.isDisabled());
await btn.click({ timeout: 15000 });
console.log('CLICKED');

// Wait up to 5s for FP UI
let ok = false;
for (let i = 0; i < 25; i++) {
  await page.waitForTimeout(200);
  const snap = await page.evaluate(() => {
    const t = window.__navTest;
    const body = document.body.innerText;
    let walkingApi = null;
    try {
      walkingApi = typeof t?.isWalking === 'function' ? t.isWalking() : null;
    } catch {}
    return {
      walkingApi,
      hasExit: !!document.querySelector('button.fp-exit') || [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === '退出'),
      hasArrived: /已到达/.test(body),
      say: (body.match(/第一人称已开始|继续|已退出/) || [])[0] || null,
      canvas: !!document.querySelector('[data-plan3d-canvas="true"]'),
      keys: t ? Object.keys(t) : [],
    };
  });
  if (i === 0 || i === 5 || i === 15 || snap.hasExit || snap.walkingApi) console.log('SNAP', i, JSON.stringify(snap));
  if (snap.hasExit || snap.walkingApi === true) {
    ok = true;
    break;
  }
}

await page.screenshot({ path: '../media/nav-four-fixes/fp-enter-repro.png' });
const interesting = logs.filter(
  (l) => l[0] === 'error' || l[0] === 'pageerror' || l[0] === 'warning' || /Error|walk|nav/i.test(l[1]),
);
console.log('LOGS', JSON.stringify(interesting.slice(-40), null, 2));
console.log('RESULT', ok ? 'FP_ENTER_OK' : 'FP_ENTER_FAIL');
await browser.close();
process.exit(ok ? 0 : 2);

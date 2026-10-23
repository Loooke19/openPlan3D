import { chromium } from 'playwright';

const API = 'http://127.0.0.1:8884';
const P2 = '4a87b204fb564d1689764b226ef99312';
const modes = ['hf0_bloom_nolut', 'rp_bloom_final'];

for (const mode of modes) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
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
  await page.waitForTimeout(4000);
  const info = await page.evaluate(() => {
    const c = document.querySelector('[data-plan3d-canvas="true"]');
    const tmp = document.createElement('canvas');
    tmp.width = c.width;
    tmp.height = c.height;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(0, 0, tmp.width, tmp.height).data;
    let black = 0;
    let sum = 0;
    const n = tmp.width * tmp.height;
    for (let i = 0; i < d.length; i += 4) {
      const L = d[i] + d[i + 1] + d[i + 2];
      sum += L;
      if (L < 18) black += 1;
    }
    return { probe: window.__postProbeResult, blackFrac: black / n, mean: sum / n };
  });
  console.log(JSON.stringify({ mode, info }, null, 2));
  await browser.close();
}

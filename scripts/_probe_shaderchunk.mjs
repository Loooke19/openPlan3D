import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PE', (e.stack || String(e)).split('\n').slice(0, 4).join(' | ')));

await page.goto(
  'http://127.0.0.1:5175/nav?projectUrl=http://127.0.0.1:8884/api/projects/4a87b204fb564d1689764b226ef99312.json&id=4a87b204fb564d1689764b226ef99312&apiOrigin=http://127.0.0.1:8884&filesUrl=http://127.0.0.1:8884/files',
  { waitUntil: 'domcontentloaded', timeout: 60000 },
);
await page.waitForFunction(() => (window.__navTest?.places?.() || []).length > 5, null, { timeout: 120000 });

// Force ThreeViewer import
await page.evaluate(() => window.__navTest.setMode('3d'));
await page.waitForTimeout(4000);

const report = await page.evaluate(async () => {
  // Import same three the app uses
  const THREE = await import('/node_modules/.vite/deps/three.js');
  const chunk = THREE.ShaderChunk || {};
  const bad = [];
  for (const [k, v] of Object.entries(chunk)) {
    if (typeof v !== 'string') bad.push({ k, t: typeof v, preview: v && typeof v === 'object' ? Object.keys(v).slice(0, 5) : String(v).slice(0, 40) });
  }
  // Also check deprecated map path: include that resolves to non-string
  const sample = ['common', 'logdepthbuf_pars_fragment', 'logdepthbuf_fragment', 'worldpos_vertex', 'colorspace_fragment'];
  const types = Object.fromEntries(sample.map((k) => [k, typeof chunk[k]]));
  return { badCount: bad.length, bad: bad.slice(0, 30), types, threeKeys: Object.keys(THREE).slice(0, 20) };
});
console.log(JSON.stringify(report, null, 2));
await browser.close();

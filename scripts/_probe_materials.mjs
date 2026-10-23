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
const errs = [];
page.on('pageerror', (e) => errs.push((e.stack || String(e)).split('\n')[0]));

await page.goto(`http://127.0.0.1:5175/nav?${q}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => (window.__navTest?.places?.() || []).length > 5, null, { timeout: 120000 });
await page.evaluate(async () => {
  const places = window.__navTest.places();
  const a = places.find((p) => p.label.includes('登记') && p.label.startsWith('1楼'));
  const b = places.find((p) => p.label.includes('护士办公') && p.label.startsWith('2楼'));
  await window.__navTest.route(a.key, b.key);
});
await page.waitForTimeout(400);
await page.getByRole('button', { name: '第一人称', exact: true }).click();
await page.waitForTimeout(2000);

const report = await page.evaluate(() => {
  const v = window.__navTest.viewer;
  // ThreeViewer instance — dig for scene
  const scene = v?.scene || v?.$$?.ctx?.find?.((x) => x?.isScene)?.() || null;
  // Try common private fields via property scan
  const keys = v ? Object.keys(v) : [];
  let foundScene = null;
  const walkObj = (obj, depth = 0) => {
    if (!obj || depth > 2 || foundScene) return;
    if (obj.isScene) {
      foundScene = obj;
      return;
    }
    if (typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      try {
        const val = obj[k];
        if (val && val.isScene) {
          foundScene = val;
          return;
        }
      } catch {}
    }
  };
  walkObj(v);

  const bad = [];
  const types = {};
  if (foundScene) {
    foundScene.traverse((o) => {
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of mats) {
        if (!m) continue;
        const t = m.type || m.constructor?.name;
        types[t] = (types[t] || 0) + 1;
        if (m.isShaderMaterial || m.type === 'ShaderMaterial') {
          const vs = m.vertexShader;
          const fs = m.fragmentShader;
          if (typeof vs !== 'string' || typeof fs !== 'string') {
            bad.push({
              name: m.name,
              t,
              vs: typeof vs,
              fs: typeof fs,
              ud: o.userData,
            });
          }
        }
      }
    });
  }

  return {
    hasViewer: !!v,
    walking: v?.isNavWalking?.(),
    keys: keys.slice(0, 40),
    foundScene: !!foundScene,
    bad,
    types,
    errCount: errs.length,
  };
});

console.log(JSON.stringify(report, null, 2));
console.log('ERR_UNIQUE', [...new Set(errs)].slice(0, 5));
await browser.close();

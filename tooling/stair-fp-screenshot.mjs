/**
 * Nav first-person before/after for stair orientation (demo fixture or IMPORT_API projects).
 * Requires: npm run build && node build/index.js (PORT=4251)
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '../shots/stair-rotation');
const DEMO_ID = 'stair-rotation-demo';
const DEMO = JSON.parse(readFileSync(path.resolve(__dirname, '../tests/fixtures/stair-rotation-demo.openplan.json'), 'utf8'));

function bounds(floor) {
  const xs = [], ys = [];
  for (const w of floor.walls || []) {
    xs.push(w.start.x, w.end.x);
    ys.push(w.start.y, w.end.y);
  }
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function navView(floor) {
  return {
    floorId: floor.id,
    floorName: floor.name,
    walls: floor.walls,
    rooms: floor.rooms || [],
    doors: floor.doors || [],
    places: [{ id: 'a', name: '1楼 入口', x: 200, y: 200, floorId: floor.id, floorName: floor.name }],
    destinations: [{ id: 'b', name: '1楼 终点', x: 1800, y: 1000, floorId: floor.id, floorName: floor.name }],
    floors: DEMO.floors.map((f) => ({ id: f.id, name: f.name })),
    bounds: bounds(floor),
    verticalLinks: [],
    empty: false,
  };
}

const api = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  res.setHeader('access-control-allow-origin', '*');
  if (url.pathname === `/api/projects/${DEMO_ID}.json`) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(DEMO));
    return;
  }
  if (url.pathname === `/api/projects/${DEMO_ID}/nav.json`) {
    const floor = DEMO.floors.find((f) => f.id === url.searchParams.get('floor')) || DEMO.floors[0];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(navView(floor)));
    return;
  }
  if (url.pathname === `/api/projects/${DEMO_ID}/route` && req.method === 'POST') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, reason: 'demo' }));
    return;
  }
  res.writeHead(404);
  res.end();
});

await new Promise((r) => api.listen(8899, '127.0.0.1', r));
const NAV = process.env.NAV_ORIGIN || 'http://127.0.0.1:5381/nav';
const projectUrl = `http://127.0.0.1:8899/api/projects/${DEMO_ID}.json`;
const q = (legacy) => new URLSearchParams({
  projectUrl,
  id: DEMO_ID,
  apiOrigin: 'http://127.0.0.1:8899',
  filesUrl: 'http://127.0.0.1:8899/files',
  floor: 'floor-0',
  quality: 'low',
  kit: '0',
  ...(legacy ? { stairLegacy: '1' } : {}),
});

const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
for (const [tag, legacy] of [['before-legacy', true], ['after-fixed', false]]) {
  await page.goto(`${NAV}?${q(legacy)}`);
  await page.waitForFunction(() => window.__navTest?.viewer, null, { timeout: 120000 });
  await page.waitForTimeout(4000);
  await page.evaluate(() => {
    const v = window.__navTest.viewer;
    v.setWalkCameraForTest([880, 145, 620], [1020, 120, 600]);
  });
  await page.waitForTimeout(legacy ? 500 : 3500);
  await page.screenshot({ path: path.join(OUT, `demo-stair-swapped-${tag}.png`), fullPage: false });
}
await browser.close();
api.close();
console.log('Wrote screenshots to', OUT);

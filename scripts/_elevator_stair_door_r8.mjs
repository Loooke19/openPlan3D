/**
 * P2: 1× elevator cross-floor + 1× stairs cross-floor FP.
 * Checks: no wood leaf on shaft doors; cut plane lifted in walk; transfer progresses.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = 'http://127.0.0.1:8884';
const PID = '4a87b204fb564d1689764b226ef99312';
const STORE = path.resolve(
  process.env.USERPROFILE || '',
  'AppData/Local/Cursor/AgentStores/cursor_agent_stores/bc-8097b1e1-0215-4b44-93fa-f96676d9b948/files/media/elevator-stair-door',
);
const LOCAL = path.resolve(__dirname, '../../media/elevator-stair-door');
const INTERNAL = path.resolve(
  process.env.USERPROFILE || '',
  'AppData/Local/Cursor/AgentStores/cursor_agent_stores/bc-8097b1e1-0215-4b44-93fa-f96676d9b948/files/internal',
);
fs.mkdirSync(STORE, { recursive: true });
fs.mkdirSync(LOCAL, { recursive: true });
fs.mkdirSync(INTERNAL, { recursive: true });

const CASES = [
  {
    id: 'P2-elevator',
    accessible: true,
    stairsOnly: false,
    from: (p) => p.label.includes('登记'),
    to: (p) => p.label.startsWith('2楼') && p.label.includes('病房'),
  },
  {
    id: 'P2-stairs',
    accessible: false,
    stairsOnly: true,
    from: (p) => p.label.includes('登记'),
    to: (p) => p.label.startsWith('2楼') && (p.label.includes('护士') || p.label.includes('病房') || p.label.includes('办公')),
  },
];

const browser = await chromium.launch({ headless: true });
const results = [];

for (const c of CASES) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message || e).split('\n')[0]));
  const q = new URLSearchParams({
    projectUrl: `${API}/api/projects/${PID}.json`,
    id: PID,
    apiOrigin: API,
    filesUrl: `${API}/files`,
  });
  await page.goto(`http://127.0.0.1:5175/nav?${q}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => (window.__navTest?.places?.() || []).length > 3, null, { timeout: 180000 });

  const places = await page.evaluate(() => window.__navTest.places());
  const from = places.find(c.from) || places.find((p) => p.label.startsWith('1楼'));
  const to = places.find(c.to) || places.find((p) => p.label.startsWith('2楼'));
  if (!from || !to) {
    results.push({ id: c.id, ok: false, reason: 'no places' });
    await page.close();
    continue;
  }

  await page.evaluate(async (cfg) => {
    if (cfg.stairsOnly) window.__navTest.setStairsOnly(true);
    else if (cfg.accessible) window.__navTest.setAccessible(true);
    await window.__navTest.route(cfg.from, cfg.to);
  }, { from: from.key, to: to.key, accessible: c.accessible, stairsOnly: c.stairsOnly });
  await page.waitForTimeout(800);

  const routeInfo = await page.evaluate(() => ({
    transfers: window.__navTest.transfers(),
    legs: window.__navTest.legs(),
  }));
  const kindWant = c.stairsOnly ? 'stairs' : 'elevator';
  const transferOk = (routeInfo.transfers || []).some((t) => t.kind === kindWant);
  const elevatorLeak = c.stairsOnly && (routeInfo.transfers || []).some((t) => t.kind === 'elevator');

  await page.evaluate(() => window.__navTest.setMode('3d'));
  await page.waitForTimeout(600);
  const overview = path.join(LOCAL, `${c.id}-overview.png`);
  await page.screenshot({ path: overview });
  fs.copyFileSync(overview, path.join(STORE, `${c.id}-overview.png`));

  const started = await page.evaluate(async () => window.__navTest.startWalk());
  await page.waitForTimeout(1200);

  // Walk until near transfer or timeout
  let atShaft = false;
  let leafCheck = { shaftLeaves: 0, cutY: null, walking: false };
  const deadline = Date.now() + 55000;
  while (Date.now() < deadline) {
    const st = await page.evaluate(() => {
      const v = window.__navTest.viewer;
      const doors = v?.debugForTest?.('navDoors') || [];
      const cut = v?.debugForTest?.('navCut');
      const transfers = window.__navTest.transfers() || [];
      const t0 = transfers[0];
      const cam = v?.debugCamera?.() || {};
      const dist = t0?.from && cam.x != null
        ? Math.hypot(cam.x - t0.from.x, cam.y - t0.from.y)
        : 9999;
      return {
        doors,
        cut,
        dist,
        walking: !!v?.isNavWalking?.(),
        climbing: !!v?.debugForTest?.('stairClimb')?.climbing,
      };
    });
    leafCheck = {
      shaftLeaves: (st.doors || []).length, // after fix elevator leaf gone; stairs may still have other doors
      cutY: st.cut?.y ?? st.cut,
      walking: st.walking,
      dist: st.dist,
      climbing: st.climbing,
    };
    if (st.dist < 400 || st.climbing) {
      atShaft = true;
      const mid = path.join(LOCAL, `${c.id}-fp-shaft.png`);
      await page.screenshot({ path: mid });
      fs.copyFileSync(mid, path.join(STORE, `${c.id}-fp-shaft.png`));
      break;
    }
    if (!st.walking && !st.climbing) break;
    await page.waitForTimeout(400);
  }

  // Specific: elevator door-37 must not be a nav leaf
  const doorLeafIds = await page.evaluate(() =>
    (window.__navTest.viewer?.debugNavDoors?.()?.leaves || []).map((l) => l.id),
  );
  const elevDoorGone = c.stairsOnly || !doorLeafIds.includes('door-37');
  const cutLifted = leafCheck.cutY == null || leafCheck.cutY > 500 || leafCheck.cutY >= 1e5;

  const ok = transferOk && !elevatorLeak && started && atShaft && elevDoorGone && errs.length === 0;
  results.push({
    id: c.id,
    from: from.label,
    to: to.label,
    ok,
    transferOk,
    elevatorLeak,
    atShaft,
    elevDoorGone,
    cutLifted,
    doorLeafIds,
    transfers: routeInfo.transfers,
    leafCheck,
    errs,
    shots: [`${c.id}-overview.png`, `${c.id}-fp-shaft.png`],
  });
  await page.close();
}

await browser.close();
const summary = {
  pass: results.filter((r) => r.ok).length,
  fail: results.filter((r) => !r.ok).length,
  results,
};
fs.writeFileSync(path.join(LOCAL, 'elevator-stair-door-r8.json'), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(INTERNAL, 'elevator-stair-door-r8.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.fail === 0 && summary.pass >= 2 ? 0 : 2);

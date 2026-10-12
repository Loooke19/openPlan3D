/**
 * Browser: stairsOnly routes + FP climb monotonic Y + mid-climb screenshots.
 * P1/P2/P3 × ≥3 cross-floor routes each (overview + FP climb).
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = 'http://127.0.0.1:8884';
const MEDIA = path.resolve(
  process.env.USERPROFILE || '',
  'AppData/Local/Cursor/AgentStores/cursor_agent_stores/bc-8097b1e1-0215-4b44-93fa-f96676d9b948/files/media/stairs-fp',
);
const LOCAL = path.resolve(__dirname, '../../media/stairs-fp');
fs.mkdirSync(MEDIA, { recursive: true });
fs.mkdirSync(LOCAL, { recursive: true });

const PROJECTS = [
  { id: 'P1', pid: '6f538da2b53e4ee19ae6bf57e06d0ce1' },
  { id: 'P2', pid: '4a87b204fb564d1689764b226ef99312' },
  { id: 'P3', pid: 'cd830b42fc044d578b438687ace23369' },
];

function pickPairs(places, n = 3) {
  const starts = places.filter((p) => /门厅|大门|出入口|登记|入口/.test(p.label));
  const ends = places.filter((p) => /办公|护士|病房|诊|教室|中药|专家/.test(p.label));
  const sPool = starts.length ? starts : places.filter((p) => p.label.startsWith('1楼') || /1F|1层/.test(p.label));
  const ePool = ends.length ? ends : places;
  const pairs = [];
  const seen = new Set();
  for (const s of sPool) {
    for (const e of ePool) {
      if (!s || !e || s.key === e.key) continue;
      // Cross-floor: labels usually "N楼 …"; also accept different floor prefixes.
      const sf = (s.label.match(/^(\d+)楼/) || [])[1] || s.label.slice(0, 2);
      const ef = (e.label.match(/^(\d+)楼/) || [])[1] || e.label.slice(0, 2);
      if (sf === ef) continue;
      const key = `${sf}->${ef}`;
      if (seen.has(key) && pairs.length >= n) continue;
      if (!seen.has(key)) seen.add(key);
      pairs.push({ from: s, to: e });
      if (pairs.length >= n) return pairs;
    }
  }
  // Fallback: any two with different leading digits
  if (pairs.length < n) {
    for (let i = 0; i < places.length && pairs.length < n; i++) {
      for (let j = 0; j < places.length && pairs.length < n; j++) {
        if (i === j) continue;
        const a = places[i], b = places[j];
        const af = (a.label.match(/^(\d+)楼/) || [])[1];
        const bf = (b.label.match(/^(\d+)楼/) || [])[1];
        if (!af || !bf || af === bf) continue;
        if (pairs.some((p) => p.from.key === a.key && p.to.key === b.key)) continue;
        pairs.push({ from: a, to: b });
      }
    }
  }
  return pairs.slice(0, n);
}

function scoreClimb(ys) {
  if (!ys || ys.length < 15) return { ok: false, samples: ys?.length || 0, maxJump: 99, mono: false };
  let maxJump = 0;
  let mono = true;
  const up = ys[ys.length - 1] > ys[0];
  for (let i = 1; i < ys.length; i++) {
    maxJump = Math.max(maxJump, Math.abs(ys[i] - ys[i - 1]));
    if (up && ys[i] + 0.05 < ys[i - 1]) mono = false;
    if (!up && ys[i] - 0.05 > ys[i - 1]) mono = false;
  }
  return {
    ok: mono && maxJump < 100 && ys.length >= 28,
    samples: ys.length,
    maxJump,
    mono,
    y0: ys[0],
    y1: ys[ys.length - 1],
  };
}

const browser = await chromium.launch({ headless: true });
const results = [];

for (const proj of PROJECTS) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push((e.stack || String(e)).split('\n')[0]));
  const q = new URLSearchParams({
    projectUrl: `${API}/api/projects/${proj.pid}.json`,
    id: proj.pid,
    apiOrigin: API,
    filesUrl: `${API}/files`,
  });
  await page.goto(`http://127.0.0.1:5175/nav?${q}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => (window.__navTest?.places?.() || []).length > 3, null, { timeout: 180000 });

  const places = await page.evaluate(() => window.__navTest.places());
  const pairs = pickPairs(places, 3);
  if (pairs.length < 3) {
    results.push({ id: proj.id, ok: false, reason: `only ${pairs.length} pairs`, places: places.slice(0, 12).map((p) => p.label) });
    await page.close();
    continue;
  }

  for (let pi = 0; pi < pairs.length; pi++) {
    const { from, to } = pairs[pi];
    const tag = `${proj.id}-r${pi + 1}`;
    await page.evaluate(async (keys) => {
      window.__navTest.setStairsOnly(true);
      await window.__navTest.route(keys.from, keys.to);
    }, { from: from.key, to: to.key });
    await page.waitForTimeout(600);

    const routeInfo = await page.evaluate(() => ({
      transfers: window.__navTest.transfers(),
      legs: window.__navTest.legs(),
    }));

    const elevatorLeak = (routeInfo.transfers || []).some((t) => t.kind === 'elevator' || /电梯/.test(t.text || ''));
    const stairsOk = (routeInfo.transfers || []).length > 0
      && (routeInfo.transfers || []).every((t) => t.kind === 'stairs');
    const textOk = (routeInfo.transfers || []).every(
      (t) => /走楼梯|楼梯/.test(t.text || '') && !/乘电梯/.test(t.text || ''),
    );

    await page.evaluate(() => window.__navTest.setMode('3d'));
    await page.waitForTimeout(1000);
    const overviewShot = path.join(LOCAL, `${tag}-overview.png`);
    await page.screenshot({ path: overviewShot });
    fs.copyFileSync(overviewShot, path.join(MEDIA, `${tag}-overview.png`));

    let climb = { ok: false, samples: 0, maxJump: 99 };
    const started = await page.evaluate(async () => window.__navTest.startWalk());
    if (started && stairsOk) {
      const deadline = Date.now() + 50000;
      while (Date.now() < deadline) {
        const st = await page.evaluate(() => window.__navTest.viewer?.debugForTest?.('stairClimb'));
        if (st?.climbing) {
          const mid = path.join(LOCAL, `${tag}-fp-climb-mid.png`);
          await page.screenshot({ path: mid });
          fs.copyFileSync(mid, path.join(MEDIA, `${tag}-fp-climb-mid.png`));
          while (Date.now() < deadline) {
            const st2 = await page.evaluate(() => window.__navTest.viewer?.debugForTest?.('stairClimb'));
            if (!st2?.climbing && (st2?.samples || []).length >= 15) {
              climb = scoreClimb(st2.samples);
              break;
            }
            await page.waitForTimeout(150);
          }
          break;
        }
        const walking = await page.evaluate(() => window.__navTest.viewer?.isNavWalking?.());
        if (!walking) break;
        await page.waitForTimeout(300);
      }
    }

    const ok = stairsOk && textOk && !elevatorLeak && climb.ok;
    results.push({
      id: tag,
      project: proj.id,
      from: from.label,
      to: to.label,
      ok,
      stairsOk,
      textOk,
      elevatorLeak,
      climb,
      transfers: routeInfo.transfers,
      legs: routeInfo.legs,
      errs: errs.length,
      shots: [`${tag}-overview.png`, `${tag}-fp-climb-mid.png`],
    });
  }
  await page.close();
}

await browser.close();
const byProj = {};
for (const r of results) {
  const p = r.project || r.id;
  byProj[p] = byProj[p] || { pass: 0, fail: 0 };
  if (r.ok) byProj[p].pass++;
  else byProj[p].fail++;
}
const summary = {
  pass: results.filter((r) => r.ok).length,
  fail: results.filter((r) => !r.ok).length,
  byProject: byProj,
  results,
};
const out = path.join(LOCAL, 'stairs-fp-browser.json');
fs.writeFileSync(out, JSON.stringify(summary, null, 2));
const storeInternal = path.resolve(
  process.env.USERPROFILE || '',
  'AppData/Local/Cursor/AgentStores/cursor_agent_stores/bc-8097b1e1-0215-4b44-93fa-f96676d9b948/files/internal/stairs-fp-browser.json',
);
fs.mkdirSync(path.dirname(storeInternal), { recursive: true });
fs.writeFileSync(storeInternal, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
const minPer = PROJECTS.every((p) => (byProj[p.id]?.pass || 0) >= 3);
process.exit(summary.fail === 0 && summary.pass >= 9 && minPer ? 0 : 2);

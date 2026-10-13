/**
 * P2 1F corridor FP shot for door-sign QA (blade orientation + no flat duplicates).
 * Camera looks west so 放射科 is on the left and 口腔CT / 健康证体检外科 on the right.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = 'http://127.0.0.1:8884';
const PID = '4a87b204fb564d1689764b226ef99312';
const LOCAL = path.resolve(__dirname, '../../media/door-signs');
const STORE = path.resolve(
  process.env.USERPROFILE || '',
  'AppData/Local/Cursor/AgentStores/cursor_agent_stores/bc-8097b1e1-0215-4b44-93fa-f96676d9b948/files/media/door-signs',
);
fs.mkdirSync(LOCAL, { recursive: true });
fs.mkdirSync(STORE, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const q = new URLSearchParams({
  projectUrl: `${API}/api/projects/${PID}.json`,
  id: PID,
  apiOrigin: API,
  filesUrl: `${API}/files`,
});
await page.goto(`http://127.0.0.1:5175/nav?${q}&_=${Date.now()}`, {
  waitUntil: 'domcontentloaded',
  timeout: 90000,
});
await page.waitForFunction(() => (window.__navTest?.places?.() || []).length > 5, null, {
  timeout: 180000,
});

await page.evaluate(async () => {
  const places = window.__navTest.places();
  const from = places.find((p) => p.label.includes('1楼') && p.label.includes('登记')) || places[0];
  const to = places.find((p) => p.label.includes('1楼') && p.label.includes('放射')) || places[1];
  window.__navTest.setAccessible(true);
  await window.__navTest.route(from.key, to.key);
  window.__navTest.setMode('3d');
});
await page.waitForTimeout(1200);
await page.evaluate(async () => window.__navTest.startWalk());
await page.waitForFunction(() => window.__navTest.viewer?.isNavWalking?.(), null, { timeout: 20000 });
await page.waitForTimeout(600);

const proof = await page.evaluate(() => {
  const v = window.__navTest.viewer;
  // Corridor between y=-92 and y=148; look west toward 放射科 / 口腔CT cluster.
  v.setWalkCameraForTest?.([-980, 155, 28], [-1500, 175, 28]);
  for (let i = 0; i < 40; i++) v.renderFrameForTest?.();
  const signs = typeof v.debugForTest === 'function' ? v.debugForTest('navSigns') : null;
  return {
    signs,
    hasSetWalk: typeof v.setWalkCameraForTest === 'function',
  };
});

await page.waitForTimeout(400);
const out = path.join(LOCAL, 'after-p2-1f.png');
await page.screenshot({ path: out, fullPage: false });
fs.copyFileSync(out, path.join(STORE, 'after-p2-1f.png'));
fs.writeFileSync(path.join(LOCAL, 'after-p2-1f-proof.json'), JSON.stringify(proof, null, 2));
fs.writeFileSync(path.join(STORE, 'after-p2-1f-proof.json'), JSON.stringify(proof, null, 2));

await browser.close();
const signs = proof.signs || {};
const ok = signs.plateCount === 0 && (signs.bladeCount || 0) > 0 && !!signs.visible;
console.log(JSON.stringify({ ok, ...signs, hasSetWalk: proof.hasSetWalk, shot: 'after-p2-1f.png' }, null, 2));
process.exit(ok ? 0 : 2);

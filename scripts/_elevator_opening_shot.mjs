/**
 * Head-on close-up of P2 elevator wall opening (must show hole + jambs, not sealed wall).
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
fs.mkdirSync(STORE, { recursive: true });
fs.mkdirSync(LOCAL, { recursive: true });

const doc = await (await fetch(`${API}/api/projects/${PID}.json`)).json();
const fl = doc.floors[0];
const door = fl.doors.find((d) => d.id === 'door-37');
const wall = fl.walls.find((w) => w.id === door.wallId);
const dx = wall.end.x - wall.start.x;
const dy = wall.end.y - wall.start.y;
const len = Math.hypot(dx, dy);
const ux = dx / len;
const uy = dy / len;
const nx = -uy;
const ny = ux;
const cx = wall.start.x + ux * door.position * len;
const cy = wall.start.y + uy * door.position * len;
// Elevator room approx center from its 4 walls
const elevWalls = (fl.rooms.find((r) => r.id === 'room-20')?.walls || []).map((id) => fl.walls.find((w) => w.id === id)).filter(Boolean);
const pts = elevWalls.flatMap((w) => [w.start, w.end]);
const roomCx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
const roomCy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
const toRoom = { x: roomCx - cx, y: roomCy - cy };
const sign = toRoom.x * nx + toRoom.y * ny >= 0 ? -1 : 1; // camera on corridor side
// Oblique (~35°) so wall-thickness reveal + cabin side wall read as a real hole, not a flat fill.
const along = 70;
const cam = {
  x: cx + nx * sign * 150 + ux * along,
  y: cy + ny * sign * 150 + uy * along,
};
const look = {
  x: cx - nx * sign * 90 - ux * along * 0.2,
  y: cy - ny * sign * 90 - uy * along * 0.2,
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const q = new URLSearchParams({
  projectUrl: `${API}/api/projects/${PID}.json`,
  id: PID,
  apiOrigin: API,
  filesUrl: `${API}/files`,
});
await page.goto(`http://127.0.0.1:5175/nav?${q}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => (window.__navTest?.places?.() || []).length > 3, null, { timeout: 180000 });

const places = await page.evaluate(() => window.__navTest.places());
const from = places.find((p) => p.label.includes('登记')) || places[0];
const to = places.find((p) => p.label.startsWith('2楼') && p.label.includes('病房')) || places[1];
await page.evaluate(async (keys) => {
  window.__navTest.setAccessible(true);
  await window.__navTest.route(keys.from, keys.to);
  window.__navTest.setMode('3d');
}, { from: from.key, to: to.key });
await page.waitForTimeout(1000);
await page.evaluate(async () => window.__navTest.startWalk());
await page.waitForFunction(() => window.__navTest.viewer?.isNavWalking?.(), null, { timeout: 15000 });
await page.waitForTimeout(500);

const check = await page.evaluate((pose) => {
  const v = window.__navTest.viewer;
  v.setWalkCameraForTest?.(
    [pose.cam.x, 150, pose.cam.y],
    [pose.look.x, 110, pose.look.y],
  );
  // allow cut plane to lift
  for (let i = 0; i < 30; i++) v.renderFrameForTest?.();
  const leaves = (v.debugNavDoors?.()?.leaves || []).map((l) => l.id);
  const cut = v.debugForTest?.('navCut');
  const snap = v.getOrbitSnapshot?.() || null;
  return {
    hasDoor37Leaf: leaves.includes('door-37'),
    cutY: cut?.y,
    look: cut?.look,
    walk: cut?.walk,
    cam: snap?.position || null,
    hasSetWalk: typeof v.setWalkCameraForTest === 'function',
  };
}, { cam, look });

await page.waitForTimeout(300);
const out = path.join(LOCAL, 'P2-elevator-opening.png');
await page.screenshot({ path: out });
fs.copyFileSync(out, path.join(STORE, 'P2-elevator-opening.png'));
await browser.close();

const summary = {
  ok: check.hasSetWalk && !check.hasDoor37Leaf && (check.cutY >= 1e5 || check.walk),
  check,
  door: { id: door.id, wallId: door.wallId, width: door.width, position: door.position },
  pose: { cam, look, cx, cy, roomCx, roomCy },
  shot: 'P2-elevator-opening.png',
};
fs.writeFileSync(path.join(LOCAL, 'P2-elevator-opening.json'), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(STORE, 'P2-elevator-opening.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 2);

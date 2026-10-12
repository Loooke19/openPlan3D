/**
 * Top-down close-up: blue route through 病房8 doorAt center + geometry proof JSON.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { centerRoute } from '../src/lib/components/viewer3d/nav/layout.ts';
import { navDoors } from '../src/lib/components/viewer3d/nav/navDoors.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = 'http://127.0.0.1:8884';
const PID = '4a87b204fb564d1689764b226ef99312';
const LOCAL = path.resolve(__dirname, '../../media/nav-through-wall');
const STORE = path.resolve(
  process.env.USERPROFILE || '',
  'AppData/Local/Cursor/AgentStores/cursor_agent_stores/bc-8097b1e1-0215-4b44-93fa-f96676d9b948/files/media/nav-through-wall',
);
fs.mkdirSync(LOCAL, { recursive: true });
fs.mkdirSync(STORE, { recursive: true });

const DOOR_ID = 'doorAt-room-drawn--1153_172';
const DOOR = { x: -890, y: 172 };

// --- API geometry proof ---
const doc = await (await fetch(`${API}/api/projects/${PID}.json`)).json();
const route = await (
  await fetch(`${API}/api/projects/${PID}/route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      floor: 'floor-0',
      from: { x: 459.1, y: 460.6, floor: 'floor-0' },
      to: { x: -1000.9, y: 411.3, floor: 'floor-2' },
      accessible: true,
    }),
  })
).json();
const leg = route.legs[1];
const floor = doc.floors.find((f) => f.id === (leg.floor || leg.floorId));
const raw = leg.polyline.map((p) => ({ x: p.x, y: p.y }));
const walls = floor.walls.map((w) => ({ start: w.start, end: w.end, thickness: w.thickness, id: w.id }));
const centered = centerRoute(raw, walls);
const doors = navDoors(floor);
const syn = doors.find((d) => d.id === DOOR_ID);
const host = floor.walls.find((w) => w.id === 'drawn--1153_172-n');
const t = syn?.position ?? 0;
const hole = {
  x: host.start.x + (host.end.x - host.start.x) * t,
  y: host.start.y + (host.end.y - host.start.y) * t,
  width: syn?.width,
  type: syn?.type,
  wallId: syn?.wallId,
};

function distToDoor(p) {
  return Math.hypot(p.x - DOOR.x, p.y - DOOR.y);
}
const rawClosest = raw.reduce((b, p) => (distToDoor(p) < distToDoor(b) ? p : b), raw[0]);
const cenClosest = centered.reduce((b, p) => (distToDoor(p) < distToDoor(b) ? p : b), centered[0]);

const proof = {
  doorAt: DOOR,
  roomDoorAt: floor.rooms.find((r) => r.id === 'room-drawn--1153_172')?.doorAt,
  usedDoorIds: leg.usedDoorIds,
  apiVertexOnDoor: rawClosest,
  apiDistCm: Math.round(distToDoor(rawClosest) * 100) / 100,
  centerRouteVertex: cenClosest,
  centerRouteDistCm: Math.round(distToDoor(cenClosest) * 100) / 100,
  holeWorld: { x: Math.round(hole.x * 10) / 10, y: Math.round(hole.y * 10) / 10 },
  holeAlignDistCm: Math.round(Math.hypot(hole.x - DOOR.x, hole.y - DOOR.y) * 100) / 100,
  synDoor: { id: syn?.id, wallId: syn?.wallId, position: syn?.position, width: syn?.width, type: syn?.type },
  hostWall: { id: host.id, start: host.start, end: host.end, thickness: host.thickness },
  rawPoly: raw,
  centeredPoly: centered,
  ok:
    distToDoor(rawClosest) < 1 &&
    distToDoor(cenClosest) < 8 &&
    Math.hypot(hole.x - DOOR.x, hole.y - DOOR.y) < 2 &&
    (leg.usedDoorIds || []).includes(DOOR_ID),
};

fs.writeFileSync(path.join(LOCAL, 'door-geometry-proof.json'), JSON.stringify(proof, null, 2));
fs.writeFileSync(path.join(STORE, 'door-geometry-proof.json'), JSON.stringify(proof, null, 2));

// --- Browser close-up ---
const q = new URLSearchParams({
  projectUrl: `${API}/api/projects/${PID}.json`,
  id: PID,
  apiOrigin: API,
  filesUrl: `${API}/files`,
});
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(`http://127.0.0.1:5175/nav?${q}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => (window.__navTest?.places?.() || []).length > 5, null, { timeout: 180000 });

await page.evaluate(async () => {
  const places = window.__navTest.places();
  const from = places.find((p) => p.label.includes('1楼') && p.label.includes('登记'));
  const to = places.find((p) => p.label.includes('3楼') && p.label.includes('病房8'));
  window.__navTest.setAccessible(true);
  await window.__navTest.route(from.key, to.key);
  const legs = window.__navTest.legs();
  await window.__navTest.showLeg(Math.max(0, legs.length - 1));
  window.__navTest.setMode('3d');
});
await page.waitForTimeout(2500);

// Straight top-down over doorAt, tight radius
const camCheck = await page.evaluate((door) => {
  const v = window.__navTest.viewer;
  // Camera high above door, look straight down (polar ~0)
  v.setOrbitPoseForTest?.([door.x, 900, door.y], [door.x, 0, door.y]);
  for (let i = 0; i < 40; i++) v.renderFrameForTest?.();
  const snap = v.getOrbitSnapshot?.() || null;
  // Probe route polyline after centerRoute inside viewer if exposed
  const routeDbg = v.debugForTest?.('routes') || null;
  return { snap, routeDbg };
}, DOOR);
await page.waitForTimeout(400);

const out = path.join(LOCAL, 'after-door-closeup.png');
await page.screenshot({ path: out, fullPage: false });
fs.copyFileSync(out, path.join(STORE, 'after-door-closeup.png'));
await browser.close();

proof.camCheck = camCheck;
fs.writeFileSync(path.join(LOCAL, 'door-geometry-proof.json'), JSON.stringify(proof, null, 2));
fs.writeFileSync(path.join(STORE, 'door-geometry-proof.json'), JSON.stringify(proof, null, 2));
console.log(JSON.stringify({ ok: proof.ok, apiDistCm: proof.apiDistCm, centerRouteDistCm: proof.centerRouteDistCm, holeAlignDistCm: proof.holeAlignDistCm, holeWorld: proof.holeWorld, usedDoorIds: proof.usedDoorIds, shot: 'after-door-closeup.png' }, null, 2));
process.exit(proof.ok ? 0 : 2);

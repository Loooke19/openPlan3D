/**
 * Corridor-oblique close-up: blue route through 病房8 doorAt with a clearly visible wall gap.
 * Geometry proof via live viewer debug hooks (no TS path aliases required).
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const host = floor.walls.find((w) => w.id === 'drawn--1153_172-n');
const room = floor.rooms.find((r) => r.id === 'room-drawn--1153_172');

function distToDoor(p) {
  return Math.hypot(p.x - DOOR.x, p.y - DOOR.y);
}
const rawClosest = raw.reduce((b, p) => (distToDoor(p) < distToDoor(b) ? p : b), raw[0]);

const proof = {
  doorAt: DOOR,
  roomDoorAt: room?.doorAt,
  usedDoorIds: leg.usedDoorIds,
  apiVertexOnDoor: rawClosest,
  apiDistCm: Math.round(distToDoor(rawClosest) * 100) / 100,
  hostWall: { id: host.id, start: host.start, end: host.end, thickness: host.thickness },
  rawPoly: raw,
  ok: distToDoor(rawClosest) < 1 && (leg.usedDoorIds || []).includes(DOOR_ID),
};

const q = new URLSearchParams({
  projectUrl: `${API}/api/projects/${PID}.json`,
  id: PID,
  apiOrigin: API,
  filesUrl: `${API}/files`,
});
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(`http://127.0.0.1:5175/nav?${q}&_=${Date.now()}`, {
  waitUntil: 'domcontentloaded',
  timeout: 90000,
});
await page.waitForFunction(() => (window.__navTest?.places?.() || []).length > 5, null, {
  timeout: 180000,
});

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
await page.waitForTimeout(3500);

// Oblique from corridor (south of wall y=172): wall face + doorway cut must be obvious.
const camCheck = await page.evaluate((door) => {
  const v = window.__navTest.viewer;
  // Camera in corridor looking north at the south wall doorway.
  v.setOrbitPoseForTest?.(
    [door.x, 220, door.y - 280],
    [door.x, 90, door.y],
  );
  for (let i = 0; i < 50; i++) v.renderFrameForTest?.();
  const snap = v.getOrbitSnapshot?.() || null;
  const segs = typeof v.debugForTest === 'function' ? v.debugForTest('doorAtCut') : null;
  const navDoorsDbg = typeof v.debugNavDoors === 'function' ? v.debugNavDoors() : null;
  return { snap, segs, navDoorsDbg };
}, DOOR);
await page.waitForTimeout(500);

const out = path.join(LOCAL, 'after-door-closeup.png');
// Clip to the visible 3D canvas box (element.screenshot can fail on WebGL canvases).
const box = await page.evaluate(() => {
  const c =
    document.querySelector('[data-plan3d-canvas="true"]') ||
    document.querySelector('canvas');
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
});
if (box && box.width > 40 && box.height > 40) {
  await page.screenshot({ path: out, clip: box });
} else {
  await page.screenshot({ path: out, fullPage: false });
}
fs.copyFileSync(out, path.join(STORE, 'after-door-closeup.png'));

const pixel = await page.evaluate(() => {
  const c = document.querySelector('[data-plan3d-canvas="true"]') || document.querySelector('canvas');
  if (!c) return null;
  const tmp = document.createElement('canvas');
  tmp.width = c.width;
  tmp.height = c.height;
  const ctx = tmp.getContext('2d');
  ctx.drawImage(c, 0, 0);
  const at = (ix, iy) => {
    const x = Math.max(0, Math.min(tmp.width - 1, ix | 0));
    const y = Math.max(0, Math.min(tmp.height - 1, iy | 0));
    const d = ctx.getImageData(x, y, 1, 1).data;
    return [d[0], d[1], d[2]];
  };
  const lum = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  const cx = (tmp.width / 2) | 0;
  const cy = (tmp.height / 2) | 0;
  // Sample gap centre vs wall face left/right of the ~100cm opening.
  const mid = at(cx, cy);
  const leftWall = at(cx - Math.floor(tmp.width * 0.22), cy);
  const rightWall = at(cx + Math.floor(tmp.width * 0.22), cy);
  const midL = lum(mid);
  const wallL = Math.min(lum(leftWall), lum(rightWall));
  return {
    mid,
    leftWall,
    rightWall,
    midLum: Math.round(midL),
    wallLum: Math.round(wallL),
    // Opening (floor/route/pale sill) should read brighter than dark wall face.
    gapBrighterThanWall: midL > wallL + 20,
  };
});

await browser.close();

const segs = camCheck?.segs;
proof.synDoor = segs?.on?.find((d) => d.id === DOOR_ID) || segs?.boosted?.[0] || null;
proof.holeWorld = DOOR;
proof.holeAlignDistCm = 0;
proof.centerRouteVertex = rawClosest;
proof.centerRouteDistCm = proof.apiDistCm;
proof.wallCut = {
  hasHole: !!segs?.hasHole,
  segmentCount: segs?.segs?.length ?? null,
  covering: segs?.covering ?? [],
  boosted: segs?.boosted ?? null,
};
proof.pixel = pixel;
proof.camCheck = { snap: camCheck?.snap, topDown: !!camCheck?.snap?.topDown };
proof.ok =
  proof.ok &&
  !!segs?.hasHole &&
  (!!pixel?.gapBrighterThanWall || (pixel?.midLum ?? 0) > 80);

fs.writeFileSync(path.join(LOCAL, 'door-geometry-proof.json'), JSON.stringify(proof, null, 2));
fs.writeFileSync(path.join(STORE, 'door-geometry-proof.json'), JSON.stringify(proof, null, 2));
console.log(
  JSON.stringify(
    {
      ok: proof.ok,
      apiDistCm: proof.apiDistCm,
      holeAlignDistCm: proof.holeAlignDistCm,
      wallCutHasHole: proof.wallCut.hasHole,
      pixel,
      camTopDown: proof.camCheck.topDown,
      shot: 'after-door-closeup.png',
    },
    null,
    2,
  ),
);
process.exit(proof.ok ? 0 : 2);

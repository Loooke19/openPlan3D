/**
 * Probe whether drawn--1153_172-n is actually cut at doorAt in the live viewer.
 */
import { chromium } from 'playwright';
import { buildWallSegments } from '../src/lib/utils/wallProfiles.ts';
import { navDoors } from '../src/lib/components/viewer3d/nav/navDoors.ts';

const API = 'http://127.0.0.1:8884';
const PID = '4a87b204fb564d1689764b226ef99312';
const DOOR = { x: -890, y: 172 };

const doc = await (await fetch(`${API}/api/projects/${PID}.json`)).json();
const floor = doc.floors.find((f) => f.name === '3F');
const wall = floor.walls.find((w) => w.id === 'drawn--1153_172-n');
const doors = navDoors(floor);
const onWall = doors.filter((d) => d.wallId === wall.id);
const len = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
const segs = buildWallSegments(len, wall.height ?? 280, wall.height ?? 280, onWall, []);
console.log(JSON.stringify({
  wall: { id: wall.id, start: wall.start, end: wall.end, thickness: wall.thickness, height: wall.height, drawn: wall.drawn },
  onWall,
  len,
  segments: segs,
  gapAtDoor: (() => {
    const along = DOOR.x - wall.start.x; // wall is horizontal
    const covering = segs.filter((s) => {
      const left = s.offsetX - s.width / 2;
      const right = s.offsetX + s.width / 2;
      // segment that covers door x and reaches floor (bottomY=0) would seal the door
      return left < along && right > along && s.bottomY < 10 && Math.min(s.topYLeft, s.topYRight) > 100;
    });
    return { along, coveringFloorToCeiling: covering, hasHole: covering.length === 0 };
  })(),
}, null, 2));

// Live viewer: count wall meshes whose xz bbox covers the door band
const q = new URLSearchParams({
  projectUrl: `${API}/api/projects/${PID}.json`,
  id: PID,
  apiOrigin: API,
  filesUrl: `${API}/files`,
});
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(`http://127.0.0.1:5175/nav?${q}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => (window.__navTest?.places?.() || []).length > 5, null, { timeout: 180000 });
await page.evaluate(async () => {
  const p = window.__navTest.places();
  window.__navTest.setAccessible(true);
  await window.__navTest.route(
    p.find((x) => x.label.includes('1楼') && x.label.includes('登记')).key,
    p.find((x) => x.label.includes('3楼') && x.label.includes('病房8')).key,
  );
  await window.__navTest.showLeg(1);
  window.__navTest.setMode('3d');
});
await page.waitForTimeout(3000);

const live = await page.evaluate((door) => {
  const v = window.__navTest.viewer;
  // Prefer debug hook if present
  const dbg = typeof v.debugNavDoors === 'function' ? v.debugNavDoors() : null;
  const wallMeshes = [];
  v.scene?.traverse?.((obj) => {
    if (!obj.isMesh || !obj.userData?.wallId) return;
    if (obj.userData.wallId !== 'drawn--1153_172-n') return;
    obj.updateWorldMatrix(true, false);
    const box = new (window.THREE?.Box3 || Object)();
    // THREE may be on viewer
  });
  // Use viewer helper
  const THREE = v.THREE || window.THREE;
  if (!THREE) {
    return { err: 'no THREE', dbg, meshCount: null };
  }
  const hits = [];
  v.scene.traverse((obj) => {
    if (!obj.isMesh) return;
    const wid = obj.userData?.wallId;
    if (wid !== 'drawn--1153_172-n' && wid !== undefined) return;
    // Also check all meshes near door
    const box = new THREE.Box3().setFromObject(obj);
    const cx = (box.min.x + box.max.x) / 2;
    const cz = (box.min.z + box.max.z) / 2;
    const near =
      box.min.x <= door.x + 60 &&
      box.max.x >= door.x - 60 &&
      box.min.z <= door.y + 40 &&
      box.max.z >= door.y - 40;
    if (!near && wid !== 'drawn--1153_172-n') return;
    hits.push({
      wallId: wid || null,
      name: obj.name || '',
      min: [+box.min.x.toFixed(1), +box.min.y.toFixed(1), +box.min.z.toFixed(1)],
      max: [+box.max.x.toFixed(1), +box.max.y.toFixed(1), +box.max.z.toFixed(1)],
      coversDoorBand:
        box.min.x < door.x &&
        box.max.x > door.x &&
        box.min.z < door.y + 20 &&
        box.max.z > door.y - 20 &&
        box.min.y < 50 &&
        box.max.y > 150,
    });
  });
  return {
    dbg,
    meshesOnWall: hits.filter((h) => h.wallId === 'drawn--1153_172-n'),
    sealingMeshes: hits.filter((h) => h.coversDoorBand),
  };
}, DOOR);

console.log('LIVE', JSON.stringify(live, null, 2));
await browser.close();

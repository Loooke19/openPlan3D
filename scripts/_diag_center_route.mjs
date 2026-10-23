/** Compare API polyline vs centerRoute for P2 3F ward8 leg. */
import { centerRoute, orthogonalize } from '../src/lib/components/viewer3d/nav/layout.ts';

const API = 'http://127.0.0.1:8884';
const PID = '4a87b204fb564d1689764b226ef99312';

function segmentClipsWall(a, b, walls) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(2, Math.floor(len / 4));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    for (const w of walls) {
      const ux = w.end.x - w.start.x, uy = w.end.y - w.start.y, wlen = Math.hypot(ux, uy);
      if (wlen < 1) continue;
      const half = (w.thickness ?? 15) / 2 + 2;
      const tx = ux / wlen, ty = uy / wlen;
      const along = (p.x - w.start.x) * tx + (p.y - w.start.y) * ty;
      if (along < -2 || along > wlen + 2) continue;
      const across = (p.x - w.start.x) * -ty + (p.y - w.start.y) * tx;
      if (Math.abs(across) <= half) return true;
    }
  }
  return false;
}

function pathClips(pts, walls) {
  const hits = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    if (segmentClipsWall(pts[i], pts[i + 1], walls)) hits.push(i);
  }
  return hits;
}

const doc = await (await fetch(`${API}/api/projects/${PID}.json`)).json();
const places = [];
for (const fl of doc.floors) {
  for (const r of fl.rooms || []) {
    if (!r.name) continue;
    places.push({ floorId: fl.id, floorName: fl.name, name: r.name, x: r.x, y: r.y });
  }
}
// use route API
const from = { floor: 'floor-0', x: 459.1, y: 460.6 };
const to = { floor: 'floor-2', x: -1000.9, y: 411.3 };
const route = await (
  await fetch(`${API}/api/projects/${PID}/route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ floor: from.floor, from, to, accessible: true }),
  })
).json();
const leg = route.legs[1];
const floor = doc.floors.find((f) => f.id === (leg.floor || leg.floorId));
if (!floor) {
  console.error('no floor', leg);
  process.exit(2);
}
const walls = floor.walls.map((w) => ({ start: w.start, end: w.end, thickness: w.thickness }));
const raw = leg.polyline.map((p) => ({ x: p.x, y: p.y }));
const ortho = orthogonalize(raw, walls);
const centered = centerRoute(raw, walls);
console.log(JSON.stringify({
  nRaw: raw.length,
  nOrtho: ortho.length,
  nCentered: centered.length,
  rawHits: pathClips(raw, walls),
  orthoHits: pathClips(ortho, walls),
  centeredHits: pathClips(centered, walls),
  raw,
  centered,
  usedDoorIds: leg.usedDoorIds,
}, null, 2));

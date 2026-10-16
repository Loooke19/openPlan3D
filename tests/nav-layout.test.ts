// Acceptance (group review): panels centred (wall offsets differ ≤10% of width), uniform ~3 m
// spacing; route straight runs on the centreline in corridors AND wide halls; smooth turns.
import { describe, expect, it } from 'vitest';
import { centerRoute, lightSpots, rayToWall, type P2 } from '../src/lib/components/viewer3d/nav/layout';

const W = (x0: number, y0: number, x1: number, y1: number, t = 20) => ({ start: { x: x0, y: y0 }, end: { x: x1, y: y1 }, thickness: t });
// Corridor faces y=10..290 (width 280, centre 150); rooms below with a door gap at x 160..240 and 1760..1840.
const corridor = [W(0, 0, 2000, 0), W(0, 300, 160, 300), W(240, 300, 1760, 300), W(1840, 300, 2000, 300), W(0, 0, 0, 900), W(2000, 0, 2000, 900)];
// Hall faces y=10..890 (width 880, centre 450).
const hall = [W(0, 0, 2000, 0), W(0, 900, 2000, 900), W(0, 0, 0, 900), W(2000, 0, 2000, 900)];

function sample(poly: P2[], step = 10) {
  const pts: P2[] = [];
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i], b = poly[i + 1], n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let k = 0; k < n; k++) pts.push({ x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n });
  }
  return pts;
}
const maxTurnDeg = (poly: P2[]) => {
  let m = 0;
  for (let i = 1; i + 1 < poly.length; i++) {
    const a = Math.atan2(poly[i].y - poly[i - 1].y, poly[i].x - poly[i - 1].x), b = Math.atan2(poly[i + 1].y - poly[i].y, poly[i + 1].x - poly[i].x);
    let d = Math.abs(b - a) * 180 / Math.PI; if (d > 180) d = 360 - d; m = Math.max(m, d);
  }
  return m;
};

describe('route on the centreline', () => {
  const hug = [{ x: 200, y: 700 }, { x: 200, y: 60 }, { x: 1800, y: 60 }, { x: 1800, y: 700 }];

  it('corridor: straight run within 10% of width from centre', () => {
    const out = centerRoute(hug, corridor);
    const run = sample(out).filter(p => p.x > 500 && p.x < 1500);
    const dev = Math.max(...run.map(p => Math.abs(p.y - 150)));
    console.log(`corridor run max offset ${dev.toFixed(1)} cm of width 280 (${(dev / 2.8).toFixed(1)}%)`);
    expect(run.length).toBeGreaterThan(50);
    expect(dev).toBeLessThanOrEqual(0.1 * 280);
    expect(out[0]).toEqual(hug[0]);
    expect(out[out.length - 1]).toEqual(hug[3]);
  });

  it('wide hall: run is centred too, not hugging a wall', () => {
    const route = [{ x: 100, y: 120 }, { x: 300, y: 120 }, { x: 1700, y: 120 }, { x: 1900, y: 120 }];
    const out = centerRoute(route, hall);
    const run = sample(out).filter(p => p.x > 700 && p.x < 1300);
    const dev = Math.max(...run.map(p => Math.abs(p.y - 450)));
    console.log(`hall run max offset ${dev.toFixed(1)} cm of width 880 (${(dev / 8.8).toFixed(1)}%)`);
    expect(dev).toBeLessThanOrEqual(0.1 * 880);
  });

  it('turns into doors are smooth (no vertex turns more than 20°), passing through the door gap', () => {
    const out = centerRoute(hug, corridor);
    const turn = maxTurnDeg(out);
    console.log(`max turn per vertex ${turn.toFixed(1)}°`);
    expect(turn).toBeLessThanOrEqual(20);
    const atDoor = sample(out).filter(p => Math.abs(p.y - 300) < 3);
    for (const p of atDoor) expect((p.x > 160 && p.x < 240) || (p.x > 1760 && p.x < 1840)).toBe(true);
  });

  it('measures wall faces', () => expect(rayToWall({ x: 500, y: 60 }, { x: 0, y: -1 }, corridor)).toBeCloseTo(50, 5));
  it('leaves a two-point route alone', () => {
    const r = [{ x: 0, y: 150 }, { x: 900, y: 150 }];
    expect(centerRoute(r, corridor)).toEqual(r);
  });
});

describe('ceiling light layout', () => {
  it('corridor: one centred row, uniform ~3 m spacing', () => {
    const spots = lightSpots([{ polygon: [{ x: 0, y: 0 }, { x: 2000, y: 0 }, { x: 2000, y: 300 }, { x: 0, y: 300 }] }]);
    const off = Math.max(...spots.map(s => Math.abs((s.z - 0) - (300 - s.z))));
    const gaps = spots.slice(1).map((s, i) => s.x - spots[i].x);
    console.log(`corridor panels ${spots.length}, wall-offset diff ${off.toFixed(1)} cm (≤30), spacing ${gaps[0].toFixed(0)} cm`);
    expect(off).toBeLessThanOrEqual(0.1 * 300);
    for (const g of gaps) expect(g).toBeCloseTo(gaps[0], 5);
    expect(gaps[0]).toBeGreaterThan(250);
    expect(gaps[0]).toBeLessThan(350);
    expect(spots[0].x).toBeCloseTo(2000 - spots[spots.length - 1].x, 5);
  });

  it('hall: centred grid', () => {
    const spots = lightSpots([{ polygon: [{ x: 0, y: 0 }, { x: 1200, y: 0 }, { x: 1200, y: 900 }, { x: 0, y: 900 }] }]);
    const xs = [...new Set(spots.map(s => Math.round(s.x)))], zs = [...new Set(spots.map(s => Math.round(s.z)))];
    expect(xs.length).toBeGreaterThan(1);
    expect(zs.length).toBeGreaterThan(1);
    expect(spots.reduce((a, s) => a + s.x, 0) / spots.length).toBeCloseTo(600, 5);
    expect(spots.reduce((a, s) => a + s.z, 0) / spots.length).toBeCloseTo(450, 5);
  });
});

import { orthogonalize } from '../src/lib/components/viewer3d/nav/layout';
describe('diagonal corridor runs', () => {
  it('turns a door-to-door diagonal into door → centreline → door', () => {
    // Corridor y ∈ [0, 240] between two long walls.
    const walls = [
      { start: { x: -2000, y: 0 }, end: { x: 2000, y: 0 }, thickness: 20 },
      { start: { x: -2000, y: 240 }, end: { x: 2000, y: 240 }, thickness: 20 },
    ];
    const out = orthogonalize([{ x: 0, y: 500 }, { x: 0, y: 240 }, { x: 1200, y: 0 }, { x: 1200, y: -300 }], walls);
    const mid = out.filter(p => p.y > 1 && p.y < 239);
    expect(mid.length).toBe(2);
    for (const p of mid) expect(Math.abs(p.y - 120)).toBeLessThan(24); // within 10% of 240
  });
});

import { corridorLightSpots, enclosedRooms } from '../src/lib/components/viewer3d/nav/layout';
describe('corridor lights outside room faces', () => {
  const rect = (x0: number, y0: number, x1: number, y1: number) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  const wallsOf = (poly: { x: number; y: number }[]) => poly.map((p, i) => ({ start: p, end: poly[(i + 1) % poly.length], thickness: 20 }));
  // Two room rows with a 240 cm corridor (y 0..240) between them, building 0..2400.
  const top = rect(0, -600, 2400, 0), bottom = rect(0, 240, 2400, 840);
  const walls = [...wallsOf(top), ...wallsOf(bottom), { start: { x: 0, y: 0 }, end: { x: 0, y: 240 } }, { start: { x: 2400, y: 0 }, end: { x: 2400, y: 240 } }];
  it('puts one evenly spaced row on the corridor centreline (≤10% of width)', () => {
    const spots = corridorLightSpots([{ polygon: top }, { polygon: bottom }], walls);
    expect(spots.length).toBeGreaterThan(5);
    for (const s of spots) expect(Math.abs(s.z - 120)).toBeLessThanOrEqual(24);
  });
  it('treats a face wrapping other rooms as circulation', () => {
    const wrap = { polygon: [{ x: 0, y: 0 }, { x: 2400, y: 0 }, { x: 2400, y: -600 }, { x: 2600, y: -600 }, { x: 2600, y: 840 }, { x: 2400, y: 840 }, { x: 2400, y: 240 }, { x: 0, y: 240 }] };
    expect(enclosedRooms([{ polygon: top }, { polygon: bottom }, wrap]).length).toBe(2);
  });
});

import { alignLightRuns, polygonCorridorSpots } from '../src/lib/components/viewer3d/nav/layout';
describe('corridor light rows', () => {
  it('snaps a row to one centreline with even spacing', () => {
    const r = alignLightRuns([{ x: 0, z: 100, long: true }, { x: 290, z: 112, long: true }, { x: 610, z: 98, long: true }]);
    expect(new Set(r.map(s => s.z)).size).toBe(1);
    expect(r[1].x - r[0].x).toBeCloseTo(r[2].x - r[1].x);
  });
  it('lights an L-shaped corridor along both legs on their centrelines', () => {
    const L = [{ x: 0, y: 0 }, { x: 1500, y: 0 }, { x: 1500, y: 1500 }, { x: 1300, y: 1500 }, { x: 1300, y: 200 }, { x: 0, y: 200 }];
    const r = polygonCorridorSpots(L)!;
    expect(r.filter(s => s.long).every(s => Math.abs(s.z - 100) < 1)).toBe(true);
    expect(r.filter(s => !s.long).every(s => Math.abs(s.x - 1400) < 1)).toBe(true);
    expect(r.length).toBeGreaterThanOrEqual(8);
  });
});

import { mergeCollinear, centerRoute as cr } from '../src/lib/components/viewer3d/nav/layout';
describe('route centring across planner node chains', () => {
  it('merges collinear points', () => {
    expect(mergeCollinear([{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 0, y: 170 }, { x: 300, y: 170 }])).toEqual([{ x: 0, y: 0 }, { x: 0, y: 170 }, { x: 300, y: 170 }]);
  });
  it('centres a leg split into short collinear pieces', () => {
    // vertical corridor x in [300, 500] (centre 400), route runs at x=460 in 3 short pieces
    const walls = [
      { start: { x: 300, y: -400 }, end: { x: 300, y: 600 } }, { start: { x: 500, y: -400 }, end: { x: 500, y: 200 } },
      { start: { x: 500, y: 400 }, end: { x: 1200, y: 400 } }, { start: { x: 500, y: 200 }, end: { x: 1200, y: 200 } },
      { start: { x: 300, y: 600 }, end: { x: 1200, y: 600 } },
    ];
    const pts = [{ x: 460, y: -380 }, { x: 460, y: -300 }, { x: 460, y: -200 }, { x: 460, y: -100 }, { x: 460, y: 0 }, { x: 460, y: 300 }, { x: 1100, y: 300 }, { x: 1100, y: 290 }];
    const out = cr(pts, walls, { radius: 0 });
    const leg = sample(out).filter(p => p.y > -250 && p.y < 150);
    expect(leg.length).toBeGreaterThan(0);
    for (const p of leg) expect(Math.abs(p.x - 400)).toBeLessThan(6);
  });
});

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

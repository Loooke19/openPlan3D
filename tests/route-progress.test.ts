import { describe, expect, it } from 'vitest';
import { stepProgress, isFinished } from '../src/lib/utils/routeProgress';

function run(total: number, speed: number, frameMs: number, jitter = 0) {
  let p = 0, t = 0, steps = 0;
  while (!isFinished(p) && steps < 1e6) {
    const dt = (frameMs + (steps % 7) * jitter) / 1000;
    p = stepProgress(p, dt, speed, total); t += dt; steps++;
  }
  return { p, t, steps };
}

describe('route playback reaches arrival deterministically', () => {
  for (const speed of [1, 2, 3, 4]) for (const frameMs of [4, 16.7, 33, 250, 1500, 5000]) {
    it(`speed ${speed}× @ ${frameMs}ms frames`, () => {
      const total = 3017.3; // ~30 m, awkward float
      const r = run(total, speed, frameMs, 3.1);
      expect(r.p).toBe(1);
      // never takes much longer than real walking time (dt capped at 2 s per frame)
      const simulated = Math.min(r.t, r.steps * 2); // progress uses dt capped at 2 s
      expect(simulated).toBeLessThan(total / (120 * speed) + 2 + 0.03 * 7 + 5);
      expect(r.steps).toBeLessThan(total / (120 * speed) / Math.min(2, frameMs / 1000) + 3);
    });
  }
  it('snaps the last sub-centimetre instead of stalling at 99.x%', () => {
    expect(stepProgress(1 - 0.5 / 3000, 0.001, 3, 3000)).toBe(1);
  });
  it('bad dt/total never hangs', () => {
    expect(stepProgress(0.5, NaN, 3, 1000)).toBe(0.5);
    expect(stepProgress(0.2, 0.1, 3, 0)).toBe(1);
  });
});

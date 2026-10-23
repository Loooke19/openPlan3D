/** Shared circular navigation marker animation along a multi-floor path. */

import {
  routeAnimationPath,
  animationPathLengths,
  pointAlongAnimation,
} from './routing.js';

const DEFAULT_SPEED = 0.045; // normalized map units per second (~ reference simulateSpeed)
/** Indoor walking pace for ETA (m/s). Matches SaaS demos (~60 m/min). */
export const WALK_MPS = 1.2;
const raf = typeof requestAnimationFrame === 'function'
  ? requestAnimationFrame.bind(globalThis)
  : (cb) => setTimeout(() => cb(Date.now()), 16);
const caf = typeof cancelAnimationFrame === 'function'
  ? cancelAnimationFrame.bind(globalThis)
  : clearTimeout;

/** Format remaining distance + ETA for the follow-marker bubble. */
export function formatNavEta(remainingMapUnits, metersPerMapUnit, { walkMps = WALK_MPS } = {}) {
  const rem = Math.max(0, Number(remainingMapUnits) || 0);
  const mpu = Number(metersPerMapUnit);
  const hasScale = Number.isFinite(mpu) && mpu > 0;
  const meters = hasScale ? rem * mpu : rem;
  const distLabel = hasScale
    ? `剩余距离: ${Math.round(meters)} 米`
    : `剩余距离: ${Math.round(rem)} 图纸单位`;
  const seconds = Math.max(0, Math.round(meters / (walkMps > 0 ? walkMps : WALK_MPS)));
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return {
    distanceText: distLabel,
    durationText: `大约时长: ${mins}分${secs}秒`,
    remainingMeters: meters,
    remainingSeconds: seconds,
    hasScale,
  };
}

export function createNavMarkerController({
  onUpdate,
  onFloorChange,
  onTip,
  onComplete,
  onProgress,
  speed = DEFAULT_SPEED,
} = {}) {
  let samples = [];
  let lengths = [0];
  let total = 0;
  let distance = 0;
  let running = false;
  let paused = false;
  let rafId = 0;
  let lastTs = 0;
  let currentFloor = null;
  let speedFactor = 1;
  let routeLengthMapUnits = 0;

  function setPath(route, defaultFloorId = null) {
    stop();
    samples = routeAnimationPath(route, defaultFloorId);
    ({ lengths, total } = animationPathLengths(samples));
    distance = 0;
    currentFloor = samples[0]?.floorId ?? defaultFloorId ?? null;
    routeLengthMapUnits = Number(route?.length) > 0 ? Number(route.length) : 0;
    return samples.length >= 2 && total > 0;
  }

  function remainingMapUnits() {
    if (!(total > 0)) return 0;
    const fraction = Math.max(0, 1 - distance / total);
    if (routeLengthMapUnits > 0) return routeLengthMapUnits * fraction;
    // Fallback: convert normalized anim distance using page-ish scale later in UI.
    return fraction * total;
  }

  function emit(point) {
    if (!point) return;
    if (point.floorId && point.floorId !== currentFloor) {
      currentFloor = point.floorId;
      onFloorChange?.(currentFloor, point);
    }
    if (point.tip) onTip?.(point.tip, point);
    onUpdate?.(point);
    const progress = total > 0 ? distance / total : 0;
    onProgress?.(progress, point, {
      remainingMapUnits: remainingMapUnits(),
      routeLengthMapUnits,
      distance,
      total,
    });
  }

  function tick(ts) {
    if (!running) return;
    rafId = raf(tick);
    if (!lastTs) { lastTs = ts; return; }
    const dt = Math.min(0.05, (ts - lastTs) / 1000);
    lastTs = ts;
    if (paused) return;
    distance = Math.min(total, distance + dt * speed * speedFactor);
    const point = pointAlongAnimation(samples, lengths, total, distance);
    emit(point);
    if (distance >= total) {
      running = false;
      caf(rafId);
      rafId = 0;
      onComplete?.(point);
    }
  }

  function start() {
    if (samples.length < 2 || !(total > 0)) return false;
    stop();
    running = true;
    paused = false;
    distance = 0;
    lastTs = 0;
    currentFloor = samples[0]?.floorId ?? null;
    emit(pointAlongAnimation(samples, lengths, total, 0));
    rafId = raf(tick);
    return true;
  }

  function pause() {
    if (!running) return false;
    paused = !paused;
    return paused;
  }

  function seek(progress) {
    if (!(total > 0)) return;
    distance = total * Math.max(0, Math.min(1, progress));
    if (distance >= total) paused = true;
    emit(pointAlongAnimation(samples, lengths, total, distance));
  }

  function stop() {
    running = false;
    paused = false;
    if (rafId) caf(rafId);
    rafId = 0;
    lastTs = 0;
  }

  function setSpeed(factor) {
    if (Number.isFinite(factor)) speedFactor = Math.max(0.25, Math.min(3, factor));
  }

  return {
    setPath,
    start,
    pause,
    seek,
    stop,
    setSpeed,
    remainingMapUnits,
    get running() { return running; },
    get paused() { return paused; },
    get progress() { return total > 0 ? distance / total : 0; },
    get samples() { return samples; },
    get total() { return total; },
    get routeLengthMapUnits() { return routeLengthMapUnits; },
  };
}

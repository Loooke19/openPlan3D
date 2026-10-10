/** Pure route-playback stepper: wall-clock based, always lands exactly on 1 at the path end. */
export const WALK_CM_PER_S = 120;
/** Remaining distance (cm) under which we snap to the end, so float drift can never stall at 99.x%. */
export const END_SNAP_CM = 1;

export function stepProgress(progress: number, dtSeconds: number, speed: number, totalCm: number): number {
  if (!(totalCm > 0)) return 1;
  const dt = Math.max(0, Math.min(2, Number.isFinite(dtSeconds) ? dtSeconds : 0));
  const next = Math.min(1, Math.max(0, progress) + (dt * Math.max(0.25, speed || 1) * WALK_CM_PER_S) / totalCm);
  return (1 - next) * totalCm <= END_SNAP_CM ? 1 : next;
}

export const isFinished = (progress: number) => progress >= 1;

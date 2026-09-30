/**
 * Default device-pixel ratio for nav / WebGL when the host under-reports DPR.
 *
 * Measured on the Cursor glass browser host (Windows): desktop pixels are 2×
 * logical (DESKTOPHORZRES/HORZRES = 5120/2560) while Electron runs with
 * `--device-scale-factor=1`, so `window.devicePixelRatio` often stays 1 and
 * canvases get upscaled soft. Floor at this default unless the page reports higher.
 */
export const DEFAULT_PIXEL_RATIO = 2;

/** Effective DPR for sharp canvases / WebGL (never below {@link DEFAULT_PIXEL_RATIO}). */
export function effectivePixelRatio(reported?: number): number {
  const dpr = typeof reported === 'number' && Number.isFinite(reported) && reported > 0
    ? reported
    : (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
  return Math.max(DEFAULT_PIXEL_RATIO, dpr);
}

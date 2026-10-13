import { describe, expect, it } from 'vitest';
import { CURRENT_NAV_FIT, FIT_TOL_CM, LEGACY_NAV_FIT } from '$lib/utils/doorWallFit';

describe('doorWallFit profiles', () => {
  it('LEGACY exceeds 1 cm jamb/frame; CURRENT stays flush', () => {
    expect(LEGACY_NAV_FIT.jambClear).toBeGreaterThan(FIT_TOL_CM);
    expect(LEGACY_NAV_FIT.frameDepthExtra).toBeGreaterThan(FIT_TOL_CM);
    expect(LEGACY_NAV_FIT.jointSealed).toBe(false);
    expect(CURRENT_NAV_FIT.jambClear).toBeLessThanOrEqual(FIT_TOL_CM);
    expect(CURRENT_NAV_FIT.frameDepthExtra).toBeLessThanOrEqual(FIT_TOL_CM);
    expect(CURRENT_NAV_FIT.jointSealed).toBe(true);
  });
});

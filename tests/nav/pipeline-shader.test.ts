import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('nav post pipeline shaders', () => {
  const src = readFileSync('src/lib/components/viewer3d/nav/pipeline.ts', 'utf8');
  it('never uses texture3D (no alias in three r182 WebGL2 → compile failure / black canvas)', () => {
    expect(src).not.toMatch(/texture3D\s*\(/);
  });
  it('installs a shader-error fallback', () => {
    expect(src).toMatch(/onShaderError/);
    expect(src).toMatch(/fallback_nolut/);
  });
});

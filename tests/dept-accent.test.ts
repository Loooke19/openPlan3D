import { describe, expect, it } from 'vitest';
import { ALL_ACCENTS, deptAccent, deptCategory, isBlueish } from '../src/lib/utils/deptAccent';
describe('department accents', () => {
  it('never uses blue/cyan (route colour)', () => { for (const c of ALL_ACCENTS) expect(isBlueish(c)).toBe(false); expect(isBlueish('#1f7cf2')).toBe(true); });
  it('is deterministic per name and grouped by category', () => {
    expect(deptAccent('内科诊室')).toBe(deptAccent('内科诊室'));
    expect(deptCategory('放射科')).toBe('exam');
    expect(deptCategory('药房')).toBe('pharmacy');
    expect(deptCategory('楼梯')).toBe('circulation');
  });
  it('neighbours can be pushed apart', () => {
    const a = deptAccent('内科诊室'); expect(deptAccent('内科诊室', a)).not.toBe(a);
  });
});

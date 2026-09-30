/** Name patterns that mark elevator / stairs / escalator rooms for vertical binding. */
const FACILITY_RULES: Array<{ kind: 'elevator' | 'stairs' | 'escalator'; needles: string[] }> = [
  { kind: 'elevator', needles: ['电梯', '升降机', 'elevator', 'lift'] },
  { kind: 'escalator', needles: ['扶梯', '自动梯', 'escalator'] },
  { kind: 'stairs', needles: ['楼梯', 'stair'] },
];

export type VerticalKind = 'elevator' | 'stairs' | 'escalator';

export function verticalKindFromName(name: string | undefined | null): VerticalKind | null {
  const text = String(name || '').trim().toLowerCase();
  if (!text) return null;
  for (const rule of FACILITY_RULES) {
    if (rule.needles.some((needle) => text.includes(needle.toLowerCase()))) return rule.kind;
  }
  return null;
}

export function isVerticalFacilityName(name: string | undefined | null): boolean {
  return verticalKindFromName(name) != null;
}

export function verticalKindLabel(kind: VerticalKind): string {
  return kind === 'elevator' ? '电梯' : kind === 'escalator' ? '扶梯' : '楼梯';
}

import type { Door, Floor, Room } from '$lib/models/types';

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

/** Prefer explicit map icon, then name patterns (「卫生间（靠电梯）」 is restroom, not a shaft). */
export function roomVerticalKind(room: Pick<Room, 'name' | 'labelIcon'> | null | undefined): VerticalKind | null {
  if (!room) return null;
  const icon = room.labelIcon;
  if (icon === 'elevator' || icon === 'stairs') return icon;
  // Exact facility names / prefixes only — avoid 「靠电梯」restrooms.
  const name = String(room.name || '').trim();
  if (!name) return null;
  if (/^(电梯|升降机|elevator|lift)\b/i.test(name) || name === '电梯' || name === '升降机') return 'elevator';
  if (/^(扶梯|自动梯|escalator)\b/i.test(name) || name === '扶梯') return 'escalator';
  if (/^(楼梯|stair)/i.test(name) || name === '楼梯') return 'stairs';
  // Disambiguated labels like 「楼梯（东）」/「电梯 A」
  if (/^电梯[\s（(A-Za-z0-9]/.test(name) || /^电梯（/.test(name)) return 'elevator';
  if (/^楼梯[\s（(A-Za-z0-9]/.test(name) || /^楼梯（/.test(name)) return 'stairs';
  return verticalKindFromName(name) && !/靠|旁|近|侧/.test(name) ? verticalKindFromName(name) : null;
}

/**
 * Door on a wall shared with an elevator / stair / escalator shaft room.
 * Used to suppress wood leaves (no cabin-door model) so FP can enter the shaft.
 */
export function doorVerticalFacilityKind(floor: Floor, door: Door): VerticalKind | null {
  const owners = (floor.rooms || []).filter((r) => (r.walls || []).includes(door.wallId));
  let found: VerticalKind | null = null;
  for (const room of owners) {
    const kind = roomVerticalKind(room);
    if (kind === 'elevator') return 'elevator';
    if (kind && !found) found = kind;
  }
  return found;
}

/** Nav shell: no swinging wood leaf for shafts (elevator/escalator: no door mesh; stairs: opening). */
export function navSuppressDoorLeaf(kind: VerticalKind | null): 'remove' | 'opening' | null {
  if (kind === 'elevator' || kind === 'escalator') return 'remove';
  if (kind === 'stairs') return 'opening';
  return null;
}

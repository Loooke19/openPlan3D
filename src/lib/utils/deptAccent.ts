/**
 * Department accent colours for door frames / colour bands, assigned by rule (no per-project data):
 * low-saturation, never blue/cyan (the route is blue), grouped by room category, picked by a
 * stable hash of the department name so the same 科室 gets the same colour on every import.
 */
export type DeptCategory = 'clinic' | 'exam' | 'pharmacy' | 'service' | 'circulation';

const PALETTES: Record<DeptCategory, string[]> = {
  // Warm greens / sages for consulting rooms.
  clinic: ['#7f9a7a', '#93a383', '#6f8f74'],
  // Muted ambers / ochres for imaging & labs.
  exam: ['#b89a6a', '#a8875c', '#c2a77a'],
  // Terracotta for pharmacy / dispensing.
  pharmacy: ['#b37f6a', '#a87262'],
  // Mauve / plum greys for service counters, toilets, wards.
  service: ['#9a8496', '#8d7f8f'],
  // Neutral warm grey for stairs / lifts / halls.
  circulation: ['#9b968e'],
};

export function deptCategory(name: string): DeptCategory {
  if (/电梯|楼梯|扶梯|大厅|走廊|通道|门厅|候诊|前厅/.test(name)) return 'circulation';
  if (/药/.test(name)) return 'pharmacy';
  if (/检验|放射|超声|影像|心电|CT|MRI|B超|内镜|化验|采血|检查/.test(name)) return 'exam';
  if (/卫生间|厕|挂号|收费|服务|护士站|输液|病房|办公|库|值班/.test(name)) return 'service';
  return 'clinic';
}

function hash(s: string) {
  let h = 2166136261;
  for (const ch of s) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Stable accent for a department name; `avoid` lets neighbours differ when the category allows. */
export function deptAccent(name: string, avoid?: string): string {
  const list = PALETTES[deptCategory(name)];
  let i = hash(name.trim()) % list.length;
  if (avoid && list[i] === avoid && list.length > 1) i = (i + 1) % list.length;
  return list[i];
}

/** True for blue/cyan hues (reserved for the route). */
export function isBlueish(hex: string) {
  const n = parseInt(hex.slice(1), 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max - min < 0.04) return false;
  let h = max === r ? ((g - b) / (max - min)) % 6 : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4;
  h = (h * 60 + 360) % 360;
  return h >= 170 && h <= 260;
}

export const ALL_ACCENTS = Object.values(PALETTES).flat();

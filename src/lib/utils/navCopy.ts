/**
 * Patient-facing wording for the nav preview (copy review 10-10):
 * 「1楼」 floors, 东/西/南/北/中 sides, disambiguated duplicate places, plain transfer steps and pins.
 * Plan coordinates: +x east, +y south (screen down), as drawn in the 2D map.
 */
export type Pt = { x: number; y: number };
export type Box = { minX: number; minY: number; maxX: number; maxY: number };

/** 「1F」→「1楼」, 「B1」/「B1F」→「地下1楼」; anything else unchanged. */
export function floorSpoken(name: string | null | undefined): string {
  const s = String(name ?? '').trim();
  let m = s.match(/^(\d+)\s*F$/i) || s.match(/^(\d+)\s*楼$/);
  if (m) return `${Number(m[1])}楼`;
  m = s.match(/^B\s*(\d+)\s*F?$/i) || s.match(/^地下\s*(\d+)\s*[层楼]$/);
  if (m) return `地下${Number(m[1])}楼`;
  m = s.match(/^(\d+)\s*层$/);
  if (m) return `${Number(m[1])}楼`;
  return s;
}

/** Compact selector text: 「1F（1楼）」. */
export function floorOption(name: string | null | undefined): string {
  const s = String(name ?? '').trim();
  const spoken = floorSpoken(s);
  return spoken && spoken !== s ? `${s}（${spoken}）` : s;
}

/** Side of the floor a point sits on: 东/西/南/北, or 中 near the middle. */
export function sideOf(p: Pt, box: Box): '东' | '西' | '南' | '北' | '中' {
  const w = Math.max(1, box.maxX - box.minX), h = Math.max(1, box.maxY - box.minY);
  const u = (p.x - box.minX) / w - 0.5, v = (p.y - box.minY) / h - 0.5;
  if (Math.abs(u) < 1 / 6 && Math.abs(v) < 1 / 6) return '中';
  // Compare in metric terms so a long, narrow floor reads east/west.
  if (Math.abs(u) * w >= Math.abs(v) * h) return u > 0 ? '东' : '西';
  return v > 0 ? '南' : '北';
}

export type NamedPlace = { id: string; name: string; floorId: string; x: number; y: number };

/**
 * Display names unique per floor: duplicates get their side (「东侧卫生间」); if two still
 * collide they are lettered (「卫生间 A」「卫生间 B」, west→east, north→south).
 */
export function disambiguate(places: NamedPlace[], boxes: Record<string, Box | undefined>): Map<string, string> {
  const out = new Map<string, string>();
  const groups = new Map<string, NamedPlace[]>();
  for (const p of places) {
    const k = `${p.floorId}::${p.name}`;
    groups.set(k, [...(groups.get(k) || []), p]);
  }
  for (const group of groups.values()) {
    if (group.length === 1) { out.set(group[0].id, group[0].name); continue; }
    const box = boxes[group[0].floorId];
    const sides = group.map(p => (box ? sideOf(p, box) : '中'));
    const unique = box && new Set(sides).size === group.length && !sides.includes('中');
    if (unique) { group.forEach((p, i) => out.set(p.id, `${sides[i]}侧${p.name}`)); continue; }
    const sorted = group.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    sorted.forEach((p, i) => out.set(p.id, `${p.name} ${String.fromCharCode(65 + i)}`));
  }
  return out;
}

export type TransferLike = {
  kind?: string; kindLabel?: string; name?: string; direction?: 'up' | 'down' | string;
  from?: Pt; fromFloorName?: string; toFloorName?: string;
};

/** 「走东侧楼梯上到 2楼」 / 「乘西侧电梯下到 1楼」. */
export function transferText(t: TransferLike, box?: Box | null): string {
  const stairs = t.kind === 'stairs' || /楼梯/.test(t.kindLabel || t.name || '');
  const what = stairs ? '楼梯' : '电梯';
  const side = box && t.from ? sideOf(t.from, box) : null;
  const where = side ? (side === '中' ? '中部' : `${side}侧`) : '';
  const to = floorSpoken(t.toFloorName) || '下一层';
  const way = t.direction === 'up' ? '上到' : t.direction === 'down' ? '下到' : '到';
  return stairs ? `走${where}${what}${way} ${to}` : `乘${where}${what}${way} ${to}`;
}

export const pinText = {
  start: (name: string) => `出发地：${name}`,
  end: (name: string) => `目的地：${name}`,
  transfer: (what: string) => `在此换乘：${what}`,
};

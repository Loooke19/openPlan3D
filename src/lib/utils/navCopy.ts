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

/**
 * Drawing orientation: compass bearing of north on the plan (0 = plan up / −y, 90 = plan right,
 * 270 = plan left), from the north arrow detected at import or set in the editor/MCP.
 * `null` = unknown: then no 东西南北 is ever emitted and duplicates are lettered (楼梯 A/B).
 */
let northBearing: number | null = null;
export function setNavNorth(deg: number | null | undefined) {
  northBearing = typeof deg === 'number' && Number.isFinite(deg) ? ((deg % 360) + 360) % 360 : null;
}
export function navNorth() { return northBearing; }

/** Side of the floor a point sits on: 东/西/南/北, 中 near the middle, '' when north is unknown. */
export function sideOf(p: Pt, box: Box): '东' | '西' | '南' | '北' | '中' | '' {
  if (northBearing === null) return '';
  const w = Math.max(1, box.maxX - box.minX), h = Math.max(1, box.maxY - box.minY);
  const u = (p.x - box.minX) / w - 0.5, v = (p.y - box.minY) / h - 0.5;
  if (Math.abs(u) < 1 / 6 && Math.abs(v) < 1 / 6) return '中';
  // Metric offsets from the middle, projected on the drawing's north/east axes.
  const dx = u * w, dy = v * h, t = (northBearing * Math.PI) / 180;
  const north = dx * Math.sin(t) - dy * Math.cos(t);
  const east = dx * Math.cos(t) + dy * Math.sin(t);
  if (Math.abs(east) >= Math.abs(north)) return east > 0 ? '东' : '西';
  return north > 0 ? '北' : '南';
}

/** 「楼梯（东）」, 「楼梯（东A）」, or without a known north 「楼梯 A」. */
function tagged(name: string, side: string, letter = '') {
  if (!side) return letter ? `${name} ${letter}` : name;
  return `${name}（${side}${letter}）`;
}

const VERTICAL = /^(楼梯|电梯|扶梯)$/;

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
    // Without a north arrow, stairs/lifts are always lettered (「电梯 A」 even when alone) so the
    // map, picker and steps name them the same way on every floor.
    if (group.length === 1) { out.set(group[0].id, northBearing === null && VERTICAL.test(group[0].name) ? `${group[0].name} A` : group[0].name); continue; }
    const box = boxes[group[0].floorId];
    const sides = group.map(p => (box ? sideOf(p, box) : '中'));
    const unique = box && new Set(sides).size === group.length && !sides.includes('中') && !sides.includes('');
    // One form everywhere (dropdown, 3D map, pins, steps): 「楼梯（东）」, or 「楼梯（东A）」 when a
    // side holds two of them (lettered west→east, north→south — same rule as mapLabels).
    if (unique) { group.forEach((p, i) => out.set(p.id, `${p.name}（${sides[i]}）`)); continue; }
    const bySide = new Map<string, NamedPlace[]>();
    group.forEach((p, i) => bySide.set(sides[i], [...(bySide.get(sides[i]) || []), p]));
    for (const [side, list] of bySide) {
      if (list.length === 1 && side) { out.set(list[0].id, tagged(list[0].name, side)); continue; }
      list.slice().sort((a, b) => a.x - b.x || a.y - b.y).forEach((p, i) => out.set(p.id, tagged(p.name, side, String.fromCharCode(65 + i))));
    }
  }
  return out;
}

export type TransferLike = {
  kind?: string; kindLabel?: string; name?: string; direction?: 'up' | 'down' | string;
  from?: Pt; fromFloorName?: string; toFloorName?: string;
  /** Display name of the stair/lift (「楼梯（东）」), so steps match the map and dropdowns. */
  display?: string;
  /** Floors only this stair/lift reaches (「只有这部楼梯能到 4 楼」). */
  onlyTo?: string[];
};

/** 「楼梯（东）」 for a transfer: its display name, else kind + side. */
export function transferPlace(t: TransferLike, box?: Box | null): string {
  if (t.display) return t.display;
  const stairs = t.kind === 'stairs' || /楼梯/.test(t.kindLabel || t.name || '');
  const side = box && t.from ? sideOf(t.from, box) : null;
  return `${stairs ? '楼梯' : '电梯'}${side ? `（${side}）` : ''}`;
}

/** 「走楼梯（东）上到 2楼」 / 「乘电梯（西）下到 1楼」. */
export function transferText(t: TransferLike, box?: Box | null): string {
  const stairs = t.kind === 'stairs' || /楼梯/.test(t.kindLabel || t.name || '');
  const to = floorSpoken(t.toFloorName) || '下一层';
  const way = t.direction === 'up' ? '上到' : t.direction === 'down' ? '下到' : '到';
  const span = (t as { floors?: number }).floors;
  const mark = (t as { landmark?: string }).landmark;
  const only = t.toFloorName && t.onlyTo?.includes(t.toFloorName) ? `只有这部能到 ${to}` : '';
  const place = transferPlace(t, box);
  // Name first (「走楼梯 A 上到 4楼」); a landmark only when the name alone doesn't identify it.
  const named = /\s[A-Z]$|（.+）$/.test(place);
  return `${stairs ? '走' : '乘'}${!named && mark ? `${mark}旁的` : ''}${place}${/\s[A-Z]$/.test(place) ? " " : ""}${way} ${to}${(() => { const bits = [span && span >= 2 ? `共 ${span} 层` : '', only].filter(Boolean); return bits.length ? `（${bits.join('，')}）` : ''; })()}`;
}

export const pinText = {
  start: (name: string) => `出发地：${name}`,
  end: (name: string) => `目的地：${name}`,
  transfer: (what: string) => `在此换乘：${what}`,
};

/**
 * 3D map labels for one floor: a name used twice gets its side in brackets (「楼梯（东）」);
 * still-colliding ones are lettered (「楼梯（东A）」). Returns label per index ('' = unnamed).
 */
export function mapLabels(rooms: { name?: string | null; polygon: Pt[] }[]): string[] {
  const pts = rooms.flatMap(r => r.polygon);
  if (!pts.length) return rooms.map(r => r.name ?? '');
  const box: Box = {
    minX: Math.min(...pts.map(p => p.x)), maxX: Math.max(...pts.map(p => p.x)),
    minY: Math.min(...pts.map(p => p.y)), maxY: Math.max(...pts.map(p => p.y)),
  };
  const centre = (poly: Pt[]) => ({ x: poly.reduce((s, p) => s + p.x, 0) / poly.length, y: poly.reduce((s, p) => s + p.y, 0) / poly.length });
  const names = rooms.map(r => (r.name ?? '').trim());
  const out = [...names];
  const count = new Map<string, number>();
  for (const n of names) if (n) count.set(n, (count.get(n) ?? 0) + 1);
  const bySide = new Map<string, number[]>();
  names.forEach((n, i) => {
    if (!n || rooms[i].polygon.length < 3) return;
    if ((count.get(n) ?? 0) < 2) { if (northBearing === null && VERTICAL.test(n)) out[i] = `${n} A`; return; }
    const key = `${n}\u0000${sideOf(centre(rooms[i].polygon), box)}`;
    bySide.set(key, [...(bySide.get(key) ?? []), i]);
  });
  for (const [key, idx] of bySide) {
    const [n, side] = key.split('\u0000');
    if (idx.length === 1 && side) { out[idx[0]] = tagged(n, side); continue; }
    idx.sort((a, b) => { const p = centre(rooms[a].polygon), q = centre(rooms[b].polygon); return p.x - q.x || p.y - q.y; });
    idx.forEach((i, k) => { out[i] = tagged(n, side, String.fromCharCode(65 + k)); });
  }
  return out;
}

/** Room is "near" the route when its box is within `margin` cm of any route vertex/segment. */
export function nearRoute(poly: Pt[], route: Pt[], margin = 350): boolean {
  if (!route.length || !poly.length) return false;
  const minX = Math.min(...poly.map(p => p.x)) - margin, maxX = Math.max(...poly.map(p => p.x)) + margin;
  const minY = Math.min(...poly.map(p => p.y)) - margin, maxY = Math.max(...poly.map(p => p.y)) + margin;
  for (let i = 0; i < route.length; i++) {
    const a = route[i], b = route[Math.min(route.length - 1, i + 1)];
    for (let t = 0; t <= 1; t += 0.1) {
      const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) return true;
    }
  }
  return false;
}

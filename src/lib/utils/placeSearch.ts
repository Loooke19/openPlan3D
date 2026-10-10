import { pinyin } from 'pinyin-pro';

export type SearchPlace = { key: string; name: string; originalName?: string; aliases?: string[]; floorId: string; floorLabel: string; category?: string; x?: number; y?: number };
export type IndexedPlace = SearchPlace & { haystack: string[] };

// 常用, in this order: entrance, 导医台, 药房/收费, 卫生间, 电梯.
const COMMON_ORDER = [/入口|出入口|大门|门厅|大厅/, /导医|服务台|咨询台/, /药房|收费|挂号/, /卫生间|男卫|女卫|^卫$|厕所/, /电梯/];
const COMMON = new RegExp(COMMON_ORDER.map(r => r.source).join('|'));
const UNNAMED = /^(未命名|房间\s*\d+$)/;
const squash = (s: string) => s.toLowerCase().replace(/[\s·・\-_（）()]/g, '');
export function commonRank(p: SearchPlace) { const i = COMMON_ORDER.findIndex(r => r.test(p.name)); return i < 0 ? 99 : i; }

/** Full pinyin (no tones, no spaces) and initials for a name: 狂犬病… → kuangquanbing… / kqb… */
export function pinyinKeys(text: string): [string, string] {
  text = text.replace(/\s+/g, '');
  const full = pinyin(text, { toneType: 'none', type: 'array', nonZh: 'consecutive' }).join('').toLowerCase();
  const first = pinyin(text, { pattern: 'first', toneType: 'none', type: 'array', nonZh: 'consecutive' }).join('').toLowerCase();
  return [full, first];
}

export function indexPlaces(list: SearchPlace[]): IndexedPlace[] {
  // Unnamed rooms are not destinations anyone searches for.
  return list.filter(p => p.name && !UNNAMED.test(p.name)).map(p => {
    const names = [p.name, p.originalName, ...(p.aliases || [])].filter(Boolean) as string[];
    return { ...p, haystack: names.flatMap(n => [squash(n), ...pinyinKeys(n)]) };
  });
}

export function isCommon(p: SearchPlace) { return COMMON.test(p.name); }

/** Matches by display/original name, aliases, full pinyin or initials; common places first. */
export function searchPlaces(list: IndexedPlace[], q: string): IndexedPlace[] {
  const t = squash(q);
  const hit = t ? list.filter(p => p.haystack.some(h => h.includes(t))) : list;
  const score = (p: IndexedPlace) => (t && p.haystack.some(h => h.startsWith(t)) ? 0 : 1) * 2 + (isCommon(p) ? 0 : 1);
  return [...hit].sort((a, b) => score(a) - score(b));
}

/** Search hint built from this building (e.g. 「如 kqb（狂犬病…）」), never a fixed example. */
export function searchExample(list: IndexedPlace[]): string {
  const p = list.find(x => !isCommon(x) && x.name.replace(/\s/g, '').length >= 3) || list[0];
  if (!p) return '搜索科室 / 拼音 / 首字母';
  return `搜索科室 / 拼音 / 首字母，如 ${pinyinKeys(p.name)[1]}（${p.name}）`;
}

// ── Toilets: gendered labels, nearest-first ─────────────────────────────────
export type ToiletKind = 'female' | 'male' | 'accessible' | 'any';
export function toiletKind(name: string): ToiletKind | null {
  if (/残卫|无障碍/.test(name)) return 'accessible';
  if (/女卫|女厕|女卫生间/.test(name)) return 'female';
  if (/男卫|男厕|男卫生间/.test(name)) return 'male';
  if (/卫生间|厕所|^卫$|洗手间/.test(name)) return 'any';
  return null;
}
export function toiletLabel(kind: ToiletKind) {
  return kind === 'accessible' ? '无障碍卫生间' : kind === 'female' ? '卫生间（女）' : kind === 'male' ? '卫生间（男）' : '卫生间';
}
/** 「1楼」/「1F（1楼）」 → 「1F」: the short form that keeps a toilet row on one line at 390 px. */
export function floorShort(label: string) {
  const m = label.match(/(B?\d+)\s*F/i) || label.match(/(地下)?(\d+)楼/);
  if (!m) return label;
  return m[0].includes('楼') ? `${m[1] ? 'B' : ''}${m[2]}F` : m[0].toUpperCase().replace(/\s/g, '');
}
export type Origin = { x: number; y: number; floorId: string } | null;
/** Rough walking metres: straight line ×1.3 on a floor, plus ~25 m per floor change. */
export function roughMetres(p: { x?: number; y?: number; floorId: string }, from: Origin, floorIndex: (id: string) => number) {
  if (!from || p.x === undefined || p.y === undefined) return null;
  const flat = Math.hypot(p.x - from.x, p.y - from.y) * 1.3 / 100;
  const floors = Math.abs(floorIndex(p.floorId) - floorIndex(from.floorId));
  return Math.round(flat + floors * 25);
}
/** Toilets sorted by distance (same floor first); accessible ones first when 只乘电梯. */
export function nearestToilets<T extends { name: string; floorId: string; x?: number; y?: number }>(
  list: T[], from: Origin, floorIndex: (id: string) => number, accessible = false,
) {
  return list
    .map(p => ({ p, kind: toiletKind(p.name), m: roughMetres(p, from, floorIndex) }))
    .filter((t): t is { p: T; kind: ToiletKind; m: number | null } => !!t.kind)
    .sort((a, b) => (accessible ? Number(b.kind === 'accessible') - Number(a.kind === 'accessible') : 0)
      || Number(a.p.floorId !== from?.floorId) - Number(b.p.floorId !== from?.floorId)
      || (a.m ?? 1e9) - (b.m ?? 1e9));
}

/**
 * Patient-facing toilet name. Drawings print 卫 / 卫A / 男卫 / 女厕 / 残卫…; signs and lists show
 * 「卫生间」, gendered only when the drawing printed a gender. The printed form stays an alias.
 * Leaves real department names (卫生健康监督…, 公共卫生科) untouched.
 */
export function toiletDisplay(name: string): string | null {
  const m = (name || '').replace(/\s+/g, '').match(/^(男|女|残|无障碍)?(卫生间|卫生|卫|厕所|厕|洗手间)([A-Za-z0-9一二三四]{0,2})$/);
  if (!m) return null;
  const g = m[1];
  const base = g === '男' ? '男卫生间' : g === '女' ? '女卫生间' : g ? '无障碍卫生间' : '卫生间';
  return base === name ? null : base;
}

export function withToiletDisplay<T extends { name?: string | null; aliases?: string[] | null }>(p: T): T {
  const d = toiletDisplay(p.name || '');
  if (!d) return p;
  const aliases = Array.from(new Set([...(p.aliases || []), p.name as string, d === '卫生间' ? '' : '卫生间', '厕所'].filter(Boolean)));
  return { ...p, originalName: (p as { originalName?: string }).originalName || p.name, name: d, aliases };
}

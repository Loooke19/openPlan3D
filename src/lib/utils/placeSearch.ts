import { pinyin } from 'pinyin-pro';

export type SearchPlace = { key: string; name: string; originalName?: string; aliases?: string[]; floorId: string; floorLabel: string; category?: string };
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

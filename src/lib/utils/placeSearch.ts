import { pinyin } from 'pinyin-pro';

export type SearchPlace = { key: string; name: string; originalName?: string; aliases?: string[]; floorId: string; floorLabel: string; category?: string };
export type IndexedPlace = SearchPlace & { haystack: string[] };

const COMMON = /门厅|大厅|导医|服务台|药房|卫生间|男卫|女卫|电梯|挂号|收费/;

/** Full pinyin (no tones, no spaces) and initials for a name: 狂犬病… → kuangquanbing… / kqb… */
export function pinyinKeys(text: string): [string, string] {
  const full = pinyin(text, { toneType: 'none', type: 'array', nonZh: 'consecutive' }).join('').toLowerCase();
  const first = pinyin(text, { pattern: 'first', toneType: 'none', type: 'array', nonZh: 'consecutive' }).join('').toLowerCase();
  return [full, first];
}

export function indexPlaces(list: SearchPlace[]): IndexedPlace[] {
  return list.map(p => {
    const names = [p.name, p.originalName, ...(p.aliases || [])].filter(Boolean) as string[];
    return { ...p, haystack: names.flatMap(n => [n.toLowerCase(), ...pinyinKeys(n)]) };
  });
}

export function isCommon(p: SearchPlace) { return COMMON.test(p.name); }

/** Matches by display/original name, aliases, full pinyin or initials; common places first. */
export function searchPlaces(list: IndexedPlace[], q: string): IndexedPlace[] {
  const t = q.trim().toLowerCase().replace(/\s+/g, '');
  const hit = t ? list.filter(p => p.haystack.some(h => h.includes(t))) : list;
  const score = (p: IndexedPlace) => (t && p.haystack.some(h => h.startsWith(t)) ? 0 : 1) * 2 + (isCommon(p) ? 0 : 1);
  return [...hit].sort((a, b) => score(a) - score(b));
}

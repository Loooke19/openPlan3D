/**
 * Bundled Simplified-Chinese font for 3D sign/label textures (Noto Sans SC, OFL, GB2312 level-1
 * subset + ASCII/punctuation). The box/kiosk system CJK font is often the JP variant (门 draws
 * with a Japanese form), so canvas text must never be drawn before this font is ready: callers
 * await `navFontReady()` and bake textures afterwards.
 */
export const NAV_FONT = '"Nav Sans SC", "Noto Sans SC", "Source Han Sans SC", "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif';

let ready: Promise<boolean> | null = null;
let loaded = false;

export function navFontLoaded() { return loaded || typeof document === 'undefined'; }

export function navFontReady(base = ''): Promise<boolean> {
  if (typeof document === 'undefined' || typeof FontFace === 'undefined') { loaded = true; return Promise.resolve(true); }
  if (ready) return ready;
  const faces = [
    new FontFace('Nav Sans SC', `url(${base}/fonts/NotoSansSC-Bold-subset.woff2) format("woff2")`, { weight: '600 900' }),
    new FontFace('Nav Sans SC', `url(${base}/fonts/NotoSansSC-Regular-subset.woff2) format("woff2")`, { weight: '100 599' }),
  ];
  ready = Promise.all(faces.map(f => f.load().then(ff => { document.fonts.add(ff); }))).then(
    () => document.fonts.load(`700 48px "Nav Sans SC"`, '门诊骨直').then(() => (loaded = true)),
    () => (loaded = true), // network failure: fall back to the stack rather than never drawing
  );
  return ready;
}

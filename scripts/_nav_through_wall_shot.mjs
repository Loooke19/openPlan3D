/**
 * P2 1F登记室 → 3F病房8（只乘电梯）：3F 俯视蓝线 after 截图 + before/after 拼接。
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = 'http://127.0.0.1:8884';
const PID = '4a87b204fb564d1689764b226ef99312';
const LOCAL = path.resolve(__dirname, '../../media/nav-through-wall');
const STORE = path.resolve(
  process.env.USERPROFILE || '',
  'AppData/Local/Cursor/AgentStores/cursor_agent_stores/bc-8097b1e1-0215-4b44-93fa-f96676d9b948/files/media/nav-through-wall',
);
fs.mkdirSync(LOCAL, { recursive: true });
fs.mkdirSync(STORE, { recursive: true });

const q = new URLSearchParams({
  projectUrl: `${API}/api/projects/${PID}.json`,
  id: PID,
  apiOrigin: API,
  filesUrl: `${API}/files`,
});

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`http://127.0.0.1:5175/nav?${q}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => (window.__navTest?.places?.() || []).length > 5, null, { timeout: 180000 });

const meta = await page.evaluate(async () => {
  const places = window.__navTest.places();
  const from = places.find((p) => p.label.includes('1楼') && p.label.includes('登记'));
  const to = places.find((p) => p.label.includes('3楼') && p.label.includes('病房8'));
  if (!from || !to) return { ok: false, reason: 'place-missing', places: places.slice(0, 8).map((p) => p.label) };
  window.__navTest.setAccessible(true);
  const msg = await window.__navTest.route(from.key, to.key);
  const legs = window.__navTest.legs();
  await window.__navTest.showLeg(Math.max(0, legs.length - 1));
  window.__navTest.setMode('3d');
  return {
    ok: true,
    msg,
    from: from.label,
    to: to.label,
    legs,
    transfers: window.__navTest.transfers(),
  };
});
if (!meta.ok) {
  console.error(JSON.stringify(meta, null, 2));
  await browser.close();
  process.exit(2);
}
await page.waitForTimeout(3500);
await page.evaluate(() => {
  try {
    // Top-down-ish overview of the 3F ward wing (matches Luke's through-wall repro angle).
    window.__navTest.viewer.setOrbitPoseForTest?.([-900, 2200, 280], [-900, 0, 280]);
    window.__navTest.viewer.nudgeOrbitForTest?.({ polar: 0.35, radiusScale: 0.95 });
    for (let i = 0; i < 20; i++) window.__navTest.viewer.renderFrameForTest?.();
  } catch {
    /* */
  }
});
await page.waitForTimeout(800);

const afterPath = path.join(LOCAL, 'after.png');
await page.screenshot({ path: afterPath, fullPage: false });
fs.copyFileSync(afterPath, path.join(STORE, 'after.png'));

const beforeSrc = path.join(STORE, 'luke-through-wall.png');
const beforeLocal = path.join(LOCAL, 'before.png');
if (fs.existsSync(beforeSrc)) {
  fs.copyFileSync(beforeSrc, beforeLocal);
  fs.copyFileSync(beforeSrc, path.join(STORE, 'before.png'));
}

await browser.close();

// Side-by-side before/after via Pillow
const py = path.resolve(__dirname, '../../.venv/Scripts/python.exe');
const compose = `
from PIL import Image
from pathlib import Path
local = Path(r"${LOCAL.replace(/\\/g, '/')}")
store = Path(r"${STORE.replace(/\\/g, '/')}")
before = Image.open(local / "before.png").convert("RGB") if (local / "before.png").exists() else None
after = Image.open(local / "after.png").convert("RGB")
if before is None:
    after.save(local / "before-after.png")
else:
    h = 720
    def fit(im):
        r = h / im.height
        return im.resize((max(1, int(im.width * r)), h))
    b, a = fit(before), fit(after)
    gap = 12
    canvas = Image.new("RGB", (b.width + a.width + gap, h), (24, 26, 28))
    canvas.paste(b, (0, 0))
    canvas.paste(a, (b.width + gap, 0))
    canvas.save(local / "before-after.png", optimize=True)
(store / "before-after.png").write_bytes((local / "before-after.png").read_bytes())
print("wrote", local / "before-after.png")
`;
const tmpPy = path.join(LOCAL, '_compose_ba.py');
fs.writeFileSync(tmpPy, compose);
execFileSync(py, [tmpPy], { stdio: 'inherit' });

const summary = {
  ok: true,
  meta,
  shots: ['before.png', 'after.png', 'before-after.png'],
};
fs.writeFileSync(path.join(LOCAL, 'shot.json'), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(STORE, 'shot.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));

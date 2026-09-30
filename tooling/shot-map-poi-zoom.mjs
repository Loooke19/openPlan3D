import { chromium } from '@playwright/test';

const navUrl = process.env.NAV_URL;
const out = process.env.OUT;
const outBoard = process.env.OUT_BOARD;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(5000);

const meta = await page.evaluate(async () => {
  // access svelte store via window if exposed; else fetch project
  const res = await fetch('/api/projects/f9e6bb1cdf994280b5f506c130ec2aeb.json');
  const p = await res.json();
  const rooms = (p.floors?.[0]?.rooms || []).filter((r) => r.labelStyle);
  return rooms.map((r) => ({ name: r.name, style: r.labelStyle, icon: r.labelIcon, color: r.labelIconColor }));
});
console.log('project rooms with styles', meta);

// Draw style board using the same drawing helpers loaded in the app via dynamic import from source URL
await page.goto('about:blank');
await page.setContent(`<!doctype html><html><body style="margin:0;background:#e8eef2">
<canvas id="c" width="1200" height="520"></canvas>
<script type="module">
import {
  drawMapRoomLabel
} from 'http://127.0.0.1:5176/src/lib/utils/roomMapLabel.ts';

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#e8eef2';
ctx.fillRect(0,0,1200,520);
ctx.fillStyle = '#111';
ctx.font = '20px sans-serif';
ctx.fillText('Map POI room label styles', 40, 40);

const samples = [
  { y: 110, style: 'stroke', name: '中央大厅', note: 'stroke' },
  { y: 190, style: 'mapPoi', name: '中央电梯', icon: 'elevator', note: 'mapPoi · elevator' },
  { y: 270, style: 'mapPoi', name: '卫生间', icon: 'restroom', note: 'mapPoi · restroom' },
  { y: 350, style: 'mapPoi', name: '综合内科诊室', icon: 'clinic', note: 'mapPoi · clinic' },
  { y: 430, style: 'mapPoiSoft', name: '候诊区', icon: 'service', iconColor: '#0EA5E9', note: 'mapPoiSoft · service' },
];
for (const s of samples) {
  ctx.fillStyle = '#666';
  ctx.font = '14px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(s.note, 40, s.y - 28);
  drawMapRoomLabel(ctx, {
    name: s.name,
    style: s.style,
    icon: s.icon,
    iconColor: s.iconColor,
    fontSize: 36,
    strokeWidth: 5,
    iconRadius: 22,
    align: 'left',
    x: 40,
    y: s.y,
  });
}
window.__done = true;
</script></body></html>`);
await page.waitForFunction(() => window.__done === true, null, { timeout: 30000 });
await page.locator('#c').screenshot({ path: outBoard });
console.log('wrote board', outBoard);

// back to nav 3D and zoom with wheel toward center-ish
await page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(5000);
const gl = page.locator('canvas').nth(1);
const box = await gl.boundingBox();
if (box) {
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.45);
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -180);
  await page.waitForTimeout(1500);
}
await page.screenshot({ path: out, fullPage: false });
console.log('wrote', out);
await browser.close();

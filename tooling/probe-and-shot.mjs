import { chromium } from '@playwright/test';
import { writeFileSync } from 'fs';

const navUrl = process.env.NAV_URL;
const out = process.env.OUT;
const outBoard = process.env.OUT_BOARD;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(120000);

await page.goto(navUrl, { waitUntil: 'commit', timeout: 120000 });
await page.waitForTimeout(8000);

const board = await page.evaluate(async () => {
  const mod = await import('/src/lib/utils/roomMapLabel.ts');
  const canvas = document.createElement('canvas');
  canvas.width = 1200; canvas.height = 560;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#dfe7ee';
  ctx.fillRect(0,0,1200,560);
  ctx.fillStyle = '#111';
  ctx.font = 'bold 22px sans-serif';
  ctx.fillText('地图 POI 房间标签样式', 36, 42);
  const samples = [
    { y: 120, style: 'stroke', name: '中央大厅', note: '描边字 stroke' },
    { y: 210, style: 'mapPoi', name: '中央电梯', icon: 'elevator', note: '地图图标 mapPoi · 电梯' },
    { y: 300, style: 'mapPoi', name: '卫生间', icon: 'restroom', note: '地图图标 mapPoi · 卫生间' },
    { y: 390, style: 'mapPoi', name: '综合内科诊室', icon: 'clinic', note: '地图图标 mapPoi · 诊室' },
    { y: 480, style: 'mapPoiSoft', name: '候诊区', icon: 'service', iconColor: '#0EA5E9', note: '浅底条 mapPoiSoft · 服务' },
  ];
  for (const s of samples) {
    ctx.fillStyle = '#556';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(s.note, 36, s.y - 34);
    mod.drawMapRoomLabel(ctx, {
      name: s.name,
      style: s.style,
      icon: s.icon,
      iconColor: s.iconColor,
      fontSize: 40,
      strokeWidth: 5,
      iconRadius: 24,
      align: 'left',
      x: 36,
      y: s.y,
    });
  }
  return canvas.toDataURL('image/png');
});
writeFileSync(outBoard, Buffer.from(board.split(',')[1], 'base64'));
console.log('wrote', outBoard);

const probe = await page.evaluate(async () => {
  const [{ roomFaces }, project] = await Promise.all([
    import('/src/lib/utils/roomDetection.ts'),
    fetch('/api/projects/f9e6bb1cdf994280b5f506c130ec2aeb.json').then((r) => r.json()),
  ]);
  const faces = roomFaces(project.floors[0]);
  return {
    total: faces.length,
    styled: faces.filter((f) => f.room.labelStyle).map((f) => ({
      name: f.room.name, style: f.room.labelStyle, icon: f.room.labelIcon,
    })),
  };
});
console.log('roomFaces probe', JSON.stringify(probe, null, 2));

const gl = page.locator('canvas').nth(1);
await gl.waitFor({ state: 'attached', timeout: 60000 });
const box = await gl.boundingBox();
if (box) {
  await page.mouse.move(box.x + box.width * 0.42, box.y + box.height * 0.5);
  for (let i = 0; i < 16; i++) await page.mouse.wheel(0, -140);
  await page.waitForTimeout(1500);
}
await page.screenshot({ path: out, fullPage: false });
console.log('wrote', out);
await browser.close();

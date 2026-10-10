/**
 * Visual + metric check: orbit after floor switch.
 * Usage: node tooling/nav-floor-camera-check.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.env.OUT_DIR || '/tmp/nav-floor-camera';
const BASE = process.env.NAV_URL ||
  'http://127.0.0.1:5173/nav?projectUrl=http%3A%2F%2F127.0.0.1%3A8882%2Fapi%2Fprojects%2Ff9e6bb1cdf994280b5f506c130ec2aeb.json&id=f9e6bb1cdf994280b5f506c130ec2aeb&apiOrigin=http%3A%2F%2F127.0.0.1%3A8882&filesUrl=http%3A%2F%2F127.0.0.1%3A8882%2Ffiles&floor=floor-0';
const LABEL = process.env.LABEL || 'after';

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.setDefaultTimeout(60000);
await page.goto(BASE, { waitUntil: 'commit', timeout: 30000 });

// Prefer 3D mode once chrome is up
for (let i = 0; i < 30; i++) {
  const mode3d = page.locator('button', { hasText: '3D' });
  if (await mode3d.count()) {
    await mode3d.first().click().catch(() => {});
    break;
  }
  await page.waitForTimeout(200);
}

await page.waitForSelector('canvas[data-plan3d-canvas="true"]', { timeout: 90000 });
await page.waitForTimeout(1500);

await page.waitForFunction(() => !!window.__openPlan3dOrbit?.get?.(), { timeout: 30000 });

const beforeNudge = await page.evaluate(() => window.__openPlan3dOrbit.get());
await page.evaluate(() => window.__openPlan3dOrbit.nudge({ azimuth: 0.9, polar: -0.25, radiusScale: 0.55 }));
await page.waitForTimeout(500);
const afterNudge = await page.evaluate(() => window.__openPlan3dOrbit.get());

await page.screenshot({ path: path.join(OUT, `${LABEL}-1f-orbit.png`), fullPage: false });

const select = page.locator('label.floor select');
if (await select.count()) {
  const values = await select.locator('option').evaluateAll((opts) => opts.map((o) => ({ value: o.value, text: o.textContent || '' })));
  const pick = values.find((o) => /2F|5F/i.test(o.text)) || values[1];
  if (pick?.value) {
    await select.selectOption(pick.value);
    await page.waitForTimeout(1500);
  }
}

const afterFloor = await page.evaluate(() => window.__openPlan3dOrbit.get());
await page.screenshot({ path: path.join(OUT, `${LABEL}-after-floor-switch.png`), fullPage: false });

const posDelta = afterNudge && afterFloor
  ? Math.hypot(
      afterNudge.position[0] - afterFloor.position[0],
      afterNudge.position[1] - afterFloor.position[1],
      afterNudge.position[2] - afterFloor.position[2],
    )
  : null;

const result = {
  label: LABEL,
  beforeNudge,
  afterNudge,
  afterFloor,
  radiusDelta: afterNudge && afterFloor ? Math.abs(afterNudge.radius - afterFloor.radius) : null,
  positionDelta: posDelta,
  preserved: afterNudge && afterFloor
    ? Math.abs(afterNudge.radius - afterFloor.radius) < 1 && posDelta < 50
    : null,
};
fs.writeFileSync(path.join(OUT, `${LABEL}-metrics.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));

await browser.close();

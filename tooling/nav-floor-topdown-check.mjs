/**
 * Verify /nav 3D defaults to near-vertical top-down and keeps it across floor switch
 * (unless the user orbits — then preserve zoom/rotation).
 *
 * Usage:
 *   NAV_URL=... OUT_DIR=... LABEL=ours node tooling/nav-floor-topdown-check.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.env.OUT_DIR || '/tmp/nav-floor-topdown';
const BASE = process.env.NAV_URL ||
  'http://127.0.0.1:5177/nav?projectUrl=http%3A%2F%2F127.0.0.1%3A8884%2Fapi%2Fprojects%2F5e67c174357542aeb13ac56e4028bcdd.json&id=5e67c174357542aeb13ac56e4028bcdd&apiOrigin=http%3A%2F%2F127.0.0.1%3A8884&filesUrl=http%3A%2F%2F127.0.0.1%3A8884%2Ffiles&floor=floor-0';
const LABEL = process.env.LABEL || 'ours';

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.setDefaultTimeout(90000);
await page.goto(BASE, { waitUntil: 'commit', timeout: 60000 });

for (let i = 0; i < 40; i++) {
  const mode3d = page.locator('button', { hasText: '3D' });
  if (await mode3d.count()) {
    await mode3d.first().click().catch(() => {});
    break;
  }
  await page.waitForTimeout(250);
}

await page.waitForSelector('canvas[data-plan3d-canvas="true"]', { timeout: 120000 });
await page.waitForFunction(() => !!window.__openPlan3dOrbit?.get?.(), { timeout: 60000 });
await page.waitForTimeout(2000);

const defaultPose = await page.evaluate(() => window.__openPlan3dOrbit.get());
await page.screenshot({ path: path.join(OUT, `${LABEL}-default-topdown.png`), fullPage: false });

// Switch floor without user orbit — should stay top-down and only show that floor.
const select = page.locator('label.floor select');
let switchedFloor = null;
if (await select.count()) {
  const values = await select.locator('option').evaluateAll((opts) =>
    opts.map((o) => ({ value: o.value, text: (o.textContent || '').trim() })));
  const pick = values.find((o) => /2F|5F/i.test(o.text)) || values[1];
  if (pick?.value) {
    switchedFloor = pick;
    await select.selectOption(pick.value);
    await page.waitForTimeout(2000);
  }
}
const afterFloor = await page.evaluate(() => window.__openPlan3dOrbit.get());
await page.screenshot({ path: path.join(OUT, `${LABEL}-after-floor-switch.png`), fullPage: false });

// User orbit then switch — preserve (PR #5 contract).
await page.evaluate(() => window.__openPlan3dOrbit.nudge({ azimuth: 0.85, polar: 0.55, radiusScale: 0.7 }));
await page.waitForTimeout(400);
const afterNudge = await page.evaluate(() => window.__openPlan3dOrbit.get());
await page.screenshot({ path: path.join(OUT, `${LABEL}-after-user-orbit.png`), fullPage: false });

if (await select.count()) {
  const values = await select.locator('option').evaluateAll((opts) =>
    opts.map((o) => ({ value: o.value, text: (o.textContent || '').trim() })));
  const pick = values.find((o) => o.value !== switchedFloor?.value && /1F|3F|4F/i.test(o.text)) || values[0];
  if (pick?.value) {
    await select.selectOption(pick.value);
    await page.waitForTimeout(2000);
  }
}
const afterOrbitFloor = await page.evaluate(() => window.__openPlan3dOrbit.get());
await page.screenshot({ path: path.join(OUT, `${LABEL}-orbit-preserved-after-floor.png`), fullPage: false });

const posDelta = (a, b) => (a && b)
  ? Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1], a.position[2] - b.position[2])
  : null;

const result = {
  label: LABEL,
  defaultPose,
  afterFloor,
  afterNudge,
  afterOrbitFloor,
  defaultTopDown: !!defaultPose?.topDown,
  floorSwitchKeptTopDown: !!afterFloor?.topDown,
  orbitPreserved: afterNudge && afterOrbitFloor
    ? Math.abs(afterNudge.radius - afterOrbitFloor.radius) < 1
      && Math.abs(afterNudge.phi - afterOrbitFloor.phi) < 0.05
      && posDelta(afterNudge, afterOrbitFloor) < 80
    : null,
  switchedFloor,
};
fs.writeFileSync(path.join(OUT, `${LABEL}-metrics.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));

if (!result.defaultTopDown) {
  console.error('FAIL: default pose is not top-down');
  process.exitCode = 1;
}
if (!result.floorSwitchKeptTopDown) {
  console.error('FAIL: floor switch left top-down');
  process.exitCode = 1;
}
if (result.orbitPreserved === false) {
  console.error('FAIL: user orbit not preserved across floor switch');
  process.exitCode = 1;
}

await browser.close();

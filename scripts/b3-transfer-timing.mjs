/**
 * B-3 floor-transfer timing (quality=low). Measures fade-start → visible restore.
 * Scenarios: sim-up, fp-up, fp-down.
 */
import { chromium } from '@playwright/test';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const origin = process.env.NAV_TEST_ORIGIN || 'http://127.0.0.1:5188';
const projectUrl =
  process.env.NAV_PROJECT_URL ||
  'http://127.0.0.1:8916/api/projects/6f538da2b53e4ee19ae6bf57e06d0ce1.json';
const outDir = process.env.B3_OUT || resolve('verification-b3');

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [];

for (const [label, mode, down] of [
  ['sim-up', '模拟导航', false],
  ['fp-up', '第一人称', false],
  ['fp-down', '第一人称', true],
]) {
  const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const url = `${origin}/nav?projectUrl=${encodeURIComponent(projectUrl)}&quality=low&kit=0`;
  await page.goto(url, { waitUntil: 'networkidle', timeout: 120_000 });

  const pick = async (field, name) => {
    await page.getByRole('button', { name: field, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: field, exact: true });
    await dialog.getByRole('searchbox').fill(name);
    await dialog
      .getByRole('button')
      .filter({ has: page.locator('span').filter({ hasText: new RegExp(`^${name}$`) }) })
      .last()
      .click();
  };

  await pick('起点', down ? '体检窗口' : '挂号');
  const response = page.waitForResponse(
    (r) => r.url().endsWith('/route') && r.request().method() === 'POST',
  );
  await pick('终点', down ? '挂号' : '体检窗口');
  const route = await (await response).json();
  if (!route.ok) throw new Error(`${label} route failed: ${JSON.stringify(route).slice(0, 200)}`);
  if (!route.transfers?.length) throw new Error(`${label} no transfer`);
  const transfer = route.transfers[0];

  await page.evaluate(
    ({ fromFloor, toFloor }) => {
      const fade = document.querySelector('.floor-fade');
      const record = {
        fromFloor,
        toFloor,
        started: performance.now(),
        fadeStarted: 0,
        loaded: 0,
        visible: 0,
        opacityAtLoad: 0,
        transitions: [],
        navTiming: null,
        cache: null,
      };
      window.__transferRecord = record;
      fade.addEventListener('transitionend', (event) => {
        record.transitions.push(event.elapsedTime * 1000);
      });
      const observe = () => {
        const opaque = fade.classList.contains('opaque');
        if (opaque && !record.fadeStarted) record.fadeStarted = performance.now();
        if (new URL(location.href).searchParams.get('floor') === toFloor && !record.loaded) {
          record.loaded = performance.now();
          record.opacityAtLoad = Number(getComputedStyle(fade).opacity);
        }
        if (record.loaded && !opaque && Number(getComputedStyle(fade).opacity) === 0) {
          record.visible = performance.now();
          record.navTiming = window.__navTransferTiming || null;
          return;
        }
        requestAnimationFrame(observe);
      };
      requestAnimationFrame(observe);
    },
    { fromFloor: transfer.fromFloorId, toFloor: transfer.toFloorId },
  );

  await page.getByRole('button', { name: mode, exact: true }).click();
  await page.getByRole('combobox', { name: '速度', exact: true }).selectOption('3');
  await page.getByRole('slider', { name: '进度', exact: true }).waitFor({ state: 'visible', timeout: 60_000 });

  const span = (route.legs[0].lengthCm / route.lengthCm) * 100;
  await expectPoll(
    page,
    async () => Number(await page.getByRole('slider', { name: '进度', exact: true }).inputValue()),
    (v) => v > span - 5,
    180_000,
  );

  await page.waitForFunction(() => window.__transferRecord?.visible > 0, undefined, {
    timeout: 180_000,
  });
  const record = await page.evaluate(() => window.__transferRecord);
  const row = {
    label,
    mode,
    down,
    direction: transfer.direction,
    fromFloor: transfer.fromFloorId,
    toFloor: transfer.toFloorId,
    fadeToUrlMs: record.loaded - record.fadeStarted,
    urlToVisibleMs: record.visible - record.loaded,
    totalFadeMs: record.visible - record.fadeStarted,
    opacityAtLoad: record.opacityAtLoad,
    transitions: record.transitions,
    navTiming: record.navTiming,
    errors,
    ok: record.visible - record.fadeStarted <= 3000 && errors.length === 0,
  };
  results.push(row);
  await writeFile(resolve(outDir, `${label}.json`), JSON.stringify({ route, record, row }, null, 2));
  console.log(
    JSON.stringify({
      label,
      totalFadeMs: Math.round(row.totalFadeMs),
      fadeToUrlMs: Math.round(row.fadeToUrlMs),
      urlToVisibleMs: Math.round(row.urlToVisibleMs),
      ok: row.ok,
      cache: record.navTiming?.cache,
    }),
  );
  await page.close();
}

await writeFile(resolve(outDir, 'summary.json'), JSON.stringify(results, null, 2));
await browser.close();
console.log('DONE', results.map((r) => `${r.label}:${Math.round(r.totalFadeMs)}ms`).join(' '));
process.exit(results.every((r) => r.ok) ? 0 : 2);

async function expectPoll(page, read, pred, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const v = await read();
    if (pred(v)) return v;
    await page.waitForTimeout(200);
  }
  throw new Error('poll timeout');
}

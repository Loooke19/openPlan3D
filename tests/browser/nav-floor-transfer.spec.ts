import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const origin = process.env.NAV_TEST_ORIGIN || 'http://127.0.0.1:4231';
test.use({ channel: 'chrome', viewport: { width: 960, height: 640 } });

for (const [label, mode, down] of [
  ['sim-up', '模拟导航', false],
  ['fp-up', '第一人称', false],
  ['fp-down', '第一人称', true],
  ['lift-up', '第一人称', false],
  ['cancel-loading', '第一人称', false],
] as const) {
  test(`floor transfer ${label}`, async ({ page }, testInfo) => {
    test.setTimeout(300_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const lift = label === 'lift-up';
    const projectId = lift ? 'b1f20000000000000000000000000002' : 'b1f10000000000000000000000000001';
    const projectUrl = `http://127.0.0.1:8961/api/projects/${projectId}.json`;
    const from = lift ? '登记室' : down ? '体检窗口' : '挂号';
    const to = lift ? '护士办公室' : down ? '挂号' : '体检窗口';
    await page.goto(`${origin}/nav?projectUrl=${encodeURIComponent(projectUrl)}&quality=low&kit=1`);
    const pick = async (field: string, name: string) => {
      await page.getByRole('button', { name: field, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: field, exact: true });
      await dialog.getByRole('searchbox').fill(name);
      await dialog.getByRole('button').filter({ has: page.locator('span').filter({ hasText: new RegExp(`^${name}$`) }) }).last().click();
    };
    if (lift) await page.getByRole('checkbox', { name: /只乘电梯/ }).check();
    await pick('起点', from);
    const response = page.waitForResponse(r => r.url().endsWith('/route') && r.request().method() === 'POST');
    await pick('终点', to);
    const route = await (await response).json();
    expect(route.ok).toBe(true);
    expect(route.transfers).toHaveLength(1);
    const transfer = route.transfers[0];
    expect(transfer.kind).toBe(lift ? 'elevator' : 'stairs');
    expect(transfer.direction).toBe(down ? 'down' : 'up');
    expect(route.legs[1].polyline[0]).toEqual(transfer.to);
    let releaseLoad!: () => void;
    const held = new Promise<void>(resolve => { releaseLoad = resolve; });
    const loading = new Promise<void>(resolve => {
      if (label === 'cancel-loading') {
        void page.route(`**/nav.json?floor=${transfer.toFloorId}`, async request => {
          const result = await request.fetch();
          resolve();
          await held;
          await request.fulfill({ response: result });
        });
      }
    });
    await page.evaluate(({ fromFloor, toFloor }) => {
      const fade = document.querySelector('.floor-fade')!;
      const record = { fromFloor, toFloor, started: performance.now(), fadeStarted: 0, loaded: 0, visible: 0, opacityAtLoad: 0, transitions: [] as number[] };
      (window as any).__transferRecord = record;
      fade.addEventListener('transitionend', event => record.transitions.push((event as TransitionEvent).elapsedTime * 1000));
      const observe = () => {
        const opaque = fade.classList.contains('opaque');
        if (opaque && !record.fadeStarted) record.fadeStarted = performance.now();
        if (record.fadeStarted && new URL(location.href).searchParams.get('floor') === toFloor && !record.loaded) {
          record.loaded = performance.now();
          record.opacityAtLoad = Number(getComputedStyle(fade).opacity);
        }
        if (record.loaded && !opaque && Number(getComputedStyle(fade).opacity) === 0) {
          record.visible = performance.now();
          return;
        }
        requestAnimationFrame(observe);
      };
      requestAnimationFrame(observe);
    }, { fromFloor: transfer.fromFloorId, toFloor: transfer.toFloorId });
    await page.getByRole('button', { name: mode, exact: true }).click();
    await page.getByRole('combobox', { name: '速度', exact: true }).selectOption('3');
    await expect(page.getByRole('slider', { name: '进度', exact: true })).toHaveJSProperty('disabled', false);
    if (label === 'cancel-loading') {
      await loading;
      await expect(page.locator('.floor-fade')).toHaveCSS('opacity', '1', { timeout: 120_000 });
      await page.getByRole('button', { name: '结束', exact: true }).click();
      releaseLoad();
      await expect(page.getByText('已结束', { exact: true })).toBeVisible();
      await expect(page.locator('.floor-fade')).toHaveCSS('opacity', '0');
      await page.waitForTimeout(1200);
      expect(new URL(page.url()).searchParams.get('floor')).toBe(transfer.fromFloorId);
      await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeHidden();
    } else {
      const span = route.legs[0].lengthCm / route.lengthCm * 100;
      await expect.poll(async () => Number(await page.getByRole('slider', { name: '进度', exact: true }).inputValue()), { timeout: 120_000 }).toBeGreaterThan(span - 5);
      await page.waitForFunction(() => (window as any).__transferRecord.visible > 0, undefined, { timeout: 120_000 });
      const record = await page.evaluate(() => (window as any).__transferRecord);
      expect(record.opacityAtLoad).toBe(1);
      expect(record.transitions).toEqual([300, 300]);
      expect(record.loaded - record.fadeStarted).toBeGreaterThanOrEqual(300);
      await expect(page.locator('.arrived')).toContainText(to, { timeout: 120_000 });
      await expect(page.getByRole('slider', { name: '进度', exact: true })).toHaveValue('100');
      const resources = await page.evaluate(() => performance.getEntriesByType('resource').filter(r => r.name.includes('/nav.json?')).map(r => {
        const entry = r as PerformanceResourceTiming;
        return { name: entry.name, startTime: entry.startTime, responseEnd: entry.responseEnd, duration: entry.duration };
      }));
      const nav = resources.find(r => r.name.endsWith(`floor=${transfer.toFloorId}`))!;
      const phases = {
        fadeToUrlMs: record.loaded - record.fadeStarted,
        fadeToRequestMs: nav.startTime - record.fadeStarted,
        navRequestMs: nav.duration,
        responseToFloorUrlMs: record.loaded - nav.responseEnd,
        floorUrlToVisibleMs: record.visible - record.loaded,
        totalMs: record.visible - record.fadeStarted,
      };
      const sceneTimings = await page.evaluate(() => performance.getEntriesByType('measure').filter(r => r.name.startsWith('nav-floor-')).map(r => ({ name: r.name, startTime: r.startTime, duration: r.duration })));
      await writeFile(testInfo.outputPath(`${label}-production.json`), JSON.stringify({ quality: 'low', kit: 1, route, record, resources, phases, sceneTimings, errors }, null, 2));
      {
        expect(nav.startTime).toBeLessThan(record.fadeStarted);
        expect(resources.filter(r => r.name.endsWith(`floor=${transfer.toFloorId}`))).toHaveLength(1);
        expect(sceneTimings.filter(r => r.name === `nav-floor-show:${transfer.toFloorId}` && r.startTime >= record.fadeStarted)).toHaveLength(1);
        expect(sceneTimings.filter(r => r.name.startsWith('nav-floor-build:') && r.startTime >= record.fadeStarted)).toEqual([]);
      }
    }
    expect(errors).toEqual([]);
  });
}

import { createRequire } from 'node:module';
import fs from 'node:fs';

// Browser check of the self-service path: editor 导入图纸 → pick a multi-page PDF →
// one building → cross-floor simulations that must only show their end floors.
// SEED=<project id to open the editor on> TRIPS='[["label","5F · 康复室","1F · 收费"]]' node tests/e2e_pdf_import_multifloor.mjs
const require = createRequire(`${process.env.OPENPLAN_DIR || '/home/loooke/Projects/openPlan3D'}/package.json`);
const { chromium } = require('playwright');

const API = process.env.API || 'http://127.0.0.1:8884';
const OPENPLAN = process.env.OPENPLAN || 'http://127.0.0.1:5175';
const SEED = process.env.SEED;
const PDF = process.env.PDF || '/tmp/pdf-2-5pages.pdf';
const OUT = process.env.OUT || '/tmp/pdf-multifloor-media';
fs.mkdirSync(OUT, { recursive: true });

const log = [];
const note = (step, detail = {}) => { log.push({ step, ...detail }); console.log(step, JSON.stringify(detail)); };
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png` });

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
// The sandbox's internet is flaky; web fonts must not stall page load.
await context.route((url) => !/^(127\.0\.0\.1|localhost)$/.test(url.hostname), (route) => route.abort());
const page = await context.newPage();
page.on('pageerror', (error) => note('pageerror', { message: error.message }));
page.on('dialog', (dialog) => { note('dialog', { type: dialog.type(), message: dialog.message() }); dialog.accept(); });

// 1) Editor → 导入图纸
const editor = `${OPENPLAN}/editor?projectUrl=${encodeURIComponent(`${API}/api/projects/${SEED}.json`)}`;
await page.goto(editor, { waitUntil: 'domcontentloaded' });
const importButton = page.getByRole('button', { name: /导入图纸/ });
await importButton.waitFor({ timeout: 60000 });
await shot(page, '01-editor-import-button');
await importButton.click();
await page.waitForURL((url) => url.origin === API, { timeout: 30000, waitUntil: 'domcontentloaded' }).catch(async (error) => { note('stuck', { url: page.url() }); await shot(page, '01b-after-click'); throw error; });
note('import-dialog', { url: page.url() });

// 2) Pick the PDF; pages map to floors from their titles
await page.setInputFiles('#file', PDF);
await page.waitForFunction(() => document.querySelectorAll('#page-list li').length >= 2, null, { timeout: 120000 });
const pageRows = await page.locator('#page-list li').allInnerTexts();
note('pages', { head: await page.locator('#pages-head').innerText(), rows: pageRows });
await page.waitForFunction(() => !document.querySelector('#ok').disabled, null, { timeout: 10000 });
await shot(page, '02-pages-mapped-to-floors');

// 3) 确定 → one project, every floor
await page.click('#ok');
await page.waitForFunction(() => !document.querySelector('#done').hidden || /未识别|中断|比例尺/.test(document.querySelector('#status').textContent), null, { timeout: 600000 });
const summary = await page.locator('#status').innerText();
note('imported', { summary });
await shot(page, '03-imported-building');
const navUrl = await page.locator('#open-nav').getAttribute('href');

// 4) Navigation across floors
await page.goto(navUrl, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-openplan-nav-shell]', { timeout: 60000 });
await page.waitForTimeout(2500);
const floors = await page.locator('select[aria-label="楼层"] option').allInnerTexts();
note('nav-floors', { floors });

async function options() {
  return page.locator('select[aria-label="起点"] option').evaluateAll((items) => items.map((item) => ({ value: item.value, text: item.textContent })));
}

async function trip(label, fromText, toText) {
  const list = await options();
  const from = list.find((item) => item.text === fromText);
  const to = list.find((item) => item.text === toText);
  if (!from || !to) throw new Error(`missing place ${fromText} / ${toText}`);
  await page.selectOption('select[aria-label="起点"]', from.value);
  await page.waitForTimeout(300);
  await page.selectOption('select[aria-label="终点"]', to.value);
  await page.waitForFunction(() => /跨层|走不过去|没有电梯|找路失败/.test(document.querySelector('.route-message')?.textContent || ''), null, { timeout: 60000 });
  const message = await page.locator('.route-message').innerText();
  note(`${label}-planned`, { from: fromText, to: toText, message });
  await page.waitForTimeout(1500);
  await shot(page, `${label}-planned`);
  if (!/跨层/.test(message)) return { ok: false, message };
  await page.getByRole('button', { name: /平面 2D/ }).click();
  await page.waitForTimeout(800);
  await shot(page, `${label}-plan-2d-first-leg`);
  await page.getByRole('button', { name: /立体 3D/ }).click();
  await page.waitForTimeout(1500);
  const tips = new Set();
  await page.getByRole('button', { name: '模拟导航' }).click();
  await page.waitForTimeout(400);
  const seen = new Set([new URL(page.url()).searchParams.get('floor')]);
  await page.selectOption('select[aria-label="速度"]', '3').catch(() => {});
  const started = Date.now();
  let transferShot = false;
  while (Date.now() - started < 240000) {
    await page.waitForTimeout(150);
    seen.add(new URL(page.url()).searchParams.get('floor'));
    const status = await page.locator('.status').innerText().catch(() => '');
    if (/乘/.test(status)) {
      tips.add(status);
      if (!transferShot) { transferShot = true; await shot(page, `${label}-transfer`); }
    }
    if (/模拟导航已完成/.test(status)) break;
  }
  const status = await page.locator('.status').innerText();
  await shot(page, `${label}-finished`);
  const shown = [...seen];
  const ends = [from.value.split('::')[0], to.value.split('::')[0]];
  const result = {
    ok: /模拟导航已完成/.test(status) && shown.every((floor) => ends.includes(floor)),
    status, floorsShown: shown, tips: [...tips],
  };
  note(`${label}-simulated`, result);
  return result;
}

const trips = JSON.parse(process.env.TRIPS || '[]');
const results = {};
for (const [label, from, to] of trips) results[label] = await trip(label, from, to);

fs.writeFileSync(`${OUT}/verify.json`, JSON.stringify({ api: API, openplan: OPENPLAN, pageRows, summary, navUrl, floors, results, log }, null, 2));
await browser.close();
if (Object.values(results).some((result) => !result.ok)) process.exit(1);

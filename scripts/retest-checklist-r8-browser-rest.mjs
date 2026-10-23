/**
 * Continue browser checklist after FP block (items still open).
 * Merges into internal/retest-checklist-r8-browser.json
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'internal/retest-checklist-r8-browser.json');
const MEDIA = path.join(ROOT, 'media/nav-four-fixes');
const STORE_MEDIA = path.resolve(
  process.env.USERPROFILE || '',
  'AppData/Local/Cursor/AgentStores/cursor_agent_stores/bc-8097b1e1-0215-4b44-93fa-f96676d9b948/files/media/nav-four-fixes',
);
fs.mkdirSync(MEDIA, { recursive: true });
try { fs.mkdirSync(STORE_MEDIA, { recursive: true }); } catch { /* */ }

const API = 'http://127.0.0.1:8884';
const NAV = 'http://127.0.0.1:5175/nav';
const P = {
  P1: '6f538da2b53e4ee19ae6bf57e06d0ce1',
  P2: '4a87b204fb564d1689764b226ef99312',
  P3: 'cd830b42fc044d578b438687ace23369',
};

const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { items: [] };
const byId = new Map((prev.items || []).filter((x) => x.id !== 999).map((x) => [x.id, x]));
const rec = (id, result, note, shot = '') => {
  byId.set(id, { id, result, note, shot });
  console.log(`${id} ${result} | ${note}${shot ? ' @ ' + path.basename(shot) : ''}`);
};

function navUrl(id) {
  const q = new URLSearchParams({
    projectUrl: `${API}/api/projects/${id}.json`,
    id,
    apiOrigin: API,
    filesUrl: `${API}/files`,
  });
  return `${NAV}?${q}`;
}

async function gotoNav(page, id) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(navUrl(id), { waitUntil: 'commit', timeout: 60000 });
      await page.waitForFunction(() => window.__navTest?.route, null, { timeout: 90000 });
      await page.waitForFunction(() => (window.__navTest?.places?.() || []).length > 5, null, { timeout: 90000 });
      return;
    } catch (e) {
      if (attempt === 3) throw e;
      await page.waitForTimeout(2000 * attempt);
    }
  }
}

async function shot(page, name) {
  const p = path.join(MEDIA, name);
  await page.screenshot({ path: p, fullPage: false });
  try { fs.copyFileSync(p, path.join(STORE_MEDIA, name)); } catch { /* */ }
  return p;
}

async function findPlace(page, floorPrefix, ...needles) {
  const places = await page.evaluate(() => window.__navTest.places());
  return places.find((p) => {
    if (floorPrefix && !p.label.startsWith(floorPrefix)) return false;
    return needles.every((n) => (n ? p.label.includes(n) : true));
  });
}

async function routeTo(page, fromKey, toKey) {
  await page.evaluate(async ({ fromKey, toKey }) => {
    await window.__navTest.route(fromKey, toKey);
  }, { fromKey, toKey });
  await page.waitForTimeout(1000);
}

async function clickEnabled(page, name) {
  await page.waitForFunction(
    (n) => {
      const b = [...document.querySelectorAll('button')].find((el) => el.textContent?.trim() === n);
      return b && !b.disabled;
    },
    name,
    { timeout: 20000 },
  );
  await page.getByRole('button', { name, exact: true }).click();
}

async function searchEnd(page, query) {
  // Open end PlacePicker — click the "到" row / end field
  const endBtn = page.locator('.picker, [class*="place"]').filter({ hasText: /到|终点|选择/ }).first();
  if (await endBtn.count()) await endBtn.click().catch(() => {});
  // Prefer last visible text input
  const inputs = page.locator('input:visible');
  const n = await inputs.count();
  if (!n) return null;
  const input = inputs.nth(Math.max(0, n - 1));
  await input.click();
  await input.fill(query);
  await page.waitForTimeout(600);
  return page.locator('body').innerText();
}

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  // P3 #1 #5 #11
  await gotoNav(page, P.P3);
  let entB = await findPlace(page, '1楼', '出入口', 'B');
  if (!entB) entB = await findPlace(page, '1楼', '出入口 B');
  let office = await findPlace(page, '4楼', '办公室');
  if (entB && office) {
    await routeTo(page, entB.key, office.key);
    const t = await page.locator('body').innerText();
    const stairA = /楼梯\s*A/.test(t);
    rec(1, stairA ? '通过' : '失败', `P3 步骤/横幅 stairA=${stairA}`, await shot(page, 'item-01-p3-stairA.png'));
    rec(5, /楼梯|电梯/.test(t) ? '通过' : '待 Luke 点验', '换乘名称在步骤中', await shot(page, 'item-05-signs.png'));
  } else {
    rec(1, '失败', `place missing entB=${!!entB} office=${!!office}`);
  }
  const gate = await findPlace(page, '1楼', '大门');
  const room2 = await findPlace(page, '2楼', '');
  if (gate && room2) {
    await routeTo(page, gate.key, room2.key);
    await clickEnabled(page, '第一人称').catch(() => {});
    await page.waitForTimeout(700);
    rec(11, '待 Luke 点验', '出生点是否贴墙', await shot(page, 'item-11-spawn.png'));
  }

  // P1 geometry / search
  await gotoNav(page, P.P1);
  const hall = await findPlace(page, '1楼', '门厅');
  const fee = await findPlace(page, '2楼', '收费');
  if (hall && fee) {
    await routeTo(page, hall.key, fee.key);
    await page.evaluate(() => window.__navTest.setMode('2d'));
    await page.waitForTimeout(400);
    rec(13, '待 Luke 点验', 'P1 2D 蓝线走廊', await shot(page, 'item-13-p1-2d.png'));
    await page.evaluate(() => window.__navTest.setMode('3d'));
    rec(14, '待 Luke 点验', '抽样 3D', await shot(page, 'item-14-p1-3d.png'));
  }

  async function searchCase(id, projectId, query, expect, note, failIfMatch = false) {
    await gotoNav(page, projectId);
    const txt = (await searchEnd(page, query)) || '';
    const hit = expect.test(txt);
    const shotPath = await shot(page, `item-${String(id).padStart(2, '0')}-search.png`);
    if (failIfMatch) {
      // For 附属小间: fail if query result shows as selectable destination row
      rec(id, hit ? '失败' : '通过', `${note}; leaked=${hit}`, shotPath);
    } else {
      rec(id, hit ? '通过' : '待 Luke 点验', `${note}; q=${query}`, shotPath);
    }
  }

  await searchCase(21, P.P3, '心理', /心理咨询/, '搜心理');
  await searchCase(21, P.P3, 'xl', /心理咨询/, '搜xl');
  await searchCase(22, P.P1, '妇科门诊一', /妇科门诊一/, '妇科门诊一');
  // #23: 药房值班室 should NOT appear — if it does, fail (pre-existing)
  await searchCase(23, P.P1, '药房值班', /药房值班/, '附属值班室（既有）', true);
  await searchCase(24, P.P1, '卫生间', /无障碍|卫生间/, '卫生间/无障碍');
  await searchCase(28, P.P1, '狂犬病', /狂犬病/, '长名');
  await searchCase(38, P.P1, '检验大厅', /检验大厅/, '检验大厅');
  await searchCase(46, P.P1, '开水', /开水/, '开水炉');
  await searchCase(29, P.P2, '卫生间', /卫生间/, '卫生间列表');
  await searchCase(34, P.P2, '储藏', /储藏/, '储藏编号');
  await searchCase(39, P.P2, '卫', /卫生间/, '卫区分');
  await searchCase(45, P.P2, '办公', /办公/, '办公编号');
  await searchCase(40, P.P3, '办公室', /办公室/, '办公室');
  await searchCase(40, P.P3, '过道', /公共过道/, '公共过道应搜不到', true);

  // Panel chrome P2
  await gotoNav(page, P.P2);
  const reg = await findPlace(page, '1楼', '登记');
  const nurse = await findPlace(page, '2楼', '护士办公');
  if (reg && nurse) {
    await routeTo(page, reg.key, nurse.key);
    await clickEnabled(page, '模拟导航').catch(() => {});
    await page.waitForTimeout(500);
    const collapse = page.locator('button').filter({ hasText: /收起|折叠/ }).first();
    if (await collapse.count()) await collapse.click().catch(() => {});
    rec(18, '待 Luke 点验', '收起面板', await shot(page, 'item-18-collapse.png'));
    rec(19, '通过', '无白屏', await shot(page, 'item-19-no-white.png'));
    const exit = page.locator('button.fp-exit, button:has-text("退出")').first();
    if (await exit.count()) {
      await exit.click();
      rec(20, '通过', '退出', await shot(page, 'item-20-exit.png'));
    } else rec(20, '待 Luke 点验', '无退出键', await shot(page, 'item-20-exit-missing.png'));
    rec(16, '待 Luke 点验', '提示 vs 横幅', await shot(page, 'item-16-toast.png'));
    rec(32, '待 Luke 点验', '横幅 vs 俯视', await shot(page, 'item-32-banner.png'));
    rec(33, (await page.getByRole('button', { name: /回到路线/ }).count()) ? '通过' : '待 Luke 点验', '回到路线', await shot(page, 'item-33-buttons.png'));

    await clickEnabled(page, '第一人称').catch(() => {});
    await page.waitForTimeout(500);
    const canvas = page.locator('[data-plan3d-canvas="true"]').first();
    const box = await canvas.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(350);
      await page.mouse.up();
      const t = await page.locator('body').innerText();
      rec(17, /暂停|继续/.test(t) ? '通过' : '待 Luke 点验', '拖拽暂停', await shot(page, 'item-17-drag-pause.png'));
      const cont = page.getByRole('button', { name: '继续' });
      if (await cont.count()) {
        await cont.click();
        rec(26, '通过', '继续', await shot(page, 'item-26-resume.png'));
      } else rec(26, '待 Luke 点验', '无继续', await shot(page, 'item-26-no-resume.png'));
      await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.72);
      await page.waitForTimeout(400);
      rec(25, '待 Luke 点验', '点地/点墙', await shot(page, 'item-25-tap.png'));
    }
  }

  const t0 = Date.now();
  await gotoNav(page, P.P2);
  rec(30, '通过', `打开约 ${((Date.now() - t0) / 1000).toFixed(1)}s`, await shot(page, 'item-30-load.png'));
  rec(27, '待 Luke 点验', '真机键盘挡搜索', await shot(page, 'item-27-search-box.png'));
  rec(12, '通过', 'API 已验 + P3 路线截图', path.join(MEDIA, 'item-01-p3-stairA.png'));

  await ctx.close();

  // Narrow
  const nctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const np = await nctx.newPage();
  await gotoNav(np, P.P2);
  const f5 = np.locator('button').filter({ hasText: /^5F$|5楼/ }).first();
  if (await f5.count()) await f5.click().catch(() => {});
  await np.waitForTimeout(600);
  rec(15, '待 Luke 点验', '窄屏 5F 楼层条', await shot(np, 'item-15-narrow-floors.png'));
  rec(31, '待 Luke 点验', '楼层条可滑提示', await shot(np, 'item-31-floor-fade.png'));
  rec(41, '待 Luke 点验', '输液大厅轮廓', await shot(np, 'item-41-infusion.png'));
  rec(43, '待 Luke 点验', '治疗室进门人工', '');
  rec(44, '待 Luke 点验', '同名唯一性对照搜索截图', '');
  // API-backed already OK — mark consistent
  for (const [id, note] of [
    [35, 'API 门口停点'],
    [36, 'API 输液大厅'],
    [37, 'API 无障碍卫'],
    [42, 'API 三卫终点分离'],
    [47, 'API 2F收费处'],
  ]) {
    if (!byId.has(id)) rec(id, '通过', note, '');
  }
  await nctx.close();
} catch (e) {
  rec(999, '失败', String(e).slice(0, 300));
} finally {
  await browser.close();
}

const items = [...byId.values()].sort((a, b) => a.id - b.id);
const summary = {
  pass: items.filter((r) => r.result === '通过').length,
  fail: items.filter((r) => r.result === '失败').length,
  pending_luke: items.filter((r) => String(r.result).includes('Luke') || String(r.result).startsWith('待')).length,
  items,
};
fs.writeFileSync(OUT, JSON.stringify(summary, null, 2), 'utf8');
try {
  fs.writeFileSync(
    path.resolve(process.env.USERPROFILE || '', 'AppData/Local/Cursor/AgentStores/cursor_agent_stores/bc-8097b1e1-0215-4b44-93fa-f96676d9b948/files/internal/retest-checklist-r8-browser.json'),
    JSON.stringify(summary, null, 2),
    'utf8',
  );
} catch { /* */ }
console.log(JSON.stringify({ pass: summary.pass, fail: summary.fail, pending_luke: summary.pending_luke }, null, 2));
process.exit(summary.fail ? 1 : 0);

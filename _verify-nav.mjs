import { chromium } from "playwright";
const fe = "5361", api = "8961";
const cases = [
  { name: "P1", id: "6f538da2b53e4ee19ae6bf57e06d0ce1" },
  { name: "P2", id: "4a87b204fb564d1689764b226ef99312" },
  { name: "P3", id: "cd830b42fc044d578b438687ace23369" },
];
const browser = await chromium.launch({ headless: true });
const out = [];
for (const c of cases) {
  const url = `http://127.0.0.1:${fe}/nav?projectUrl=http://127.0.0.1:${api}/api/projects/${c.id}.json`;
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(8000);
  const text = await page.evaluate(() => (document.body && document.body.innerText) || "");
  const hasFloor = /1F|2F|3F|楼层|F1|F2|F3/.test(text);
  const hasRoute = /从|到|模拟导航|第一人称|选择起点|起点|终点/.test(text);
  const isMgmt = /新建项目|Welcome|导入图纸/.test(text) && !hasRoute;
  out.push({
    name: c.name,
    url,
    finalUrl: page.url(),
    ok: hasFloor && hasRoute && !isMgmt,
    hasFloor,
    hasRoute,
    isMgmt,
    errors: errors.slice(0, 5),
    snip: text.replace(/\s+/g, " ").slice(0, 220),
  });
  await page.screenshot({ path: `_nav-${c.name}.png`, fullPage: false });
  await page.close();
}
{
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${fe}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);
  const text = await page.evaluate(() => (document.body && document.body.innerText) || "");
  out.push({
    name: "ROOT",
    finalUrl: page.url(),
    redirectedToNav: page.url().includes("/nav"),
    isMgmt: /新建项目|Welcome/.test(text) && !/从|到|模拟导航|第一人称/.test(text),
    snip: text.replace(/\s+/g, " ").slice(0, 160),
  });
  await page.close();
}
await browser.close();
console.log(JSON.stringify(out, null, 2));

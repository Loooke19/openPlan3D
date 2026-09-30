import { chromium } from '@playwright/test';

const navUrl = process.env.NAV_URL;
const out3d = process.env.OUT3D;
const out2d = process.env.OUT2D;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (msg) => {
  if (['error'].includes(msg.type())) console.log('CONSOLE', msg.type(), msg.text());
});
page.on('pageerror', (err) => console.log('PAGEERROR', err.message));
await page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(8000);
const info = await page.evaluate(() => ({
  title: document.title,
  body: document.body?.innerText?.slice(0, 500),
  canvases: [...document.querySelectorAll('canvas')].map((c) => ({
    cls: c.className,
    w: c.width,
    h: c.height,
    display: getComputedStyle(c).display,
    visibility: getComputedStyle(c).visibility,
  })),
  errors: document.querySelector('.error, [class*=error]')?.textContent,
}));
console.log(JSON.stringify(info, null, 2));
await page.screenshot({ path: out3d, fullPage: false });
console.log('wrote', out3d);

// click 2D mode
const clicked = await page.evaluate(() => {
  const buttons = [...document.querySelectorAll('button')];
  const b = buttons.find((el) => /^(2D|平面)$/.test((el.textContent || '').trim()) || (el.textContent || '').includes('2D'));
  if (b) { b.click(); return b.textContent; }
  return null;
});
console.log('clicked', clicked);
await page.waitForTimeout(2500);
await page.screenshot({ path: out2d, fullPage: false });
console.log('wrote', out2d);
await browser.close();

/**
 * Keep P1-cleaned open on the test editor (5176) with mcpOrigin=8880
 * until this process is killed. Clicks the MCP bubble so the page probes
 * the bridge; prints linked status when the pill is online.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const API = process.env.API_ORIGIN || 'http://127.0.0.1:8886';
const VITE = process.env.VITE_ORIGIN || 'http://127.0.0.1:5176';
const MCP = process.env.MCP_ORIGIN || 'http://127.0.0.1:8880';
const PID = process.env.PROJECT_ID || '6981c5f7bf464bc4a8fed87880780ebc';
const FLOOR = process.env.FLOOR_ID || 'floor-0';
const SHOT = process.env.OUT_PNG
  || 'C:\\Users\\offic\\Documents\\Cursor\\gifu-test-env-1015-wt\\internal\\acceptance\\mcp-shots\\bubble-online.png';

async function mcpCall(name, args = {}) {
  const body = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: { name, arguments: args },
  };
  const res = await fetch(`${MCP}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  const text = json?.result?.content?.[0]?.text;
  try {
    return text ? JSON.parse(text) : json;
  } catch {
    return json;
  }
}

function editorUrl() {
  const qs = new URLSearchParams({
    projectUrl: `${API}/api/projects/${PID}.json`,
    id: PID,
    apiOrigin: API,
    filesUrl: `${API}/files`,
    mcpOrigin: MCP,
  });
  return `${VITE}/editor?${qs}`;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.addInitScript(() => {
  localStorage.setItem('openplan-editor-mcp-probe', '1');
});
const url = editorUrl();
console.log(JSON.stringify({ opening: url }));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.reload({ waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForSelector('canvas[data-plan2d-canvas="true"]', { timeout: 180000 });
const select = page.locator('select[aria-label]').first();
await select.waitFor({ state: 'visible', timeout: 120000 });
await select.selectOption(FLOOR);
await page.waitForTimeout(1500);

const bubble = page.getByTestId('mcp-status-bubble');
await bubble.click().catch(() => {});
await page.waitForTimeout(800);

let linked = false;
for (let i = 0; i < 40; i++) {
  const state = await page.evaluate(() => {
    const el = document.querySelector('[data-mcp-status]');
    return {
      status: el?.getAttribute('data-mcp-status') || '',
      linked: el?.getAttribute('data-mcp-linked') || '',
      text: el?.innerText || '',
    };
  });
  const session = await mcpCall('editor_session');
  console.log(JSON.stringify({ poll: i, bubble: state, session }));
  if (state.status === 'online' && state.linked === 'yes' && (session.sessions || []).length > 0) {
    linked = true;
    break;
  }
  if (i === 2) await bubble.click().catch(() => {});
  await page.waitForTimeout(1000);
}

fs.mkdirSync(path.dirname(SHOT), { recursive: true });
await page.screenshot({ path: SHOT, type: 'png' });
const CTRL = Number(process.env.EDITOR_CTRL_PORT || 18990);
const ctrl = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  try {
    if (url.pathname === '/status') {
      const bubble = await page.evaluate(() => {
        const el = document.querySelector('[data-mcp-status]');
        return {
          status: el?.getAttribute('data-mcp-status') || '',
          linked: el?.getAttribute('data-mcp-linked') || '',
          text: (el?.querySelector('.pill')?.textContent || '').trim(),
        };
      });
      const session = await mcpCall('editor_session');
      res.end(JSON.stringify({ bubble, session }));
      return;
    }
    if (url.pathname.startsWith('/floor/')) {
      const id = decodeURIComponent(url.pathname.slice('/floor/'.length));
      await select.selectOption(id);
      await page.waitForTimeout(1000);
      res.end(JSON.stringify({ ok: true, floorId: id }));
      return;
    }
    if (url.pathname === '/shot') {
      const dest = url.searchParams.get('path') || SHOT;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await page.screenshot({ path: dest, type: 'png' });
      res.end(JSON.stringify({ ok: true, path: dest }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(err) }));
  }
});
ctrl.listen(CTRL, '127.0.0.1', () => {
  console.log(JSON.stringify({
    mcpLinked: linked,
    shot: SHOT,
    keepOpen: true,
    ctrl: `http://127.0.0.1:${CTRL}`,
  }));
});
if (!linked) {
  console.error('MCP_NOT_LINKED');
}

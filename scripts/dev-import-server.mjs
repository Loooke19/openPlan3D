/**
 * Local drawing-import stand-in used when Loooke19/gifu-hospital-3d-tour is not cloned.
 * Serves GET /files (project cards with 导航浏览 + 编辑项目) and /api/projects/{id}.json
 * from real openplan fixtures in this repo — no mock card names.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.IMPORT_PORT || 8884);
const OPENPLAN = (process.env.OPENPLAN_ORIGIN || 'http://127.0.0.1:5381').replace(/\/$/, '');
const DATA_DIR = process.env.IMPORT_DATA_DIR || path.join(ROOT, 'tests/fixtures');

/** @type {Map<string, { project: any, revision: number, file: string }>} */
const store = new Map();

function loadFixtures() {
  store.clear();
  const files = fs.readdirSync(DATA_DIR).filter((name) => name.endsWith('.openplan.json'));
  for (const file of files) {
    try {
      const project = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
      if (!project || typeof project !== 'object' || typeof project.id !== 'string' || !Array.isArray(project.floors)) continue;
      store.set(project.id, { project, revision: Number(project.revision) || 1, file });
    } catch {
      /* skip unreadable fixtures */
    }
  }
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  cors(res);
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type });
  res.end(payload);
}

function listProjects() {
  return [...store.values()].map(({ project, revision }) => ({
    id: project.id,
    name: project.name || project.id,
    updatedAt: project.updatedAt || null,
    floorCount: Array.isArray(project.floors) ? project.floors.length : 0,
    revision,
  }));
}

function cardLinks(id) {
  const origin = `http://127.0.0.1:${PORT}`;
  const projectUrl = `${origin}/api/projects/${encodeURIComponent(id)}.json`;
  const q = new URLSearchParams({
    id,
    projectUrl,
    apiOrigin: origin,
    filesUrl: `${origin}/files`,
  });
  return {
    nav: `${OPENPLAN}/nav?${q}`,
    edit: `${OPENPLAN}/editor?${q}`,
  };
}

function filesPage() {
  const cards = listProjects().map((project) => {
    const hrefs = cardLinks(project.id);
    return `<article class="card" id="p-${escapeHtml(project.id)}" data-project-id="${escapeHtml(project.id)}" data-project-name="${escapeHtml(project.name)}">
  <h2>${escapeHtml(project.name)}</h2>
  <p class="meta">${project.floorCount} 层 · ${escapeHtml(project.id)}</p>
  <div class="actions">
    <a class="nav" data-testid="nav-browse" href="${escapeHtml(hrefs.nav)}">导航浏览</a>
    <a class="edit" data-testid="edit-project" href="${escapeHtml(hrefs.edit)}">编辑项目</a>
  </div>
</article>`;
  }).join('\n');
  return `<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>导航项目管理</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; background: #f3f4f6; color: #111827; }
    header { background: #1e293b; color: #fff; padding: 20px 24px; }
    header h1 { margin: 0; font-size: 22px; }
    header p { margin: 6px 0 0; opacity: .7; font-size: 14px; }
    main { max-width: 960px; margin: 0 auto; padding: 24px; display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
    .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; }
    .card:target { outline: 2px solid #2563eb; }
    .card h2 { margin: 0; font-size: 16px; }
    .meta { margin: 8px 0 14px; font-size: 12px; color: #6b7280; word-break: break-all; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    a { text-decoration: none; font-size: 13px; font-weight: 600; padding: 8px 12px; border-radius: 8px; }
    a.nav { border: 1px solid #cbd5e1; color: #334155; }
    a.edit { background: #2563eb; color: #fff; }
  </style>
</head>
<body>
  <header>
    <h1>导航项目管理</h1>
    <p>导入服务项目列表 · ${store.size} 个项目</p>
  </header>
  <main>${cards}</main>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function jsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function navPayload(project) {
  const floor = project.floors?.[0];
  const walls = (floor?.walls || []).map((wall) => ({
    start: wall.start, end: wall.end, thickness: wall.thickness,
  }));
  const rooms = (floor?.rooms || []).map((room) => ({
    id: room.id, name: room.displayName || room.name, polygon: [],
  }));
  const xs = walls.flatMap((w) => [w.start?.x, w.end?.x]).filter((n) => Number.isFinite(n));
  const ys = walls.flatMap((w) => [w.start?.y, w.end?.y]).filter((n) => Number.isFinite(n));
  return {
    floorId: floor?.id || '',
    floorName: floor?.name || '',
    floors: (project.floors || []).map((item) => ({ id: item.id, name: item.name })),
    places: rooms.map((room) => ({ id: room.id, name: room.name, x: 0, y: 0, floorId: floor?.id, floorName: floor?.name })),
    walls,
    rooms,
    bounds: {
      minX: xs.length ? Math.min(...xs) : 0,
      minY: ys.length ? Math.min(...ys) : 0,
      maxX: xs.length ? Math.max(...xs) : 1,
      maxY: ys.length ? Math.max(...ys) : 1,
    },
  };
}

loadFixtures();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && (url.pathname === '/files' || url.pathname === '/files/')) {
    send(res, 200, filesPage(), 'text/html; charset=utf-8');
    return;
  }
  if (req.method === 'GET' && (url.pathname === '/api/projects' || url.pathname === '/api/projects.json')) {
    send(res, 200, { projects: listProjects() });
    return;
  }

  const jsonMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\.json$/);
  if (jsonMatch) {
    const id = decodeURIComponent(jsonMatch[1]);
    const entry = store.get(id);
    if (!entry) { send(res, 404, { detail: 'not found' }); return; }
    if (req.method === 'GET') {
      send(res, 200, { ...entry.project, revision: entry.revision });
      return;
    }
    if (req.method === 'PUT') {
      try {
        const body = await jsonBody(req);
        const next = body.project || body;
        if (!next || next.id !== id) { send(res, 400, { detail: 'id' }); return; }
        const base = Number(body.baseRevision);
        if (!body.force && Number.isFinite(base) && base !== entry.revision) {
          send(res, 409, { revision: entry.revision, project: entry.project });
          return;
        }
        entry.project = next;
        entry.revision += 1;
        next.revision = entry.revision;
        send(res, 200, { revision: entry.revision, project: next });
        return;
      } catch {
        send(res, 400, { detail: 'json' });
        return;
      }
    }
  }

  const navMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/nav\.json$/);
  if (req.method === 'GET' && navMatch) {
    const entry = store.get(decodeURIComponent(navMatch[1]));
    if (!entry) { send(res, 404, { detail: 'not found' }); return; }
    const floorId = url.searchParams.get('floor');
    const payload = navPayload(entry.project);
    if (floorId) {
      const floor = (entry.project.floors || []).find((item) => item.id === floorId);
      if (floor) payload.floorId = floor.id;
    }
    send(res, 200, payload);
    return;
  }

  const routeMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/route$/);
  if (req.method === 'POST' && routeMatch) {
    send(res, 200, { ok: false, reason: 'empty' });
    return;
  }

  send(res, 404, { detail: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`import files http://127.0.0.1:${PORT}/files  openplan=${OPENPLAN}  projects=${store.size}`);
});

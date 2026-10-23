import { HospitalScene } from './scene3d.js';
import { createFacilityIconSvg, decorateFacilityButtons, isFacilityPoi } from './facility-icons.js';
import { createNavMarkerController } from './nav-marker.js';
import { MAX_WAYPOINTS } from './routing.js';
import { facilityCategory } from './map-art.js';

const canvas = document.querySelector('#plan');
const sceneHost = document.querySelector('#scene3d');
const simMarker = document.querySelector('#sim-marker');
const status = document.querySelector('#status');
const places = document.querySelector('#places');
const floorSelect = document.querySelector('#floor');
const floorName = document.querySelector('#floor-name');
const startSelect = document.querySelector('#start');
const endSelect = document.querySelector('#end');
const waypointsHost = document.querySelector('#waypoints');
const routeMessage = document.querySelector('#route-message');
const params = new URLSearchParams(location.search);
const projectId = params.get('id') || '';

const MAX_VIA = MAX_WAYPOINTS;

let doc = null;
let view = null;
let frame = null;
let mode = '3d';
let scene = null;
let route = null;
let routeNorm = [];
let waypoints = [];
let category = 'all';
let busy = false;
let walking = false;
let simulating = false;

const $ = (id) => document.getElementById(id);

function say(text) {
  status.textContent = text;
}

function metersLabel(lengthCm) {
  const meters = Math.round((lengthCm || 0) / 100);
  return meters < 1 ? '不到 1 米' : `约 ${meters} 米`;
}

function fit() {
  const bounds = view && view.bounds;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!bounds || width < 2 || height < 2) return null;
  const pad = 28;
  const spanX = Math.max(1, bounds.maxX - bounds.minX);
  const spanY = Math.max(1, bounds.maxY - bounds.minY);
  const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY);
  return {
    scale,
    ox: (width - spanX * scale) / 2 - bounds.minX * scale,
    oy: (height - spanY * scale) / 2 - bounds.minY * scale,
  };
}

function toScreen(map, x, y) {
  return [map.ox + x * map.scale, map.oy + y * map.scale];
}

function toPlan(map, x, y) {
  return [(x - map.ox) / map.scale, (y - map.oy) / map.scale];
}

function cmToNorm(x, y) {
  const bounds = doc && doc.cmBounds;
  if (!bounds) return null;
  const spanX = Math.max(1, bounds.maxX - bounds.minX);
  const spanY = Math.max(1, bounds.maxY - bounds.minY);
  return [
    (x - bounds.minX) / spanX,
    (y - bounds.minY) / spanY,
  ];
}

function draw() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(width * ratio));
  canvas.height = Math.max(1, Math.floor(height * ratio));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.fillStyle = '#eef0f2';
  ctx.fillRect(0, 0, width, height);
  const map = fit();
  frame = map;
  if (!view || !map) return;
  // Maker-style room fills under walls.
  for (const room of view.rooms || []) {
    const poly = room.polygon || [];
    if (poly.length < 3) continue;
    ctx.beginPath();
    poly.forEach((point, index) => {
      const [x, y] = toScreen(map, point.x, point.y);
      if (index) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = room.fillColor || '#e9e7e4';
    ctx.fill();
    ctx.strokeStyle = '#b6bdc0';
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
  ctx.lineCap = 'square';
  ctx.strokeStyle = '#8b919a';
  for (const wall of view.walls || []) {
    const [x0, y0] = toScreen(map, wall.start.x, wall.start.y);
    const [x1, y1] = toScreen(map, wall.end.x, wall.end.y);
    ctx.lineWidth = Math.max(2, (wall.thickness || 15) * map.scale);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }
  ctx.fillStyle = '#eef0f2';
  for (const opening of view.openings || []) {
    const hw = opening.width / 2;
    const ht = opening.across / 2;
    const nx = -opening.uy;
    const ny = opening.ux;
    const corners = [
      [opening.x + opening.ux * hw + nx * ht, opening.y + opening.uy * hw + ny * ht],
      [opening.x - opening.ux * hw + nx * ht, opening.y - opening.uy * hw + ny * ht],
      [opening.x - opening.ux * hw - nx * ht, opening.y - opening.uy * hw - ny * ht],
      [opening.x + opening.ux * hw - nx * ht, opening.y + opening.uy * hw - ny * ht],
    ];
    ctx.beginPath();
    corners.forEach((point, index) => {
      const [x, y] = toScreen(map, point[0], point[1]);
      if (index) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.closePath();
    ctx.fill();
  }
  if (route && route.polyline && route.polyline.length > 1) {
    ctx.strokeStyle = '#1a7af8';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    route.polyline.forEach((point, index) => {
      const [x, y] = toScreen(map, point.x, point.y);
      if (index) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.stroke();
  }
  for (const place of filteredDestinations()) {
    const [x, y] = toScreen(map, place.x, place.y);
    ctx.fillStyle = place.color || '#dce8df';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (isFacilityPoi({ category: place.category })) {
      ctx.fillStyle = '#222';
      ctx.font = '11px sans-serif';
      ctx.fillText(place.name, x + 8, y + 4);
    }
  }
}

function destinationMeta(place) {
  const poi = (doc && doc.pois || []).find((item) => item.id === place.id);
  return {
    ...place,
    category: poi?.category || 'room',
  };
}

function filteredDestinations() {
  return ((view && view.destinations) || []).map(destinationMeta).filter((place) => {
    if (category === 'all') return true;
    return facilityCategory(place) === category || place.category === category;
  });
}

function fillSelect(select, selected) {
  const previous = selected ?? select.value;
  select.replaceChildren();
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = '请选择';
  select.append(blank);
  for (const place of (view && view.destinations) || []) {
    const option = document.createElement('option');
    option.value = place.id;
    option.textContent = place.name;
    select.append(option);
  }
  if ([...select.options].some((option) => option.value === previous)) {
    select.value = previous;
  }
}

function renderWaypoints() {
  waypointsHost.replaceChildren();
  waypoints.forEach((id, index) => {
    const row = document.createElement('div');
    row.className = 'waypoint-row';
    const mark = document.createElement('span');
    mark.className = 'dot waypoint-dot';
    const label = document.createElement('span');
    label.textContent = `经${index + 1}`;
    const select = document.createElement('select');
    select.setAttribute('aria-label', `途经点${index + 1}`);
    fillSelect(select, id);
    select.onchange = () => {
      waypoints[index] = select.value;
      if (!select.value) waypoints.splice(index, 1);
      stopAll();
      renderWaypoints();
      planRoute();
    };
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-waypoint';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `移除途经点${index + 1}`);
    remove.onclick = () => {
      waypoints.splice(index, 1);
      stopAll();
      renderWaypoints();
      planRoute();
    };
    row.append(mark, label, select, remove);
    waypointsHost.append(row);
  });
  const add = $('add-waypoint');
  add.disabled = waypoints.length >= MAX_VIA;
}

function renderPlaces() {
  places.replaceChildren();
  for (const place of filteredDestinations()) {
    const button = document.createElement('button');
    button.type = 'button';
    if (isFacilityPoi(place)) {
      const chip = document.createElement('span');
      chip.className = 'facility-chip';
      chip.append(createFacilityIconSvg(place.category), document.createTextNode(place.name));
      button.append(chip);
    } else {
      button.textContent = place.name;
    }
    button.addEventListener('click', () => {
      if (!startSelect.value) startSelect.value = place.id;
      else if (!endSelect.value || endSelect.value === startSelect.value) endSelect.value = place.id;
      else endSelect.value = place.id;
      planRoute();
    });
    places.append(button);
  }
}

function renderFloor() {
  const floors = (view && view.floors) || [];
  if (floors.length > 1) {
    floorSelect.hidden = false;
    floorName.hidden = true;
    floorSelect.replaceChildren();
    for (const floor of floors) {
      const option = document.createElement('option');
      option.value = floor.id;
      option.textContent = floor.name || floor.id;
      option.selected = floor.id === view.floorId;
      floorSelect.append(option);
    }
  } else {
    floorSelect.hidden = true;
    floorName.hidden = false;
    floorName.textContent = (view && view.floorName) || '';
  }
}

function placeById(id) {
  return ((view && view.destinations) || []).find((item) => item.id === id) || null;
}

function poiById(id) {
  return ((doc && doc.pois) || []).find((item) => item.id === id) || null;
}

function syntheticRoute(normPolyline, lengthCm) {
  const floorId = (doc && doc.floorId) || 'floor';
  const length = Math.max(0.001, (lengthCm || 0) / 100 / ((doc && doc.calibration && doc.calibration.metersPerMapUnit) || 0.05));
  return {
    length,
    steps: [{
      reversed: false,
      edge: {
        source: `${floorId}::start`,
        target: `${floorId}::end`,
        floorId,
        enabled: true,
        lengthMapUnits: length,
        polyline: normPolyline,
      },
    }],
  };
}

function applySceneRoute() {
  if (!scene || !routeNorm.length) {
    scene?.setRoute([]);
    return;
  }
  const start = poiById(startSelect.value);
  const end = poiById(endSelect.value);
  const vias = waypoints.map(poiById).filter(Boolean);
  scene.setRoute(routeNorm, start, end, vias);
}

function destroyScene() {
  try { scene?.dispose(); } catch {}
  scene = null;
  sceneHost.replaceChildren();
}

function ensureScene() {
  if (!doc || doc.empty || scene) return scene;
  scene = new HospitalScene(sceneHost, doc, {
    onSelect: (id) => {
      if (!id) return;
      if (!startSelect.value) startSelect.value = id;
      else endSelect.value = id;
      planRoute();
    },
    onProgress: (fraction) => {
      $('walk-seek').value = String(Math.round(fraction * 1000) / 10);
    },
    onComplete: () => {
      walking = false;
      walkControls();
      say('第一人称到达终点');
    },
  });
  applySceneRoute();
  scene.setFilter(category, '', true, endSelect.value || null);
  return scene;
}

function setMode(next) {
  mode = next;
  const is3d = mode === '3d';
  canvas.classList.toggle('hidden', is3d);
  sceneHost.classList.toggle('hidden', !is3d);
  $('toggle-2d').classList.toggle('is-active', !is3d);
  $('toggle-3d').classList.toggle('is-active', is3d);
  $('toggle-2d').setAttribute('aria-pressed', String(!is3d));
  $('toggle-3d').setAttribute('aria-pressed', String(is3d));
  if (is3d) ensureScene()?.setVisible(true);
  else {
    scene?.setVisible(false);
    draw();
  }
  walkControls();
}

const navMarker = createNavMarkerController({
  onUpdate: (point) => {
    if (!point) return;
    scene?.setNavMarker?.([point.x, point.y], mode === '3d', point.heading);
    if (mode === '2d' && frame) {
      const bounds = doc.cmBounds;
      const x = bounds.minX + point.x * (bounds.maxX - bounds.minX);
      const y = bounds.minY + point.y * (bounds.maxY - bounds.minY);
      const [sx, sy] = toScreen(frame, x, y);
      simMarker.hidden = false;
      simMarker.style.left = `${sx}px`;
      simMarker.style.top = `${sy}px`;
    } else {
      simMarker.hidden = true;
    }
  },
  onProgress: (fraction) => {
    $('walk-seek').value = String(Math.round(fraction * 1000) / 10);
  },
  onTip: (tip) => {
    if (tip) routeMessage.textContent = tip;
  },
  onComplete: () => {
    simulating = false;
    walkControls();
    simMarker.hidden = true;
    scene?.clearNavMarker?.();
    say('模拟导航结束');
  },
});

function walkControls() {
  const active = walking || simulating;
  $('pause-walk').hidden = !active;
  $('stop-walk').hidden = !active;
  $('walk-playback').hidden = !active;
  $('simulate').hidden = active;
  $('walk-fp').hidden = active || mode !== '3d';
  $('pause-walk').textContent = (walking ? scene?.paused : navMarker.paused) ? '继续' : '暂停';
  const ready = !!(route && route.polyline && route.polyline.length > 1);
  $('simulate').disabled = !ready;
  $('walk-fp').disabled = !ready || mode !== '3d';
}

function stopWalk() {
  scene?.stopWalk();
  walking = false;
}

function stopSim() {
  navMarker.stop();
  simulating = false;
  simMarker.hidden = true;
  scene?.clearNavMarker?.();
}

function stopAll() {
  stopWalk();
  stopSim();
  walkControls();
}

async function planRoute() {
  stopAll();
  route = null;
  routeNorm = [];
  applySceneRoute();
  draw();
  const start = placeById(startSelect.value);
  const end = placeById(endSelect.value);
  const vias = waypoints.map(placeById).filter(Boolean);
  if (!start || !end) {
    routeMessage.textContent = '选择起点和终点';
    walkControls();
    return;
  }
  if (start.id === end.id && !vias.length) {
    routeMessage.textContent = '起终点相同';
    walkControls();
    return;
  }
  busy = true;
  say('正在找路');
  const response = await fetch(`/api/projects/${projectId}/route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      floor: view.floorId,
      from: { x: start.x, y: start.y },
      to: { x: end.x, y: end.y },
      via: vias.map((place) => ({ x: place.x, y: place.y })),
    }),
  });
  busy = false;
  if (!response.ok) {
    say('走不过去');
    routeMessage.textContent = '走不过去';
    walkControls();
    return;
  }
  const result = await response.json();
  if (!result.ok) {
    say(result.reason === 'off-plan' ? '点在可走的地方' : '走不过去');
    routeMessage.textContent = '走不过去';
    walkControls();
    return;
  }
  route = result;
  routeNorm = result.polyline
    .map((point) => cmToNorm(point.x, point.y))
    .filter(Boolean);
  const viaNote = vias.length ? ` · 经 ${vias.length} 个途经点` : '';
  const label = metersLabel(result.lengthCm) + viaNote;
  routeMessage.textContent = label;
  say(label);
  applySceneRoute();
  draw();
  walkControls();
}

async function load(floorId) {
  stopAll();
  destroyScene();
  route = null;
  routeNorm = [];
  waypoints = [];
  say('正在打开');
  const query = new URLSearchParams({ floor: floorId || params.get('floor') || '' });
  const [navResponse, mapResponse] = await Promise.all([
    fetch(`/api/projects/${projectId}/nav.json?${query}`),
    fetch(`/api/projects/${projectId}/map.json?${query}`),
  ]);
  if (!navResponse.ok || !mapResponse.ok) {
    say('这一层没有打开');
    return;
  }
  view = await navResponse.json();
  doc = await mapResponse.json();
  const next = new URL(location.href);
  if (view.floorId) next.searchParams.set('floor', view.floorId);
  history.replaceState(null, '', next);
  renderFloor();
  fillSelect(startSelect);
  fillSelect(endSelect);
  renderWaypoints();
  renderPlaces();
  setMode(mode);
  draw();
  say(view.empty ? '这一层没有户型' : '选择起点和终点，或点平面/立体标签');
  routeMessage.textContent = view.empty ? '这一层没有户型' : '选择起点和终点';
  walkControls();
}

function hitPlace(x, y) {
  if (!frame) return null;
  let best = null;
  let bestDistance = 18;
  for (const place of view.destinations || []) {
    const [sx, sy] = toScreen(frame, place.x, place.y);
    const distance = Math.hypot(sx - x, sy - y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = place;
    }
  }
  return best;
}

canvas.addEventListener('click', (event) => {
  if (!frame || !view || view.empty || busy || mode !== '2d') return;
  const rect = canvas.getBoundingClientRect();
  const place = hitPlace(event.clientX - rect.left, event.clientY - rect.top);
  if (!place) return;
  if (!startSelect.value) startSelect.value = place.id;
  else endSelect.value = place.id;
  planRoute();
});

floorSelect.addEventListener('change', () => {
  params.set('floor', floorSelect.value);
  load(floorSelect.value);
});

startSelect.addEventListener('change', () => planRoute());
endSelect.addEventListener('change', () => planRoute());

$('add-waypoint').onclick = () => {
  if (waypoints.length >= MAX_VIA) return;
  stopAll();
  waypoints.push('');
  renderWaypoints();
};

$('toggle-2d').onclick = () => { stopWalk(); setMode('2d'); };
$('toggle-3d').onclick = () => setMode('3d');

$('simulate').onclick = () => {
  if (!routeNorm.length) return;
  stopWalk();
  const fake = syntheticRoute(routeNorm, route.lengthCm);
  if (!navMarker.setPath(fake, doc.floorId)) {
    say('无法沿该路线模拟');
    return;
  }
  simulating = true;
  walkControls();
  navMarker.setSpeed(Number($('walk-speed').value) || 1);
  if (mode !== '3d') setMode('3d');
  ensureScene();
  navMarker.start();
  say('模拟导航已开始');
};

$('walk-fp').onclick = () => {
  if (!routeNorm.length) return;
  stopSim();
  setMode('3d');
  const current = ensureScene();
  if (!current) return;
  applySceneRoute();
  walking = true;
  walkControls();
  current.setWalkSpeed(Number($('walk-speed').value) || 1);
  current.startWalk();
  say('第一人称已开始');
};

$('walk-speed').onchange = () => {
  scene?.setWalkSpeed(Number($('walk-speed').value) || 1);
  navMarker.setSpeed(Number($('walk-speed').value) || 1);
};

$('walk-seek').oninput = () => {
  const progress = Number($('walk-seek').value) / 100;
  if (simulating) navMarker.seek(progress);
  else scene?.seekWalk(progress);
  walkControls();
};

$('pause-walk').onclick = () => {
  if (simulating) navMarker.pause();
  else scene?.pauseWalk();
  walkControls();
};

$('stop-walk').onclick = () => {
  stopAll();
  say(metersLabel(route?.lengthCm || 0));
};

document.querySelectorAll('[data-category]').forEach((button) => {
  button.onclick = () => {
    category = button.dataset.category;
    document.querySelectorAll('[data-category]').forEach((item) => {
      const active = item.dataset.category === category;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    renderPlaces();
    draw();
    scene?.setFilter(category === 'all' ? 'all' : category, '', true, endSelect.value || null);
  };
});

window.addEventListener('resize', () => {
  draw();
});

decorateFacilityButtons(document);

if (!projectId) say('没有打开文件');
else load(params.get('floor') || '');

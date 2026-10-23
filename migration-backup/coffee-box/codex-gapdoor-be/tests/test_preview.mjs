// Run with: node tests/test_preview.mjs
// No npm install, browser, GPU, or network is needed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { findRoute, findRouteVia, routePolyline, routeArrows, MAX_WAYPOINTS, buildVerticalLinks, buildMultiFloorGraph, findCrossFloorRoute, splitRouteByFloor, routeAnimationPath, pointAlongAnimation, animationPathLengths, splitPolylineNearPoint } from '../preview/routing.js';
import { createNavMarkerController, formatNavEta } from '../preview/nav-marker.js';
import { displayPois, roomColor, facilityCategory, matchesFilter, obstacleForSelection, layoutMapLabels, poiForRoom } from '../preview/map-art.js';
import { containsPoint, closestPointOnPolygon, wallSignPlacements } from '../preview/wall-signs.js';
import { facilityChipBox, isFacilityPoi, FACILITY_BADGE_RADIUS, FACILITY_ICON_SIZE, FACILITY_LABEL_GAP, FACILITY_SCENE_BADGE } from '../preview/facility-icons.js';
import { sanitizeAppearance, APPEARANCE_DEFAULTS } from '../preview/appearance.js';
import { WalkLook } from '../preview/walk-look.js';
import {
  pageSizeOf, homeViewFor, homeViewForBoundary, toPageUnits, toNormalized,
  renderPixelToNormalized, normalizedToRenderPixel, mapLabelUnit, overlayLabelScale,
  LABEL_MIN_SCREEN_RATIO, LABEL_FONT_SIZE, LABEL_MIN_SCREEN_PX, LABEL_STAGGER_LINE,
  labelStaggerOffsets, rectsOverlap, isManualCropBoundary,
  createMapDraft, draftToMapDocument, assertCompatibleMapDocument,
  DEFAULT_PDF_SIZE, rasterSizeFor,
} from '../preview/map-coords.js';

// Three's browser import map is reproduced for the isolated, non-WebGL math tests below.
if (!vm.SourceTextModule) {
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', fileURLToPath(import.meta.url)], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = name => JSON.parse(fs.readFileSync(path.join(root, 'data', name), 'utf8'));
const doc = readJSON('map.json');
const samples = readJSON('sample-routes.json');
const pois = new Map(doc.pois.map(poi => [poi.id, poi]));
const nodes = new Map(doc.graph.nodes.map(node => [node.id, node]));
const close = (actual, expected, epsilon = 1e-6) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} differs from ${expected}`);
const samePoint = (a, b) => { close(a[0], b[0]); close(a[1], b[1]); };
test('walk look holds while dragging, returns smoothly on release, and clamps angles', () => {
  const look=new WalkLook();look.begin(1,0,0);look.move(1,100,50);
  close(look.yaw,-.5);close(look.pitch,-.2);
  look.update(1);close(look.yaw,-.5);
  look.move(2,500,500);close(look.yaw,-.5);
  look.end(1);look.update(.1);assert.ok(look.yaw>-.5&&look.yaw<0);
  // The deliberately slower return keeps most of the view offset after 100 ms.
  assert.ok(look.yaw < -.35);
  for(let i=0;i<240;i++)look.update(1/60);
  close(look.yaw,0);close(look.pitch,0);
  look.begin(1,0,0);look.move(1,100000,100000);
  close(look.yaw,-Math.PI*.85);close(look.pitch,-.65);
  look.reset();assert.equal(look.pointer,null);close(look.yaw,0);
});
test('appearance settings validate persisted values and preserve defaults', () => {
  assert.deepEqual(sanitizeAppearance(null), APPEARANCE_DEFAULTS);
  const value=sanitizeAppearance({accent:'#123abc',wall:'bad',exposure:99,tileSize:0,grain:NaN});
  assert.equal(value.accent,'#123abc');assert.equal(value.wall,APPEARANCE_DEFAULTS.wall);
  assert.equal(value.exposure,1.8);assert.equal(value.tileSize,6);assert.equal(value.grain,1);
});

test('wall signs cover long walls, face outside the room and fit their wall segment', () => {
  const polygon = [[0,0],[100,0],[100,20],[0,20]];
  for (const reversed of [polygon, [...polygon].reverse()]) {
    const signs = wallSignPlacements({ x:50,z:0,angle:0,length:100,height:19 }, reversed);
    assert.equal(signs.length, 3);
    for (const s of signs) {
      assert.equal(s.nz, -1);
      assert.equal(containsPoint(reversed, s.x + s.nx, s.z + s.nz), false);
      assert.ok(s.x - s.width / 2 >= 0 && s.x + s.width / 2 <= 100);
    }
  }
  assert.equal(wallSignPlacements({ x:5,z:0,angle:0,length:8,height:19 }, polygon).length, 1);
  assert.deepEqual(wallSignPlacements({ length:2,height:19 }, polygon), []);
  assert.equal(wallSignPlacements({ x:50,z:0,angle:0,length:100,height:19 },polygon,false).length,1);
});

function testPlayback() {
  const scene = Object.create(HospitalScene.prototype);
  scene.walking = true; scene.paused = true; scene.routeLength = 100;
  let updates = 0, progress;
  scene.positionWalkCamera = () => updates++;
  scene.onProgress = p => progress = p;
  scene.setWalkSpeed(2); assert.equal(scene.walkSpeedFactor, 2);
  scene.setWalkSpeed(.25); assert.equal(scene.walkSpeedFactor, .25);
  scene.setWalkSpeed(.1); assert.equal(scene.walkSpeedFactor, .25);
  scene.setWalkSpeed(99); assert.equal(scene.walkSpeedFactor, 3);
  scene.setWalkSpeed(NaN); assert.equal(scene.walkSpeedFactor, 3);
  scene.seekWalk(.6); assert.equal(scene.walkDistance, 60); assert.equal(scene.paused, true);
  scene.paused = false;
  scene.seekWalk(.2); assert.equal(scene.walkDistance, 20); assert.equal(scene.paused, false);
  scene.seekWalk(2); assert.equal(progress, 1); assert.equal(scene.paused, true);
  scene.seekWalk(-1); assert.equal(progress, 0);
  scene.seekWalk(NaN); assert.equal(updates, 4);
}

test('direction arrows follow route order, corners and reversed endpoints', () => {
  assert.deepEqual(routeArrows([]), []);
  assert.deepEqual(routeArrows([[0,0],[1,0]]), []);
  assert.deepEqual(routeArrows([[0,0],[100,0]], 0), []);
  const arrows = routeArrows([[0,0],[0,0],[40,0],[40,40]]);
  assert.ok(arrows.length > 2);
  for (const a of arrows) close(a.angle, a.x < 40 ? 0 : Math.PI / 2);
  for (const a of routeArrows([[100,0],[0,0]])) close(Math.abs(a.angle), Math.PI);
});

test('route arrow phase advances chevrons toward the destination', () => {
  const points = [[0,0],[100,0]];
  const a = routeArrows(points, 18, 0);
  const b = routeArrows(points, 18, 9);
  assert.ok(a.length && b.length);
  assert.ok(b[0].x > a[0].x);
  const wrapped = routeArrows(points, 18, 18);
  close(wrapped[0].x, a[0].x);
});

test('preview wires flowing route arrows in 2D and 3D', () => {
  const viewer = fs.readFileSync(path.join(root, 'preview', 'viewer.js'), 'utf8');
  const scene = fs.readFileSync(path.join(root, 'preview', 'scene3d.js'), 'utf8');
  const routing = fs.readFileSync(path.join(root, 'preview', 'routing.js'), 'utf8');
  assert.match(routing, /ROUTE_ARROW_SPEED/);
  assert.match(viewer, /paintRouteArrows/);
  assert.match(viewer, /ensureRouteArrowFlow/);
  assert.match(viewer, /setRouteArrowPhase/);
  assert.match(scene, /setRouteArrowPhase\s*\(/);
  assert.match(scene, /applyRouteArrowPhase/);
});

test('projected map labels opt out of button transform easing', () => {
  const css = fs.readFileSync(path.join(root, 'preview/interface.css'), 'utf8');
  assert.match(css, /\.scene-poi-label,\.scene-route-marker\s*\{[^}]*transition:\s*none!important/);
  assert.match(css, /\.scene-poi-label,\.scene-route-marker\s*\{[^}]*animation:\s*none!important/);
});

test('hiding the 3D canvas keeps it in layout so WebGL survives 2D mode', () => {
  const css = fs.readFileSync(path.join(root, 'preview/interface.css'), 'utf8');
  assert.match(css, /#scene3d\.hidden\{[^}]*display:\s*block!important/);
  assert.match(css, /#scene3d\.hidden\{[^}]*visibility:\s*hidden/);
  const viewer = fs.readFileSync(path.join(root, 'preview', 'viewer.js'), 'utf8');
  assert.match(viewer, /isContextLost/);
  const editor = fs.readFileSync(path.join(root, 'preview', 'editor.js'), 'utf8');
  assert.match(editor, /isContextLost/);
});

function assertContinuous(route, startId, endId) {
  let cursor = startId;
  for (const { edge, reversed } of route.steps) {
    const from = reversed ? edge.target : edge.source;
    const to = reversed ? edge.source : edge.target;
    assert.equal(from, cursor, 'graph steps must connect');
    const polyline = reversed ? [...edge.polyline].reverse() : edge.polyline;
    samePoint(polyline[0], nodes.get(from).position);
    samePoint(polyline.at(-1), nodes.get(to).position);
    cursor = to;
  }
  assert.equal(cursor, endId);
  const line = routePolyline(route);
  if (startId === endId) { assert.deepEqual(line, []); return; }
  samePoint(line[0], nodes.get(startId).position);
  samePoint(line.at(-1), nodes.get(endId).position);
  let length = 0;
  for (let i = 1; i < line.length; i++) {
    assert.notDeepEqual(line[i], line[i - 1], 'shared edge endpoints must not be duplicated');
    length += Math.hypot((line[i][0] - line[i - 1][0]) * doc.source.pdfSize[0], (line[i][1] - line[i - 1][1]) * doc.source.pdfSize[1]);
  }
  // Stored edge lengths and normalized points are rounded independently by the exporter.
  close(length, route.length, .02);
}

test('all 64 POIs match the independently generated Python sample routes', () => {
  assert.equal(doc.pois.length, 64);
  assert.equal(samples.length, 64);
  for (const sample of samples) {
    const start = pois.get(sample.from).nodeId, end = pois.get(sample.to).nodeId;
    const route = findRoute(doc.graph, start, end);
    assert.equal(Boolean(route), sample.reachable, sample.to);
    close(route.length, sample.route.lengthMapUnits);
    assertContinuous(route, start, end);
  }
});

test('every reverse route is continuous and has the same shortest length', () => {
  for (const sample of samples) {
    const start = pois.get(sample.to).nodeId, end = pois.get(sample.from).nodeId;
    const route = findRoute(doc.graph, start, end);
    close(route.length, sample.route.lengthMapUnits);
    assertContinuous(route, start, end);
  }
});

test('same-point routes are zero length, including when all edges are closed', () => {
  const closed = new Set(doc.graph.edges.map(edge => edge.id));
  for (const poi of doc.pois) {
    const route = findRoute(doc.graph, poi.nodeId, poi.nodeId, closed);
    assert.deepEqual(route, { length: 0, steps: [] });
    assert.deepEqual(routePolyline(route), []);
  }
  assert.deepEqual(routePolyline(null), []);
});

test('closing a POI access path makes it unreachable without corrupting the source map', () => {
  const start = pois.get('entrance-main').nodeId, end = pois.get('department-radiology').nodeId;
  const closed = new Set(doc.graph.edges.filter(edge => edge.source === start || edge.target === start).map(edge => edge.id));
  assert.ok(closed.size > 0);
  assert.equal(findRoute(doc.graph, start, end, closed), null);
  assert.ok(findRoute(doc.graph, start, end), 'normal route remains available after removing temporary closures');
});

test('route planner respects closures, disabled edges, and reversed geometry', () => {
  const graph = { edges: [
    { id: 'ab', source: 'a', target: 'b', enabled: true, lengthMapUnits: 1, polyline: [[0, 0], [1, 0]] },
    { id: 'bc', source: 'b', target: 'c', enabled: true, lengthMapUnits: 1, polyline: [[1, 0], [1, 1]] },
    { id: 'ac', source: 'a', target: 'c', enabled: true, lengthMapUnits: 4, polyline: [[0, 0], [1, 1]] },
    { id: 'disabled', source: 'a', target: 'c', enabled: false, lengthMapUnits: .1, polyline: [[0, 0], [1, 1]] },
  ] };
  assert.deepEqual(routePolyline(findRoute(graph, 'c', 'a')), [[1, 1], [1, 0], [0, 0]]);
  close(findRoute(graph, 'a', 'c', new Set(['ab'])).length, 4);
  assert.equal(findRoute(graph, 'a', 'c', new Set(['ab', 'ac'])), null);
});

test('cross-floor routing links elevators and splits floor segments', () => {
  const fixture = readJSON('cross-floor-fixture.json');
  const links = buildVerticalLinks(fixture.floors);
  assert.ok(links.length >= 2, 'elevator and stairs should match by name');
  assert.ok(links.some(l => l.kind === 'elevator'));
  assert.ok(links.some(l => l.kind === 'stairs'));
  const multi = buildMultiFloorGraph(fixture.floors, links);
  const route = findCrossFloorRoute(multi, '1F', 'n1', '2F', 'n1');
  assert.ok(route, '1F entrance reaches 2F pharmacy via vertical link');
  assert.ok(route.length > 0.4);
  const segments = splitRouteByFloor(route);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].floorId, '1F');
  assert.equal(segments[1].floorId, '2F');
  assert.ok(segments[0].transfer);
  assert.match(segments[0].transfer.tip, /电梯|扶梯|楼梯/);
  const samples = routeAnimationPath(route);
  assert.ok(samples.length >= 4);
  assert.equal(samples[0].floorId, '1F');
  assert.equal(samples.at(-1).floorId, '2F');
  const { lengths, total } = animationPathLengths(samples);
  const mid = pointAlongAnimation(samples, lengths, total, total * 0.5);
  assert.ok(mid);
  assert.ok(['1F', '2F'].includes(mid.floorId));
});

test('nav marker controller advances along a cross-floor path', async () => {
  const fixture = readJSON('cross-floor-fixture.json');
  const multi = buildMultiFloorGraph(fixture.floors, buildVerticalLinks(fixture.floors));
  const route = findCrossFloorRoute(multi, '1F', 'n1', '2F', 'n4');
  assert.ok(route);
  const floors = [];
  let completed = false;
  const controller = createNavMarkerController({
    speed: 5,
    onFloorChange: floorId => floors.push(floorId),
    onComplete: () => { completed = true; },
  });
  assert.equal(controller.setPath(route), true);
  assert.equal(controller.start(), true);
  await new Promise(resolve => {
    const t0 = Date.now();
    const tick = () => {
      if (completed || Date.now() - t0 > 2000) return resolve();
      setTimeout(tick, 16);
    };
    tick();
  });
  controller.stop();
  assert.ok(completed, 'marker should finish the path');
  assert.ok(floors.includes('2F') || controller.samples.at(-1).floorId === '2F');
});

test('nav marker exposes heading and remaining distance / ETA copy', () => {
  const fixture = readJSON('cross-floor-fixture.json');
  const multi = buildMultiFloorGraph(fixture.floors, buildVerticalLinks(fixture.floors));
  const route = findCrossFloorRoute(multi, '1F', 'n1', '2F', 'n4');
  assert.ok(route);
  const samples = routeAnimationPath(route);
  const { lengths, total } = animationPathLengths(samples);
  const start = pointAlongAnimation(samples, lengths, total, 0);
  assert.ok(Number.isFinite(start.heading));
  const mid = pointAlongAnimation(samples, lengths, total, total * 0.25);
  assert.ok(Number.isFinite(mid.heading));
  let lastMeta = null;
  const controller = createNavMarkerController({
    onProgress: (_p, _pt, meta) => { lastMeta = meta; },
  });
  assert.equal(controller.setPath(route), true);
  controller.seek(0);
  assert.ok(lastMeta);
  close(lastMeta.remainingMapUnits, route.length, 1e-6);
  controller.seek(0.5);
  assert.ok(lastMeta.remainingMapUnits < route.length);
  close(lastMeta.remainingMapUnits, route.length * 0.5, 1e-6);
  const meters = formatNavEta(120, 1);
  assert.equal(meters.distanceText, '剩余距离: 120 米');
  assert.match(meters.durationText, /^大约时长: \d+分\d+秒$/);
  const units = formatNavEta(80, null);
  assert.equal(units.distanceText, '剩余距离: 80 图纸单位');
});

test('preview wires nav marker heading and ETA bubble', () => {
  const viewer = fs.readFileSync(path.join(root, 'preview', 'viewer.js'), 'utf8');
  const scene = fs.readFileSync(path.join(root, 'preview', 'scene3d.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'preview', 'interface.css'), 'utf8');
  assert.match(viewer, /formatNavEta/);
  assert.match(viewer, /nav-marker-arrow/);
  assert.match(viewer, /nav-eta-bubble/);
  assert.match(viewer, /markerPoint\.heading/);
  assert.match(viewer, /route-traveled/);
  assert.match(viewer, /splitPolylineNearPoint/);
  assert.match(scene, /projectNavMarker/);
  assert.match(scene, /setRouteTravel/);
  assert.match(css, /\.nav-eta-bubble/);
  assert.match(css, /\.route-traveled/);
});

test('splitPolylineNearPoint grays traveled half of a path', () => {
  const poly = [[0, 0], [10, 0], [10, 10], [20, 10]];
  const mid = splitPolylineNearPoint(poly, [10, 5]);
  assert.ok(mid.traveled.length >= 2);
  assert.ok(mid.remaining.length >= 2);
  close(mid.traveled.at(-1)[0], 10);
  close(mid.traveled.at(-1)[1], 5);
  close(mid.remaining[0][0], 10);
  close(mid.remaining[0][1], 5);
  const start = splitPolylineNearPoint(poly, [0, 0]);
  assert.ok(start.remaining.length >= 2);
  const end = splitPolylineNearPoint(poly, [20, 10]);
  assert.ok(end.traveled.length >= 2);
});

test('shared vector-map catalog preserves POIs and uses valid colors and normalized label positions', () => {
  const display = displayPois(doc);
  assert.equal(display.length, 64);
  assert.equal(new Set(display.map(poi => poi.id)).size, 64);
  for (const poi of display) {
    assert.ok(poi.displayName.length > 0);
    assert.ok(poi.displayPosition.every(value => Number.isFinite(value) && value >= 0 && value <= 1));
    if (poi.category === 'entrance') assert.deepEqual(poi.displayPosition, poi.position);
    assert.ok(['entrance', 'restroom', 'stairs', 'elevator', 'escalator', 'service'].includes(facilityCategory(poi)));
  }
  for (const obstacle of doc.geometry.obstacles) assert.match(roomColor(obstacle, doc), /^#[0-9a-f]{6}$/i);
  assert.equal(facilityCategory({ category: 'accessible-restroom' }), 'restroom');
  assert.ok(matchesFilter({ category: 'department', name: '综合内科' }, 'all', '内科'));
  assert.ok(!matchesFilter({ category: 'department', name: '综合内科' }, 'elevator', '内科'));
});

const moduleCache = new Map();
function moduleAt(filename) {
  filename = path.resolve(root, filename);
  if (!moduleCache.has(filename)) moduleCache.set(filename, new vm.SourceTextModule(fs.readFileSync(filename, 'utf8'), { identifier: filename }));
  return moduleCache.get(filename);
}
const sceneModule = moduleAt('preview/scene3d.js');
await sceneModule.link((specifier, parent) => moduleAt(specifier === 'three'
  ? 'assets/vendor/three/three.module.js'
  : specifier.startsWith('three/addons/')
    ? `assets/vendor/three/addons/${specifier.slice(13)}`
    : path.resolve(path.dirname(parent.identifier), specifier)));
await sceneModule.evaluate();
const { HospitalScene } = sceneModule.namespace;
const { Vector3, Group, Matrix4 } = moduleCache.get(path.join(root, 'assets/vendor/three/three.module.js')).namespace;

test('3D colored route is a flat ribbon above its white halo, never enclosed by it', () => {
  const scene = Object.create(HospitalScene.prototype);
  scene.routePoints = [new Vector3(0, .8, 0), new Vector3(10, .8, 0), new Vector3(10, .8, 10)];
  scene.routeGroup = new Group();
  scene.addRouteStroke(2.4, '#ffffff', .5);
  scene.addRouteStroke(1.5, '#299477', .85);
  const halo = scene.routeGroup.children[0], colored = scene.routeGroup.children[2];
  assert.equal(halo.geometry.type, 'BoxGeometry');
  assert.equal(colored.geometry.type, 'BoxGeometry');
  for (let i = 0; i < 2; i++) {
    const h = new Matrix4(), c = new Matrix4();halo.getMatrixAt(i, h);colored.getMatrixAt(i, c);
    assert.ok(c.elements[13] - .06 > h.elements[13] + .06, 'green surface must sit above the halo');
  }
  scene.routeGroup.traverse(object => {object.geometry?.dispose();object.material?.dispose();});
});

test('3D floor slabs are single-sided and counters sit above the corridor', () => {
  const src = fs.readFileSync(path.join(root, 'preview', 'scene3d.js'), 'utf8');
  assert.match(src, /mesh\.material\.side = THREE\.FrontSide/);
  assert.match(src, /polygonOffset/);
  assert.match(src, /isCounter \? 6\.45/);
  assert.match(src, /flatPolygon\(geometry\.buildingBoundary, '#fbfcfa', 0/);
  const scene = Object.create(HospitalScene.prototype);
  scene.center = [0, 0];
  scene.size = [100, 100];
  scene.point = HospitalScene.prototype.point;
  const cw = scene.floorShapeCoords([[0, 0], [0, 1], [1, 1], [1, 0]]);
  const ccw = scene.floorShapeCoords([[0, 0], [1, 0], [1, 1], [0, 1]]);
  const area = pts => {
    let a = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
    return a;
  };
  assert.ok(area(cw) > 0);
  assert.ok(area(ccw) > 0);
});

test('waypoint chaining finds multi-stop routes and rejects overlong via lists', () => {
  assert.equal(MAX_WAYPOINTS, 6);
  const graph = { edges: [
    { id: 'ab', source: 'a', target: 'b', enabled: true, lengthMapUnits: 1, polyline: [[0, 0], [1, 0]] },
    { id: 'bc', source: 'b', target: 'c', enabled: true, lengthMapUnits: 1, polyline: [[1, 0], [1, 1]] },
    { id: 'cd', source: 'c', target: 'd', enabled: true, lengthMapUnits: 1, polyline: [[1, 1], [2, 1]] },
  ] };
  const via = findRouteVia(graph, ['a', 'b', 'd']);
  assert.ok(via);
  assert.equal(via.length, 3);
  assert.deepEqual(routePolyline(via), [[0, 0], [1, 0], [1, 1], [2, 1]]);
  assert.equal(findRouteVia(graph, ['a', 'b', 'c', 'd', 'c', 'b', 'a', 'd', 'c']), null);
  assert.equal(findRouteVia(graph, ['a']), null);
  assert.deepEqual(findRouteVia(graph, ['a', 'a', 'a']), { length: 0, steps: [] });
});

test('3D walking camera interpolates straight segments, preserves corners, and clamps endpoints', () => {
  const scene = Object.create(HospitalScene.prototype);
  scene.routePoints = [[0, 0, 0], [10, 0, 0], [10, 0, 10], [25, 0, 10]].map(point => new Vector3(...point));
  scene.routeLengths = [0, 10, 20, 35];
  scene.routeLength = 35;
  for (const [distance, expected] of [[-1, [0, 0, 0]], [0, [0, 0, 0]], [5, [5, 0, 0]], [10, [10, 0, 0]],
    [15, [10, 0, 5]], [20, [10, 0, 10]], [27.5, [17.5, 0, 10]], [35, [25, 0, 10]], [40, [25, 0, 10]]]) {
    close(scene.pointAlong(distance).distanceTo(new Vector3(...expected)), 0);
  }
});

test('wall sign directions follow camera heading and respect wall occlusion', () => {
  const scene = Object.create(HospitalScene.prototype);
  const label = { poi: { name: '综合内科', category: 'department' }, text: { textContent: '综合内科' },
    element: { classList: { add() {} }, style: {} }, walkPoint: new Vector3(0, 14, -40) };
  scene.labels = [label]; scene.endpointLabels = [];
  scene.walkCamera = { position: new Vector3(0, 12, 0), getWorldDirection(v) { return v.set(0, 0, -1); } };
  scene.wallSigns = [{ poi: label.poi, mesh: { position: new Vector3(-10, 13, -10) }, normal: new Vector3(1, 0, 0) }];
  scene.walkContext = { textContent: '' }; scene.width = 800; scene.height = 400;
  scene.project = () => ({ x: 400, y: 200, visible: true });
  scene.labelRay = { set() {}, intersectObject() { return []; } };
  scene.showPois = false; scene.term = '不匹配';
  scene.layoutWalkLabels();
  assert.equal(label.element.hidden, true, 'floating labels are disabled during walking');
  assert.match(scene.walkContext.textContent, /左侧：综合内科/);
  scene.wallSigns[0].mesh.position.x = 10;
  scene.wallSigns[0].normal.x = -1;
  scene.layoutWalkLabels();
  assert.match(scene.walkContext.textContent, /右侧：综合内科/);
  scene.labelRay.intersectObject = () => [{}];
  scene.layoutWalkLabels();
  assert.doesNotMatch(scene.walkContext.textContent, /综合内科/);
  scene.labelRay.intersectObject = () => [];
  scene.wallSigns[0].mesh.position.z = 20;
  scene.layoutWalkLabels();
  assert.doesNotMatch(scene.walkContext.textContent, /综合内科/);
});

test('procedural surfaces use world-space instance coordinates and distinct shader cache keys', () => {
  const scene = Object.create(HospitalScene.prototype); scene.resources = [];
  const wall = scene.surfaceMaterial('wall', '#ffffff');
  const floor = scene.surfaceMaterial('floor', '#ffffff');
  assert.notEqual(wall.customProgramCacheKey(), floor.customProgramCacheKey());
  for (const material of [wall, floor]) {
    const shader = { vertexShader: '#include <worldpos_vertex>', fragmentShader: '#include <color_fragment>' };
    material.onBeforeCompile(shader);
    assert.match(shader.vertexShader, /instanceMatrix \* hospitalWorld/);
    assert.match(shader.fragmentShader, /diffuseColor.rgb/);
    material.dispose();
  }
});

test('3D zoom agrees with the SVG/viewer scale-factor convention', () => {
  const scene = Object.create(HospitalScene.prototype);
  let updates = 0;
  scene.camera = { zoom: 1, updateProjectionMatrix() { updates++; } };
  scene.controls = { minZoom: .45, maxZoom: 8 };
  scene.zoom(.8);
  close(scene.camera.zoom, 1.25, 1e-9);
  scene.zoom(1.25);
  close(scene.camera.zoom, 1);
  scene.zoom(.001);
  close(scene.camera.zoom, 8);
  scene.zoom(100);
  close(scene.camera.zoom, .45);
  scene.walking = true;
  scene.zoom(.8);
  close(scene.camera.zoom, .45);
  assert.equal(updates, 4);
});
test('3D overlay labels keep a readable floor when the camera zooms in', () => {
  const scene = Object.create(HospitalScene.prototype);
  scene.walking = false;
  scene.camera = { zoom: 1 };
  close(scene.labelZoom(), 1);
  scene.camera.zoom = 2;
  close(scene.labelZoom(), overlayLabelScale(2));
  assert.ok(scene.labelZoom() <= 1, 'zooming in must not enlarge overlay labels');
  assert.ok(scene.labelZoom() >= LABEL_MIN_SCREEN_RATIO, 'zoomed-in overlay text stays at least home size');
  scene.camera.zoom = 8;
  close(scene.labelZoom(), overlayLabelScale(8));
  assert.equal(scene.labelZoom(), LABEL_MIN_SCREEN_RATIO);
  scene.camera.zoom = 0.45;
  close(scene.labelZoom(), overlayLabelScale(0.45));
  assert.ok(scene.labelZoom() > 1, 'zooming out may enlarge labels so they stay readable');
  scene.walking = true;
  close(scene.labelZoom(), 1);
});
test('walking playback supports speed limits and seeking without losing pause state', testPlayback);

test('map labels keep a readable on-screen floor when zooming in', () => {
  const page = [800, 1210];
  const home = homeViewFor(page)[2];
  const atHome = mapLabelUnit(page, home);
  close(atHome, 1);
  const twice = mapLabelUnit([1600, 2420]);
  close(twice / atHome, 2);
  const zoomedIn = mapLabelUnit(page, home / 2);
  const zoomedOut = mapLabelUnit(page, home * 1.5);
  const tight = mapLabelUnit(page, home / 8);
  assert.ok(zoomedIn < atHome, 'map-unit size drops when the viewBox shrinks so text does not cover rooms');
  close(zoomedIn, atHome / 2);
  assert.ok(zoomedOut > atHome, 'map-unit size grows when zoomed out so text stays readable');
  const screen = (unit, width) => unit / width;
  close(screen(zoomedIn, home / 2), screen(atHome, home));
  assert.ok(screen(tight, home / 8) >= screen(atHome, home) * LABEL_MIN_SCREEN_RATIO - 1e-9, 'high zoom keeps home on-screen size');
  assert.ok(screen(zoomedOut, home * 1.5) > screen(atHome, home), 'zoomed-out labels stay at least as large on screen');
  close(overlayLabelScale(1), 1);
  assert.equal(overlayLabelScale(2), LABEL_MIN_SCREEN_RATIO);
  assert.equal(overlayLabelScale(8), LABEL_MIN_SCREEN_RATIO);
  assert.ok(overlayLabelScale(0.5) > 1);
  const editor = fs.readFileSync(path.join(root, 'preview', 'editor.js'), 'utf8');
  const viewer = fs.readFileSync(path.join(root, 'preview', 'viewer.js'), 'utf8');
  assert.match(editor, /mapLabelUnit\(pageSize,\s*view\[2\]\)/);
  assert.match(viewer, /mapLabelUnit\(pageSize,\s*view\[2\]\)/);
  assert.match(editor, /function zoomMap\([^)]*\)\{[\s\S]*?\n  render2D\(\);\n\}/);
  assert.match(viewer, /function zoom\(factor\)\{if\(mode==='3d'\)\{scene\?\.zoom\(factor\);return;\}[\s\S]*render2D\(\);\}/);
  assert.doesNotMatch(editor, /view\[2\]\/\(svg\.clientWidth/);
  assert.doesNotMatch(viewer, /view\[2\]\/\(svg\.clientWidth/);
  assert.equal(LABEL_FONT_SIZE, 25);
  assert.equal(LABEL_MIN_SCREEN_PX, 18);
  const homeBox = homeViewFor(page);
  const previewScale = Math.min(1018 / homeBox[2], 607 / homeBox[3]);
  assert.ok(LABEL_FONT_SIZE * previewScale >= LABEL_MIN_SCREEN_PX - 1e-6,
    'Gifu home view room names are at least 18 CSS px on a 1440×900 preview canvas');
  assert.match(viewer, /LABEL_FONT_SIZE\s*\*\s*unit/);
  assert.match(editor, /LABEL_FONT_SIZE\s*\*\s*unit/);
  assert.doesNotMatch(viewer, /fill:'#ffffff',opacity:selected/);
  assert.doesNotMatch(viewer, /height:18\*unit,rx:3,fill:'#ffffff'/);
  assert.match(viewer, /layoutMapLabels\(labels/);
  const css = fs.readFileSync(path.join(root, 'preview', 'interface.css'), 'utf8');
  assert.match(css, /\.map-poi:not\(\.is-facility\) text/);
});

test('overview major names stay separately readable', () => {
  const page = pageSizeOf(doc);
  const home = homeViewFor(page);
  const catalog = displayPois(doc);
  const names = ['住院中心', '多功能室', '信息咨询处'];
  const ids = ['admission-center', 'multipurpose-room', 'service-information'];
  const placedAt = viewWidth => {
    const placed = layoutMapLabels(catalog, { pageSize: page, viewWidth });
    return ids.map(id => {
      const item = placed.find(entry => entry.poi.id === id);
      assert.ok(item, `${id} must stay visible`);
      return item;
    });
  };
  const overlapPair = (a, b) => rectsOverlap(a.rect, b.rect, 0, 0);
  const homePlaced = placedAt(home[2]);
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      assert.equal(overlapPair(homePlaced[i], homePlaced[j]), false,
        `${names[i]} overlaps ${names[j]} at overview`);
    }
  }
  const zoomed = placedAt(home[2] / 3);
  for (let i = 0; i < 3; i++) {
    assert.equal(zoomed[i].ox, 0);
    assert.equal(zoomed[i].oy, 0);
    for (let j = i + 1; j < 3; j++) {
      assert.equal(overlapPair(zoomed[i], zoomed[j]), false,
        `${names[i]} overlaps ${names[j]} when zoomed in`);
    }
  }
  assert.ok(labelStaggerOffsets(1, true).length > 1);
  assert.ok(LABEL_STAGGER_LINE >= 2);
  const art = fs.readFileSync(path.join(root, 'preview', 'map-art.js'), 'utf8');
  assert.match(art, /labelStaggerOffsets\(unit, force\)/);
  assert.doesNotMatch(art, /fill:'#ffffff'/);
});

test('pageSizeOf reads MapDocument source and rejects invalid sizes', () => {
  assert.deepEqual(pageSizeOf(doc), [800, 1210]);
  assert.deepEqual(pageSizeOf({ pdfSize: [1024, 768] }), [1024, 768]);
  assert.throws(() => pageSizeOf({ pdfSize: [0, 10] }));
  assert.deepEqual(DEFAULT_PDF_SIZE, [800, 1210]);
});

test('homeViewFor scales the Gifu framing to arbitrary page sizes', () => {
  assert.deepEqual(homeViewFor([800, 1210]).map(v => +v.toFixed(6)), [38, 12, 776, 835].map(v => +v.toFixed(6)));
  const wide = homeViewFor([1600, 1000]);
  samePoint(wide, [76, 1000 * 12 / 1210, 1552, 1000 * 835 / 1210]);
});

test('normalized and page-unit conversion round-trips', () => {
  const size = [640, 480];
  const page = toPageUnits([0.25, 0.5], size);
  samePoint(page, [160, 240]);
  samePoint(toNormalized(page, size), [0.25, 0.5]);
});

test('crop without rotation keeps original-page normalization', () => {
  const page = {
    originalSize: [1000, 800],
    crop: { x: 100, y: 50, width: 400, height: 200 },
    rotation: 0,
    pixelSize: [400, 200],
  };
  const mid = renderPixelToNormalized([200, 100], page);
  samePoint(mid, [0.3, 0.1875]);
  samePoint(normalizedToRenderPixel(mid, page), [200, 100]);
});

test('full-page rotations round-trip for multiple sizes', () => {
  for (const size of [[800, 1210], [1024, 768], [600, 600]]) {
    for (const rotation of [0, 90, 180, 270]) {
      const raster = rasterSizeFor(size, null, rotation);
      const page = { originalSize: size, crop: null, rotation, pixelSize: raster };
      const samples = [[0, 0], [raster[0] / 2, raster[1] / 2], [raster[0], raster[1]]];
      for (const pixel of samples) {
        const norm = renderPixelToNormalized(pixel, page);
        const back = normalizedToRenderPixel(norm, page);
        samePoint(back, pixel);
        assert.ok(norm[0] >= -1e-9 && norm[0] <= 1 + 1e-9);
        assert.ok(norm[1] >= -1e-9 && norm[1] <= 1 + 1e-9);
      }
    }
  }
});

test('cropped and rotated raster still maps back to original page basis', () => {
  const size = [1000, 800];
  const crop = { x: 100, y: 100, width: 400, height: 200 };
  for (const rotation of [0, 90, 180, 270]) {
    const raster = rasterSizeFor(size, crop, rotation);
    const page = { originalSize: size, crop, rotation, pixelSize: raster };
    const pixel = [raster[0] * 0.25, raster[1] * 0.75];
    const norm = renderPixelToNormalized(pixel, page);
    samePoint(normalizedToRenderPixel(norm, page), pixel);
    // Still within the original page, not the crop-local 0..1 box.
    const [x, y] = toPageUnits(norm, size);
    assert.ok(x >= crop.x - 1e-6 && x <= crop.x + crop.width + 1e-6);
    assert.ok(y >= crop.y - 1e-6 && y <= crop.y + crop.height + 1e-6);
  }
});

test('draft preserves original pdfSize when exporting MapDocument', () => {
  const draft = createMapDraft({
    id: 'demo-draft',
    fileName: 'ward.pdf',
    sha256: 'abc',
    byteLength: 12,
    originalSize: [1024, 768],
    rotation: 90,
    crop: { x: 10, y: 20, width: 400, height: 300 },
  });
  assert.equal(draft.schemaVersion, 'draft-1.0.0');
  const exported = draftToMapDocument(draft, {
    id: 'ward-1f',
    name: 'Ward',
    status: 'demo',
    floorId: '1F',
    source: { url: '', pdfUrl: '', imageUrl: '', imageSize: [1, 1] },
    calibration: null,
    geometry: { buildingBoundary: [], obstacles: [], wallSegments: [], walkableMaskUrl: '', safeMaskUrl: '', clearance: { value: 1, unit: 'pdf-map-unit', physicalRadiusVerified: false } },
    pois: [],
    doors: [],
    graph: { algorithm: 'test', coordinateSystem: 'normalized-top-left', nodes: [], edges: [] },
    notes: [],
  });
  assert.equal(exported.schemaVersion, '1.0.0');
  assert.deepEqual(exported.source.pdfSize, [1024, 768]);
  assert.equal(exported.source.page, 1);
  assert.equal(exported.source.pdfSha256, 'abc');
  assertCompatibleMapDocument(exported);
  assertCompatibleMapDocument(doc);
});

test('sample MapDraft keeps Gifu crop on the original page basis', () => {
  const draft = readJSON('sample-map-draft.json');
  assert.equal(draft.schemaVersion, 'draft-1.0.0');
  assert.deepEqual(draft.page.originalSize, [800, 1210]);
  const origin = renderPixelToNormalized([0, 0], draft.page);
  samePoint(origin, [78 / 800, 42 / 1210]);
  const back = normalizedToRenderPixel(origin, draft.page);
  samePoint(back, [0, 0]);
  const exported = draftToMapDocument(draft, {
    ...doc,
    source: { ...doc.source, pdfSha256: 'stale', page: 9, pdfSize: [1, 1] },
  });
  assert.equal(exported.source.pdfSha256, draft.sourceFile.sha256);
  assert.equal(exported.source.page, 1);
  assert.deepEqual(exported.source.pdfSize, [800, 1210]);
});

test('generated floors fit the building boundary instead of the Gifu legend crop', () => {
  const box = homeViewForBoundary([[0.1, 0.1], [0.5, 0.1], [0.5, 0.4], [0.1, 0.4]], [800, 1210]);
  assert.ok(box[0] < 80 && box[1] < 121);
  assert.ok(box[0] + box[2] > 400 && box[1] + box[3] > 484);
  assert.deepEqual(homeViewForBoundary([], [800, 1210]), homeViewFor([800, 1210]));
});

test('crop-sized rectangles are not treated as vector outer walls', () => {
  const page = [800, 564];
  const cropRect = [[18 / 800, 10 / 564], [791 / 800, 10 / 564], [791 / 800, 396 / 564], [18 / 800, 396 / 564]];
  assert.equal(isManualCropBoundary(cropRect, page, [773, 386]), true);
  const pageRect = [[0, 0], [1, 0], [1, 1], [0, 1]];
  assert.equal(isManualCropBoundary(pageRect, page), true);
  const diamond = [[0.3, 0.05], [0.64, 0.22], [0.91, 0.48], [0.37, 0.66], [0.04, 0.48]];
  assert.equal(isManualCropBoundary(diamond, page, [773, 386]), false);
});

test('institution floor switcher never mixes Gifu demo floors', () => {
  const viewer = fs.readFileSync(path.join(root, 'preview', 'viewer.js'), 'utf8');
  assert.match(viewer, /Institution maps are isolated/);
  assert.match(viewer, /if\(projectFloors\.length\)return \[\.\.\.projectFloors\]/);
  assert.match(viewer, /purgeBuiltinFloorCache/);
  assert.match(viewer, /!projectFloors\.length&&isBuiltin\(data\)/);
});

test('stage 2 maker panel is wired in the preview page', () => {
  const html = fs.readFileSync(path.join(root, 'preview', 'index.html'), 'utf8');
  for (const id of ['maker-panel', 'maker-upload', 'maker-thumbs', 'maker-page', 'maker-crop', 'maker-save', 'maker-rotation', 'maker-build', 'maker-floor-id', 'maker-floor-name', 'floor-switcher', 'floor-number', 'edit-map', 'maker-open-edit', 'maker-crop-overlay', 'maker-page-fs', 'maker-crop-fs', 'maker-crop-fullscreen-open', 'maker-crop-zoom-in', 'maker-crop-zoom-out']) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.ok(html.includes('./maker.js'));
  assert.ok(fs.existsSync(path.join(root, 'preview', 'maker.js')));
  assert.ok(fs.existsSync(path.join(root, 'assets', 'vendor', 'pdfjs', 'pdf.min.mjs')));
  const maker = fs.readFileSync(path.join(root, 'preview', 'maker.js'), 'utf8');
  assert.match(maker, /function openCropFullscreen/);
  assert.match(maker, /function renderFullscreenPage/);
  assert.match(maker, /function setCropZoom/);
  assert.match(maker, /CROP_ZOOM_MAX/);
  const css = fs.readFileSync(path.join(root, 'preview', 'interface.css'), 'utf8');
  assert.match(css, /\.maker-crop-overlay/);
  assert.match(css, /\.maker-crop--fs/);
});

test('editor switches to another ready floor and never dead-ends', () => {
  const html = fs.readFileSync(path.join(root, 'preview', 'edit.html'), 'utf8');
  for (const id of ['loading-message', 'loading-actions', 'loading-back', 'loading-generate', 'back-preview']) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.match(html, /返回导览/);
  assert.match(html, /去生成楼层/);
  const editor = fs.readFileSync(path.join(root, 'preview', 'editor.js'), 'utf8');
  assert.match(editor, /function pickReadyFloor/);
  assert.match(editor, /function showEmptyState/);
  assert.match(editor, /function resolveFloorMap/);
  assert.match(editor, /location\.replace\(editorHref/);
  assert.match(editor, /history\.replaceState/);
  assert.match(editor, /previewMakerHref/);
  assert.match(editor, /function canDeleteFloor/);
  assert.match(editor, /至少保留一层三维地图，不能删除最后一层/);
  assert.doesNotMatch(editor, /请先生成这一层的三维地图/);
  const helpers = editor.slice(editor.indexOf('function readyFloors'), editor.indexOf('async function loadFloorMap'));
  const ctx = vm.runInNewContext(`${helpers}; ({readyFloors, pickReadyFloor, canDeleteFloor})`);
  const record = {
    activeFloor: '2F',
    floors: {
      1: {id: '1F', status: 'ready'},
      2: {id: '2F', status: 'ready'},
      3: {id: '3F', status: 'draft'},
    },
  };
  assert.equal(ctx.pickReadyFloor(record, '2F'), '2F');
  assert.equal(ctx.pickReadyFloor(record, '2F', '2F'), '1F');
  assert.equal(ctx.pickReadyFloor(record, 'gone', '2F'), '1F');
  assert.equal(ctx.pickReadyFloor({floors: {1: {id: '3F', status: 'draft'}}}, '3F'), null);
  assert.equal(ctx.canDeleteFloor(record), true);
  assert.equal(ctx.canDeleteFloor({floors: {1: {id: '1F', status: 'ready'}}}), false);
  const maker = fs.readFileSync(path.join(root, 'preview', 'maker.js'), 'utf8');
  const hrefSrc = maker.slice(maker.indexOf('function editorHref'), maker.indexOf('function syncImportMode'));
  const href = vm.runInNewContext(`${hrefSrc}; editorHref`, {encodeURIComponent});
  assert.equal(href({id: 'p1', floors: {1: {id: '1F', status: 'draft'}}, draft: {floor: {id: '1F'}}}), '');
  assert.match(href({id: 'p1', activeFloor: '2F', floors: {1: {id: '1F', status: 'ready'}, 2: {id: '2F', status: 'ready'}}}), /floor=2F/);
  assert.match(maker, /get\('maker'\)==='1'\)setMakerOpen\(true\)/);
  const css = fs.readFileSync(path.join(root, 'preview', 'interface.css'), 'utf8');
  assert.match(css, /#loading-actions|#loading \.loading-card/);
  assert.match(css, /\.editor-page \.header-actions \.text-button\{display:inline-flex\}/);
  assert.match(css, /\.header-actions \.danger-text\[hidden\]/);
});

test('editor page is a separate desk with delete-floor and no orange handles', () => {
  const html = fs.readFileSync(path.join(root, 'preview', 'edit.html'), 'utf8');
  for (const id of ['dept-list', 'facility-list', 'place-name', 'icon-palette', 'delete-floor', 'map', 'scene3d']) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.ok(html.includes('./editor.js'));
  assert.match(html, /await import\('\.\/editor\.js'\)/);
  const editor = fs.readFileSync(path.join(root, 'preview', 'editor.js'), 'utf8');
  assert.match(editor, /deleteFloor/);
  assert.match(editor, /showLoading/);
  assert.match(editor, /status==='ready'/);
  assert.doesNotMatch(editor, /resize handle|orange|#f97316|#ff9800/i);
  const css = fs.readFileSync(path.join(root, 'preview/interface.css'), 'utf8');
  assert.match(css, /\.map-poi:focus-visible[^}]*outline:\s*none/);
  assert.match(css, /No orange frame/);
  assert.match(css, /#loading\[hidden\]/);
  const maker = fs.readFileSync(path.join(root, 'preview', 'maker.js'), 'utf8');
  assert.match(maker, /floor-pdf/);
  assert.match(maker, /maker-add-floor-hint/);
  assert.match(maker, /awaitingNewFloorPdf/);
  assert.match(maker, /isRegeneratingReadyFloor/);
  assert.match(maker, /readyFloorIds/);
  assert.doesNotMatch(maker, /current\?\.status==='ready'\?'重新生成 3D'/);
});

test('add-floor build button uses floor id, not page ready status', () => {
  const maker = fs.readFileSync(path.join(root, 'preview', 'maker.js'), 'utf8');
  const update = maker.slice(maker.indexOf('function updateBuildButton'), maker.indexOf('function apiError'));
  assert.match(update, /isRegeneratingReadyFloor\(\)\?'重新生成 3D':'生成 3D'/);
  assert.match(update, /awaitingNewFloorPdf\(\)/);
  assert.doesNotMatch(update, /pageFloor\(project/);
  assert.match(maker, /readyFloorIds\(\)\.has\(floorId\)/);
});

test('facility drag stays inside the owning room polygon', () => {
  const square = [[0.2, 0.2], [0.6, 0.2], [0.6, 0.5], [0.2, 0.5]];
  assert.deepEqual(closestPointOnPolygon(square, 0.4, 0.3), [0.4, 0.3]);
  const clamped = closestPointOnPolygon(square, 0.9, 0.9);
  assert.ok(clamped[0] <= 0.6 + 1e-9 && clamped[1] <= 0.5 + 1e-9);
  assert.ok(clamped[0] >= 0.2 - 1e-9 && clamped[1] >= 0.2 - 1e-9);
  const editor = fs.readFileSync(path.join(root, 'preview', 'editor.js'), 'utf8');
  const down = editor.slice(editor.indexOf("group.addEventListener('pointerdown'"), editor.indexOf("group.addEventListener('click'"));
  assert.match(down, /freezeDragBounds/);
  assert.match(down, /polygon:bounds\.polygon/);
  assert.ok(down.indexOf('drag=') < down.indexOf('selectPlace'), 'capture drag before focusing the name field');
  assert.match(editor, /clampNorm\([^,]+,[^,]+, drag\.polygon\)/);
});

test('2D editor selection overlay follows the selected room polygon', () => {
  const rooms = [
    {id:'skew', polygon:[[0.1,0.2],[0.4,0.1],[0.5,0.4],[0.2,0.5]]},
    {id:'other', polygon:[[0.6,0.6],[0.8,0.6],[0.8,0.8],[0.6,0.8]]},
  ];
  assert.equal(obstacleForSelection('room-skew', null, rooms)?.id, 'skew');
  assert.equal(obstacleForSelection('dept-1', {roomId:'skew'}, rooms)?.id, 'skew');
  assert.equal(obstacleForSelection('room-skew', {roomId:'other'}, rooms)?.id, 'other');
  assert.equal(obstacleForSelection('icon-1', {roomId:'missing'}, rooms), null);
  assert.equal(obstacleForSelection(null, {roomId:'skew'}, rooms), null);
  const skew = rooms[0].polygon;
  const overlayPts = obstacleForSelection('room-skew', null, rooms).polygon;
  assert.deepEqual(overlayPts, skew);
  const xs = skew.map(p=>p[0]), ys = skew.map(p=>p[1]);
  const bbox = [[Math.min(...xs),Math.min(...ys)],[Math.max(...xs),Math.min(...ys)],[Math.max(...xs),Math.max(...ys)],[Math.min(...xs),Math.max(...ys)]];
  assert.notDeepEqual(overlayPts, bbox);
  const editor = fs.readFileSync(path.join(root, 'preview', 'editor.js'), 'utf8');
  const render = editor.slice(editor.indexOf('function render2D'), editor.indexOf('function render()'));
  assert.match(render, /selectedObstacle\(\)/);
  assert.match(render, /class:`editor-room\$\{/);
  assert.match(render, /class:'editor-room-mask'/);
  assert.match(render, /points:points\(selected\.polygon\)/);
  assert.ok(render.indexOf("class:'editor-room-mask'") < render.indexOf('drawMarker'), 'mask under labels');
  assert.doesNotMatch(render, /editor-room-mask[\s\S]{0,120}<rect|element\('rect'/);
  const css = fs.readFileSync(path.join(root, 'preview/interface.css'), 'utf8');
  assert.match(css, /\.editor-page \.editor-room-mask\{[^}]*pointer-events:\s*none/);
  assert.match(css, /\.editor-label\.is-selected \.editor-label-text\{[^}]*paint-order:\s*stroke fill/);
});

test('selected facilities keep the icon beside the name', () => {
  assert.equal(isFacilityPoi({ category: 'elevator' }), true);
  assert.equal(isFacilityPoi({ category: 'department' }), false);
  const compact = facilityChipBox(100, 50, 1, '电梯', false);
  const labeled = facilityChipBox(100, 50, 1, '电梯', true);
  assert.equal(compact.right - compact.left, FACILITY_BADGE_RADIUS * 2);
  assert.ok(FACILITY_ICON_SIZE > FACILITY_BADGE_RADIUS, 'glyph fills most of the badge');
  assert.ok(labeled.right > compact.right + FACILITY_LABEL_GAP);
  assert.equal(compact.left, labeled.left);
  const icons = fs.readFileSync(path.join(root, 'preview', 'facility-icons.js'), 'utf8');
  const viewer = fs.readFileSync(path.join(root, 'preview', 'viewer.js'), 'utf8');
  const editor = fs.readFileSync(path.join(root, 'preview', 'editor.js'), 'utf8');
  const scene = fs.readFileSync(path.join(root, 'preview', 'scene3d.js'), 'utf8');
  assert.match(icons, /size: FACILITY_ICON_SIZE \* unit/);
  assert.match(icons, /LABEL_FONT_SIZE \* unit/);
  assert.doesNotMatch(icons, /setAttribute\('fill', '#ffffff'\)/);
  assert.match(icons, /class', 'facility-chip-label'/);
  assert.match(viewer, /drawFacilityChip\(group/);
  assert.match(viewer, /showText:textLabel/);
  assert.doesNotMatch(viewer, /facilitySymbol/);
  assert.match(editor, /drawFacilityChip\(group/);
  assert.match(editor, /showText:selected/);
  assert.match(scene, /createFacilityIconSvg/);
  assert.match(scene, /FACILITY_SCENE_BADGE/);
  assert.match(scene, /transformOrigin = '0 0'/);
  assert.match(scene, /label\.icon\) label\.icon\.hidden = false/);
  assert.doesNotMatch(scene, /facilitySymbol/);
  assert.equal(FACILITY_SCENE_BADGE, 28);
});

test('map icons and labels suppress the browser context menu', () => {
  const viewer = fs.readFileSync(path.join(root, 'preview', 'viewer.js'), 'utf8');
  const scene = fs.readFileSync(path.join(root, 'preview', 'scene3d.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'preview', 'interface.css'), 'utf8');
  assert.match(viewer, /group\.addEventListener\('contextmenu',\s*ev=>ev\.preventDefault\(\)\)/);
  assert.match(viewer, /svg\.addEventListener\('contextmenu',\s*ev=>ev\.preventDefault\(\)\)/);
  assert.match(viewer, /\$\('scene3d'\)\.addEventListener\('contextmenu',\s*ev=>ev\.preventDefault\(\)\)/);
  assert.match(scene, /container\.addEventListener\('contextmenu', this\.blockContextMenu\)/);
  assert.match(scene, /element\.addEventListener\('contextmenu', event => event\.preventDefault\(\)\)/);
  assert.match(scene, /new OrbitControls\(this\.camera, this\.container\)/);
  assert.match(scene, /if \(event\.button === 0\) event\.stopPropagation\(\)/);
  assert.match(css, /#map,\.map-poi,\.scene-poi-label\{[^}]*-webkit-touch-callout:\s*none/);
});

test('preview and edit pages remove input and button focus rings', () => {
  const interfaceCss = fs.readFileSync(path.join(root, 'preview/interface.css'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'preview/styles.css'), 'utf8');
  assert.doesNotMatch(interfaceCss, /#9a6b37/);
  assert.doesNotMatch(interfaceCss, /outline:\s*3px\s+solid/);
  assert.doesNotMatch(interfaceCss, /\.status\{left:282px\}/);
  assert.match(interfaceCss, /button:focus[^{]*\{[^}]*outline:\s*none/);
  assert.match(interfaceCss, /input:focus[^{]*\{[^}]*outline:\s*none/);
  assert.match(styles, /button:focus[^{]*\{[^}]*outline:\s*none/);
  assert.match(styles, /\.search-box:focus-within/);
});

test('named rooms become start/end on both editor and preview', () => {
  const editor = fs.readFileSync(path.join(root, 'preview', 'editor.js'), 'utf8');
  const viewer = fs.readFileSync(path.join(root, 'preview', 'viewer.js'), 'utf8');
  const maker = fs.readFileSync(path.join(root, 'preview', 'maker.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'preview', 'edit.html'), 'utf8');
  const previewHtml = fs.readFileSync(path.join(root, 'preview', 'index.html'), 'utf8');
  const build = fs.readFileSync(path.join(root, 'scripts', 'maker_build.py'), 'utf8');
  assert.match(html, /id="start"/);
  assert.match(html, /id="end"/);
  assert.match(html, /设为起点/);
  assert.match(html, /设为终点/);
  assert.match(previewHtml, /id="start"/);
  assert.match(previewHtml, /id="end"/);
  assert.match(previewHtml, /设为起点/);
  assert.match(previewHtml, /设为终点/);
  assert.match(editor, /renamedRooms\[selectedId\.slice\(5\)\]=name/);
  assert.match(editor, /function setNavEndpoint/);
  assert.match(editor, /findRoute\(doc\.graph,start\.nodeId,end\.nodeId\)/);
  assert.match(editor, /id="set-start"|set-start/);
  assert.match(editor, /roomOnly/);
  assert.match(viewer, /function setNavEndpoint/);
  assert.match(viewer, /poiForRoom\(doc,\s*o\.id\)/);
  assert.match(viewer, /function selectPoi\(id, asStart=false\)/);
  assert.match(viewer, /id="set-start"|set-start/);
  assert.match(maker, /async function openReadyFloorMap/);
  assert.match(maker, /await openReadyFloorMap\(record\)/);
  assert.match(build, /def _promote_named_rooms/);
  assert.match(build, /renamed_rooms\.get\(room\["id"\]\)/);
  const fake = {
    pois: [
      {id:'room-skew', name:'处置室', roomId:'skew', nodeId:'poi:room-skew', category:'room'},
      {id:'icon-1', name:'电梯', roomId:'skew', nodeId:null, category:'elevator'},
    ],
  };
  assert.equal(poiForRoom(fake, 'skew').id, 'room-skew');
  assert.equal(poiForRoom(fake, 'missing'), null);
  const start = fake.pois[0];
  const graph = {
    nodes: [
      {id:'j1', position:[0.2,0.2], kind:'junction'},
      {id:start.nodeId, position:[0.3,0.3], kind:'poi', poiId:start.id},
      {id:'poi:end', position:[0.8,0.8], kind:'poi', poiId:'end-1'},
    ],
    edges: [
      {id:'access:room-skew', source:start.nodeId, target:'j1', lengthMapUnits:10, polyline:[[0.3,0.3],[0.2,0.2]], enabled:true},
      {id:'e1', source:'j1', target:'poi:end', lengthMapUnits:20, polyline:[[0.2,0.2],[0.8,0.8]], enabled:true},
    ],
  };
  const route = findRoute(graph, start.nodeId, 'poi:end');
  assert.ok(route);
  assert.ok(route.length > 0);
});


test('institution list items keep two-line labels visible', () => {
  const css = fs.readFileSync(path.join(root, 'preview/interface.css'), 'utf8');
  assert.match(css, /\.institution-list button\s*\{[^}]*flex:\s*0 0 auto/);
  assert.match(css, /\.institution-list button\s*\{[^}]*min-height:\s*52px/);
  assert.match(css, /\.institution-list button\s*\{[^}]*overflow:\s*visible/);
  assert.match(css, /\.institution-list button span\s*\{[^}]*line-height:\s*1\.4/);
});

test('institution switcher is wired for preview and editor', () => {
  const previewHtml = fs.readFileSync(path.join(root, 'preview', 'index.html'), 'utf8');
  const editHtml = fs.readFileSync(path.join(root, 'preview', 'edit.html'), 'utf8');
  const maker = fs.readFileSync(path.join(root, 'preview', 'maker.js'), 'utf8');
  const editor = fs.readFileSync(path.join(root, 'preview', 'editor.js'), 'utf8');
  const institutions = fs.readFileSync(path.join(root, 'preview', 'institutions.js'), 'utf8');
  const store = fs.readFileSync(path.join(root, 'scripts', 'maker_store.py'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'scripts', 'maker_app.py'), 'utf8');
  assert.match(previewHtml, /id="institution-switcher"/);
  assert.match(previewHtml, /id="maker-institution-name"/);
  assert.match(editHtml, /id="institution-switcher"/);
  assert.match(maker, /mountInstitutionSwitcher/);
  assert.match(maker, /createNewInstitution/);
  assert.match(editor, /mountInstitutionSwitcher/);
  assert.match(institutions, /确认删除/);
  assert.match(institutions, /institution-delete-confirm/);
  assert.match(store, /def list_projects/);
  assert.match(store, /def rename/);
  assert.match(store, /def delete/);
  assert.match(app, /@app\.get\("\/api\/projects"\)/);
  assert.match(app, /@app\.patch\("\/api\/projects\/\{project_id\}"\)/);
  assert.match(app, /@app\.delete\("\/api\/projects\/\{project_id\}"\)/);
});

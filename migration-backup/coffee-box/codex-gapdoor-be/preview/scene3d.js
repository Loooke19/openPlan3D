import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { roomColor, displayPois, facilityCategory, facilityColor } from './map-art.js';
import { createFacilityIconSvg, facilityIconKey, isFacilityPoi, FACILITY_SCENE_BADGE, FACILITY_SCENE_GAP, FACILITY_SCENE_ICON } from './facility-icons.js';
import { routeArrows, ROUTE_ARROW_SPACING } from './routing.js';
import { wallSignPlacements } from './wall-signs.js';
import { sanitizeAppearance } from './appearance.js';
import { WalkLook } from './walk-look.js';
import { overlayLabelScale, isManualCropBoundary } from './map-coords.js';

const WALL_HEIGHT = 19;
const EYE_HEIGHT = 12;
const WALK_SPEED = 30; // Drawing units / second, not surveyed metres.
const WALL_SIGN_WIDTH = 18; // One consistent physical plaque size for every room.
const UP = new THREE.Vector3(0, 1, 0);

/** Roofless vector model. All horizontal geometry uses the navigation map's PDF units. */
export class HospitalScene {
  constructor(container, doc, { onSelect = () => {}, onProgress = () => {}, onComplete = () => {} } = {}) {
    this.container = container;
    this.doc = doc;
    this.onSelect = onSelect;
    this.onProgress = onProgress;
    this.onComplete = onComplete;
    this.size = doc.source.pdfSize;
    this.pois = displayPois(doc);
    this.category = 'all';
    this.term = '';
    this.showPois = true;
    this.selectedId = null;
    this.visible = true;
    this.disposed = false;
    this.walking = false;
    this.paused = false;
    this.walkSpeedFactor = 1;
    this.routePoints = [];
    this.routeLengths = [];
    this.routeLength = 0;
    this.labels = [];
    this.resources = [];
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#f6f8fa');
    const bounds = doc.geometry.buildingBoundary.map(p => [p[0] * this.size[0], p[1] * this.size[1]]);
    this.center = [(Math.min(...bounds.map(p => p[0])) + Math.max(...bounds.map(p => p[0]))) / 2,
      (Math.min(...bounds.map(p => p[1])) + Math.max(...bounds.map(p => p[1]))) / 2];
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.setClearColor('#f6f8fa');
    Object.assign(this.renderer.domElement.style, { display: 'block', width: '100%', height: '100%', touchAction: 'none' });
    this.renderer.domElement.setAttribute('aria-label', '可旋转、缩放的医院一楼三维地图');
    this.container.appendChild(this.renderer.domElement);
    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'scene-label-layer';
    Object.assign(this.labelLayer.style, { position: 'absolute', inset: '0', overflow: 'hidden', pointerEvents: 'none' });
    this.container.appendChild(this.labelLayer);
    this.walkContext = document.createElement('div');
    this.walkContext.className = 'walk-context';
    this.walkContext.hidden = true;
    this.container.appendChild(this.walkContext);
    this.labelRay = new THREE.Raycaster();
    this.camera = new THREE.OrthographicCamera(-500, 500, 400, -400, .1, 5000);
    this.walkCamera = new THREE.PerspectiveCamera(68, 1, .35, 2500);
    this.activeCamera = this.camera;
    this.camera.position.set(90, 1000, 650);
    this.camera.lookAt(0, 0, 0);
    this.blockContextMenu = event => event.preventDefault();
    this.container.addEventListener('contextmenu', this.blockContextMenu);
    this.controls = new OrbitControls(this.camera, this.container);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = .12;
    this.controls.screenSpacePanning = true;
    this.controls.minPolarAngle = .12;
    this.controls.maxPolarAngle = Math.PI / 2.5;
    this.controls.minZoom = .45;
    this.controls.maxZoom = 8;
    this.controls.target.set(0, 0, 0);
    this.walkLook = new WalkLook();
    const canvas = this.renderer.domElement;
    this.lookDown = e => {
      if(!this.walking || e.button !== 0 || !this.walkLook.begin(e.pointerId,e.clientX,e.clientY))return;
      canvas.setPointerCapture(e.pointerId);canvas.style.cursor='grabbing';e.preventDefault();
    };
    this.lookMove = e => { if(this.walking)this.walkLook.move(e.pointerId,e.clientX,e.clientY); };
    this.lookEnd = e => {
      this.walkLook.end(e.pointerId);
      if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);
      canvas.style.cursor=this.walking?'grab':'';
    };
    this.lookBlur = () => { const id=this.walkLook.pointer;if(id!==null)this.lookEnd({pointerId:id}); };
    canvas.addEventListener('pointerdown',this.lookDown);
    canvas.addEventListener('pointermove',this.lookMove);
    for(const event of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(event,this.lookEnd);
    window.addEventListener('blur',this.lookBlur);
    this.ambientLight = new THREE.HemisphereLight('#ffffff', '#b8bfc4', 1.8);
    this.scene.add(this.ambientLight);
    const sun = new THREE.DirectionalLight('#fff5e8', 2.2);
    this.sunLight = sun;
    sun.position.set(-400, 900, 300);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -650, right: 650, top: 650, bottom: -650, near: 1, far: 2200 });
    sun.shadow.normalBias = .4;
    this.scene.add(sun);
    this.architecture = new THREE.Group();
    this.scene.add(this.architecture);
    this.routeGroup = new THREE.Group();
    this.scene.add(this.routeGroup);
    this.routeArrowMesh = null;
    this.routeArrowPhase = 0;
    this.routeArrowFlat = [];
    this.navMarkerGroup = new THREE.Group();
    this.scene.add(this.navMarkerGroup);
    this.navMarker = null;
    this.buildArchitecture();
    this.buildLabels();
    this.signGroup = new THREE.Group();
    this.signGroup.visible = false;
    this.scene.add(this.signGroup);
    this.wallSigns = [];
    document.fonts.ready.then(() => { if (!this.disposed) this.buildWallSigns(); });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.fit();
    this.previousTime = 0;
    this.renderFrame = this.renderFrame.bind(this);
    this.frameId = requestAnimationFrame(this.renderFrame);
  }

  point(p, height = 0) {
    return new THREE.Vector3(p[0] * this.size[0] - this.center[0], height, p[1] * this.size[1] - this.center[1]);
  }

  material(color, extra = {}) {
    const result = new THREE.MeshStandardMaterial({ color, roughness: 1, metalness: 0, ...extra });
    this.resources.push(result);
    return result;
  }

  // World-space procedural surfaces: consistent scale across differently sized wall instances.
  // CAD imports already carry axis-grid risk; never paint floor tile grout that reads as 标尺.
  isCadSource() {
    return String(this.doc?.source?.sourceKind || '').toLowerCase() === 'cad';
  }

  surfaceMaterial(kind, color) {
    this.surfaceUniforms ||= { hospitalGrain:{value:1},hospitalTileSize:{value:12},hospitalSkirt:{value:7} };
    const material = this.material(color, { roughness: kind === 'wall' ? .88 : .65 });
    const cadFloor = kind !== 'wall' && this.isCadSource();
    material.customProgramCacheKey = () => `hospital-${kind}-${cadFloor ? 'cad' : 'v1'}`;
    material.onBeforeCompile = shader => {
      shader.vertexShader = 'varying vec3 hospitalPosition;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <worldpos_vertex>', `
        #include <worldpos_vertex>
        vec4 hospitalWorld = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          hospitalWorld = instanceMatrix * hospitalWorld;
        #endif
        hospitalPosition = (modelMatrix * hospitalWorld).xyz;
      `);
      Object.assign(shader.uniforms ||= {}, this.surfaceUniforms);
      shader.fragmentShader = 'varying vec3 hospitalPosition;\nuniform float hospitalGrain;\nuniform float hospitalTileSize;\nuniform float hospitalSkirt;\n' + shader.fragmentShader;
      const surface = kind === 'wall' ? `
        float grain = sin(hospitalPosition.x * 42.0 + hospitalPosition.z * 37.0) * sin(hospitalPosition.y * 51.0);
        diffuseColor.rgb *= 0.97 + grain * 0.025 * hospitalGrain;
        if (hospitalPosition.y < 1.15) diffuseColor.rgb *= vec3(0.39, 0.47, 0.45);
        else if (hospitalPosition.y < hospitalSkirt) diffuseColor.rgb *= vec3(0.80, 0.88, 0.85);
        if (hospitalPosition.y > hospitalSkirt - .3 && hospitalPosition.y < hospitalSkirt + .2) diffuseColor.rgb *= vec3(0.54, 0.66, 0.59);
      ` : cadFloor ? `
        float grain = sin(hospitalPosition.x * 31.0) * sin(hospitalPosition.z * 39.0);
        diffuseColor.rgb *= 1.0 + grain * 0.01 * hospitalGrain;
      ` : `
        vec2 tile = hospitalPosition.xz / hospitalTileSize;
        vec2 edge = abs(fract(tile - 0.5) - 0.5);
        vec2 aa = max(fwidth(tile), vec2(0.001));
        vec2 seam = 1.0 - smoothstep(vec2(0.018), vec2(0.018) + aa, edge);
        float grout = max(seam.x, seam.y);
        float grain = sin(hospitalPosition.x * 31.0) * sin(hospitalPosition.z * 39.0);
        diffuseColor.rgb *= 1.0 - grout * 0.18 + grain * 0.012 * hospitalGrain;
      `;
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n' + surface);
    };
    return material;
  }

  floorShapeCoords(points) {
    const coords = points.map(p => {
      const v = this.point(p);
      return [v.x, -v.z];
    });
    let area = 0;
    for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
      area += coords[j][0] * coords[i][1] - coords[i][0] * coords[j][1];
    }
    if (area < 0) coords.reverse();
    return coords;
  }

  flatPolygon(points, color, height = .1, offsetUnits = 1) {
    const shape = new THREE.Shape();
    this.floorShapeCoords(points).forEach((p, i) => {
      if (i === 0) shape.moveTo(p[0], p[1]);
      else shape.lineTo(p[0], p[1]);
    });
    shape.closePath();
    const geometry = new THREE.ShapeGeometry(shape);
    geometry.rotateX(-Math.PI / 2);
    this.resources.push(geometry);
    const mesh = new THREE.Mesh(geometry, this.surfaceMaterial('floor', color));
    // Zero-thickness DoubleSide planes z-fight with themselves and pick up the
    // hemisphere ground tint — a flickering green sheet on the floor.
    mesh.material.side = THREE.FrontSide;
    mesh.material.polygonOffset = true;
    mesh.material.polygonOffsetFactor = -1;
    mesh.material.polygonOffsetUnits = -Math.max(1, offsetUnits);
    mesh.receiveShadow = true;
    mesh.position.y = height;
    this.architecture.add(mesh);
    return mesh;
  }

  buildArchitecture() {
    const geometry = this.doc.geometry;
    this.corridorFloor = this.flatPolygon(geometry.buildingBoundary, '#fbfcfa', 0, 1);
    // A shallow plinth makes the actual building silhouette readable against the map canvas.
    const base = this.flatPolygon(geometry.buildingBoundary, '#d6dad8', -2.2, 1);
    base.scale.set(1.008, 1, 1.008);
    const walls = [];
    let roomId = null;
    const seen = new Set();
    const doors = (this.doc.doors || []).map(d => ({ ...d, p: this.point(d.position) }));
    const entrances = this.pois.filter(p => facilityCategory(p) === 'entrance').map(p => ({ p: this.point(p.position), entrance: true }));
    const addWall = (a, b, height, width = 1.7, boundary = false) => {
      const start = this.point(a), end = this.point(b);
      const length = start.distanceTo(end);
      if (length < .4) return;
      const key = [start, end].map(v => `${v.x.toFixed(1)},${v.z.toFixed(1)}`).sort().join('|');
      if (seen.has(key)) return;
      seen.add(key);
      const direction = end.clone().sub(start).normalize();
      const openings = [];
      for (const door of boundary ? [...doors, ...entrances] : doors) {
        const delta = door.p.clone().sub(start);
        const along = delta.dot(direction);
        const nearest = start.clone().addScaledVector(direction, Math.max(0, Math.min(length, along)));
        if (door.p.distanceTo(nearest) < (door.entrance ? 24 : 2.2) && along > -2 && along < length + 2) {
          // PDF-pt widths from CAD openings (swing ≈22, wall-gap ≈28); default leaf ~8pt.
          const halfWidth = door.entrance ? 10 : Math.max(4.2, (Number(door.widthMapUnits) || 8) * 0.5);
          openings.push([Math.max(0, along - halfWidth), Math.min(length, along + halfWidth)]);
        }
      }
      openings.sort((x, y) => x[0] - y[0]);
      let cursor = 0;
      const piece = (from, to) => {
        if (to - from < .4) return;
        const midpoint = start.clone().addScaledVector(direction, (from + to) / 2);
        walls.push({ roomId, x: midpoint.x, z: midpoint.z, length: to - from, height, width,
          angle: Math.atan2(-direction.z, direction.x) });
      };
      for (const [from, to] of openings) { piece(cursor, from); cursor = Math.max(cursor, to); }
      piece(cursor, length);
    };
    const outline = (points, height, width, boundary = false) => {
      for (let i = 1; i < points.length; i++) addWall(points[i - 1], points[i], height, width, boundary);
      if (points.length > 2) addWall(points[points.length - 1], points[0], height, width, boundary);
    };
    geometry.obstacles.forEach((obstacle, index) => {
      roomId = obstacle.id;
      const isCourt = obstacle.kind === 'courtyard';
      const isCounter = obstacle.kind === 'counter';
      // Keep slabs off the corridor plane. Counters are desk-height so the
      // original map's green 柜台 no longer z-fights as a flashing floor layer.
      const slab = isCounter ? 6.45 : isCourt ? 0.08 : 0.4;
      this.flatPolygon(obstacle.polygon, roomColor(obstacle, this.doc), slab, index + 2);
      outline(obstacle.polygon, isCourt ? 3.8 : isCounter ? 7 : WALL_HEIGHT, isCounter ? 2 : 1.7);
      if (isCourt) this.addCourtyard(obstacle.polygon);
      if (obstacle.kind === 'stairs' || obstacle.kind === 'escalator') this.addSteps(obstacle.polygon);
    });
    // Include only unsupplied stroke segments; polygon walls above take precedence.
    roomId = null;
    for (const line of geometry.wallSegments || []) {
      for (let i = 1; i < line.length; i++) addWall(line[i - 1], line[i], WALL_HEIGHT, 1.4);
    }
    if (!isManualCropBoundary(geometry.buildingBoundary, this.size, this.doc.source?.imageSize)) {
      outline(geometry.buildingBoundary, WALL_HEIGHT, 2, true);
    }
    const wallGeometry = new THREE.BoxGeometry(1, 1, 1);
    this.resources.push(wallGeometry);
    const wallMesh = new THREE.InstancedMesh(wallGeometry, this.surfaceMaterial('wall', '#e2e6e3'), walls.length);
    wallMesh.castShadow = true;
    wallMesh.receiveShadow = true;
    this.wallMesh = wallMesh;
    this.wallPieces = walls;
    const dummy = new THREE.Object3D();
    walls.forEach((wall, i) => {
      dummy.position.set(wall.x, wall.height / 2, wall.z);
      dummy.rotation.set(0, wall.angle, 0);
      dummy.scale.set(wall.length, wall.height, wall.width);
      dummy.updateMatrix();
      wallMesh.setMatrixAt(i, dummy.matrix);
    });
    wallMesh.instanceMatrix.needsUpdate = true;
    this.architecture.add(wallMesh);
  }

  addCourtyard(points) {
    const ps = points.map(p => this.point(p));
    const minX = Math.min(...ps.map(p => p.x)), maxX = Math.max(...ps.map(p => p.x));
    const minZ = Math.min(...ps.map(p => p.z)), maxZ = Math.max(...ps.map(p => p.z));
    const radius = Math.min(maxX - minX, maxZ - minZ) * .1;
    const crown = new THREE.IcosahedronGeometry(Math.min(6, radius), 1);
    this.resources.push(crown);
    const treeMaterial = this.material('#adc7ac');
    for (const [x, z] of [[.28, .28], [.72, .7], [.3, .7]]) {
      const tree = new THREE.Mesh(crown, treeMaterial);
      tree.position.set(minX + (maxX - minX) * x, 5, minZ + (maxZ - minZ) * z);
      tree.scale.y = .85;
      this.architecture.add(tree);
    }
  }

  addSteps(points) {
    const ps = points.map(p => this.point(p));
    const minX = Math.min(...ps.map(p => p.x)), maxX = Math.max(...ps.map(p => p.x));
    const minZ = Math.min(...ps.map(p => p.z)), maxZ = Math.max(...ps.map(p => p.z));
    const width = (maxX - minX) * .65, depth = (maxZ - minZ) * .65;
    const stepGeometry = new THREE.BoxGeometry(width, .7, depth / 7);
    this.resources.push(stepGeometry);
    const material = this.material('#c0ced2');
    for (let i = 0; i < 7; i++) {
      const step = new THREE.Mesh(stepGeometry, material);
      step.position.set((minX + maxX) / 2, .8 + i * .65, (minZ + maxZ) / 2 - depth / 2 + (i + .5) * depth / 7);
      this.architecture.add(step);
    }
  }

  buildLabels() {
    for (const poi of this.pois) {
      const category = facilityCategory(poi);
      const element = document.createElement('button');
      element.type = 'button';
      element.className = `scene-poi-label scene-poi-${category}`;
      element.setAttribute('aria-label', `选择目的地：${poi.name}`);
      element.title = poi.name;
      const facility = isFacilityPoi(poi);
      Object.assign(element.style, {
        position: 'absolute', left: '0', top: '0', border: '0', background: 'transparent',
        padding: facility ? '0' : '3px 4px', color: '#424a4c', font: '500 12px system-ui, -apple-system, "Segoe UI", "IBM Plex Sans SC", sans-serif',
        whiteSpace: 'nowrap', lineHeight: '1.35', textAlign: facility ? 'left' : 'center', cursor: 'pointer',
        pointerEvents: 'auto', textShadow: '0 1px 2px #fff, 0 0 4px #fff', transition: 'none',
        display: 'inline-flex', alignItems: 'center', gap: facility ? `${FACILITY_SCENE_GAP}px` : '4px',
        outline: 'none', boxShadow: 'none',
      });
      let icon = null;
      if (facility) {
        icon = document.createElement('span');
        icon.className = 'scene-facility-mark';
        Object.assign(icon.style, { display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: `${FACILITY_SCENE_BADGE}px`, height: `${FACILITY_SCENE_BADGE}px`, borderRadius: '50%',
          flex: `0 0 ${FACILITY_SCENE_BADGE}px`,
          color: '#fefefe', background: facilityColor(category), textShadow: 'none' });
        icon.append(createFacilityIconSvg(facilityIconKey(poi.category), {
          stroke: '#fff', width: FACILITY_SCENE_ICON, height: FACILITY_SCENE_ICON,
        }));
        element.append(icon);
      }
      const text = document.createElement('span');
      text.textContent = poi.displayName || poi.name;
      element.append(text);
      element.addEventListener('contextmenu', event => event.preventDefault());
      element.addEventListener('pointerdown', event => {
        if (event.button === 0) event.stopPropagation();
      });
      element.addEventListener('click', e => { e.stopPropagation(); this.onSelect(poi.id, e.shiftKey); });
      this.labelLayer.append(element);
      this.labels.push({ element, text, icon, poi, category, point: this.point(poi.displayPosition || poi.labelPosition || poi.position, WALL_HEIGHT + 2), walkPoint: this.point(poi.position, 14), width: 0 });
    }
  }

  buildWallSigns() {
    this.wallSignRecords = [];
    for (const room of this.doc.geometry.obstacles) {
      if (room.kind === 'counter' || room.kind === 'courtyard') continue;
      const candidates = this.wallPieces.filter(w => w.roomId === room.id && w.length >= 3 && w.height >= 15);
      if (!candidates.length) continue;
      const names = this.pois.filter(p => p.roomId === room.id);
      const anchor = names[0] ? this.point(names[0].position) : null;
      candidates.sort((a, b) => anchor
        ? Math.hypot(a.x-anchor.x,a.z-anchor.z)-Math.hypot(b.x-anchor.x,b.z-anchor.z)
        : b.length-a.length);
      const name = [...new Set(names.map(p => p.displayName || p.name))].join(' / ')
        || `${({ elevator: '电梯区域', stairs: '楼梯区域', escalator: '扶梯区域' })[room.kind] || '未命名房间'} ${room.id}`;
      const poi = { id: `wall-room:${room.id}`, name, displayName: name };
      const polygon = room.polygon.map(p => { const v = this.point(p); return [v.x, v.z]; });
      // Actual world-space planes mounted on room walls, not camera-facing overlays.
      const canvas = document.createElement('canvas');
      canvas.width = 1024; canvas.height = 256;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fbfdfb'; ctx.fillRect(0, 0, 1024, 256);
      ctx.fillStyle = '#28573f'; ctx.fillRect(0, 220, 1024, 36);
      ctx.font = '600 68px "IBM Plex Sans SC", system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(poi.displayName || poi.name, 512, 116, 950);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      this.resources.push(texture);
      // A second face improves recognition at corners; route-aware placement below
      // temporarily moves one plaque to the wall facing the selected route.
      const record = { roomId: room.id, candidates, polygon, poi, signs: [] };
      for (const wall of candidates.slice(0, 2)) for (const placement of wallSignPlacements(wall, polygon, false)) {
        const normal = new THREE.Vector3(placement.nx, 0, placement.nz);
        const center = new THREE.Vector3(placement.x, 13, placement.z);
        const width = WALL_SIGN_WIDTH;
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, width / 4),
          new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
        mesh.position.copy(center).addScaledVector(normal, wall.width / 2 + .08);
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
        mesh.userData.poiId = poi.id;
        this.signGroup.add(mesh);
        const sign = { mesh, normal, poi, defaultPlacement: placement, defaultWall: wall };
        record.signs.push(sign);
        this.wallSigns.push(sign);
      }
      this.wallSignRecords.push(record);
    }
    this.repositionWallSigns();
  }

  applyWallSignPlacement(sign, wall, polygon) {
    const placement = wallSignPlacements(wall, polygon, false)[0];
    if (!placement) return;
    sign.normal.set(placement.nx, 0, placement.nz);
    sign.mesh.position.set(placement.x, 13, placement.z).addScaledVector(sign.normal, wall.width / 2 + .08);
    sign.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), sign.normal);
  }

  repositionWallSigns() {
    for (const record of this.wallSignRecords || []) {
      const routePoints = this.routePoints || [];
      let routeWall = null;
      if (routePoints.length > 1) {
        let closest = Infinity;
        for (const wall of record.candidates) for (const point of routePoints) {
          const distance = Math.hypot(wall.x - point.x, wall.z - point.z);
          if (distance < closest) { closest = distance; routeWall = wall; }
        }
        if (closest > 70) routeWall = null;
      }
      if (routeWall && record.signs[0]) this.applyWallSignPlacement(record.signs[0], routeWall, record.polygon);
      else if (record.signs[0]) this.applyWallSignPlacement(record.signs[0], record.signs[0].defaultWall, record.polygon);
      if (record.signs[1]) this.applyWallSignPlacement(record.signs[1], record.signs[1].defaultWall, record.polygon);
    }
  }

  setRoute(polyline = [], startPoi = null, endPoi = null, viaPois = []) {
    if (this.walking) this.stopWalk();
    this.routeGroup.traverse(object => {
      object.geometry?.dispose();
      if (object.material) (Array.isArray(object.material) ? object.material : [object.material]).forEach(m => m.dispose());
    });
    this.routeGroup.clear();
    this.routeArrowMesh = null;
    this.routeArrowFlat = [];
    this._travelKey = '';
    this._travelSplitActive = false;
    this.endpointLabels?.forEach(label => label.element.remove());
    this.endpointLabels = [];
    this.startPoi = startPoi;
    this.endPoi = endPoi;
    this.viaPois = Array.isArray(viaPois) ? viaPois.filter(Boolean).slice(0, 6) : [];
    this.routePolylineNorm = Array.isArray(polyline) ? polyline.map(p => [...p]) : [];
    this.routePoints = polyline.map(p => this.point(p, .8)).filter((p, i, list) => i === 0 || p.distanceToSquared(list[i - 1]) > .00001);
    this.repositionWallSigns();
    this.routeLengths = [0];
    this.routeLength = 0;
    for (let i = 1; i < this.routePoints.length; i++) {
      this.routeLength += this.routePoints[i].distanceTo(this.routePoints[i - 1]);
      this.routeLengths.push(this.routeLength);
    }
    if (this.routePoints.length < 2) return;
    this.addRouteStroke(2.4, '#ffffff', .5);
    this.addRouteStroke(1.5, this.appearance?.accent || '#306048', .85);
    this.addRouteArrows();
    const markers = [
      [startPoi, this.routePoints[0], '起', '#379e7b'],
      ...this.viaPois.map((poi, index) => {
        const target = this.point(poi.position, .8);
        let best = this.routePoints[0], bestDist = Infinity;
        for (const point of this.routePoints) {
          const d = point.distanceToSquared(target);
          if (d < bestDist) { bestDist = d; best = point; }
        }
        return [poi, best, `经${index + 1}`, '#4d7eb8'];
      }),
      [endPoi, this.routePoints[this.routePoints.length - 1], '终', '#ec8b4d'],
    ];
    for (const [poi, position, title, color] of markers) {
      if (!position) continue;
      const marker = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, .7, 32), new THREE.MeshBasicMaterial({ color }));
      marker.position.copy(position).setY(1.4);
      this.routeGroup.add(marker);
      const label = document.createElement('div');
      label.className = 'scene-route-marker';
      label.textContent = `${title} · ${poi?.displayName || poi?.name || ''}`;
      Object.assign(label.style, { position: 'absolute', top: '0', left: '0', color: '#fff', background: color,
        padding: '5px 9px', border: '2px solid #fff', borderRadius: '4px', fontSize: '12px', fontWeight: '600',
        whiteSpace: 'nowrap', boxShadow: '0 2px 8px #59645b24', pointerEvents: 'none' });
      this.labelLayer.append(label);
      this.endpointLabels.push({ element: label, point: position.clone().setY(10) });
    }
  }

  addRouteArrows() {
    this.routeArrowFlat = this.routePoints.map(p => [p.x, p.z]);
    const arrows = routeArrows(this.routeArrowFlat, ROUTE_ARROW_SPACING, this.routeArrowPhase);
    if (!arrows.length) { this.routeArrowMesh = null; return; }
    const shape = new THREE.Shape();
    shape.moveTo(1.8, 0); shape.lineTo(-1.4, 1.15); shape.lineTo(-.6, 0);
    shape.lineTo(-1.4, -1.15); shape.closePath();
    const geometry = new THREE.ShapeGeometry(shape);
    geometry.rotateX(-Math.PI / 2);
    // Over-allocate so flowing phase can expose one extra chevron without rebuilding.
    const capacity = Math.max(arrows.length + 2, 4);
    const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial({ color: '#ffffff', side: THREE.DoubleSide, toneMapped: false }), capacity);
    mesh.count = arrows.length;
    mesh.name = 'route-direction-arrows';
    this.routeArrowMesh = mesh;
    this.routeGroup.add(mesh);
    this.applyRouteArrowPhase(this.routeArrowPhase);
  }

  setRouteArrowPhase(phase = 0) {
    this.routeArrowPhase = ((Number(phase) || 0) % ROUTE_ARROW_SPACING + ROUTE_ARROW_SPACING) % ROUTE_ARROW_SPACING;
    this.applyRouteArrowPhase(this.routeArrowPhase);
  }

  applyRouteArrowPhase(phase = 0) {
    const mesh = this.routeArrowMesh;
    if (!mesh || this.routeArrowFlat.length < 2) return;
    const arrows = routeArrows(this.routeArrowFlat, ROUTE_ARROW_SPACING, phase);
    if (!arrows.length) { mesh.count = 0; mesh.instanceMatrix.needsUpdate = true; return; }
    if (arrows.length > mesh.instanceMatrix.count) {
      // Rebuild if capacity is somehow too small.
      mesh.removeFromParent();
      mesh.geometry?.dispose();
      mesh.material?.dispose();
      this.routeArrowMesh = null;
      this.addRouteArrows();
      return;
    }
    const dummy = new THREE.Object3D();
    arrows.forEach((arrow, i) => {
      dummy.position.set(arrow.x, 1.02, arrow.y);
      dummy.rotation.set(0, -arrow.angle, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.count = arrows.length;
    mesh.instanceMatrix.needsUpdate = true;
  }

  ensureNavMarker() {
    if (this.navMarker) return this.navMarker;
    const group = new THREE.Group();
    group.name = 'nav-marker';
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(5.5, 5.5, 0.7, 32),
      new THREE.MeshBasicMaterial({ color: '#2f7d5b', toneMapped: false }),
    );
    disc.position.y = 2.2;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(6.2, 8.2, 48),
      new THREE.MeshBasicMaterial({ color: '#ffffff', side: THREE.DoubleSide, toneMapped: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 2.45;
    const pulse = new THREE.Mesh(
      new THREE.RingGeometry(8.4, 9.6, 48),
      new THREE.MeshBasicMaterial({ color: '#379e7b', transparent: true, opacity: 0.55, side: THREE.DoubleSide, toneMapped: false }),
    );
    pulse.rotation.x = -Math.PI / 2;
    pulse.position.y = 2.5;
    // Forward arrow (local +X); yaw set in setNavMarker to match route heading.
    const arrowShape = new THREE.Shape();
    arrowShape.moveTo(4.8, 0);
    arrowShape.lineTo(-2.4, 2.8);
    arrowShape.lineTo(-0.8, 0);
    arrowShape.lineTo(-2.4, -2.8);
    arrowShape.closePath();
    const arrow = new THREE.Mesh(
      new THREE.ShapeGeometry(arrowShape),
      new THREE.MeshBasicMaterial({ color: '#ffffff', side: THREE.DoubleSide, toneMapped: false }),
    );
    arrow.rotation.x = -Math.PI / 2;
    arrow.position.y = 2.65;
    group.add(disc, ring, pulse, arrow);
    group.visible = false;
    this.navMarkerGroup.add(group);
    this.navMarker = group;
    this.navMarkerPulse = pulse;
    this.navMarkerArrow = arrow;
    return group;
  }

  setNavMarker(normalizedPoint, visible = true, heading = null) {
    const marker = this.ensureNavMarker();
    if (!normalizedPoint || !visible) {
      marker.visible = false;
      return;
    }
    const point = this.point(normalizedPoint, 0.8);
    marker.position.copy(point);
    if (Number.isFinite(heading)) {
      // Match route arrow convention: map atan2(dy, dx) → world yaw.
      marker.rotation.y = -heading;
    }
    marker.visible = true;
  }

  /** Screen-space position of the nav marker for HTML ETA bubble. */
  projectNavMarker() {
    if (!this.navMarker?.visible) return { x: 0, y: 0, visible: false };
    return this.project(this.navMarker.position.clone().setY(this.navMarker.position.y + 4));
  }

  clearNavMarker() {
    if (this.navMarker) this.navMarker.visible = false;
  }

  addRouteStroke(radius, color, height) {
    const material = new THREE.MeshBasicMaterial({ color });
    material.userData.routeAccent = height === .85 && color !== '#8b9490';
    // Every segment is straight: no Catmull-Rom smoothing that could cut a corridor corner.
    // Flat ribbons keep the colored stroke above its white halo. Nested round
    // cylinders would hide the green stroke entirely inside the larger white one.
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const segments = new THREE.InstancedMesh(geometry, material, Math.max(1, this.routePoints.length - 1));
    segments.userData.routeStroke = true;
    const dummy = new THREE.Object3D();
    for (let i = 1; i < this.routePoints.length; i++) {
      const a = this.routePoints[i - 1], b = this.routePoints[i];
      const direction = b.clone().sub(a);
      dummy.position.copy(a).add(b).multiplyScalar(.5).setY(height);
      dummy.rotation.set(0, Math.atan2(-direction.z, direction.x), 0);
      dummy.scale.set(direction.length(), .12, radius * 2);
      dummy.updateMatrix();
      segments.setMatrixAt(i - 1, dummy.matrix);
    }
    segments.count = Math.max(0, this.routePoints.length - 1);
    this.routeGroup.add(segments);
    const joints = new THREE.InstancedMesh(new THREE.SphereGeometry(radius, 8, 6), material, Math.max(1, this.routePoints.length));
    joints.userData.routeStroke = true;
    this.routePoints.forEach((p, i) => {
      dummy.position.copy(p).setY(height);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, .025, 1);
      dummy.updateMatrix();
      joints.setMatrixAt(i, dummy.matrix);
    });
    joints.count = this.routePoints.length;
    this.routeGroup.add(joints);
  }

  clearRouteStrokeMeshes() {
    const remove = [];
    for (const child of this.routeGroup.children) {
      if (child.userData?.routeStroke || child.name === 'route-direction-arrows') remove.push(child);
    }
    for (const child of remove) {
      child.geometry?.dispose();
      if (child.material) {
        (Array.isArray(child.material) ? child.material : [child.material]).forEach(m => m.dispose());
      }
      this.routeGroup.remove(child);
    }
    this.routeArrowMesh = null;
    this.routeArrowFlat = [];
  }

  /**
   * While simulating: gray traveled + accent remaining. When simulating ends, restore full accent stroke.
   * `traveledNorm` / `remainingNorm` are normalized map polylines for the active floor.
   */
  setRouteTravel(traveledNorm = [], remainingNorm = [], simulating = false) {
    if (!simulating) {
      if (!this._travelSplitActive) return;
      this._travelSplitActive = false;
      this._travelKey = '';
      this.clearRouteStrokeMeshes();
      if (this.routePoints.length >= 2) {
        this.addRouteStroke(2.4, '#ffffff', .5);
        this.addRouteStroke(1.5, this.appearance?.accent || '#306048', .85);
        this.addRouteArrows();
      }
      return;
    }
    const tLast = traveledNorm?.at(-1);
    const rFirst = remainingNorm?.[0];
    const key = `${traveledNorm?.length || 0}:${remainingNorm?.length || 0}:${tLast?.[0]?.toFixed?.(4)}:${tLast?.[1]?.toFixed?.(4)}:${rFirst?.[0]?.toFixed?.(4)}:${rFirst?.[1]?.toFixed?.(4)}`;
    if (key === this._travelKey) return;
    this._travelKey = key;
    this._travelSplitActive = true;
    const fullPoints = this.routePoints;
    this.clearRouteStrokeMeshes();
    const paint = (norm, gray) => {
      if (!Array.isArray(norm) || norm.length < 2) return;
      this.routePoints = norm.map(p => this.point(p, .8)).filter((p, i, list) => i === 0 || p.distanceToSquared(list[i - 1]) > .00001);
      if (this.routePoints.length < 2) return;
      if (gray) {
        this.addRouteStroke(2.4, '#d5d9d6', .5);
        this.addRouteStroke(1.5, '#8b9490', .85);
      } else {
        this.addRouteStroke(2.4, '#ffffff', .5);
        this.addRouteStroke(1.5, this.appearance?.accent || '#306048', .85);
        this.addRouteArrows();
      }
    };
    paint(traveledNorm, true);
    paint(remainingNorm, false);
    this.routePoints = fullPoints;
  }

  setFilter(category = 'all', term = '', showPois = true, selectedId = null) {
    this.category = category;
    this.term = term.trim().toLowerCase();
    this.showPois = showPois;
    this.selectedId = selectedId || null;
    this.labels.forEach(label => { label.width = 0; });
  }

  resize() {
    const width = this.container.clientWidth, height = this.container.clientHeight;
    if (!width || !height) return;
    const previousAspect = this.width / this.height;
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height, false);
    this.walkCamera.aspect = width / height;
    this.walkCamera.updateProjectionMatrix();
    if (this.baseHeight) {
      this.updateFrustum();
      if (Math.abs(previousAspect - width / height) > .15 && !this.walking) this.fit();
    }
  }

  updateFrustum() {
    const halfHeight = this.baseHeight / 2;
    const aspect = (this.width || 800) / (this.height || 600);
    this.camera.left = -halfHeight * aspect;
    this.camera.right = halfHeight * aspect;
    this.camera.top = halfHeight;
    this.camera.bottom = -halfHeight;
    this.camera.updateProjectionMatrix();
  }

  fit() {
    if (this.walking) this.stopWalk();
    this.camera.position.set(65, 1050, 670);
    this.controls.target.set(0, 0, 0);
    this.camera.zoom = 1;
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld(true);
    const projected = this.doc.geometry.buildingBoundary.map(p => this.point(p, WALL_HEIGHT).applyMatrix4(this.camera.matrixWorldInverse));
    const width = Math.max(...projected.map(p => p.x)) - Math.min(...projected.map(p => p.x));
    const height = Math.max(...projected.map(p => p.y)) - Math.min(...projected.map(p => p.y));
    const aspect = (this.width || 800) / (this.height || 600);
    this.baseHeight = Math.max(height * 1.16, width / aspect * 1.2);
    this.updateFrustum();
    this.controls.update();
  }

  zoom(factor) {
    if (this.walking) return;
    this.camera.zoom = THREE.MathUtils.clamp(this.camera.zoom / factor, this.controls.minZoom, this.controls.maxZoom);
    this.camera.updateProjectionMatrix();
  }

  startWalk() {
    if (this.routePoints.length < 2 || this.routeLength <= 0) return false;
    this.walking = true;
    this.walkLook.reset();
    this.renderer.domElement.style.cursor='grab';
    this.paused = false;
    this.walkDistance = 0;
    this.activeCamera = this.walkCamera;
    this.controls.enabled = false;
    this.positionWalkCamera();
    this.onProgress(0);
    return true;
  }

  setWalkSpeed(factor) {
    if (Number.isFinite(factor)) this.walkSpeedFactor = THREE.MathUtils.clamp(factor, .25, 3);
  }

  setAppearance(value) {
    const settings = this.appearance = sanitizeAppearance(value);
    if (this.renderer) this.renderer.toneMappingExposure = settings.exposure;
    if (this.ambientLight) this.ambientLight.intensity = settings.ambient;
    if (this.sunLight) this.sunLight.intensity = settings.sun;
    if (this.wallMesh?.material) {
      this.wallMesh.material.color.set(settings.wall);
      this.wallMesh.material.roughness = settings.roughness;
    }
    if (this.corridorFloor?.material) this.corridorFloor.material.color.set(settings.floor);
    if (this.surfaceUniforms) {
      this.surfaceUniforms.hospitalGrain.value = settings.grain;
      // CAD maps: keep tile size huge so leftover grout paths stay invisible.
      this.surfaceUniforms.hospitalTileSize.value = this.isCadSource() ? 1e6 : settings.tileSize;
      this.surfaceUniforms.hospitalSkirt.value = settings.skirtHeight;
    }
    this.routeGroup?.traverse(object => { if(object.material?.userData.routeAccent)object.material.color.set(settings.accent); });
  }

  seekWalk(progress) {
    if (!this.walking || !Number.isFinite(progress)) return;
    const fraction = THREE.MathUtils.clamp(progress, 0, 1);
    this.walkDistance = this.routeLength * fraction;
    if (fraction === 1) this.paused = true;
    this.positionWalkCamera();
    this.onProgress(fraction);
  }

  pauseWalk() {
    if (!this.walking) return false;
    this.paused = !this.paused;
    return this.paused;
  }

  stopWalk() {
    this.lookBlur?.();
    this.walkLook?.reset();
    this.renderer.domElement.style.cursor='';
    this.walking = false;
    this.paused = false;
    this.activeCamera = this.camera;
    this.controls.enabled = true;
  }

  pointAlong(distance) {
    const d = Math.max(0, Math.min(this.routeLength, distance));
    let low = 1, high = this.routeLengths.length - 1;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.routeLengths[mid] < d) low = mid + 1;
      else high = mid;
    }
    const from = Math.max(0, low - 1), to = low;
    const length = this.routeLengths[to] - this.routeLengths[from];
    return this.routePoints[from].clone().lerp(this.routePoints[to], length ? (d - this.routeLengths[from]) / length : 0);
  }

  positionWalkCamera() {
    const position = this.pointAlong(this.walkDistance);
    const look = this.pointAlong(Math.min(this.routeLength, this.walkDistance + 12));
    if (position.distanceToSquared(look) < .01) {
      const previous = this.pointAlong(Math.max(0, this.walkDistance - 4));
      look.copy(position).add(position.clone().sub(previous));
    }
    this.walkCamera.position.copy(position).setY(EYE_HEIGHT);
    this.walkCamera.lookAt(look.x, EYE_HEIGHT - 1, look.z);
    this.walkCamera.rotateOnWorldAxis(UP, this.walkLook?.yaw || 0);
    this.walkCamera.rotateX(this.walkLook?.pitch || 0);
    this.walkCamera.updateMatrixWorld();
  }

  setVisible(visible) {
    this.visible = visible;
    this.container.classList.toggle('hidden', !visible);
    this.container.setAttribute('aria-hidden', String(!visible));
    if (!visible && this.walking) this.stopWalk();
    if (visible) this.resize();
  }

  project(point) {
    const p = point.clone().project(this.activeCamera);
    return { x: (p.x + 1) * this.width / 2, y: (1 - p.y) * this.height / 2,
      visible: p.z > -1 && p.z < 1 && p.x > -1.08 && p.x < 1.08 && p.y > -1.08 && p.y < 1.08 };
  }

  labelZoom() {
    if (this.walking) return 1;
    return overlayLabelScale(this.camera.zoom);
  }

  layoutLabels() {
    this.walkContext.hidden = !this.walking;
    this.signGroup.visible = this.walking;
    if (this.walking) { this.layoutWalkLabels(); return; }
    const occupied = [];
    const zoom = this.labelZoom();
    for (const label of this.endpointLabels || []) {
      const p = this.project(label.point);
      label.element.hidden = !p.visible || this.walking;
      if (!label.element.hidden) {
        label.element.style.transform = `translate(${p.x}px,${p.y - 12 * zoom}px) translate(-50%,-100%) scale(${zoom})`;
        occupied.push({ x: p.x - (label.element.offsetWidth * zoom) / 2, y: p.y - 43 * zoom, w: label.element.offsetWidth * zoom, h: 33 * zoom });
      }
    }
    const sorted = [...this.labels].sort((a, b) => {
      const score = l => (l.poi.id === this.endPoi?.id ? 100 : 0) + (l.poi.category === 'department' ? 20 : 0) + (l.category === 'entrance' ? 10 : 0);
      return score(b) - score(a);
    });
    for (const label of sorted) {
      label.element.classList.remove('is-walk-label');
      label.element.disabled = false;
      const selected = label.poi.id === this.startPoi?.id || label.poi.id === this.endPoi?.id || label.poi.id === this.selectedId;
      const matches = (this.category === 'all' || label.category === this.category)
        && (!this.term || label.poi.name.toLowerCase().includes(this.term));
      const p = this.project(label.point);
      const expanded = this.category !== 'all' || this.term || selected;
      const transit = ['entrance','restroom','elevator','escalator','stairs'].includes(label.category);
      if (label.icon) label.icon.hidden = false;
      label.text.hidden = !expanded && transit && label.category !== 'entrance';
      let visible = this.showPois && p.visible && (matches || selected) && !this.walking
        && (expanded || label.poi.major || transit || label.poi.category === 'pharmacy');
      if (visible) {
        const textLength = [...(label.poi.displayName || label.poi.name)].length;
        const badge = FACILITY_SCENE_BADGE;
        const width = (label.icon
          ? (label.text.hidden ? badge : label.width || Math.min(230, textLength * 12 + badge + FACILITY_SCENE_GAP))
          : (label.text.hidden ? 28 : label.width || Math.min(230, textLength * 12 + 14 + (transit ? 24 : 0)))) * zoom;
        const box = label.icon
          ? { x: p.x - (badge / 2) * zoom, y: p.y - (badge / 2) * zoom, w: width, h: badge * zoom }
          : { x: p.x - width / 2, y: p.y - 13 * zoom, w: width, h: 26 * zoom };
        visible = !occupied.some(b => box.x < b.x + b.w + 3 && box.x + box.w + 3 > b.x && box.y < b.y + b.h + 2 && box.y + box.h + 2 > b.y);
        if (visible) {
          occupied.push(box);
          if (label.icon) {
            const ox = badge / 2;
            const oy = (label.element.offsetHeight || badge) / 2;
            label.element.style.transformOrigin = '0 0';
            label.element.style.transform = `translate(${p.x - ox * zoom}px,${p.y - oy * zoom}px) scale(${zoom})`;
          } else {
            label.element.style.transformOrigin = '50% 50%';
            label.element.style.transform = `translate(${p.x}px,${p.y}px) translate(-50%,-50%) scale(${zoom})`;
          }
        }
      }
      label.element.hidden = !visible;
      if (visible && !label.width) label.width = label.element.offsetWidth;
    }
  }

  layoutWalkLabels() {
    for (const label of this.endpointLabels || []) label.element.hidden = true;
    for (const label of this.labels) label.element.hidden = true;
    const origin = this.walkCamera.position;
    const forward = this.walkCamera.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
    const right = forward.clone().cross(UP).normalize();
    const sides = { left: [], right: [], front: [] };
    for (const sign of this.wallSigns) {
      const delta = sign.mesh.position.clone().sub(origin);
      const distance = delta.length();
      if (distance > 100 || delta.dot(forward) < -8 || delta.dot(sign.normal) >= 0) continue;
      this.labelRay.set(origin, delta.clone().normalize());
      this.labelRay.far = Math.max(0, distance - .2);
      if (this.labelRay.intersectObject(this.wallMesh, false).length) continue;
      const lateral = delta.dot(right);
      const side = Math.abs(lateral) < Math.max(3, delta.dot(forward) * .22) ? 'front' : lateral < 0 ? 'left' : 'right';
      sides[side].push({ distance, name: sign.poi.displayName || sign.poi.name });
    }
    const name = side => sides[side].sort((a, b) => a.distance - b.distance)[0]?.name || '暂无已确认地点';
    const context = `左侧：${name('left')} ｜ 前方：${name('front')} ｜ 右侧：${name('right')}`;
    if (this.walkContext.textContent !== context) this.walkContext.textContent = context;
  }

  renderFrame(time) {
    if (this.disposed) return;
    this.frameId = requestAnimationFrame(this.renderFrame);
    const delta = Math.min((time - this.previousTime) / 1000 || 0, .05);
    this.previousTime = time;
    if (!this.visible || !this.width || !this.height) return;
    if (this.walking) {
      this.walkLook.update(delta);
      if (!this.paused) {
        this.walkDistance = Math.min(this.routeLength, this.walkDistance + delta * WALK_SPEED * this.walkSpeedFactor);
        this.onProgress(this.walkDistance / this.routeLength);
        if (this.walkDistance >= this.routeLength) { this.stopWalk(); this.onComplete(); }
      }
      if(this.walking)this.positionWalkCamera();
    } else this.controls.update();
    if (this.navMarker?.visible && this.navMarkerPulse) {
      const s = 1 + 0.12 * Math.sin((time || 0) * 0.006);
      this.navMarkerPulse.scale.set(s, s, s);
    }
    this.renderer.render(this.scene, this.activeCamera);
    this.layoutLabels();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.container.removeEventListener('contextmenu', this.blockContextMenu);
    const canvas=this.renderer.domElement;
    canvas.removeEventListener('pointerdown',this.lookDown);
    canvas.removeEventListener('pointermove',this.lookMove);
    for(const event of ['pointerup','pointercancel','lostpointercapture'])canvas.removeEventListener(event,this.lookEnd);
    window.removeEventListener('blur',this.lookBlur);
    const seen = new Set();
    this.scene.traverse(object => {
      for (const resource of [object.geometry, ...(Array.isArray(object.material) ? object.material : [object.material])]) {
        if (resource && !seen.has(resource)) { resource.dispose(); seen.add(resource); }
      }
    });
    this.renderer.dispose();
    for (const resource of this.resources) if (resource.isTexture) resource.dispose();
    this.renderer.domElement.remove();
    this.labelLayer.remove();
    this.walkContext.remove();
  }
}

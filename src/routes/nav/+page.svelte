<script lang="ts">
  import PlacePicker from '$lib/components/nav/PlacePicker.svelte';
  import { centerRoute } from '$lib/components/viewer3d/nav/layout';
  import { indexPlaces, withToiletDisplay, toiletDisplay } from '$lib/utils/placeSearch';
  import { setNavNorth } from '$lib/utils/navCopy';
  import { onMount, untrack } from 'svelte';
  import { replaceState as kitReplaceState } from '$app/navigation';
  import { page } from '$app/state';
  import { get } from 'svelte/store';
  import { currentProject, loadProject, viewMode, setActiveFloor } from '$lib/stores/project';
  import { readProject } from '$lib/utils/projectValidation';
  import { markClean } from '$lib/stores/saveStatus';
  import { drawMapRoomLabel, resolveRoomLabelStyle, type RoomLabelStyle } from '$lib/utils/roomMapLabel';
  import { effectivePixelRatio } from '$lib/utils/pixelRatio';
  import { projectHomeUrl, resolveProjectLibraryUrl } from '$lib/utils/projectLibraryUrl';
  import { disambiguate, floorOption, floorSpoken, pinText, transferPlace, transferText } from '$lib/utils/navCopy';
  import { importOrigin, originOf, projectImportOrigin } from '$lib/utils/importOrigin';
  import type { Room } from '$lib/models/types';

  let ThreeViewer: any = $state(null);
  let viewer: any = $state(null);
  let ready = $state(false);
  let loadError = $state<string | null>(null);
  let mode = $state<'2d' | '3d'>('3d');
  let status = $state('正在打开');
  // First open can take a few seconds: show a spinner, a filling bar and elapsed seconds.
  let loadSecs = $state(0);
  $effect(() => {
    if (view) return;
    loadSecs = 0;
    const t = setInterval(() => { loadSecs += 1; }, 1000);
    return () => clearInterval(t);
  });
  let routeMessage = $state('选择起点和终点');
  let noLiftFallback = $state('');
  let routeFailed = $state(false);
  let busy = $state(false);
  let simulating = $state(false);
  let walking = $state(false);
  let playbackPlaying = $state(false);
  let category = $state('all');
  let startId = $state('');
  let endId = $state('');
  let waypoints = $state<string[]>([]);
  let routePolyline = $state<{ x: number; y: number }[]>([]);
  let routeDoorIds = $state<string[]>([]);
  let routeLegs = $state<RouteLeg[]>([]);
  let routeTransfers = $state<RouteTransfer[]>([]);
  let activeLegIndex = $state(0);
  let lengthCm = $state(0);
  let walkSpeed = $state(1);
  let walkSeek = $state(0);
  // Narrow screens: the route panel starts collapsed to a one-line instruction (QA 390px).
  let panelOpen = $state(false);
  let tapStart: { x: number; y: number; t: number } | null = null;

  function onViewerPointerDown(e: PointerEvent) { tapStart = { x: e.clientX, y: e.clientY, t: performance.now() }; }
  let tapHint = $state('');
  let tapHintTimer: ReturnType<typeof setTimeout> | null = null;
  function hint(text: string) {
    tapHint = text;
    if (tapHintTimer) clearTimeout(tapHintTimer);
    tapHintTimer = setTimeout(() => (tapHint = ''), 1600);
  }
  /**
   * Tap-to-walk in first person (QA acceptance): a tap (≤ 8 px, ≤ 250 ms — drag-to-look is never
   * a tap) on the floor walks there along the walkable mesh; on a wall it doesn't move and hints;
   * tapping again while walking (or while the route plays) stops.
   */
  async function onViewerPointerUp(e: PointerEvent) {
    const s0 = tapStart; tapStart = null;
    if (!s0 || !walking || (e.target as HTMLElement)?.closest?.('button, a, select, input, label')) return;
    if (Math.hypot(e.clientX - s0.x, e.clientY - s0.y) > 8 || performance.now() - s0.t > 250) return;
    if (viewer?.isTapWalking?.()) { viewer.stopTapWalk(); say('已停下'); return; }
    if (playbackPlaying) { viewer?.pauseRouteSimulation?.(); playbackPlaying = false; say('已暂停'); return; }
    const target = viewer?.pickWalkTarget?.(e.clientX, e.clientY);
    if (!target || 'wall' in target) { hint('点地面可走过去'); return; }
    const from = viewer?.getWalkPosition?.();
    if (!from || !view) return;
    try {
      const response = await fetch(`${apiOrigin}/api/projects/${projectId}/route`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ floor: view.floorId, from: { ...from, floor: view.floorId }, to: { ...target.floor, floor: view.floorId }, via: [] }),
      });
      const result = await response.json();
      const pts = result?.ok ? (result.legs?.[0]?.polyline || result.polyline) : null;
      if (!pts || pts.length < 2) { hint('那里走不过去'); return; }
      say('正在走过去 · 再点一下停下');
      viewer?.walkPath?.(pts, Number(walkSpeed) || 1, () => say('已到达'));
    } catch {
      hint('那里走不过去');
    }
  }
  let pendingModeAction = $state<'simulate' | 'walk' | null>(null);
  let pendingLegAdvance = $state(false);
  let restoredViewer: any = null;
  let planCanvas: HTMLCanvasElement | undefined = $state();
  let transferTimer: ReturnType<typeof setTimeout> | null = null;
  let transferNotice = $state('');
  let arrivedText = $state('');
  function endLabel() { const e = placeByKey(endId); return e ? (displayNames.get(placeKey(e)) || e.name || '') : ''; }
  /** Final arrival in first person: frame the destination door and keep FP until the user exits. */
  function arrive(firstPerson: boolean) {
    // Always announce arrival (overview simulation and first person alike).
    arrivedText = `已到达：${endLabel()}`;
    say(arrivedText);
    if (firstPerson || viewer?.isNavWalking?.()) viewer?.faceNavArrival?.();
  }
  let legAdvanceToken = 0;
  let accessible = $state(false);

  type Place = {
    id: string;
    name: string;
    x: number;
    y: number;
    color?: string;
    category?: string;
    floorId?: string;
    floorName?: string;
    originalName?: string;
    aliases?: string[];
    restricted?: boolean;
  };
  type RouteLeg = {
    floorId: string;
    floorName?: string;
    lengthCm?: number;
    polyline: { x: number; y: number }[];
    usedDoorIds?: string[];
  };
  type RouteTransfer = {
    afterLeg: number;
    kind?: string;
    kindLabel?: string;
    name?: string;
    fromFloorId?: string;
    toFloorId?: string;
    fromFloorName?: string;
    toFloorName?: string;
    direction?: 'up' | 'down';
    from?: { x: number; y: number };
    to?: { x: number; y: number };
  };
  type NavRoom = {
    id: string;
    name?: string;
    fillColor?: string;
    polygon: { x: number; y: number }[];
  };
  type NavView = {
    floorId: string;
    floorName?: string;
    floors?: { id: string; name: string }[];
    destinations?: Place[];
    places?: Place[];
    walls?: { start: { x: number; y: number }; end: { x: number; y: number }; thickness?: number }[];
    rooms?: NavRoom[];
    openings?: any[];
    bounds?: { minX: number; minY: number; maxX: number; maxY: number };
    empty?: boolean;
    verticalLinks?: { name?: string; stops: { floorId: string; x: number; y: number }[] }[];
  };

  let view = $state<NavView | null>(null);
  let projectId = $state('');
  let apiOrigin = $state('http://127.0.0.1:8881');
  /** Back target: openPlan project library (`/`), never the import API `/files` page. */
  let libraryUrl = $state('/');

  const MAX_VIA = 6;

  $effect(() => {
    if (mode === '3d' && !ThreeViewer) {
      import('$lib/components/viewer3d/ThreeViewer.svelte').then((m) => {
        ThreeViewer = m.default;
      });
    }
    viewMode.set(mode);
  });

  $effect(() => {
    if (mode === '2d') drawPlan();
  });

  // The 3D viewer is loaded lazily; start only after its scene has mounted.
  $effect(() => {
    if (mode !== '3d' || !viewer || !pendingModeAction) return;
    const action = pendingModeAction;
    // The scene may still be (re)building the floor when this fires (P3: FP sometimes did nothing,
    // the route set on the old scene was wiped by the rebuild). Retry each frame until the viewer
    // reports it really started, for up to ~4 s.
    let tries = 0;
    const attempt = () => {
      if (pendingModeAction !== action || !viewer || mode !== '3d') return;
      restoredViewer = viewer; // a fresh start: never seek back to an older playback position
      viewer.setNavRoute?.(routePolyline, routeDoorIds);
      if (action === 'simulate') viewer.startRouteSimulation?.(walkSpeed);
      else viewer.enterWalkAlongRoute?.(Number(walkSpeed) || 1);
      const started = action === 'simulate' ? viewer.isSimulating?.() !== false : viewer.isNavWalking?.() !== false;
      if (started || ++tries > 240) pendingModeAction = null;
      else requestAnimationFrame(attempt);
    };
    requestAnimationFrame(attempt);
  });

  $effect(() => {
    if (mode !== '3d' || !viewer || pendingModeAction || viewer === restoredViewer) return;
    restoredViewer = viewer;
    const seek = untrack(() => Number(walkSeek) || 0);
    if (seek > 0) requestAnimationFrame(() => {
      if (viewer === restoredViewer && !viewer.isSimulating?.()) viewer.setSimulationProgress?.(seek / 100);
    });
  });

  // Keep the current floor's button visible in the scrolling floor bar (P2 5F looked unselected).
  $effect(() => {
    const id = view?.floorId;
    if (!id) return;
    requestAnimationFrame(() => document.querySelector('.floor-btn.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  });

  // 3D signs over every stair/lift landing, same patient name as banner/steps (「楼梯 A」).
  $effect(() => {
    const links = view?.verticalLinks || [];
    if (!viewer) return;
    const list = links.flatMap((l) => l.name ? l.stops.map((st) => ({ floorId: st.floorId, x: st.x, y: st.y, name: l.name! })) : []);
    untrack(() => viewer?.setNavLinkSigns?.(list));
  });

  // The 3D viewer mounts lazily; rebuild the floor stack once it exists.
  $effect(() => {
    if (mode !== '3d' || !viewer) return;
    untrack(() => requestAnimationFrame(() => syncFloorStack()));
  });

  // One monotonic progress for the whole multi-floor trip (QA r7: 85→100 then back to ~40%).
  const legLens = $derived(routeLegs.map((l) => l.lengthCm || (l.polyline || []).reduce((a, p, i, arr) => i ? a + Math.hypot(p.x - arr[i - 1].x, p.y - arr[i - 1].y) : 0, 0)));
  const tripSpan = (i: number) => {
    const total = legLens.reduce((a, b) => a + b, 0) || 1;
    const before = legLens.slice(0, i).reduce((a, b) => a + b, 0);
    return { from: (before / total) * 100, width: ((legLens[i] || 0) / total) * 100 };
  };
  const tripSeek = $derived.by(() => {
    if (!routeLegs.length) return Number(walkSeek) || 0;
    const { from, width } = tripSpan(activeLegIndex);
    return Math.round((from + width * (Number(walkSeek) || 0) / 100) * 10) / 10;
  });

  function handleRouteProgress(ratio: number, playing: boolean) {
    walkSeek = Math.round(ratio * 1000) / 10;
    playbackPlaying = playing;
    if (playing && ratio < 1 && arrivedText) arrivedText = '';
    if (!(ratio >= 1 && !playing) || pendingLegAdvance) return;
    if (!(simulating || walking) || activeLegIndex + 1 >= routeLegs.length) {
      arrive(walking);
      return;
    }
    const transfer = routeTransfers.find((item) => item.afterLeg === activeLegIndex);
    const next = routeLegs[activeLegIndex + 1];
    const tip = transfer
      ? transferText(withDisplay({ ...transfer, toFloorName: transfer.toFloorName || next?.floorName }), view?.bounds)
      : `换到 ${floorSpoken(next?.floorName) || '下一层'}`;
    say(tip);
    transferNotice = tip;
    if (walking && transfer?.from) {
      // QA r7: at the transfer, look at the stair/lift itself (nearest 楼梯/电梯 place on this floor).
      const stairs = transfer.kind === 'stairs' || /楼梯/.test(transfer.kindLabel || '');
      let best: Place | null = null, bestD = 500;
      for (const p of allPlaces()) {
        if (p.floorId !== routeLegs[activeLegIndex]?.floorId || !(stairs ? /楼梯/ : /电梯/).test(p.name || '')) continue;
        const d = Math.hypot(p.x - transfer.from.x, p.y - transfer.from.y);
        if (d < bestD) { bestD = d; best = p; }
      }
      // No named stair room (e.g. P3 楼梯 A): the landing is where the route meets the shaft,
      // so look on along the final approach direction, into the stairs.
      const pts = routePolyline;
      const a = pts[pts.length - 2], b = pts[pts.length - 1];
      const fwd = a && b ? { x: b.x + (b.x - a.x) / (Math.hypot(b.x - a.x, b.y - a.y) || 1) * 150, y: b.y + (b.y - a.y) / (Math.hypot(b.x - a.x, b.y - a.y) || 1) * 150 } : null;
      const target = best && bestD < 500 ? { x: best.x, y: best.y } : fwd;
      if (target) viewer?.faceNavPoint?.(target); else viewer?.faceNavArrival?.();
    }
    pendingLegAdvance = true;
    if (transferTimer) clearTimeout(transferTimer);
    transferTimer = setTimeout(() => {
      transferTimer = null;
      void advanceToLeg(activeLegIndex + 1);
    }, walking ? Math.max(1500, 2500 / (Number(walkSpeed) || 1)) : Math.max(450, 1200 / (Number(walkSpeed) || 1)));
  }

  function handleNavWalkExit() {
    walking = false;
    playbackPlaying = false;
  }

  function metersLabel(cm: number) {
    const meters = Math.round((cm || 0) / 100);
    return meters < 1 ? '不到 1 米' : `约 ${meters} 米`;
  }

  /** Collapsed panel line: what to do on this leg (「1楼：走楼梯 A 上到 4楼」 / 「4楼：到 办公室 A」). */
  function currentStepText() {
    const leg = routeLegs[activeLegIndex];
    if (!leg) return '';
    const ride = transferAfter(activeLegIndex);
    const here = floorSpoken(leg.floorName || leg.floorId);
    return `${activeLegIndex + 1}/${routeLegs.length} ${here}：${ride ? transferText(withDisplay(ride), view?.bounds) : `前往目的地 · ${metersLabel(leg.lengthCm || 0)}`}`;
  }

  function placeKey(place: Place) {
    return `${place.floorId || view?.floorId || ''}::${place.id}`;
  }

  // Duplicate names on a floor read 「卫生间（东）」/「楼梯（东A）」 (floors share plan axes).
  const displayNames = $derived(disambiguate(
    allPlaces().map((p) => ({ id: placeKey(p), name: !p.name || /^房间\s*\d+$/.test(p.name) ? '未命名房间' : p.name, floorId: p.floorId || '', x: p.x, y: p.y })),
    Object.fromEntries((view?.floors || []).map((f) => [f.id, view?.bounds])),
  ));

  const pickerPlaces = $derived(indexPlaces(allPlaces().filter(p => !(p as { ensuite?: boolean }).ensuite).map(p => {
    const k = placeKey(p); const full = placeLabel(p); const i = full.indexOf(' · ');
    return { key: k, name: i >= 0 ? full.slice(i + 3) : full, originalName: p.originalName, aliases: p.aliases,
      floorId: p.floorId || '', floorLabel: i >= 0 ? full.slice(0, i) : '', x: p.x, y: p.y, restricted: p.restricted };
  })));
  // Where 「最近的卫生间」 measures from: the chosen start, else the first-person position.
  const pickerOrigin = $derived.by(() => {
    const s0 = placeByKey(startId);
    if (s0) return { x: s0.x, y: s0.y, floorId: s0.floorId || view?.floorId || '' };
    const w = walking ? viewer?.getWalkPosition?.() : null;
    if (w && view) return { ...w, floorId: view.floorId };
    // No start yet: measure from the main entrance (patients usually come in there).
    // Never a 限制通行区 entrance; the main entrance (大门 / 主入口) first.
    const open = allPlaces().filter((p) => !p.restricted);
    const gate = open.find((p) => /大门|主入口/.test(p.name || '') || (p.aliases || []).includes('大门'))
      || open.find((p) => /出入口/.test(p.name || '')) || open.find((p) => /门厅|大厅/.test(p.name || ''));
    return gate ? { x: gate.x, y: gate.y, floorId: gate.floorId || view?.floorId || '' } : null;
  });
  /** Data-driven: any elevator among this building's places. */
  const hasLift = () => allPlaces().some((p) => /电梯/.test(p.name || ''));
  const floorIndex = (id: string) => (view?.floors || []).findIndex((f) => f.id === id);

  /** The stair/lift a transfer uses, under the same display name as the dropdown (「楼梯（东）」). */
  function withDisplay<T extends { from?: { x: number; y: number }; fromFloorId?: string; toFloorId?: string; kind?: string; kindLabel?: string }>(t: T): T & { display?: string; floors?: number; landmark?: string } {
    const ids = (view?.floors || []).map((f) => f.id);
    const span = t.fromFloorId && t.toFloorId ? Math.abs(ids.indexOf(t.toFloorId) - ids.indexOf(t.fromFloorId)) : 0;
    if (span >= 2) t = { ...t, floors: span };
    if (!t.from) return t;
    // Landmark: the nearest named, non-circulation place within 8 m (「护士站旁」).
    let mark = '', markD = 800;
    for (const p of allPlaces()) {
      // Only places a patient can see and name (never 配电间/氧气瓶存放处).
      if ((t.fromFloorId && p.floorId !== t.fromFloorId) || p.restricted || !/护士站|收费|挂号|大门|门厅|大厅|候诊|导医|服务台|药房/.test(p.name || '')) continue;
      const d = Math.hypot(p.x - t.from!.x, p.y - t.from!.y);
      if (d < markD) { markD = d; mark = displayNames.get(placeKey(p)) || p.name; }
    }
    if (mark) t = { ...t, landmark: mark };
    // The importer names stairs for patients (「楼梯 A」/「楼梯（北）」): the link's own name wins,
    // so marker, step text and map label always name the shaft the route really uses.
    const own = (t as { name?: string }).name || '';
    if (/^(楼梯|电梯|扶梯)(\s[A-Z]|（.+）)$/.test(own)) return { ...t, display: own };
    const stairs = t.kind === 'stairs' || /楼梯/.test(t.kindLabel || '');
    let best: Place | null = null, bestD = 450;
    for (const p of allPlaces()) {
      if ((t.fromFloorId && p.floorId !== t.fromFloorId) || !/楼梯|电梯/.test(p.name || '')) continue;
      if (stairs !== /楼梯/.test(p.name || '') && /电梯楼梯/.test(p.name || '') === false) continue;
      const d = Math.hypot(p.x - t.from!.x, p.y - t.from!.y);
      if (d < bestD) { bestD = d; best = p; }
    }
    return { ...t, display: best ? displayNames.get(placeKey(best)) : undefined };
  }

  function placeLabel(place: Place) {
    const floor = floorSpoken(place.floorName || place.floorId || '');
    const name = displayNames.get(placeKey(place)) || place.name || place.id;
    return floor ? `${floor} · ${name}` : name;
  }

  function allPlaces(): Place[] {
    return placesCache();
  }
  // Generic display normalisation (toilets → 「卫生间」) applied once per nav payload.
  let placesMemo: { src: unknown; out: Place[] } = { src: null, out: [] };
  function placesCache(): Place[] {
    const src = view?.places?.length ? view.places : view?.destinations;
    if (placesMemo.src === src) return placesMemo.out;
    placesMemo = { src, out: rawPlaces().map((p) => withToiletDisplay(p)) };
    return placesMemo.out;
  }
  function rawPlaces(): Place[] {
    const listed = view?.places || [];
    if (listed.length) return listed;
    return (view?.destinations || []).map((place) => ({
      ...place,
      floorId: place.floorId || view?.floorId || '',
      floorName: place.floorName || view?.floorName || view?.floorId || '',
    }));
  }

  function filteredPlaces(): Place[] {
    const list = allPlaces();
    if (category === 'all') return list;
    return list.filter((p) => p.category === category);
  }

  function multiFloor() {
    return (view?.floors?.length || 0) > 1;
  }

  function transferAfter(index: number) {
    return routeTransfers.find((item) => item.afterLeg === index);
  }

  function placeByKey(key: string) {
    return allPlaces().find((place) => placeKey(place) === key);
  }

  function stopPoint(place: Place) {
    return { x: place.x, y: place.y, floor: place.floorId || view?.floorId || '' };
  }

  /** Merge per-room map-label settings from the loaded project JSON. */
  function roomLabelMeta(place: Place): {
    style: RoomLabelStyle;
    icon?: Room['labelIcon'];
    iconColor?: string;
    textColor?: string;
  } {
    const project = get(currentProject);
    const floorId = view?.floorId || '';
    const floor = project?.floors?.find((f) => f.id === floorId) ?? project?.floors?.[0];
    const room = floor?.rooms?.find((r) => r.id === place.id);
    return {
      style: resolveRoomLabelStyle(room?.labelStyle),
      icon: room?.labelIcon,
      iconColor: room?.labelIconColor,
      textColor: room?.labelColor,
    };
  }

  function say(text: string) {
    status = text;
  }

  let planRouteMemo: { src: unknown; walls: unknown; out: { x: number; y: number }[] } = { src: null, walls: null, out: [] };
  function planRoutePts() {
    const walls = view?.walls || [];
    if (planRouteMemo.src !== routePolyline || planRouteMemo.walls !== walls) {
      let out = routePolyline;
      try { out = centerRoute(routePolyline, walls as any); } catch { /* keep raw */ }
      planRouteMemo = { src: routePolyline, walls, out };
    }
    return planRouteMemo.out;
  }

  // 2D zoom/pan (wheel, pinch-free buttons, drag). Labels re-declutter at each zoom level.
  let planZoom = $state(1);
  let planPan = $state({ x: 0, y: 0 });
  let planDrag: { x: number; y: number; px: number; py: number; moved: boolean } | null = null;
  function zoomPlan(factor: number, cx?: number, cy?: number) {
    const c = planCanvas; if (!c) return;
    const z = Math.max(1, Math.min(8, planZoom * factor));
    const k = z / planZoom;
    const ax = (cx ?? c.clientWidth / 2) - c.clientWidth / 2, ay = (cy ?? c.clientHeight / 2) - c.clientHeight / 2;
    planPan = z === 1 ? { x: 0, y: 0 } : { x: ax - (ax - planPan.x) * k, y: ay - (ay - planPan.y) * k };
    planZoom = z;
    drawPlan();
  }
  function onPlanWheel(e: WheelEvent) {
    e.preventDefault();
    const r = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    zoomPlan(e.deltaY < 0 ? 1.25 : 0.8, e.clientX - r.left, e.clientY - r.top);
  }
  function onPlanDown(e: PointerEvent) { planDrag = { x: e.clientX, y: e.clientY, px: planPan.x, py: planPan.y, moved: false }; }
  function onPlanMove(e: PointerEvent) {
    if (!planDrag || planZoom === 1) return;
    const dx = e.clientX - planDrag.x, dy = e.clientY - planDrag.y;
    if (Math.hypot(dx, dy) > 6) planDrag.moved = true;
    if (planDrag.moved) { planPan = { x: planDrag.px + dx, y: planDrag.py + dy }; drawPlan(); }
  }
  function onPlanUp() { setTimeout(() => { planDrag = null; }, 0); }

  function drawPlan() {
    const canvas = planCanvas;
    if (!canvas || !view) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const ratio = effectivePixelRatio();
    canvas.width = Math.max(1, Math.floor(width * ratio));
    canvas.height = Math.max(1, Math.floor(height * ratio));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = '#eef0f2';
    ctx.fillRect(0, 0, width, height);
    const bounds = view.bounds;
    if (!bounds) return;
    const pad = 28;
    const spanX = Math.max(1, bounds.maxX - bounds.minX);
    const spanY = Math.max(1, bounds.maxY - bounds.minY);
    const fit = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY);
    const scale = fit * planZoom;
    const ox = (width - spanX * scale) / 2 - bounds.minX * scale + planPan.x;
    const oy = (height - spanY * scale) / 2 - bounds.minY * scale + planPan.y;
    const toScreen = (x: number, y: number) => [ox + x * scale, oy + y * scale] as const;
    // Maker-style room fills under walls (soft hospital palette).
    for (const room of view.rooms || []) {
      const poly = room.polygon || [];
      if (poly.length < 3) continue;
      ctx.beginPath();
      poly.forEach((point, index) => {
        const [x, y] = toScreen(point.x, point.y);
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
      const [x0, y0] = toScreen(wall.start.x, wall.start.y);
      const [x1, y1] = toScreen(wall.end.x, wall.end.y);
      ctx.lineWidth = Math.max(2, (wall.thickness || 15) * scale);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
    if (routePolyline.length > 1) {
      // Same corridor-centred path as the 3D ribbon (never the raw sparse polyline).
      const routePolyline = planRoutePts();
      const drawPoly = (pts: { x: number; y: number }[], color: string, width = 3) => {
        if (pts.length < 2) return;
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        pts.forEach((point, index) => {
          const [x, y] = toScreen(point.x, point.y);
          if (index) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        });
        ctx.stroke();
      };
      const splitAt = (ratio: number) => {
        const total = routePolyline.reduce((sum, point, index) => {
          if (!index) return 0;
          return sum + Math.hypot(point.x - routePolyline[index - 1].x, point.y - routePolyline[index - 1].y);
        }, 0);
        let remain = Math.max(0, Math.min(1, ratio)) * total;
        const traveled: { x: number; y: number }[] = [routePolyline[0]];
        const remaining: { x: number; y: number }[] = [];
        let cut: { x: number; y: number } | null = null;
        for (let i = 0; i + 1 < routePolyline.length; i++) {
          const a = routePolyline[i];
          const b = routePolyline[i + 1];
          const len = Math.hypot(b.x - a.x, b.y - a.y);
          if (!cut && remain <= len) {
            const t = len > 0 ? remain / len : 0;
            cut = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
            traveled.push(cut);
            remaining.push(cut, ...routePolyline.slice(i + 1));
            break;
          }
          remain -= len;
          traveled.push(b);
        }
        if (!cut) return { traveled: routePolyline, remaining: [] as { x: number; y: number }[] };
        return { traveled, remaining };
      };
      // After arrival (≥99.5 %) keep the whole route blue, not a grey "travelled" line.
      const showSplit = Number(walkSeek) > 0.5 && Number(walkSeek) < 99.5 && routePolyline.length > 1;
      if (showSplit) {
        const { traveled, remaining } = splitAt(Number(walkSeek) / 100);
        drawPoly(traveled, '#8b9490', 3);
        drawPoly(remaining, '#1a7af8', 3.5);
      } else {
        drawPoly(routePolyline, '#1a7af8', 3.5);
      }
      // Sparse, small chevrons inside the route line show direction without covering the plan.
      const arrowPts = showSplit ? splitAt(Number(walkSeek) / 100).remaining : routePolyline;
      if (arrowPts.length > 1) {
        let total = 0;
        const segs: { a: { x: number; y: number }; dx: number; dy: number; start: number; length: number }[] = [];
        for (let i = 1; i < arrowPts.length; i++) {
          const a = arrowPts[i - 1];
          const b = arrowPts[i];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const length = Math.hypot(dx, dy);
          if (length < 1) continue;
          segs.push({ a, dx: dx / length, dy: dy / length, start: total, length });
          total += length;
        }
        const spacing = Math.max(160, 96 / Math.max(scale, 0.001));
        let index = 0;
        ctx.fillStyle = '#fff';
        for (let distance = spacing * 0.5; distance < total - spacing * 0.5; distance += spacing) {
          while (index < segs.length - 1 && distance > segs[index].start + segs[index].length) index++;
          const s = segs[index];
          const t = distance - s.start;
          if (Math.min(t, s.length - t) * scale < 8) continue;
          const [sx, sy] = toScreen(s.a.x + s.dx * t, s.a.y + s.dy * t);
          const angle = Math.atan2(s.dy, s.dx);
          ctx.save();
          ctx.translate(sx, sy);
          ctx.rotate(angle);
          ctx.beginPath();
          ctx.moveTo(4, 0);
          ctx.lineTo(-3, 2.5);
          ctx.lineTo(-1, 0);
          ctx.lineTo(-3, -2.5);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
      }
    }
    // Labels scale with the plan (a room is often < 40 px wide on a phone) and are decluttered:
    // start/end and 常用 first, then the rest, skipping any label that would overlap one placed.
    const fontPx = Math.max(11, Math.min(18, scale * 120));
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const hits = (b: { x0: number; y0: number; x1: number; y1: number }) => placed.some(o => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);
    const ends = new Set([startId, endId]);
    const cands = filteredPlaces()
      .filter(place => (place.floorId || view!.floorId) === view!.floorId)
      .filter(place => place.name && !/^(未命名|房间\s*\d+$)/.test(place.name))
      .map(place => ({ place, pri: ends.has(placeKey(place)) ? 0 : /入口|门厅|导医|药房|收费|卫生间|电梯|楼梯/.test(place.name || '') ? 1 : 2 }))
      .sort((a, b) => a.pri - b.pri);
    ctx.font = `600 ${fontPx}px "Nav Sans SC", "Noto Sans SC", system-ui, sans-serif`;
    for (const { place, pri } of cands) {
      const [x, y] = toScreen(place.x, place.y);
      const meta = roomLabelMeta(place);
      if (meta.style === 'hidden') continue;
      const placeName = displayNames.get(placeKey(place)) || place.name || place.id;
      const w = ctx.measureText(placeName).width;
      const box = { x0: x - 6, y0: y - fontPx * 0.7, x1: x + 10 + w, y1: y + fontPx * 0.7 };
      if (pri > 0 && hits(box)) {
        // No room for the text: keep a small dot so the place is still visible.
        ctx.fillStyle = place.color || '#9aa4a0';
        ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
        continue;
      }
      placed.push(box);
      ctx.fillStyle = place.color || '#dce8df';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      drawMapRoomLabel(ctx, {
        name: placeName,
        style: 'stroke',
        textColor: '#000000',
        fontSize: fontPx,
        strokeWidth: 1.5,
        align: 'left',
        x: x + 7,
        y,
      });
    }
    for (const transfer of routeTransfers) {
      const ends = [
        transfer.fromFloorId === view.floorId && transfer.from
          ? { at: transfer.from, text: pinText.transfer(transferPlace(withDisplay(transfer), view.bounds)) }
          : null,
        transfer.toFloorId === view.floorId && transfer.to
          ? { at: transfer.to, text: `${transferPlace(withDisplay(transfer), view.bounds)} · 从${floorSpoken(transfer.fromFloorName)}到达` }
          : null,
      ];
      for (const end of ends) {
        if (!end) continue;
        const [x, y] = toScreen(end.at.x, end.at.y);
        ctx.fillStyle = '#0f3d7a';
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(x - 8, y - 8, 16, 16, 3);
        ctx.fill();
        ctx.stroke();
        ctx.font = '600 12px system-ui, sans-serif';
        const label = end.text.trim();
        const w = ctx.measureText(label).width + 10;
        ctx.fillStyle = 'rgba(15, 61, 122, 0.92)';
        ctx.beginPath();
        ctx.roundRect(x + 12, y - 11, w, 20, 3);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillText(label, x + 17, y + 3);
      }
    }
  }

  function stopAll() {
    legAdvanceToken += 1;
    if (transferTimer) {
      clearTimeout(transferTimer);
      transferTimer = null;
    }
    pendingModeAction = null;
    pendingLegAdvance = false;
    transferNotice = '';
    simulating = false;
    walking = false;
    playbackPlaying = false;
    walkSeek = 0;
    activeLegIndex = 0;
    viewer?.pauseRouteSimulation?.();
    viewer?.stopRouteSimulation?.();
    viewer?.exitNavWalk?.();
  }

  function applyLeg(index: number) {
    const leg = routeLegs[index];
    if (!leg) return;
    activeLegIndex = index;
    routePolyline = leg.polyline || [];
    routeDoorIds = leg.usedDoorIds || [];
    walkSeek = 0;
    viewer?.setNavRoute?.(routePolyline, routeDoorIds);
    syncFloorStack();
    drawPlan();
  }

  /** 3D overview: show every floor of a cross-floor route as an exploded stack. */
  function syncFloorStack() {
    if (!viewer?.setNavFloorStack) return;
    const floorsOnRoute = new Set(routeLegs.map((leg) => leg.floorId));
    if (floorsOnRoute.size < 2 || simulating || walking) { viewer.setNavFloorStack([], []); return; }
    const end = placeByKey(endId);
    viewer.setNavFloorStack(routeLegs, routeTransfers.map((t) => ({ ...t, kindLabel: transferPlace(withDisplay(t), view?.bounds) })), end ? (displayNames.get(placeKey(end)) || end.name || '') : '');
  }

  let navLoadSeq = 0;
  let pendingFloorId = $state('');
  const navCache = new Map<string, any>();

  async function loadNav(floorId: string, opts: { keepRoute?: boolean } = {}) {
    if (!opts.keepRoute) {
      stopAll();
      routePolyline = [];
      routeDoorIds = [];
      routeLegs = [];
      routeTransfers = [];
      viewer?.clearNavRoute?.();
      waypoints = [];
      startId = '';
      endId = '';
      say('正在打开');
    }
    // Newest request wins, and the pressed floor lights up at once: a slow nav.json used to make
    // the first floor click look ignored (and an older response could land after a newer one).
    const seq = ++navLoadSeq;
    pendingFloorId = floorId || '';
    let data: any = floorId ? navCache.get(floorId) : null;
    if (!data) {
      const query = new URLSearchParams({ floor: floorId || '' });
      let response: Response;
      try {
        response = await fetch(`${apiOrigin}/api/projects/${projectId}/nav.json?${query}`);
      } catch {
        if (seq === navLoadSeq) { pendingFloorId = ''; say('服务连不上，请重试'); }
        return;
      }
      if (seq !== navLoadSeq) return;
      if (!response.ok) {
        pendingFloorId = '';
        say('这一层没有打开');
        return;
      }
      data = await response.json();
      if (seq !== navLoadSeq) return;
      if (data?.floorId) navCache.set(data.floorId, data);
    }
    pendingFloorId = '';
    view = data;
    if (view?.floorId) {
      const project = get(currentProject);
      if (project?.floors?.some((f) => f.id === view!.floorId)) {
        setActiveFloor(view.floorId);
      }
      const next = new URL(window.location.href);
      next.searchParams.set('floor', view.floorId);
      // SvelteKit owns history: a raw history.replaceState here confused its router on floor
      // switches (arrival on the next floor bounced back to 「正在打开…」 and reset the route).
      if (next.href !== window.location.href) {
        try { kitReplaceState(next, page.state); } catch { /* router not ready yet: skip */ }
      }
    }
    if (!opts.keepRoute) {
      say(view?.empty ? '这一层没有户型' : '选择起点和终点');
      routeMessage = view?.empty ? '这一层没有户型' : '选择起点和终点';
    }
    drawPlan();
  }

  /** Viewing a floor the route doesn't touch: jump back to the route's first leg before playing. */
  async function ensureRouteFloor() {
    if (routePolyline.length) return true;
    const leg = routeLegs[0];
    if (!leg) return false;
    if (view?.floorId !== leg.floorId) await loadNav(leg.floorId, { keepRoute: true });
    applyLeg(0);
    return routePolyline.length > 0;
  }

  async function advanceToLeg(index: number) {
    const leg = routeLegs[index];
    // Switching floors exits first-person in the viewer, which clears `walking`.
    const firstPerson = walking;
    if (!leg) {
      pendingLegAdvance = false;
      arrive(firstPerson);
      return;
    }
    const token = legAdvanceToken;
    if (view?.floorId !== leg.floorId) {
      await loadNav(leg.floorId, { keepRoute: true });
    }
    if (token !== legAdvanceToken) return;
    applyLeg(index);
    pendingLegAdvance = false;
    transferNotice = '';
    mode = '3d';
    walking = firstPerson;
    simulating = !firstPerson;
    pendingModeAction = firstPerson ? 'walk' : 'simulate';
    playbackPlaying = true;
    say(firstPerson ? `继续 ${floorSpoken(leg.floorName) || '这一层'}` : `继续模拟 ${floorSpoken(leg.floorName) || '这一层'}`);
  }

  async function planRoute() {
    stopAll();
    routeFailed = false;
    arrivedText = '';
    routePolyline = [];
    routeDoorIds = [];
    routeLegs = [];
    routeTransfers = [];
    viewer?.clearNavRoute?.();
    lengthCm = 0;
    if (!view || !projectId) return;
    const start = placeByKey(startId);
    const end = placeByKey(endId);
    const vias = waypoints.map(placeByKey).filter(Boolean) as Place[];
    if (!start || !end) {
      routeMessage = '选择起点和终点';
      return;
    }
    if (placeKey(start) === placeKey(end) && !vias.length) {
      routeMessage = '起点和终点不能是同一个地方，请重新选终点';
      say(routeMessage);
      return;
    }
    busy = true;
    noLiftFallback = '';
    say('正在找路');
    try {
      const response = await fetch(`${apiOrigin}/api/projects/${projectId}/route`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          floor: start.floorId || view.floorId,
          from: stopPoint(start),
          to: stopPoint(end),
          via: vias.map(stopPoint),
          accessible,
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        const reasons: Record<string, string> = {
          'off-plan': '点在可走的地方',
          'no-link': '没有电梯或楼梯连通',
          blocked: '走不过去',
          empty: '这一层没有户型',
        };
        // 只乘电梯 on a building without lifts: say so plainly instead of a bare failure.
        const noLift = accessible && result.reason === 'no-link' && !allPlaces().some(p => /电梯/.test(p.name || ''));
        let msg = reasons[result.reason] || '走不过去';
        if (noLift) {
          const fl = (view?.floors || []).map(f => f.id);
          const n = Math.abs(fl.indexOf(end.floorId || '') - fl.indexOf(start.floorId || ''));
          const dir = fl.indexOf(end.floorId || '') > fl.indexOf(start.floorId || '') ? '下' : '上';
          noLiftFallback = n ? `改走楼梯（需走楼梯${dir} ${n} 层）` : '改走楼梯';
          msg = '本楼暂无电梯，可改走楼梯或联系导诊台协助';
        }
        say(msg);
        routeMessage = msg;
        return;
      }
      routeLegs = (result.legs || []).filter((leg: RouteLeg) => (leg.polyline || []).length > 1);
      if (!routeLegs.length && result.polyline?.length > 1) {
        routeLegs = [{
          floorId: result.floorId || start.floorId || view.floorId,
          floorName: view.floorName || view.floorId,
          lengthCm: result.lengthCm || 0,
          polyline: result.polyline,
          usedDoorIds: result.usedDoorIds || [],
        }];
      }
      routeTransfers = result.transfers || [];
      lengthCm = result.lengthCm || 0;
      const viaNote = vias.length ? ` · 经 ${vias.length} 个途经点` : '';
      const crossNote = result.crossFloor ? ` · ${routeLegs.length} 段跨层` : '';
      const label = metersLabel(lengthCm) + viaNote + crossNote;
      routeMessage = label;
      say(label);
      const firstFloor = routeLegs[0]?.floorId;
      if (firstFloor && view.floorId !== firstFloor) {
        await loadNav(firstFloor, { keepRoute: true });
      }
      applyLeg(0);
    } catch {
      // Server unreachable: old steps are already cleared; offer a retry instead of stale steps.
      routeFailed = true;
      say('找路失败：服务暂时连不上');
      routeMessage = '找路失败：服务暂时连不上';
    } finally {
      busy = false;
    }
  }

  async function showFloor(floorId: string) {
    stopAll();
    await loadNav(floorId, { keepRoute: true });
    const index = routeLegs.findIndex((leg) => leg.floorId === floorId);
    if (index >= 0) {
      applyLeg(index);
      return;
    }
    routePolyline = [];
    routeDoorIds = [];
    viewer?.clearNavRoute?.();
    drawPlan();
  }

  async function showLeg(index: number) {
    const leg = routeLegs[index];
    if (!leg) return;
    stopAll();
    if (view?.floorId !== leg.floorId) await loadNav(leg.floorId, { keepRoute: true });
    applyLeg(index);
  }

  function onPlanClick(event: MouseEvent) {
    if (!planCanvas || !view?.bounds || mode !== '2d' || busy) return;
    const rect = planCanvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const bounds = view.bounds;
    const width = planCanvas.clientWidth;
    const height = planCanvas.clientHeight;
    const pad = 28;
    const spanX = Math.max(1, bounds.maxX - bounds.minX);
    const spanY = Math.max(1, bounds.maxY - bounds.minY);
    const fit = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY);
    const scale = fit * planZoom;
    const ox = (width - spanX * scale) / 2 - bounds.minX * scale + planPan.x;
    const oy = (height - spanY * scale) / 2 - bounds.minY * scale + planPan.y;
    const mx = (px - ox) / scale;
    const my = (py - oy) / scale;
    let best: Place | null = null;
    let bestD = 18 / scale;
    const candidates = (view.destinations || []).map((place) => ({
      ...place,
      floorId: place.floorId || view!.floorId,
      floorName: place.floorName || view!.floors?.find((f) => f.id === view!.floorId)?.name || view!.floorId,
    }));
    for (const place of candidates) {
      const d = Math.hypot(place.x - mx, place.y - my);
      if (d < bestD) {
        bestD = d;
        best = place;
      }
    }
    if (!best) return;
    const key = placeKey(best);
    if (!startId) startId = key;
    else endId = key;
    void planRoute();
  }

  onMount(() => {
    // Dev-only hook for scripted same-camera screenshots; absent from production builds.
    if (import.meta.env.DEV) (window as any).__navTest = {
      get viewer() { return viewer; },
      places: () => allPlaces().map((p) => ({ key: placeKey(p), label: placeLabel(p) })),
      route: async (from: string, to: string) => { startId = from; endId = to; await planRoute(); return routeMessage; },
      showLeg: async (i: number) => showLeg(Math.min(i, routeLegs.length - 1)),
      transfers: () => routeTransfers.map((t) => { const st = allPlaces().filter((p) => p.floorId === t.fromFloorId && /楼梯|电梯/.test(p.name || '')).sort((a, b) => Math.hypot(a.x - t.from!.x, a.y - t.from!.y) - Math.hypot(b.x - t.from!.x, b.y - t.from!.y))[0]; return { from: st ? { x: st.x, y: st.y } : t.from, name: (t as any).name }; }),
      setMode: (m: '2d' | '3d') => { mode = m; },
    };
    void (async () => {
      try {
        const url = new URL(window.location.href);
        // No ?apiOrigin: use the project's own import service, not a stale hard-coded port (8881).
        const projectHint = url.searchParams.get('id') || url.searchParams.get('projectUrl')?.match(/\/projects\/([0-9a-f]{32})/i)?.[1];
        apiOrigin = (url.searchParams.get('apiOrigin') || originOf(url.searchParams.get('projectUrl')) || projectImportOrigin(projectHint) || importOrigin()).replace(/\/$/, '');
        libraryUrl = resolveProjectLibraryUrl(url.searchParams, url.origin);
        if (libraryUrl === '/' && apiOrigin) libraryUrl = projectHomeUrl(projectHint, apiOrigin);
        projectId = url.searchParams.get('id') || '';
        const projectUrl = url.searchParams.get('projectUrl');
        if (!projectUrl && !projectId) {
          loadError = '缺少 projectUrl 或 id';
          return;
        }
        const fetchUrl = projectUrl || `${apiOrigin}/api/projects/${projectId}.json`;
        if (!projectId && projectUrl) {
          const match = projectUrl.match(/\/projects\/([0-9a-f]{32})/i);
          if (match) projectId = match[1];
        }
        // First open on phones was ~13 s to 3D: fetch the project while the 3D viewer code
        // downloads/parses in parallel (it used to start only after the nav data), and say which
        // step is running.
        say('正在下载项目（1/3）');
        const viewerCode = import('$lib/components/viewer3d/ThreeViewer.svelte');
        const response = await fetch(fetchUrl);
        if (!response.ok) throw new Error(`project ${response.status}`);
        const raw = await response.json();
        // Cardinal words only when the drawing's north arrow is known (import/editor/MCP).
        setNavNorth(raw?.northBearing ?? null);
        const project = readProject(raw);
        loadProject(project);
        markClean();
        if (!projectId) projectId = project.id;
        say('正在加载 3D 引擎（2/3）');
        ThreeViewer ??= (await viewerCode).default;
        const floor = url.searchParams.get('floor') || project.activeFloorId || '';
        await loadNav(floor);
        ready = true;
        // Prefer 3D shell
        mode = '3d';
        viewMode.set('3d');
      } catch (error: any) {
        loadError = error?.message || '打开失败';
      }
    })();

    const onResize = () => drawPlan();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });
</script>

{#if loadError}
  <div class="nav-error">{loadError}</div>
{:else if ready}
  <div class="nav" data-openplan-nav-shell>
    <header class="nav-bar">
      <a class="back" href={libraryUrl} data-testid="back-to-projects" aria-label="返回项目列表"><span class="back-icon" aria-hidden="true">‹</span><span class="back-text">返回项目列表</span></a>
      <h1>导航</h1>
      <div class="floor" role="group" aria-label="楼层">
        {#if (view?.floors?.length || 0) > 1}
          {#each view?.floors || [] as floor}
            <button type="button" class="floor-btn" class:on={pendingFloorId ? floor.id === pendingFloorId : floor.id === view?.floorId} aria-pressed={floor.id === view?.floorId}
              title={floorOption(floor.name)} onclick={() => showFloor(floor.id)}>{floor.name}</button>
          {/each}
        {:else}
          <span>{view?.floors?.[0]?.name || ''}</span>
        {/if}
      </div>
      <div class="mode-switch" role="group" aria-label="视图">
        <button type="button" class:is-active={mode === '2d'} aria-pressed={mode === '2d'} onclick={() => { stopAll(); mode = '2d'; }}>平面 2D</button>
        <button type="button" class:is-active={mode === '3d'} aria-pressed={mode === '3d'} onclick={() => { mode = '3d'; }}>立体 3D</button>
      </div>
    </header>
    <div class="stage">
      <div class="canvas-wrap">
        <canvas
          bind:this={planCanvas}
          class="plan"
          class:hidden={mode !== '2d'}
          onclick={(e) => { if (!planDrag?.moved) onPlanClick(e); }}
          onwheel={onPlanWheel}
          onpointerdown={onPlanDown}
          onpointermove={onPlanMove}
          onpointerup={onPlanUp}
        ></canvas>
        {#if mode === '2d'}
          <div class="plan-zoom">
            <button type="button" aria-label="放大" onclick={() => zoomPlan(1.4)}>＋</button>
            <button type="button" aria-label="缩小" onclick={() => zoomPlan(1 / 1.4)}>－</button>
          </div>
        {/if}
        <div class="viewer" class:hidden={mode !== '3d'} onpointerdowncapture={onViewerPointerDown} onpointerupcapture={onViewerPointerUp}>
          {#if ThreeViewer}
            <ThreeViewer bind:this={viewer} navShell={true} routePolyline={routePolyline} routeDoorIds={routeDoorIds} onRouteProgress={handleRouteProgress} onNavWalkExit={handleNavWalkExit} />
          {/if}
        </div>
        {#if tapHint}
          <div class="tap-hint" role="status">{tapHint}</div>
        {/if}
        {#if transferNotice}
          <div class="transfer-notice" role="status">{transferNotice}</div>
        {/if}
        {#if walking}
          <!-- Touch first person: no pointer lock / keyboard here, so say how to move and offer a big exit. -->
          <div class="fp-touch-hint" aria-hidden="true">拖动看四周 · 点地面前进</div>
          <button type="button" class="fp-exit" onclick={() => { const done = arrivedText; stopAll(); arrivedText = done; say('已退出第一人称'); }}>退出</button>
        {/if}
        {#if arrivedText}
          <div class="transfer-notice arrived" role="status">{arrivedText}{#if walking}<small>按 Esc 或点「结束」退出第一人称</small>{/if}</div>
        {/if}
      </div>
      <aside class="side" class:open={panelOpen}>
        <button type="button" class="panel-peek" aria-expanded={panelOpen} onclick={() => (panelOpen = !panelOpen)}>
          <span class="peek-text">{transferNotice || arrivedText || (routeLegs.length > 1 && (simulating || walking) ? currentStepText() : '') || (routeLegs.length || noLiftFallback || routeFailed || routeMessage !== '选择起点和终点' ? routeMessage : status)}</span>
          <span class="peek-toggle">{panelOpen ? '收起' : '展开'}</span>
        </button>
        {#if !panelOpen && multiFloor() && !hasLift() && view}<p class="nolift-peek peek-nolift" role="note">本楼无电梯，可联系导医台协助</p>{/if}
        {#if routeFailed && !panelOpen}<button type="button" class="nolift nolift-peek" onclick={() => void planRoute()}>重试</button>{/if}
        {#if noLiftFallback && !panelOpen}<button type="button" class="nolift nolift-peek" onclick={() => { accessible = false; void planRoute(); }}>{noLiftFallback}</button>{/if}
        <div class="route-stops">
          <label class="route-stop"><span class="dot start-dot"></span>从
            <PlacePicker bind:value={startId} places={pickerPlaces} label="起点" onchange={() => planRoute()} />
          </label>
          <div class="waypoints" aria-label="途经点">
            {#each waypoints as wp, index}
              <label class="route-stop"><span class="dot via-dot"></span>经
                <PlacePicker bind:value={waypoints[index]} places={pickerPlaces} label="途经点" onchange={() => planRoute()} />
                <button type="button" class="remove" onclick={() => { waypoints = waypoints.filter((_, i) => i !== index); planRoute(); }}>×</button>
              </label>
            {/each}
          </div>
          <button
            type="button"
            class="add-waypoint"
            disabled={waypoints.length >= MAX_VIA}
            onclick={() => { if (waypoints.length < MAX_VIA) waypoints = [...waypoints, '']; }}
          >＋ 途经点</button>
          <label class="route-stop"><span class="dot end-dot"></span>到
            <PlacePicker bind:value={endId} places={pickerPlaces} label="终点" origin={pickerOrigin} {floorIndex} {accessible} hasLift={hasLift()} onchange={() => planRoute()} />
          </label>
          {#if multiFloor()}
            <label class="accessible" class:off={!hasLift()}>
              <input type="checkbox" bind:checked={accessible} disabled={!hasLift()} onchange={() => {
                // Route already rides the lift: nothing to change, just say so.
                if (accessible && routeTransfers.length && routeTransfers.every((t) => t.kind !== 'stairs')) { routeMessage = '当前路线已全程乘电梯，无需走楼梯'; say(routeMessage); return; }
                void planRoute();
              }} />
              只乘电梯（无障碍）
            {#if !hasLift()}<span class="nolift-note">本楼无电梯，可联系导医台协助</span>{/if}
            </label>
          {/if}
        </div>
        <div class="walk-row">
          <button
            type="button"
            class="primary"
            disabled={!routeLegs.length || busy}
            onclick={async () => {
              if (!(await ensureRouteFloor())) return;
              mode = '3d';
              walking = false;
              simulating = true;
              playbackPlaying = true;
              walkSeek = 0; pendingModeAction = 'simulate';
              say('模拟导航已开始');
            }}
          >模拟导航</button>
          <button
            type="button"
            disabled={!routeLegs.length || busy}
            onclick={async () => {
              if (!(await ensureRouteFloor())) return;
              mode = '3d';
              simulating = false;
              walking = true;
              playbackPlaying = true;
              walkSeek = 0; pendingModeAction = 'walk';
              say('第一人称已开始');
            }}
          >第一人称</button>
          <button
            type="button"
            hidden={!simulating && !walking}
            onclick={() => {
              viewer?.pauseRouteSimulation?.();
              playbackPlaying = false;
              say('已暂停');
            }}
            disabled={!playbackPlaying}
          >暂停</button>
          <button
            type="button"
            hidden={(!simulating && !walking) || playbackPlaying || Number(walkSeek) >= 100}
            onclick={() => {
              viewer?.resumeRouteSimulation?.();
              playbackPlaying = true;
              say(walking ? '继续自动行走' : '继续模拟导航');
            }}
          >继续</button>
          <button
            type="button"
            hidden={!simulating && !walking}
            onclick={() => { stopAll(); say('已结束'); }}
          >结束</button>
        </div>
        <div class="playback" hidden={(!simulating && !walking) || !routePolyline.length}>
          <label>速度
            <select
              aria-label="速度"
              bind:value={walkSpeed}
              onchange={() => viewer?.setSimulationSpeed?.(Number(walkSpeed) || 1)}
            >
              <option value={0.5}>0.5×</option>
              <option value={1}>1×</option>
              <option value={1.5}>1.5×</option>
              <option value={2}>2×</option>
              <option value={3}>3×</option>
            </select>
          </label>
          <label class="seek">进度
            <input
              type="range"
              min="0"
              max="100"
              step="0.1"
              value={tripSeek}
              aria-label="进度"
              oninput={(e) => {
                // Seek within the current floor's stretch of the trip.
                const { from, width } = tripSpan(activeLegIndex);
                const v = Number((e.currentTarget as HTMLInputElement).value) || 0;
                walkSeek = width > 0 ? Math.max(0, Math.min(100, ((v - from) / width) * 100)) : v;
                viewer?.setSimulationProgress?.((Number(walkSeek) || 0) / 100);
                if (mode === '2d') drawPlan();
              }}
            />
          </label>
        </div>
        <p class="route-message">{routeMessage}</p>
        {#if routeFailed}<button type="button" class="nolift retry" onclick={() => void planRoute()}>重试</button>{/if}
        {#if routeLegs.length && !busy}
          <div class="route-tools">
            <button type="button" onclick={async () => { stopAll(); await ensureRouteFloor(); viewer?.frameNavRoute?.(); say('已回到路线'); }}>回到路线</button>
            <button type="button" onclick={() => void planRoute()}>重新规划</button>
          </div>
        {/if}
        {#if noLiftFallback}<button type="button" class="nolift" onclick={() => { accessible = false; void planRoute(); }}>{noLiftFallback}</button>{/if}
        {#if routeLegs.length > 1}
          <ol class="itinerary" aria-label="分段">
            {#each routeLegs as leg, index}
              <li>
                <button
                  type="button"
                  class:is-active={index === activeLegIndex}
                  aria-pressed={index === activeLegIndex}
                  onclick={() => showLeg(index)}
                >
                  <span>{index + 1}. {floorSpoken(leg.floorName || leg.floorId)}</span>
                  <span class="leg-length">{metersLabel(leg.lengthCm || 0)}</span>
                </button>
              </li>
              {#if transferAfter(index)}
                {@const ride = transferAfter(index)!}
                <li class="ride">{transferText(withDisplay(ride), view?.bounds)}</li>
              {/if}
            {/each}
          </ol>
        {/if}
        <nav class="facility-bar" aria-label="设施">
          {#each [
            ['all', '全部'],
            ['entrance', '出入口'],
            ['restroom', '卫生间'],
            ['elevator', '电梯'],
            ['stairs', '楼梯'],
            ['service', '服务'],
          ] as [id, label]}
            <button
              type="button"
              class:is-active={category === id}
              aria-pressed={category === id}
              onclick={() => { category = id; drawPlan(); }}
            >{label}</button>
          {/each}
        </nav>
        <div class="places">
          {#each filteredPlaces().filter((p) => p.name && !/^(未命名|房间\s*\d+$)/.test(p.name) && !(p as { ensuite?: boolean }).ensuite) as place}
            <button
              type="button"
              class="place"
              onclick={() => {
                const key = placeKey(place);
                if (!startId) startId = key;
                else endId = key;
                void planRoute();
              }}
            >
              <span class="swatch" style="background:{place.color || '#dce8df'}"></span>
              <span>{placeLabel(place)}</span>
            </button>
          {/each}
        </div>
      </aside>
    </div>
    <p class="status">{status}</p>
  </div>
{:else}
  <div class="nav-loading" role="status" aria-live="polite">
    <div class="nav-spinner" aria-hidden="true"></div>
    <p>正在打开导航地图…{loadSecs >= 3 ? `（已 ${loadSecs} 秒，第一次打开较慢）` : ''}</p>
    <div class="nav-bar"><span style="width:{Math.min(95, 15 + loadSecs * 8)}%"></span></div>
  </div>
{/if}

<style>
  :global(html), :global(body) {
    height: 100%;
    margin: 0;
  }
  .nav {
    height: 100vh;
    display: flex;
    flex-direction: column;
    background: #f2f3f5;
    color: #222;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "IBM Plex Sans SC", sans-serif;
  }
  .nav-bar {
    height: 48px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 16px;
    background: #fff;
    border-bottom: 1px solid #e6e6e6;
    position: relative;
    z-index: 1;
  }
  .nav-bar h1 { margin: 0; font-size: 16px; font-weight: 600; }
  .back { color: #1a7af8; text-decoration: none; }
  .floor { margin-left: auto; margin-right: 12px; color: #333; display: flex; gap: 4px; overflow-x: auto; max-width: 60vw; scrollbar-width: none; }
  .floor-btn { min-width: 44px; min-height: 36px; border: 1px solid #d0d5dd; background: #fff; border-radius: 6px; font: inherit; font-weight: 600; cursor: pointer; flex: none; }
  .floor-btn.on { background: #1f2937; color: #fff; border-color: #1f2937; }
  .floor select { height: 32px; border: 1px solid #d9d9d9; background: #fff; padding: 0 8px; }
  .plan-zoom { position: absolute; right: 12px; bottom: 12px; display: flex; flex-direction: column; gap: 6px; z-index: 2; }
  .plan-zoom button { width: 44px; height: 44px; border-radius: 8px; border: 1px solid #d0d5dd; background: #fff; font-size: 22px; cursor: pointer; }
  .mode-switch { display: flex; flex: none; border: 1px solid #d9d9d9; background: #f7f7f8; }
  .mode-switch button { white-space: nowrap; }
  .mode-switch button {
    height: 32px; border: 0; background: transparent; padding: 0 10px; cursor: pointer; color: #555;
  }
  .mode-switch button.is-active { background: #fff; color: #111; box-shadow: 0 0 0 1px #d9d9d9; }
  .stage { flex: 1; min-height: 0; display: flex; position: relative; z-index: 2; }
  .canvas-wrap { flex: 1; min-width: 0; position: relative; background: #eef0f2; }
  .plan, .viewer { position: absolute; inset: 0; width: 100%; height: 100%; }
  .plan { display: block; cursor: crosshair; }
  .plan.hidden, .viewer.hidden { visibility: hidden; pointer-events: none; }
  .side {
    width: 280px; flex: none; overflow: auto; background: #fff;
    border-left: 1px solid #e6e6e6; padding: 12px; display: flex; flex-direction: column; gap: 10px;
    position: relative; z-index: 5;
  }
  .route-stops { display: flex; flex-direction: column; gap: 6px; }
  .route-stop { display: flex; align-items: center; gap: 6px; font-size: 13px; }
  .route-stop select { flex: 1; height: 32px; border: 1px solid #d9d9d9; background: #fff; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .start-dot { background: #22c55e; }
  .end-dot { background: #ef4444; }
  .via-dot { background: #f59e0b; }
  .add-waypoint, .walk-row button, .place, .facility-bar button {
    border: 1px solid #d9d9d9; background: #fff; height: 32px; cursor: pointer; font-size: 13px;
  }
  .add-waypoint { width: 100%; }
  .walk-row { display: flex; flex-wrap: wrap; gap: 6px; }
  .walk-row button { padding: 0 10px; }
  .walk-row .primary { background: #1a7af8; color: #fff; border-color: #1a7af8; }
  .walk-row button:disabled { opacity: 0.45; cursor: default; }
  .playback { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
  .playback[hidden] { display: none !important; }
  .seek input { width: 100%; }
  .route-message { margin: 0; font-size: 13px; color: #555; min-height: 1.2em; }
  .facility-bar { display: flex; flex-wrap: wrap; gap: 4px; }
  .facility-bar button { padding: 0 8px; }
  .facility-bar button.is-active { background: #111; color: #fff; border-color: #111; }
  .places { display: flex; flex-direction: column; gap: 4px; }
  .place { display: flex; align-items: center; gap: 8px; padding: 0 8px; text-align: left; }
  .swatch { width: 10px; height: 10px; border-radius: 2px; flex: none; }
  .status {
    margin: 0; padding: 6px 16px; font-size: 12px; color: #666;
    background: #fff; border-top: 1px solid #e6e6e6;
  }
  .remove { border: 0; background: transparent; cursor: pointer; font-size: 16px; color: #888; }
  .transfer-notice.arrived { background: #1f7a4d; display: flex; flex-direction: column; align-items: center; gap: 2px; }
  .transfer-notice.arrived small { font-size: 12px; opacity: .85; font-weight: 400; }
  .transfer-notice {
    position: absolute; top: 16px; left: 50%; transform: translateX(-50%); z-index: 4;
    padding: 8px 16px; background: rgba(15, 61, 122, 0.92); color: #fff;
    font-size: 15px; font-weight: 600; pointer-events: none;
  }
  .accessible { display: flex; align-items: center; gap: 8px; min-height: 44px; font-size: 13px; color: #444; cursor: pointer; }
  .accessible input { width: 20px; height: 20px; margin: 0; cursor: pointer; }
  .itinerary { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
  .itinerary button {
    width: 100%; height: 30px; display: flex; justify-content: space-between; align-items: center;
    padding: 0 8px; border: 1px solid #d9d9d9; background: #fff; cursor: pointer; font-size: 13px;
  }
  .itinerary button.is-active { border-color: #1a7af8; color: #1a7af8; }
  .leg-length { color: #777; }
  .itinerary .ride { padding: 2px 8px; color: #0f3d7a; font-size: 12px; }
  .links { border-top: 1px solid #eee; padding-top: 8px; font-size: 13px; }
  .links summary { cursor: pointer; color: #333; }
  .link-row { display: flex; align-items: center; gap: 6px; padding: 6px 0; border-bottom: 1px solid #f2f2f2; }
  .link-kind { flex: none; padding: 1px 6px; background: #0f3d7a; color: #fff; font-size: 12px; }
  .link-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .link-text span { color: #666; font-size: 12px; }
  .link-auto { flex: none; color: #888; font-size: 12px; }
  .link-form { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; }
  .link-form-row { display: flex; gap: 6px; }
  .link-form select, .link-form input { height: 30px; border: 1px solid #d9d9d9; background: #fff; min-width: 0; }
  .link-form-row input { flex: 1; padding: 0 6px; }
  .link-form button { height: 30px; border: 1px solid #0f3d7a; background: #0f3d7a; color: #fff; cursor: pointer; }
  .link-form button:disabled { opacity: 0.45; cursor: default; }
  .hint { margin: 4px 0 0; color: #777; font-size: 12px; }
  .nav-error { padding: 24px; font-family: system-ui, sans-serif; }
  .nav-loading { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; font-family: system-ui, sans-serif; color: #334; }
  .nav-loading p { margin: 0; font-size: 16px; }
  .nav-spinner { width: 40px; height: 40px; border-radius: 50%; border: 4px solid #d6dde6; border-top-color: #1e6fd9; animation: nav-spin 0.9s linear infinite; }
  .nav-bar { width: min(280px, 70vw); height: 6px; background: #e3e8ef; border-radius: 3px; overflow: hidden; }
  .nav-bar span { display: block; height: 100%; background: #1e6fd9; transition: width 0.8s ease; }
  @keyframes nav-spin { to { transform: rotate(360deg); } }
  .tap-hint { position: absolute; left: 50%; top: 45%; transform: translate(-50%, -50%); z-index: 5; padding: 8px 14px; border-radius: 20px; background: rgba(22, 48, 42, .88); color: #fff; font-size: 14px; pointer-events: none; }
  .nolift-peek { display: none; }
  .nolift { min-height: 44px; padding: 0 14px; border-radius: 8px; border: 0; background: #1f7cf2; color: #fff; font-weight: 600; }
  .panel-peek, .back-icon { display: none; }
  .fp-touch-hint, .fp-exit { display: none; }
  .accessible.off { color: #888; }
  .peek-nolift { display: none; margin: 0; padding: 0 14px 8px; font-size: 13px; color: #8a4b00; }
  .nolift-note { display: block; margin-left: 24px; font-size: 13px; color: #8a4b00; }
  .route-tools { display: flex; gap: 8px; }
  .route-tools button { flex: 1; min-height: 44px; border: 1px solid #ccd; border-radius: 8px; background: #fff; font: inherit; }
  @media (max-width: 720px), (pointer: coarse) {
    .fp-touch-hint { display: block; position: absolute; left: 50%; bottom: 76px; transform: translateX(-50%); z-index: 6; padding: 6px 14px; border-radius: 18px; background: rgba(20, 30, 40, .72); color: #fff; font-size: 14px; pointer-events: none; animation: fpHint 5s forwards; white-space: nowrap; }
    .fp-exit { display: block; position: absolute; right: 12px; top: 12px; z-index: 30; touch-action: manipulation; min-width: 88px; min-height: 52px; border: 0; border-radius: 26px; background: #c62828; color: #fff; font-size: 18px; font-weight: 700; box-shadow: 0 2px 8px rgba(0,0,0,.3); }
  }
  @keyframes fpHint { 0%, 80% { opacity: 1; } 100% { opacity: 0; } }
  @media (max-width: 720px) {
    .floor-btn, .side select { min-height: 44px; }
    /* 5+ floors: buttons scroll sideways (edge fade hints more), never clipped mid-button. */
    .floor { min-width: 0; flex: 1 1 auto; max-width: none; scroll-snap-type: x mandatory; mask-image: linear-gradient(90deg, #000 85%, transparent); }
    .floor-btn { scroll-snap-align: start; min-width: 44px; padding: 0 6px; }
    .stage { flex-direction: column; }
    /* The 3D view never collapses to 0 when the panel opens (grey canvas / zero-size attachments). */
    .canvas-wrap { flex: 1 1 auto; min-height: 40vh; }
    .side { flex: 0 1 auto; }
    .floor { margin-right: 16px; }
    .side { width: 100%; max-height: 52vh; border-left: 0; border-top: 1px solid #e6e6e6; }
    /* Collapsed: only the one-line instruction; 3D gets the screen. */
    .side:not(.open) { max-height: 56px; overflow: hidden; }
    .side:not(.open) > :not(.panel-peek):not(.nolift-peek) { display: none; }
    .nolift-peek { display: block; margin: 0 12px 10px; }
    .panel-peek { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 48px; padding: 0 12px;
      border: 0; border-bottom: 1px solid #eee; background: #fff; font: inherit; text-align: left; cursor: pointer; }
    .peek-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; color: #16302a; }
    .peek-toggle { color: #1a7af8; font-size: 13px; }
    .peek-nolift { display: block; }
    /* Header: back icon + floor + one view toggle. */
    .nav-bar h1, .back-text { display: none; }
    .back-icon { display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; font-size: 30px; line-height: 1; }
    .mode-switch button.is-active { display: none; }
    .mode-switch button { min-height: 44px; }
    .status { display: none; }
  }
</style>

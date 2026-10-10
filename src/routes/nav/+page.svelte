<script lang="ts">
  import PlacePicker from '$lib/components/nav/PlacePicker.svelte';
  import { indexPlaces } from '$lib/utils/placeSearch';
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
  let routeMessage = $state('选择起点和终点');
  let noLiftFallback = $state('');
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
    requestAnimationFrame(() => {
      if (pendingModeAction !== action || !viewer || mode !== '3d') return;
      pendingModeAction = null;
      viewer.setNavRoute?.(routePolyline, routeDoorIds);
      if (action === 'simulate') viewer.startRouteSimulation?.(walkSpeed);
      else viewer.enterWalkAlongRoute?.(Number(walkSpeed) || 1);
    });
  });

  $effect(() => {
    if (mode !== '3d' || !viewer || pendingModeAction || viewer === restoredViewer) return;
    restoredViewer = viewer;
    const seek = untrack(() => Number(walkSeek) || 0);
    if (seek > 0) requestAnimationFrame(() => {
      if (viewer === restoredViewer && !viewer.isSimulating?.()) viewer.setSimulationProgress?.(seek / 100);
    });
  });

  // The 3D viewer mounts lazily; rebuild the floor stack once it exists.
  $effect(() => {
    if (mode !== '3d' || !viewer) return;
    untrack(() => requestAnimationFrame(() => syncFloorStack()));
  });

  function handleRouteProgress(ratio: number, playing: boolean) {
    walkSeek = Math.round(ratio * 1000) / 10;
    playbackPlaying = playing;
    if (!(ratio >= 1 && !playing) || pendingLegAdvance) return;
    if (!(simulating || walking) || activeLegIndex + 1 >= routeLegs.length) {
      say(walking ? '已到达终点' : '模拟导航已完成');
      return;
    }
    const transfer = routeTransfers.find((item) => item.afterLeg === activeLegIndex);
    const next = routeLegs[activeLegIndex + 1];
    const tip = transfer
      ? transferText(withDisplay({ ...transfer, toFloorName: transfer.toFloorName || next?.floorName }), view?.bounds)
      : `换到 ${floorSpoken(next?.floorName) || '下一层'}`;
    say(tip);
    transferNotice = tip;
    pendingLegAdvance = true;
    if (transferTimer) clearTimeout(transferTimer);
    transferTimer = setTimeout(() => {
      transferTimer = null;
      void advanceToLeg(activeLegIndex + 1);
    }, Math.max(450, 1200 / (Number(walkSpeed) || 1)));
  }

  function handleNavWalkExit() {
    walking = false;
    playbackPlaying = false;
  }

  function metersLabel(cm: number) {
    const meters = Math.round((cm || 0) / 100);
    return meters < 1 ? '不到 1 米' : `约 ${meters} 米`;
  }

  function placeKey(place: Place) {
    return `${place.floorId || view?.floorId || ''}::${place.id}`;
  }

  // Duplicate names on a floor read 「卫生间（东）」/「楼梯（东A）」 (floors share plan axes).
  const displayNames = $derived(disambiguate(
    allPlaces().map((p) => ({ id: placeKey(p), name: !p.name || /^房间\s*\d+$/.test(p.name) ? '未命名房间' : p.name, floorId: p.floorId || '', x: p.x, y: p.y })),
    Object.fromEntries((view?.floors || []).map((f) => [f.id, view?.bounds])),
  ));

  const pickerPlaces = $derived(indexPlaces(allPlaces().map(p => {
    const k = placeKey(p); const full = placeLabel(p); const i = full.indexOf(' · ');
    return { key: k, name: i >= 0 ? full.slice(i + 3) : full, originalName: p.originalName, aliases: p.aliases,
      floorId: p.floorId || '', floorLabel: i >= 0 ? full.slice(0, i) : '' };
  })));

  /** The stair/lift a transfer uses, under the same display name as the dropdown (「楼梯（东）」). */
  function withDisplay<T extends { from?: { x: number; y: number }; fromFloorId?: string; kind?: string; kindLabel?: string }>(t: T): T & { display?: string } {
    if (!t.from) return t;
    const stairs = t.kind === 'stairs' || /楼梯/.test(t.kindLabel || '');
    let best: Place | null = null, bestD = 450;
    for (const p of allPlaces()) {
      if ((t.fromFloorId && p.floorId !== t.fromFloorId) || !/楼梯|电梯/.test(p.name || '')) continue;
      if (stairs !== /楼梯/.test(p.name || '') && /电梯楼梯/.test(p.name || '') === false) continue;
      const d = Math.hypot(p.x - t.from.x, p.y - t.from.y);
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
    const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY);
    const ox = (width - spanX * scale) / 2 - bounds.minX * scale;
    const oy = (height - spanY * scale) / 2 - bounds.minY * scale;
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
      const showSplit = Number(walkSeek) > 0.5 && routePolyline.length > 1;
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
    for (const place of filteredPlaces()) {
      if ((place.floorId || view.floorId) !== view.floorId) continue;
      const [x, y] = toScreen(place.x, place.y);
      const meta = roomLabelMeta(place);
      if (meta.style === 'hidden') continue;
      const placeName = place.name || place.id;
      if (meta.style === 'mapPoi' || meta.style === 'mapPoiSoft') {
        drawMapRoomLabel(ctx, {
          name: placeName,
          style: meta.style,
          icon: meta.icon,
          iconColor: meta.iconColor || place.color,
          textColor: meta.textColor || '#000000',
          fontSize: 28,
          strokeWidth: 1.5,
          iconRadius: 10,
          align: 'left',
          x: x - 4,
          y,
        });
      } else {
        ctx.fillStyle = place.color || '#dce8df';
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        drawMapRoomLabel(ctx, {
          name: placeName,
          style: 'stroke',
          textColor: '#000000',
          fontSize: 28,
          strokeWidth: 1.5,
          align: 'left',
          x: x + 8,
          y,
        });
      }
    }
    for (const transfer of routeTransfers) {
      const ends = [
        transfer.fromFloorId === view.floorId && transfer.from
          ? { at: transfer.from, text: pinText.transfer(transferPlace(withDisplay(transfer), view.bounds)) }
          : null,
        transfer.toFloorId === view.floorId && transfer.to
          ? { at: transfer.to, text: `从${floorSpoken(transfer.fromFloorName)}到达` }
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
    const query = new URLSearchParams({ floor: floorId || '' });
    const response = await fetch(`${apiOrigin}/api/projects/${projectId}/nav.json?${query}`);
    if (!response.ok) {
      say('这一层没有打开');
      return;
    }
    view = await response.json();
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

  async function advanceToLeg(index: number) {
    const leg = routeLegs[index];
    // Switching floors exits first-person in the viewer, which clears `walking`.
    const firstPerson = walking;
    if (!leg) {
      pendingLegAdvance = false;
      say(firstPerson ? '已到达终点' : '模拟导航已完成');
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
      routeMessage = '起终点相同';
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
      say('找路失败');
      routeMessage = '找路失败';
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
    const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY);
    const ox = (width - spanX * scale) / 2 - bounds.minX * scale;
    const oy = (height - spanY * scale) / 2 - bounds.minY * scale;
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
      <label class="floor">
        {#if (view?.floors?.length || 0) > 1}
          <select
            aria-label="楼层"
            value={view?.floorId || ''}
            onchange={(e) => showFloor((e.currentTarget as HTMLSelectElement).value)}
          >
            {#each view?.floors || [] as floor}
              <option value={floor.id}>{floorOption(floor.name)}</option>
            {/each}
          </select>
        {:else}
          <span>{view?.floors?.[0]?.name || ''}</span>
        {/if}
      </label>
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
          onclick={onPlanClick}
        ></canvas>
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
      </div>
      <aside class="side" class:open={panelOpen}>
        <button type="button" class="panel-peek" aria-expanded={panelOpen} onclick={() => (panelOpen = !panelOpen)}>
          <span class="peek-text">{transferNotice || (routeLegs.length || noLiftFallback ? routeMessage : status)}</span>
          <span class="peek-toggle">{panelOpen ? '收起' : '展开'}</span>
        </button>
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
            <PlacePicker bind:value={endId} places={pickerPlaces} label="终点" onchange={() => planRoute()} />
          </label>
          {#if multiFloor()}
            <label class="accessible">
              <input type="checkbox" bind:checked={accessible} onchange={() => planRoute()} />
              只乘电梯（无障碍）
            </label>
          {/if}
        </div>
        <div class="walk-row">
          <button
            type="button"
            class="primary"
            disabled={!routePolyline.length || busy}
            onclick={() => {
              if (!routePolyline.length) return;
              mode = '3d';
              walking = false;
              simulating = true;
              playbackPlaying = true;
              pendingModeAction = 'simulate';
              say('模拟导航已开始');
            }}
          >模拟导航</button>
          <button
            type="button"
            disabled={!routePolyline.length || busy}
            onclick={() => {
              if (!routePolyline.length) return;
              mode = '3d';
              simulating = false;
              walking = true;
              playbackPlaying = true;
              pendingModeAction = 'walk';
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
              bind:value={walkSeek}
              aria-label="进度"
              oninput={() => {
                viewer?.setSimulationProgress?.((Number(walkSeek) || 0) / 100);
                if (mode === '2d') drawPlan();
              }}
            />
          </label>
        </div>
        <p class="route-message">{routeMessage}</p>
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
          {#each filteredPlaces() as place}
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
  <div class="nav-error">正在打开…</div>
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
  .floor { margin-left: auto; color: #333; }
  .floor select { height: 32px; border: 1px solid #d9d9d9; background: #fff; padding: 0 8px; }
  .mode-switch { display: flex; border: 1px solid #d9d9d9; background: #f7f7f8; }
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
  .tap-hint { position: absolute; left: 50%; top: 45%; transform: translate(-50%, -50%); z-index: 5; padding: 8px 14px; border-radius: 20px; background: rgba(22, 48, 42, .88); color: #fff; font-size: 14px; pointer-events: none; }
  .nolift-peek { display: none; }
  .nolift { min-height: 44px; padding: 0 14px; border-radius: 8px; border: 0; background: #1f7cf2; color: #fff; font-weight: 600; }
  .panel-peek, .back-icon { display: none; }
  @media (max-width: 720px) {
    .floor select, .side select { min-height: 44px; }
    .stage { flex-direction: column; }
    .side { width: 100%; max-height: 52vh; border-left: 0; border-top: 1px solid #e6e6e6; }
    /* Collapsed: only the one-line instruction; 3D gets the screen. */
    .side:not(.open) { max-height: 56px; overflow: hidden; }
    .side:not(.open) > :not(.panel-peek):not(.nolift-peek) { display: none; }
    .nolift-peek { display: block; margin: 0 12px 10px; }
    .panel-peek { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 48px; padding: 0 12px;
      border: 0; border-bottom: 1px solid #eee; background: #fff; font: inherit; text-align: left; cursor: pointer; }
    .peek-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; color: #16302a; }
    .peek-toggle { color: #1a7af8; font-size: 13px; }
    /* Header: back icon + floor + one view toggle. */
    .nav-bar h1, .back-text { display: none; }
    .back-icon { display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; font-size: 30px; line-height: 1; }
    .mode-switch button.is-active { display: none; }
    .mode-switch button { min-height: 44px; }
    .status { display: none; }
  }
</style>

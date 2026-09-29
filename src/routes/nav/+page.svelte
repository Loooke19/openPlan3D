<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { get } from 'svelte/store';
  import { currentProject, loadProject, viewMode, setActiveFloor } from '$lib/stores/project';
  import { readProject } from '$lib/utils/projectValidation';
  import { markClean } from '$lib/stores/saveStatus';

  let ThreeViewer: any = $state(null);
  let viewer: any = $state(null);
  let ready = $state(false);
  let loadError = $state<string | null>(null);
  let mode = $state<'2d' | '3d'>('3d');
  let status = $state('正在打开');
  let routeMessage = $state('选择起点和终点');
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
  let pendingModeAction = $state<'simulate' | 'walk' | null>(null);
  let pendingLegAdvance = $state(false);
  let restoredViewer: any = null;
  let planCanvas: HTMLCanvasElement | undefined = $state();
  let transferTimer: ReturnType<typeof setTimeout> | null = null;
  let transferNotice = $state('');
  let legAdvanceToken = 0;
  let accessible = $state(false);
  let linkKind = $state('elevator');
  let linkName = $state('');
  let linkFrom = $state('');
  let linkTo = $state('');
  let linkBusy = $state(false);
  let linkMessage = $state('');

  const LINK_KINDS = [
    ['elevator', '电梯'],
    ['stairs', '楼梯'],
    ['escalator', '扶梯'],
  ];

  type Place = {
    id: string;
    name: string;
    x: number;
    y: number;
    color?: string;
    category?: string;
    floorId?: string;
    floorName?: string;
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
  type LinkStop = { floorId: string; floorName?: string; placeId?: string; name?: string; x: number; y: number };
  type VerticalLink = {
    id: string;
    kind: string;
    kindLabel?: string;
    name: string;
    source?: 'auto' | 'manual';
    stops: LinkStop[];
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
    verticalLinks?: VerticalLink[];
    walls?: { start: { x: number; y: number }; end: { x: number; y: number }; thickness?: number }[];
    rooms?: NavRoom[];
    openings?: any[];
    bounds?: { minX: number; minY: number; maxX: number; maxY: number };
    empty?: boolean;
  };

  let view = $state<NavView | null>(null);
  let projectId = $state('');
  let apiOrigin = $state('http://127.0.0.1:8881');
  let filesUrl = $state('http://127.0.0.1:8881/files');

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
    const way = transfer?.direction === 'up' ? '上' : transfer?.direction === 'down' ? '下' : '';
    const tip = transfer
      ? `乘${transfer.kindLabel || '电梯'}${way}到 ${transfer.toFloorName || next?.floorName || '下一层'}`
      : `换到 ${next?.floorName || '下一层'}`;
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

  function placeLabel(place: Place) {
    const floor = place.floorName || place.floorId || '';
    const name = place.name || place.id;
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

  function placesOnFloor(floorId: string): Place[] {
    return allPlaces().filter((place) => place.floorId === floorId);
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

  function say(text: string) {
    status = text;
  }

  function drawPlan() {
    const canvas = planCanvas;
    if (!canvas || !view) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const ratio = window.devicePixelRatio || 1;
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
      ctx.fillStyle = place.color || '#dce8df';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      const placeName = place.name || place.id;
      ctx.font = 'bold 24px "Noto Sans SC", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.strokeText(placeName, x + 8, y);
      ctx.fillStyle = '#222222';
      ctx.fillText(placeName, x + 8, y);
    }
    for (const transfer of routeTransfers) {
      const ends = [
        transfer.fromFloorId === view.floorId && transfer.from
          ? { at: transfer.from, text: `${transfer.kindLabel || '电梯'} → ${transfer.toFloorName || ''}` }
          : null,
        transfer.toFloorId === view.floorId && transfer.to
          ? { at: transfer.to, text: `${transfer.fromFloorName || ''} ${transfer.kindLabel || '电梯'}到达` }
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
    drawPlan();
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
      history.replaceState(null, '', next);
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
    say(firstPerson ? `继续 ${leg.floorName || '这一层'}` : `继续模拟 ${leg.floorName || '这一层'}`);
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
        say(reasons[result.reason] || '走不过去');
        routeMessage = reasons[result.reason] || '走不过去';
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

  const LINK_ERRORS: Record<string, string> = {
    floor: '两端要在不同楼层',
    stops: '选好两端',
    stop: '选好两端',
    kind: '类型不对',
    full: '连通太多了',
  };

  async function afterLinksChanged(message: string) {
    linkMessage = message;
    await loadNav(view?.floorId || '', { keepRoute: true });
    if (startId && endId) await planRoute();
  }

  async function addLink() {
    const from = placeByKey(linkFrom);
    const to = placeByKey(linkTo);
    if (!from || !to) {
      linkMessage = '选好两端';
      return;
    }
    if (from.floorId === to.floorId) {
      linkMessage = '两端要在不同楼层';
      return;
    }
    linkBusy = true;
    try {
      const response = await fetch(`${apiOrigin}/api/projects/${projectId}/vertical-links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: linkKind,
          name: linkName,
          stops: [from, to].map((place) => ({ floorId: place.floorId, roomId: place.id, x: place.x, y: place.y })),
        }),
      });
      if (!response.ok) {
        const detail = (await response.json().catch(() => ({})))?.detail;
        linkMessage = LINK_ERRORS[detail] || '没有连上';
        return;
      }
      linkName = '';
      linkFrom = '';
      linkTo = '';
      await afterLinksChanged(`已连通 ${placeLabel(from)} ⇄ ${placeLabel(to)}`);
    } catch {
      linkMessage = '没有连上';
    } finally {
      linkBusy = false;
    }
  }

  async function removeLink(link: VerticalLink) {
    linkBusy = true;
    try {
      const response = await fetch(
        `${apiOrigin}/api/projects/${projectId}/vertical-links/${encodeURIComponent(link.id)}`,
        { method: 'DELETE' },
      );
      if (!response.ok) {
        linkMessage = '没有删掉';
        return;
      }
      await afterLinksChanged(`已删除 ${link.name}`);
    } catch {
      linkMessage = '没有删掉';
    } finally {
      linkBusy = false;
    }
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
    void (async () => {
      try {
        const url = new URL(window.location.href);
        apiOrigin = (url.searchParams.get('apiOrigin') || 'http://127.0.0.1:8881').replace(/\/$/, '');
        filesUrl = url.searchParams.get('filesUrl') || `${apiOrigin}/files`;
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
        const response = await fetch(fetchUrl);
        if (!response.ok) throw new Error(`project ${response.status}`);
        const project = readProject(await response.json());
        loadProject(project);
        markClean();
        if (!projectId) projectId = project.id;
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
      <a class="back" href={filesUrl}>文件</a>
      <h1>导航</h1>
      <label class="floor">
        {#if (view?.floors?.length || 0) > 1}
          <select
            aria-label="楼层"
            value={view?.floorId || ''}
            onchange={(e) => showFloor((e.currentTarget as HTMLSelectElement).value)}
          >
            {#each view?.floors || [] as floor}
              <option value={floor.id}>{floor.name}</option>
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
        <div class="viewer" class:hidden={mode !== '3d'}>
          {#if ThreeViewer}
            <ThreeViewer bind:this={viewer} navShell={true} routePolyline={routePolyline} routeDoorIds={routeDoorIds} onRouteProgress={handleRouteProgress} onNavWalkExit={handleNavWalkExit} />
          {/if}
        </div>
        {#if transferNotice}
          <div class="transfer-notice" role="status">{transferNotice}</div>
        {/if}
      </div>
      <aside class="side">
        <div class="route-stops">
          <label class="route-stop"><span class="dot start-dot"></span>从
            <select bind:value={startId} aria-label="起点" onchange={() => planRoute()}>
              <option value="">选择</option>
              {#each allPlaces() as place}
                <option value={placeKey(place)}>{placeLabel(place)}</option>
              {/each}
            </select>
          </label>
          <div class="waypoints" aria-label="途经点">
            {#each waypoints as wp, index}
              <label class="route-stop"><span class="dot via-dot"></span>经
                <select
                  bind:value={waypoints[index]}
                  aria-label={`途经点 ${index + 1}`}
                  onchange={() => planRoute()}
                >
                  <option value="">选择</option>
                  {#each allPlaces() as place}
                    <option value={placeKey(place)}>{placeLabel(place)}</option>
                  {/each}
                </select>
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
            <select bind:value={endId} aria-label="终点" onchange={() => planRoute()}>
              <option value="">选择</option>
              {#each allPlaces() as place}
                <option value={placeKey(place)}>{placeLabel(place)}</option>
              {/each}
            </select>
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
                  <span>{index + 1}. {leg.floorName || leg.floorId}</span>
                  <span class="leg-length">{metersLabel(leg.lengthCm || 0)}</span>
                </button>
              </li>
              {#if transferAfter(index)}
                {@const ride = transferAfter(index)!}
                <li class="ride">乘{ride.kindLabel || '电梯'}「{ride.name}」{ride.fromFloorName} → {ride.toFloorName}</li>
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
        {#if multiFloor()}
          <details class="links">
            <summary>上下层连通 · {view?.verticalLinks?.length || 0}</summary>
            {#each view?.verticalLinks || [] as link (link.id)}
              <div class="link-row">
                <span class="link-kind">{link.kindLabel || link.kind}</span>
                <span class="link-text">
                  <strong>{link.name}</strong>
                  <span>{link.stops.map((stop) => `${stop.floorName || stop.floorId} ${stop.name || ''}`.trim()).join(' ⇄ ')}</span>
                </span>
                {#if link.source === 'manual'}
                  <button type="button" class="remove" aria-label={`删除 ${link.name}`} disabled={linkBusy} onclick={() => removeLink(link)}>×</button>
                {:else}
                  <span class="link-auto" title="同名的电梯 / 楼梯房间自动配对">自动</span>
                {/if}
              </div>
            {:else}
              <p class="hint">还没有连通。把两层的房间都命名为「电梯」或「楼梯」会自动配对，也可以在下面手动连。</p>
            {/each}
            <form class="link-form" onsubmit={(event) => { event.preventDefault(); void addLink(); }}>
              <div class="link-form-row">
                <select bind:value={linkKind} aria-label="连通类型">
                  {#each LINK_KINDS as [id, label]}
                    <option value={id}>{label}</option>
                  {/each}
                </select>
                <input bind:value={linkName} placeholder="名称（可空）" aria-label="连通名称" maxlength="40" />
              </div>
              {#snippet placeOptions(label: string)}
                <option value="">{label}</option>
                {#each view?.floors || [] as floor}
                  <optgroup label={floor.name}>
                    {#each placesOnFloor(floor.id) as place}
                      <option value={placeKey(place)}>{place.name || place.id}</option>
                    {/each}
                  </optgroup>
                {/each}
              {/snippet}
              <select bind:value={linkFrom} aria-label="一端">{@render placeOptions('一端')}</select>
              <select bind:value={linkTo} aria-label="另一端">{@render placeOptions('另一端')}</select>
              <button type="submit" disabled={linkBusy || !linkFrom || !linkTo}>添加连通</button>
              {#if linkMessage}<p class="hint">{linkMessage}</p>{/if}
            </form>
          </details>
        {/if}
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
  .accessible { display: flex; align-items: center; gap: 6px; font-size: 13px; color: #444; }
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
  @media (max-width: 720px) {
    .stage { flex-direction: column; }
    .side { width: 100%; max-height: 42vh; border-left: 0; border-top: 1px solid #e6e6e6; }
  }
</style>

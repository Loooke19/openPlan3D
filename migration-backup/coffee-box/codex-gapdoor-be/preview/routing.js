// Dijkstra on the exact corridor skeleton; never smooth paths through obstacles.
export function findRoute(graph,start,end,closed=new Set()){
  const adj=new Map(),dist=new Map([[start,0]]),parents=new Map(),queue=[[0,start]];
  for(const e of graph.edges){if(!e.enabled||closed.has(e.id))continue;for(const[a,b]of[[e.source,e.target],[e.target,e.source]]){if(!adj.has(a))adj.set(a,[]);adj.get(a).push([b,e]);}}
  while(queue.length){
    queue.sort((a,b)=>b[0]-a[0]);const[cost,u]=queue.pop();if(cost!==dist.get(u))continue;
    if(u===end){const steps=[];let node=end;while(node!==start){const[prev,edge]=parents.get(node);steps.push({edge,reversed:edge.source!==prev});node=prev;}return{length:cost,steps:steps.reverse()};}
    for(const[v,e]of adj.get(u)||[]){const alt=cost+e.lengthMapUnits;if(alt<(dist.get(v)??Infinity)){dist.set(v,alt);parents.set(v,[u,e]);queue.push([alt,v]);}}
  }return null;
}
export const MAX_WAYPOINTS = 6;

/** Chain shortest paths through ordered stops: start -> vias (≤6) -> end. */
export function findRouteVia(graph, stops, closed = new Set()) {
  if (!Array.isArray(stops) || stops.length < 2) return null;
  if (stops.length > MAX_WAYPOINTS + 2) return null;
  const steps = [];
  let length = 0;
  for (let i = 1; i < stops.length; i++) {
    const from = stops[i - 1], to = stops[i];
    if (from === to) continue;
    const leg = findRoute(graph, from, to, closed);
    if (!leg) return null;
    length += leg.length;
    steps.push(...leg.steps);
  }
  return { length, steps };
}
export function routePolyline(route){const result=[];for(const step of route?.steps||[])for(const p of step.reversed?[...step.edge.polyline].reverse():step.edge.polyline){const last=result.at(-1);if(!last||last[0]!==p[0]||last[1]!==p[1])result.push(p);}return result;}

/** Vertical transfer facility categories (aligned with VgoMap EnterType). */
export const VERTICAL_CATEGORIES = new Set(['elevator', 'stairs', 'escalator']);
export const VERTICAL_COST = Object.freeze({ elevator: 28, escalator: 34, stairs: 48 });
export const FLOOR_SEP = '::';

export function namespaceNode(floorId, nodeId) {
  return `${floorId}${FLOOR_SEP}${nodeId}`;
}

export function parseNamespaced(id) {
  if (typeof id !== 'string') return null;
  const i = id.indexOf(FLOOR_SEP);
  if (i <= 0) return null;
  return { floorId: id.slice(0, i), nodeId: id.slice(i + FLOOR_SEP.length) };
}

function poiKey(poi) {
  const name = String(poi.name || poi.displayName || '').replace(/\s+/g, '');
  return `${poi.category}|${name}`;
}

function xyDist(a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/**
 * Match elevator/stairs/escalator POIs across floors.
 * Prefer same category+name; fall back to nearest same-category within maxDist (normalized).
 * `forced` may inject explicit pairs: [{fromFloor,toFloor,fromNode,toNode,kind,cost?}].
 */
export function buildVerticalLinks(floorDocs, { maxDist = 0.06, forced = [] } = {}) {
  const links = [];
  const seen = new Set();
  const push = link => {
    const key = [link.fromFloor, link.fromNode, link.toFloor, link.toNode].join('|');
    const rev = [link.toFloor, link.toNode, link.fromFloor, link.fromNode].join('|');
    if (seen.has(key) || seen.has(rev)) return;
    seen.add(key);
    links.push(link);
  };
  for (const item of forced || []) {
    if (!item?.fromFloor || !item?.toFloor || !item?.fromNode || !item?.toNode) continue;
    push({
      fromFloor: item.fromFloor,
      toFloor: item.toFloor,
      fromNode: item.fromNode,
      toNode: item.toNode,
      kind: item.kind || 'elevator',
      cost: Number.isFinite(item.cost) ? item.cost : (VERTICAL_COST[item.kind] ?? VERTICAL_COST.elevator),
    });
  }
  const floors = (floorDocs || []).filter(f => f?.floorId && Array.isArray(f.pois));
  for (let i = 0; i < floors.length; i++) {
    for (let j = i + 1; j < floors.length; j++) {
      const a = floors[i], b = floors[j];
      const aVerts = a.pois.filter(p => VERTICAL_CATEGORIES.has(p.category) && p.nodeId);
      const bVerts = b.pois.filter(p => VERTICAL_CATEGORIES.has(p.category) && p.nodeId);
      const usedB = new Set();
      for (const pa of aVerts) {
        let best = null, bestDist = maxDist;
        const keyA = poiKey(pa);
        for (const pb of bVerts) {
          if (pb.category !== pa.category || usedB.has(pb.id)) continue;
          if (poiKey(pb) === keyA) {
            best = pb; bestDist = 0; break;
          }
          const d = xyDist(pa.position, pb.position);
          if (d < bestDist) { best = pb; bestDist = d; }
        }
        if (!best) continue;
        usedB.add(best.id);
        push({
          fromFloor: a.floorId,
          toFloor: b.floorId,
          fromNode: pa.nodeId,
          toNode: best.nodeId,
          kind: pa.category,
          cost: VERTICAL_COST[pa.category] ?? VERTICAL_COST.elevator,
          fromPoiId: pa.id,
          toPoiId: best.id,
        });
      }
    }
  }
  return links;
}

/** Merge per-floor graphs + vertical edges into one Dijkstra-ready graph. */
export function buildMultiFloorGraph(floorDocs, links = []) {
  const nodes = [];
  const edges = [];
  const nodeIds = new Set();
  for (const floor of floorDocs || []) {
    const floorId = floor.floorId;
    if (!floorId || !floor.graph) continue;
    for (const n of floor.graph.nodes || []) {
      const id = namespaceNode(floorId, n.id);
      if (nodeIds.has(id)) continue;
      nodeIds.add(id);
      nodes.push({ ...n, id, floorId, localId: n.id });
    }
    for (const e of floor.graph.edges || []) {
      edges.push({
        ...e,
        id: namespaceNode(floorId, e.id),
        source: namespaceNode(floorId, e.source),
        target: namespaceNode(floorId, e.target),
        floorId,
        kind: e.kind || 'walk',
        polyline: (e.polyline || []).map(p => [...p]),
      });
    }
  }
  let v = 0;
  for (const link of links || []) {
    const source = namespaceNode(link.fromFloor, link.fromNode);
    const target = namespaceNode(link.toFloor, link.toNode);
    if (!nodeIds.has(source) || !nodeIds.has(target)) continue;
    const fromPos = nodes.find(n => n.id === source)?.position;
    const toPos = nodes.find(n => n.id === target)?.position;
    const mid = fromPos && toPos
      ? [(fromPos[0] + toPos[0]) / 2, (fromPos[1] + toPos[1]) / 2]
      : fromPos || toPos || [0, 0];
    edges.push({
      id: `vertical:${v++}:${link.kind}`,
      source,
      target,
      lengthMapUnits: link.cost ?? VERTICAL_COST[link.kind] ?? VERTICAL_COST.elevator,
      polyline: fromPos && toPos ? [fromPos, mid, toPos] : [mid],
      enabled: true,
      mode: 'vertical',
      kind: 'vertical',
      verticalKind: link.kind,
      fromFloor: link.fromFloor,
      toFloor: link.toFloor,
      accessibility: 'unknown',
    });
  }
  return { algorithm: 'dijkstra-multi-floor', nodes, edges };
}

export function findCrossFloorRoute(multiGraph, startFloor, startNode, endFloor, endNode, closed = new Set()) {
  if (!multiGraph || !startFloor || !startNode || !endFloor || !endNode) return null;
  return findRoute(
    multiGraph,
    namespaceNode(startFloor, startNode),
    namespaceNode(endFloor, endNode),
    closed,
  );
}

/**
 * Split a multi-floor route into contiguous same-floor walk segments.
 * Vertical edges become transfer tips between segments.
 */
export function splitRouteByFloor(route) {
  const segments = [];
  if (!route?.steps?.length) return segments;
  let current = null;
  for (const step of route.steps) {
    const edge = step.edge;
    if (edge.kind === 'vertical' || edge.mode === 'vertical') {
      if (current) {
        current.transfer = {
          kind: edge.verticalKind || 'elevator',
          fromFloor: edge.fromFloor,
          toFloor: edge.toFloor,
          tip: transferTip(edge.verticalKind || 'elevator', edge.toFloor),
        };
        segments.push(current);
        current = null;
      } else {
        segments.push({
          floorId: edge.fromFloor,
          steps: [],
          transfer: {
            kind: edge.verticalKind || 'elevator',
            fromFloor: edge.fromFloor,
            toFloor: edge.toFloor,
            tip: transferTip(edge.verticalKind || 'elevator', edge.toFloor),
          },
        });
      }
      continue;
    }
    const floorId = edge.floorId || parseNamespaced(edge.source)?.floorId || parseNamespaced(edge.id)?.floorId;
    if (!current || current.floorId !== floorId) {
      if (current) segments.push(current);
      current = { floorId, steps: [] };
    }
    current.steps.push(step);
  }
  if (current) segments.push(current);
  for (const seg of segments) {
    seg.polyline = routePolyline({ steps: seg.steps });
    seg.length = seg.steps.reduce((sum, s) => sum + (s.edge.lengthMapUnits || 0), 0);
  }
  return segments;
}

function transferTip(kind, toFloor) {
  const label = { elevator: '乘电梯', escalator: '乘扶梯', stairs: '走楼梯' }[kind] || '换乘';
  return `${label}到 ${toFloor || '其他楼层'}`;
}

/** Flatten multi-floor route to animation samples: {floorId, x, y, kind, tip?}. */
export function routeAnimationPath(route, defaultFloorId = null) {
  const samples = [];
  if (!route?.steps?.length) return samples;
  const pushPoint = (floorId, point, meta = {}) => {
    if (!point || !floorId) return;
    const last = samples.at(-1);
    if (last && last.floorId === floorId && last.x === point[0] && last.y === point[1]) return;
    samples.push({ floorId, x: point[0], y: point[1], ...meta });
  };
  for (const step of route.steps) {
    const edge = step.edge;
    if (edge.kind === 'vertical' || edge.mode === 'vertical') {
      const from = parseNamespaced(step.reversed ? edge.target : edge.source);
      const to = parseNamespaced(step.reversed ? edge.source : edge.target);
      const poly = step.reversed ? [...edge.polyline].reverse() : edge.polyline;
      if (from && poly?.[0]) pushPoint(from.floorId, poly[0], { kind: 'transfer-enter' });
      if (to && poly?.at(-1)) {
        pushPoint(to.floorId, poly.at(-1), {
          kind: 'transfer-exit',
          tip: transferTip(edge.verticalKind || 'elevator', to.floorId),
          transferKind: edge.verticalKind || 'elevator',
        });
      }
      continue;
    }
    const floorId = edge.floorId || parseNamespaced(edge.source)?.floorId || defaultFloorId;
    const poly = step.reversed ? [...edge.polyline].reverse() : edge.polyline;
    for (const p of poly || []) pushPoint(floorId, p, { kind: 'walk' });
  }
  return samples;
}

/** Cumulative length along animation samples (same-floor Euclidean; transfer hops use edge cost via optional weights). */
export function animationPathLengths(samples) {
  const lengths = [0];
  let total = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    const sameFloor = a.floorId === b.floorId;
    const d = sameFloor ? Math.hypot(b.x - a.x, b.y - a.y) : (VERTICAL_COST[b.transferKind] ?? VERTICAL_COST.elevator) * 0.001;
    total += d;
    lengths.push(total);
  }
  return { lengths, total };
}

/** Heading (radians) along samples; prefers same-floor forward segment. */
export function headingAlongSamples(samples, fromIndex = 0) {
  if (!samples?.length) return 0;
  const start = Math.max(0, Math.min(fromIndex, samples.length - 1));
  for (let i = start; i < samples.length - 1; i++) {
    const a = samples[i], b = samples[i + 1];
    if (a.floorId !== b.floorId) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    if (dx || dy) return Math.atan2(dy, dx);
  }
  for (let i = start; i > 0; i--) {
    const a = samples[i - 1], b = samples[i];
    if (a.floorId !== b.floorId) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    if (dx || dy) return Math.atan2(dy, dx);
  }
  return 0;
}

export function pointAlongAnimation(samples, lengths, total, distance) {
  if (!samples?.length) return null;
  if (samples.length === 1 || !(total > 0)) {
    return { ...samples[0], t: 0, index: 0, heading: headingAlongSamples(samples, 0) };
  }
  const d = Math.max(0, Math.min(total, distance));
  let low = 1, high = lengths.length - 1;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (lengths[mid] < d) low = mid + 1;
    else high = mid;
  }
  const to = low, from = Math.max(0, to - 1);
  const span = lengths[to] - lengths[from];
  const t = span ? (d - lengths[from]) / span : 0;
  const a = samples[from], b = samples[to];
  const heading = headingAlongSamples(samples, from);
  if (a.floorId !== b.floorId) {
    return { ...b, t: 1, index: to, tip: b.tip || a.tip, heading };
  }
  return {
    floorId: a.floorId,
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    kind: b.kind || a.kind || 'walk',
    tip: b.tip,
    t,
    index: from,
    heading,
  };
}

// Shared decorative arrow placements in drawing units, ordered start -> destination.
// `phase` shifts chevrons forward along the path (wraps every `spacing`) for flow animation.
export const ROUTE_ARROW_SPACING=18;
export const ROUTE_ARROW_SPEED=28; // map units / second toward destination

/** Split a polyline at the closest point to `point`. Both halves include the split vertex. */
export function splitPolylineNearPoint(points, point) {
  if (!Array.isArray(points) || points.length < 2 || !point) {
    return { traveled: [], remaining: points?.length ? points.map(p => [...p]) : [] };
  }
  let bestDist = Infinity, bestI = 1, bestT = 0, bestX = points[0][0], bestY = points[0][1];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / len2)) : 0;
    const x = a[0] + dx * t, y = a[1] + dy * t;
    const d = Math.hypot(point[0] - x, point[1] - y);
    if (d < bestDist) {
      bestDist = d;
      bestI = i;
      bestT = t;
      bestX = x;
      bestY = y;
    }
  }
  const split = [bestX, bestY];
  const traveled = [];
  for (let i = 0; i < bestI; i++) traveled.push([...points[i]]);
  if (bestT > 1e-6) traveled.push(split);
  else if (!traveled.length) traveled.push(split);
  const remaining = [split];
  for (let i = bestI; i < points.length; i++) {
    const p = points[i];
    if (Math.hypot(p[0] - split[0], p[1] - split[1]) < 1e-9) continue;
    remaining.push([...p]);
  }
  if (remaining.length < 2 && bestT < 1 - 1e-6) remaining.push([...points[bestI]]);
  return { traveled, remaining };
}

export function routeArrows(points, spacing=ROUTE_ARROW_SPACING, phase=0){
  if(!Number.isFinite(spacing)||spacing<=0)return [];
  const segments=[];let total=0;
  for(let i=1;i<points.length;i++){
    const a=points[i-1],b=points[i],dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy);
    if(!length)continue;
    segments.push({a,dx:dx/length,dy:dy/length,start:total,length});total+=length;
  }
  const result=[];let index=0;
  const offset=((Number(phase)||0)%spacing+spacing)%spacing;
  for(let distance=8+offset;distance<total-6;distance+=spacing){
    while(index<segments.length-1&&distance>segments[index].start+segments[index].length)index++;
    const s=segments[index],t=distance-s.start;
    result.push({x:s.a[0]+s.dx*t,y:s.a[1]+s.dy*t,angle:Math.atan2(s.dy,s.dx)});
  }
  return result;
}

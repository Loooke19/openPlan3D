"""Reproducible, local PDF-vector -> geometry/mask/topology pipeline.

The named profile is an explicit adapter for this particular PDF, not a generic
floor-plan recognizer. Semantic/demo-door annotations remain separate from code.
"""
from __future__ import annotations

import argparse
from collections import deque
import hashlib
import heapq
import json
import logging
import math
from pathlib import Path
import unicodedata

import numpy as np
import pdfplumber
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
logging.getLogger("pdfminer").setLevel(logging.ERROR)


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def norm(point, size):
    return [round(point[0] / size[0], 7), round(point[1] / size[1], 7)]


def rectangle(r):
    x, y, X, Y = r
    return [(x, y), (X, y), (X, Y), (x, Y)]


def contains(point, polygon):
    x, y = point
    inside = False
    for a, b in zip(polygon, polygon[1:] + polygon[:1]):
        if (a[1] > y) != (b[1] > y) and x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]:
            inside = not inside
    return inside


def closest_boundary(point, polygon):
    candidates = []
    for a,b in zip(polygon,polygon[1:]+polygon[:1]):
        dx,dy = b[0]-a[0],b[1]-a[1]
        denom = dx*dx+dy*dy
        t = max(0,min(1,((point[0]-a[0])*dx+(point[1]-a[1])*dy)/denom)) if denom else 0
        q = [a[0]+t*dx,a[1]+t*dy]
        candidates.append(q)
    return min(candidates,key=lambda p: math.dist(p,point))


def neighbors(p, mask, diagonals=True):
    x, y = p
    h, w = mask.shape
    for dx, dy in [(1,0),(-1,0),(0,1),(0,-1)] + ([(1,1),(1,-1),(-1,1),(-1,-1)] if diagonals else []):
        X, Y = x + dx, y + dy
        if 0 <= X < w and 0 <= Y < h and mask[Y, X]:
            if dx and dy and not (mask[y, X] and mask[Y, x]):
                continue
            yield (X, Y)


def components(mask):
    labels = np.zeros(mask.shape, dtype=np.int32)
    sizes = []
    for y, x in zip(*np.nonzero(mask)):
        if labels[y, x]:
            continue
        label = len(sizes) + 1
        queue = deque([(int(x), int(y))])
        labels[y, x] = label
        count = 0
        while queue:
            p = queue.popleft()
            count += 1
            for X, Y in neighbors(p, mask):
                if not labels[Y, X]:
                    labels[Y, X] = label
                    queue.append((X, Y))
        sizes.append(count)
    return labels, sizes


def skeletonize(mask):
    """Zhang-Suen thinning, with zero padding so page boundaries never wrap."""
    a = np.pad(mask.astype(np.uint8), 1)
    while True:
        removed = 0
        for phase in (0, 1):
            p = [a[:-2,1:-1], a[:-2,2:], a[1:-1,2:], a[2:,2:],
                 a[2:,1:-1], a[2:,:-2], a[1:-1,:-2], a[:-2,:-2]]
            n = sum(p)
            transitions = sum(((p[i] == 0) & (p[(i + 1) % 8] == 1)).astype(np.uint8) for i in range(8))
            if phase == 0:
                guards = (p[0]*p[2]*p[4] == 0) & (p[2]*p[4]*p[6] == 0)
            else:
                guards = (p[0]*p[2]*p[6] == 0) & (p[0]*p[4]*p[6] == 0)
            delete = (a[1:-1,1:-1] == 1) & (n >= 2) & (n <= 6) & (transitions == 1) & guards
            removed += int(delete.sum())
            a[1:-1,1:-1][delete] = 0
        if not removed:
            return a[1:-1,1:-1].astype(bool)


def path_to_skeleton(start, skeleton, mask):
    queue, parents = deque([start]), {start: None}
    while queue:
        p = queue.popleft()
        if skeleton[p[1], p[0]]:
            result = []
            while p is not None:
                result.append(p)
                p = parents[p]
            return result[::-1]
        for q in neighbors(p, mask, diagonals=False):
            if q not in parents:
                parents[q] = p
                queue.append(q)
    return None


def simplify(points):
    if len(points) < 3:
        return points
    result = [points[0]]
    for a, b, c in zip(points, points[1:], points[2:]):
        if (b[0]-a[0], b[1]-a[1]) != (c[0]-b[0], c[1]-b[1]):
            result.append(b)
    return result + [points[-1]]


def extract_geometry(pdf, profile):
    with pdfplumber.open(pdf) as doc:
        page = doc.pages[profile["page"] - 1]
        size = [page.width, page.height]
        if size != profile["pdfSize"]:
            raise ValueError("PDF尺寸与适配配置不符；请创建新profile，不可套用本图边界。")
        boundary = page.curves[profile["boundaryCurveIndex"]]["pts"]
        if len(boundary) != 15 or not contains((400, 500), boundary):
            raise ValueError("PDF绘图结构发生变化，必须重新核对适配配置。")
        obstacles, walls = [], []
        for kind, objects, limit in [("curve", page.curves, profile["architectureCurveLimit"]), ("rect", page.rects, profile["architectureRectLimit"])]:
            for i, obj in enumerate(objects[:limit]):
                if obj["top"] >= 815:
                    continue
                pts = obj["pts"]
                color = obj.get("non_stroking_color")
                matched = isinstance(color, (tuple, list)) and any(max(abs(a-b) for a,b in zip(color, c)) < 0.002 for c in profile["roomColors"])
                if obj["fill"] and matched:
                    obstacles.append({"id": f"{kind}-{i}", "kind": "room" if obj["width"] * obj["height"] > 500 else "counter", "polygonPdf": pts, "color": list(color), "sourceObject": f"{kind}[{i}]"})
                if obj["stroke"]:
                    walls.append(pts)
        # Architectural linework before the decorative symbol layers.
        walls.extend([o["pts"] for o in page.lines[:45] if o["top"] < 815])
        for exclusion in profile["exclusions"]:
            obstacles.append({**exclusion, "polygonPdf": rectangle(exclusion["rect"]), "color": [0.88]*3, "sourceObject": "reviewed-profile"})
        words = [{"text": unicodedata.normalize("NFKC", w["text"]), "bbox": [w["x0"], w["top"], w["x1"], w["bottom"]], "layer": "map" if w["top"] < 815 else "legend", "method": "pdf-text-layer"} for w in page.extract_words(x_tolerance=2, y_tolerance=3)]
    return size, boundary, obstacles, walls, words


def build_mask(size, boundary, obstacles, walls, profile):
    canvas = Image.new("L", tuple(map(int, size)), 0)
    draw = ImageDraw.Draw(canvas)
    draw.polygon(boundary, fill=255)
    for obstacle in obstacles:
        draw.polygon(obstacle["polygonPdf"], fill=0)
    for line in walls:
        if len(line) >= 2:
            draw.line(line, fill=0, width=1)
    for override in profile["walkableOverrides"]:
        draw.polygon(override["polygonPdf"], fill=255)
    # Pixel clearance only; real-world radius is deliberately unknown until calibrated.
    safe = canvas.filter(ImageFilter.MinFilter(2 * profile["clearancePdf"] + 1))
    step = profile["cellSizePdf"]
    arr = np.array(safe) > 0
    h, w = arr.shape
    grid = arr[:h//step*step,:w//step*step].reshape(h//step,step,w//step,step).all(axis=(1,3))
    return canvas, safe, grid


def build_graph(skeleton, mask, forced, cell, size):
    coords = {(int(x),int(y)) for y,x in zip(*np.nonzero(skeleton))}
    adjacent = {p: sorted(q for q in neighbors(p, mask) if q in coords) for p in sorted(coords)}
    junctions = {p for p in coords if len(adjacent[p]) != 2} | forced
    # A closed skeleton ring needs at least one seed to be represented.
    remaining = set(coords)
    while remaining:
        first = min(remaining)
        stack, component = [first], set()
        while stack:
            p = stack.pop()
            if p in component:
                continue
            component.add(p)
            stack.extend(adjacent[p])
        if not component & junctions:
            junctions.add(first)
        remaining -= component
    ids = {p: f"n{i}" for i,p in enumerate(sorted(junctions))}
    def position(p):
        return norm([(p[0]+0.5)*cell, (p[1]+0.5)*cell], size)
    nodes = [{"id": ids[p], "position": position(p), "kind": "junction"} for p in sorted(junctions)]
    edges, seen = [], set()
    for start in sorted(junctions):
        for next_point in adjacent[start]:
            if frozenset((start,next_point)) in seen:
                continue
            chain = [start, next_point]
            seen.add(frozenset(chain))
            while chain[-1] not in junctions:
                a,b = chain[-2:]
                c = next(q for q in adjacent[b] if q != a)
                seen.add(frozenset((b,c)))
                chain.append(c)
            length = sum(math.dist(a,b)*cell for a,b in zip(chain,chain[1:]))
            edges.append({"id": f"e{len(edges)}", "source": ids[start], "target": ids[chain[-1]], "lengthMapUnits": round(length,4), "polyline": [position(p) for p in simplify(chain)], "enabled": True, "mode": "walk", "accessibility": "unknown"})
    return nodes, edges, ids, position


def shortest_path(graph, start, end):
    adjacent = {}
    for e in graph["edges"]:
        if not e["enabled"]:
            continue
        adjacent.setdefault(e["source"], []).append((e["target"], e))
        adjacent.setdefault(e["target"], []).append((e["source"], e))
    distances, parent, queue = {start:0}, {}, [(0,start)]
    while queue:
        d,u = heapq.heappop(queue)
        if d != distances[u]:
            continue
        if u == end:
            path = []
            while u != start:
                v,e = parent[u]
                path.append({"edgeId":e["id"], "reversed":e["source"] != v})
                u = v
            return {"lengthMapUnits":d, "steps":path[::-1]}
        for v,e in adjacent.get(u, []):
            alt = d + e["lengthMapUnits"]
            if alt < distances.get(v, math.inf):
                distances[v], parent[v] = alt, (u,e)
                heapq.heappush(queue,(alt,v))
    return None


def run(profile_path, annotations_path, pdf_path, output):
    profile = json.loads(profile_path.read_text())
    annotations = json.loads(annotations_path.read_text())
    if hashlib.sha256(pdf_path.read_bytes()).hexdigest() != profile["expectedSourceSha256"]:
        raise ValueError("PDF与已审核来源不一致；请更新适配配置而非沿用旧矢量索引。")
    if [annotations["sourceImage"]["width"],annotations["sourceImage"]["height"]] != profile["imageSize"]:
        raise ValueError("标注图片尺寸不匹配")
    size,boundary,obstacles,walls,words = extract_geometry(pdf_path,profile)
    mask,safe,grid = build_mask(size,boundary,obstacles,walls,profile)
    labels,counts = components(grid)
    skeleton = skeletonize(grid)
    forced, attachments, warnings = set(), [], []
    cell = profile["cellSizePdf"]
    all_y, all_x = np.nonzero(grid)
    image_size = profile["imageSize"]
    for poi in annotations["pois"]:
        requested = [poi["anchorPoint"][i]*size[i]/image_size[i] for i in (0,1)]
        # Closest safe sample. Changes are recorded; no unbounded silent snapping.
        distances = ((all_x+0.5)*cell-requested[0])**2 + ((all_y+0.5)*cell-requested[1])**2
        idx = int(np.argmin(distances))
        snap = float(distances[idx]**0.5)
        if snap > 30:
            warnings.append(f"{poi['id']}：候选入口离可走区域过远，未生成连接")
            attachments.append((poi,None,None,snap))
            continue
        point = (int(all_x[idx]), int(all_y[idx]))
        chain = path_to_skeleton(point, skeleton, grid)
        if chain is None:
            warnings.append(f"{poi['id']}：入口所在可走区域无中心线")
        else:
            forced.add(chain[-1])
        attachments.append((poi,point,chain,snap))
    nodes,edges,ids,position = build_graph(skeleton,grid,forced,cell,size)
    pois, doors = [], []
    for poi,point,chain,snap in attachments:
        label_pdf = [poi["labelPoint"][i]*size[i]/image_size[i] for i in (0,1)]
        rooms = [o for o in obstacles if o["kind"] == "room" and contains(label_pdf,o["polygonPdf"])]
        room_id = rooms[0]["id"] if rooms else None
        entry = {**poi,"labelPosition":norm(label_pdf,size),"roomId":room_id,"requestedAnchor":norm([poi["anchorPoint"][i]*size[i]/image_size[i] for i in (0,1)],size),"snapMapUnits":round(snap,2),"floorId":"1F","position":position(point) if point else None,"nodeId":None,"componentId":int(labels[point[1],point[0]]) if point else None}
        entry.pop("labelPoint",None)
        entry.pop("anchorPoint",None)
        entry["confidenceMeaning"] = "name-and-symbol-identification-not-surveyed-door-location"
        if rooms and point and poi["category"] in {"department","shop","reception","pharmacy","service","restroom","accessible-restroom"}:
            arrival_pdf = [(point[0]+.5)*cell,(point[1]+.5)*cell]
            door_pos = closest_boundary(arrival_pdf,rooms[0]["polygonPdf"])
            doors.append({"id":f"door:{poi['id']}","poiId":poi["id"],"obstacleId":room_id,"position":norm(door_pos,size),"corridorAnchor":position(point),"provenance":"demo-placement","opensRoomInterior":False})
        if chain:
            node_id = f"poi:{poi['id']}"
            entry["nodeId"] = node_id
            nodes.append({"id":node_id,"position":position(point),"kind":"poi","poiId":poi["id"]})
            edges.append({"id":f"access:{poi['id']}","source":node_id,"target":ids[chain[-1]],"lengthMapUnits":round(sum(math.dist(a,b)*cell for a,b in zip(chain,chain[1:])),4),"polyline":[position(p) for p in simplify(chain)],"enabled":True,"mode":"walk","accessibility":"unknown"})
        pois.append(entry)
    graph = {"algorithm":"skeleton-topology-with-shortest-path","coordinateSystem":"normalized-top-left","nodes":nodes,"edges":edges}
    document = {"schemaVersion":"1.0.0","id":profile["id"],"name":profile["name"],"status":"demo","floorId":"1F","source":{"url":profile["sourceUrl"],"pdfUrl":profile["pdfUrl"],"pdfSha256":hashlib.sha256(pdf_path.read_bytes()).hexdigest(),"page":1,"pdfSize":size,"imageSize":image_size,"imageUrl":"../source/gifu-1f.png"},"calibration":profile["calibration"],"geometry":{"buildingBoundary":[norm(p,size) for p in boundary],"obstacles":[{**{k:v for k,v in o.items() if k not in ('polygonPdf','rect')},"polygon":[norm(p,size) for p in o["polygonPdf"]]} for o in obstacles],"wallSegments":[[norm(p,size) for p in wall] for wall in walls],"walkableMaskUrl":"../data/walkable-mask.png","safeMaskUrl":"../data/safe-mask.png","clearance":{"value":profile["clearancePdf"],"unit":"pdf-map-unit","physicalRadiusVerified":False}},"pois":pois,"doors":doors,"graph":graph,"notes":profile["notes"]}
    route_samples = []
    source = next((p for p in pois if p["category"] == "entrance" and "主" in p["name"]),pois[0])
    for p in pois:
        route = shortest_path(graph,source["nodeId"],p["nodeId"]) if p["nodeId"] else None
        route_samples.append({"from":source["id"],"to":p["id"],"reachable":route is not None,"route":route})
        if route is None:
            warnings.append(f"{source['id']} → {p['id']}：不连通")
    output.mkdir(parents=True,exist_ok=True)
    mask.save(output/"walkable-mask.png")
    safe.save(output/"safe-mask.png")
    overlay = Image.new("RGBA",mask.size,(0,0,0,0))
    rgba = np.array(overlay)
    rgba[np.array(mask)>0] = [0,162,146,75]
    Image.fromarray(rgba).save(output/"walkable-overlay.png")
    write_json(output/"map.json",document)
    write_json(output/"text-extraction.json",{"page":1,"size":size,"method":"pdf-text-layer-not-OCR","words":words})
    write_json(output/"sample-routes.json",route_samples)
    report = {"sourceHash":document["source"]["pdfSha256"],"poiCount":len(pois),"roomAndObstacleCount":len(obstacles),"textTokenCount":len(words),"walkableComponents":counts,"graphNodes":len(nodes),"graphEdges":len(edges),"reachableFromMainEntrance":sum(r["reachable"] for r in route_samples),"warnings":warnings,"unverified":["真实比例未标定，距离只输出图纸单位","门/服务到达点由模型按Demo要求设置","不推断营业时间、科室权限或无障碍条件","模板适配器不等于任意图纸全自动识别"]}
    write_json(output/"validation-report.json",report)
    print(json.dumps(report,ensure_ascii=False,indent=2))
    return document,grid


if __name__ == "__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf",type=Path,default=ROOT/"source/gifu-hospital-map.pdf")
    parser.add_argument("--profile",type=Path,default=ROOT/"data/gifu-1f-profile.json")
    parser.add_argument("--annotations",type=Path,default=ROOT/"data/gifu-1f-poi-annotations.json")
    parser.add_argument("--output",type=Path,default=ROOT/"data")
    args=parser.parse_args()
    run(args.profile,args.annotations,args.pdf,args.output)

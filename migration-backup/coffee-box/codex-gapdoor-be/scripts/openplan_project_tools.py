"""File-level project tools for the openPlan MCP (no editor tab needed).

They talk to the import server's HTTP API (default http://127.0.0.1:8882, override with
OPENPLAN_IMPORT_API) and go through the same optimistic-concurrency write-back the editor
uses, so a concurrent editor save surfaces as a conflict instead of being overwritten.
"""
from __future__ import annotations

import json
import math
import os
import urllib.error
import urllib.request

TIMEOUT_S = 15


class ToolError(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


def api_base() -> str:
    return os.environ.get("OPENPLAN_IMPORT_API", "http://127.0.0.1:8882").rstrip("/")


def _http(method: str, path: str, body: dict | None = None, base: str | None = None):
    url = (base or api_base()) + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as res:
            return json.loads(res.read() or b"null")
    except urllib.error.HTTPError as exc:
        detail = exc.read()[:300].decode("utf-8", "replace")
        if exc.code == 409:
            raise ToolError("版本冲突：工程刚被别处保存，请重新读取后再改") from exc
        raise ToolError(f"{method} {path} -> {exc.code} {detail}") from exc
    except urllib.error.URLError as exc:
        raise ToolError(f"连不上导入服务 {url}: {exc.reason}") from exc


def _project(pid: str, base=None) -> dict:
    if not isinstance(pid, str) or not pid:
        raise ToolError("projectId 必填")
    return _http("GET", f"/api/projects/{pid}.json", base=base)


def _save(project: dict, base=None) -> dict:
    return _http("PUT", f"/api/projects/{project['id']}.json", {"project": project, "baseRevision": int(project.get("revision") or 0)}, base=base)


def _centroid(poly):
    if not poly:
        return None
    return {"x": round(sum(p["x"] for p in poly) / len(poly), 1), "y": round(sum(p["y"] for p in poly) / len(poly), 1)}


def project_list(base=None) -> dict:
    data = _http("GET", "/api/projects", base=base)
    items = data.get("projects", data) if isinstance(data, dict) else data
    return {"projects": [{"id": p.get("id"), "name": p.get("name"), "floors": p.get("floorCount") or len(p.get("floors") or [])} for p in items or []]}


def project_export(pid: str, base=None) -> dict:
    """Compact model for diffing against truth tables: rooms (names, centroids), doors, links."""
    d = _project(pid, base)
    floors = []
    for f in d.get("floors") or []:
        rooms = []
        walls = {w.get("id"): w for w in f.get("walls") or []}
        for r in f.get("rooms") or []:
            if not (r.get("polygon") or r.get("points")):
                # openPlan rooms reference walls: the centroid of their endpoints is the room centre.
                ends = [w[k] for wid in r.get("walls") or [] if (w := walls.get(wid)) for k in ("start", "end") if isinstance(w.get(k), dict)]
                r = {**r, "points": ends}
            rooms.append({k: v for k, v in {
                "id": r.get("id"), "name": r.get("name"), "displayName": r.get("displayName"),
                "aliases": r.get("aliases"), "area": r.get("area"), "at": _centroid(r.get("polygon") or r.get("points")),
            }.items() if v not in (None, [], "")})
        widths = sorted(round(x.get("width", 0)) for x in f.get("doors") or [])
        pois = [{"id": t.get("id"), "name": t.get("text"), "at": {"x": t.get("x"), "y": t.get("y")}}
                for t in f.get("textAnnotations") or [] if t.get("poi")]
        floors.append({"pois": pois, "id": f.get("id"), "name": f.get("name"), "level": f.get("level"), "rooms": rooms,
                       "doors": len(widths), "doorWidthMedianCm": widths[len(widths) // 2] if widths else None})
    return {"id": d.get("id"), "name": d.get("name"), "revision": d.get("revision"), "northBearing": d.get("northBearing"),
            "floors": floors, "verticalLinks": d.get("verticalLinks") or []}


def project_update_rooms(pid: str, floor_id: str, rooms: list, base=None) -> dict:
    """Patch room name / displayName / aliases by id. displayName '' clears it (falls back to name)."""
    if not isinstance(rooms, list) or not rooms:
        raise ToolError("rooms 必须是非空数组")
    d = _project(pid, base)
    floor = next((f for f in d.get("floors") or [] if f.get("id") == floor_id), None)
    if not floor:
        raise ToolError(f"楼层不存在: {floor_id}")
    by_id = {r.get("id"): r for r in floor.get("rooms") or []}
    changed = []
    for patch in rooms:
        room = by_id.get(patch.get("id"))
        if room is None:
            raise ToolError(f"房间不存在: {patch.get('id')}")
        if "name" in patch:
            room["name"] = str(patch["name"]).strip()
        if "displayName" in patch:
            v = str(patch["displayName"] or "").strip()
            if v:
                room["displayName"] = v
            else:
                room.pop("displayName", None)
        if "aliases" in patch:
            al = [str(a).strip() for a in patch["aliases"] or [] if str(a).strip()]
            if al:
                room["aliases"] = al
            else:
                room.pop("aliases", None)
        if "attachedTo" in patch:  # only reachable through this room: not a destination of its own
            v = str(patch["attachedTo"] or "").strip()
            if v:
                room["attachedTo"] = v
            else:
                room.pop("attachedTo", None)
        if "standalone" in patch:  # force a public destination (never hidden as attached)
            if patch["standalone"]:
                room["standalone"] = True
            else:
                room.pop("standalone", None)
        changed.append(room["id"])
    saved = _save(d, base)
    return {"changed": changed, "revision": saved.get("revision")}


def project_set_vertical_links(pid: str, links: list, base=None) -> dict:
    """Replace stair/lift connectivity: [{kind: stairs|elevator, name, stops:[{floorId,x,y}]}]."""
    return _http("PUT", f"/api/projects/{pid}/vertical-links", {"links": links}, base=base)


def project_set_restricted_zones(pid: str, zones: list, base=None) -> dict:
    """Replace 限制通行区: [{floorId, polygon:[{x,y}], name?, provisional?}]; survives re-import."""
    return _http("POST", f"/api/projects/{pid}/restricted-zones", {"zones": zones}, base=base)


def project_set_orientation(pid: str, north_bearing, base=None) -> dict:
    return _http("PUT", f"/api/projects/{pid}/orientation", {"northBearing": north_bearing}, base=base)


def _scale_point(p, k):
    if isinstance(p, dict) and isinstance(p.get("x"), (int, float)) and isinstance(p.get("y"), (int, float)):
        p["x"] = round(p["x"] * k, 2)
        p["y"] = round(p["y"] * k, 2)


def project_calibrate_scale(pid: str, measured_cm: float, true_cm: float, base=None) -> dict:
    """Rescale plan coordinates so a length that measures `measured_cm` becomes `true_cm`
    (e.g. a door read as 75 cm that is really 90 cm). Heights are left alone."""
    if not (isinstance(measured_cm, (int, float)) and isinstance(true_cm, (int, float)) and measured_cm > 0 and true_cm > 0):
        raise ToolError("measuredCm / trueCm 必须是正数")
    k = true_cm / measured_cm
    if not 0.05 <= k <= 20:
        raise ToolError(f"比例 {k:.3f} 不合理")
    d = _project(pid, base)
    for f in d.get("floors") or []:
        for w in f.get("walls") or []:
            _scale_point(w.get("start"), k)
            _scale_point(w.get("end"), k)
        for key in ("doors", "windows"):
            for o in f.get(key) or []:
                if isinstance(o.get("width"), (int, float)):
                    o["width"] = round(o["width"] * k, 1)
        for r in f.get("rooms") or []:
            for pkey in ("polygon", "points"):
                for p in r.get(pkey) or []:
                    _scale_point(p, k)
            if isinstance(r.get("area"), (int, float)):
                r["area"] = round(r["area"] * k * k, 3)
        for key in ("stairs", "columns", "furniture"):
            for item in f.get(key) or []:
                _scale_point(item.get("position"), k)
    saved = _save(d, base)
    links = d.get("verticalLinks") or []
    for link in links:
        for s in link.get("stops") or []:
            _scale_point(s, k)
    if links:
        project_set_vertical_links(pid, links, base)
    return {"factor": round(k, 5), "revision": saved.get("revision")}


def project_draw_room(pid: str, floor_id: str, rect: list, name: str, display_name: str = "", door=None, base=None,
                      open_sides=None, clear_inside=False) -> dict:
    """Trace a room the importer missed: axis-aligned rect [{x,y}..] in plan cm, its printed name,
    optional door point {x,y}. Sides snap to imported walls; missing sides become partitions.
    Persisted per PDF so re-imports re-draw it."""
    import draw_rooms
    if not (isinstance(rect, list) and len(rect) >= 2 and name):
        raise ToolError("rect（至少两个角点）和 name 必填")
    d = _project(pid, base)
    floor = next((f for f in d.get("floors") or [] if f.get("id") == floor_id), None)
    if not floor:
        raise ToolError(f"楼层不存在: {floor_id}")
    room = draw_rooms.add_drawn_room(floor, rect, str(name).strip(), str(display_name or "").strip(), door,
                                      open_sides=[x for x in (open_sides or []) if x in ("n", "s", "w", "e")],
                                      clear_inside=bool(clear_inside))
    if door:
        room["doorAt"] = door
    saved = _save(d, base)
    return {"room": room["id"], "polygon": room["floorPolygon"], "walls": room["walls"], "revision": saved.get("revision")}


def project_remove_drawn_room(pid: str, floor_id: str, room_id: str, base=None) -> dict:
    """Undo a drawn room (its partitions and door too)."""
    import draw_rooms
    d = _project(pid, base)
    floor = next((f for f in d.get("floors") or [] if f.get("id") == floor_id), None)
    if not floor or not draw_rooms.remove_drawn_room(floor, room_id):
        raise ToolError(f"没有这个补画房间: {room_id}")
    saved = _save(d, base)
    return {"removed": room_id, "revision": saved.get("revision")}


TOOLS = {
    "project_list": (lambda a: project_list(), "列出导入服务里的工程（不需要打开编辑器）。", {}),
    "project_export": (lambda a: project_export(a.get("projectId")), "导出工程模型摘要（房间名/显示名/别名/中心点、门数、楼梯电梯连通、指北方向），用于与人工对照表比对。",
                       {"projectId": {"type": "string"}}),
    "project_update_rooms": (lambda a: project_update_rooms(a.get("projectId"), a.get("floorId"), a.get("rooms")),
                             "按 id 改房间 name（图上原名）/ displayName（导航显示名，'' 清除）/ aliases。走编辑器同一写回通道，冲突返回错误。",
                             {"projectId": {"type": "string"}, "floorId": {"type": "string"}, "rooms": {"type": "array", "items": {"type": "object"}}}),
    "project_set_vertical_links": (lambda a: project_set_vertical_links(a.get("projectId"), a.get("links")),
                                   "整体替换楼梯/电梯连通：[{kind: stairs|elevator, name, stops:[{floorId,x,y}]}]，每部至少 2 站。",
                                   {"projectId": {"type": "string"}, "links": {"type": "array", "items": {"type": "object"}}}),
    "project_set_restricted_zones": (lambda a: project_set_restricted_zones(a.get("projectId"), a.get("zones")),
                                     "整体替换限制通行区（如发热/感染控制区）：[{floorId, polygon:[{x,y}], name, provisional}]。导航默认绕开，终点在区内才进入；区内楼梯同样受限。重新导入同一 PDF 后保留。",
                                     {"projectId": {"type": "string"}, "zones": {"type": "array", "items": {"type": "object"}}}),
    "project_set_orientation": (lambda a: project_set_orientation(a.get("projectId"), a.get("northBearing")),
                                "设置指北方向：图上北方的方位角（0=图上方，90=右，270=左）；null=未知（导航不说东西南北，改用 A/B）。",
                                {"projectId": {"type": "string"}, "northBearing": {"type": ["number", "null"]}}),
    "project_calibrate_scale": (lambda a: project_calibrate_scale(a.get("projectId"), a.get("measuredCm"), a.get("trueCm")),
                                "按已知长度校准比例：图上量得 measuredCm 的长度实际是 trueCm（如门宽 90）。整体缩放平面坐标。",
                                {"projectId": {"type": "string"}, "measuredCm": {"type": "number"}, "trueCm": {"type": "number"}}),
    "project_remove_drawn_room": (lambda a: project_remove_drawn_room(a.get("projectId"), a.get("floorId"), a.get("roomId")),
                                  "撤销一个补画的房间（连同补的隔墙和门）。", {"projectId": {"type": "string"}, "floorId": {"type": "string"}, "roomId": {"type": "string"}}),
    "project_draw_room": (lambda a: project_draw_room(a.get("projectId"), a.get("floorId"), a.get("rect"), a.get("name"), a.get("displayName") or "", a.get("door"), open_sides=a.get("openSides"), clear_inside=a.get("clearInside")),
                          "补画导入漏掉的房间：rect 为平面坐标(cm)的矩形角点，name 为图上名称，door 可选门位置 {x,y}。边贴合已有墙，缺的边补隔墙；按 PDF 记住，重新导入后自动补回。",
                          {"projectId": {"type": "string"}, "floorId": {"type": "string"}, "rect": {"type": "array", "items": {"type": "object"}},
                           "name": {"type": "string"}, "displayName": {"type": "string"}, "door": {"type": "object"}}),
}


def tool_specs() -> list[dict]:
    return [{"name": n, "description": desc, "inputSchema": {"type": "object", "properties": props, "additionalProperties": False}}
            for n, (_fn, desc, props) in TOOLS.items()]

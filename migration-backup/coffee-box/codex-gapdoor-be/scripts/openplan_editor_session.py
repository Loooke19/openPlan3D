"""In-memory session hub for the openPlan editor MCP.

The open editor is the source of truth. This module checks patches against the
last snapshot, queues them, and waits until the page applies them through the
editor store. It does not write ``data/kujiale-import`` and it does not talk
to the upstream share MCP.
"""
from __future__ import annotations

import threading
import time
import uuid
from typing import Any
from urllib.parse import urlparse

DEFAULT_PORT = 8879
DEFAULT_ORIGIN = f"http://127.0.0.1:{DEFAULT_PORT}"
DETAIL_LIMIT = 200
MAX_PATCHES = 400
SNAPSHOT_STALE_S = 20
TOOL_TIMEOUT_S = 8

DOOR_TYPES = frozenset({"single", "double", "sliding", "french", "pocket", "bifold", "opening", "garage"})
WINDOW_TYPES = frozenset({"standard", "fixed", "casement", "sliding", "bay"})
WALL_FIELDS = frozenset({"id", "start", "end", "thickness", "height", "color", "interiorColor", "exteriorColor"})
DOOR_FIELDS = frozenset({"id", "wallId", "position", "width", "height", "type"})
WINDOW_FIELDS = frozenset({"id", "wallId", "position", "width", "height", "sillHeight", "type"})
ROOM_FIELDS = frozenset({"id", "name", "color", "floorTexture"})
NEW_WALL_FIELDS = frozenset({"id", "start", "end", "thickness", "height", "color"})
UPSERT_ROOM_FIELDS = frozenset({"id", "name", "color", "floorTexture", "walls", "area", "floorOpening"})
FLOOR_TEXTURES = frozenset({
    "none", "light-oak", "walnut", "bamboo", "laminate",
    "ceramic-white", "ceramic-gray", "porcelain",
    "marble-white", "marble-dark", "carpet-beige", "carpet-gray",
    "concrete", "slate", "vinyl", "hardwood", "tile",
})


class SessionError(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


def loopback_http_url(value: str) -> bool:
    try:
        parsed = urlparse(value)
    except Exception:
        return False
    if parsed.scheme != "http" or parsed.username or parsed.password:
        return False
    return parsed.hostname in ("127.0.0.1", "localhost") and bool(parsed.path)


def _num(value: Any) -> bool:
    return type(value) in (int, float) and value == value and value not in (float("inf"), float("-inf"))


def _point(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and set(value) <= {"x", "y"}
        and _num(value.get("x"))
        and _num(value.get("y"))
    )


def _color(value: Any) -> bool:
    if not isinstance(value, str) or len(value) not in (4, 7) or not value.startswith("#"):
        return False
    hexes = value[1:]
    return all(ch in "0123456789abcdefABCDEF" for ch in hexes)


def _text(value: Any, limit: int) -> bool:
    return isinstance(value, str) and 0 < len(value) <= limit and "\n" not in value and "\r" not in value


def _lists(floor: dict) -> None:
    for key in ("walls", "doors", "windows", "rooms", "stairs"):
        if key not in floor or floor[key] is None:
            floor[key] = []
        if not isinstance(floor[key], list):
            raise SessionError(f"楼层字段不是数组: {key}")


def normalize_project(project: Any) -> dict:
    if not isinstance(project, dict):
        raise SessionError("工程不是 JSON 对象")
    if not isinstance(project.get("id"), str) or not project["id"]:
        raise SessionError("工程缺少 id")
    floors = project.get("floors")
    if not isinstance(floors, list) or not floors:
        raise SessionError("工程没有楼层")
    for floor in floors:
        if not isinstance(floor, dict) or not isinstance(floor.get("id"), str):
            raise SessionError("楼层缺少 id")
        _lists(floor)
    active = project.get("activeFloorId")
    if not isinstance(active, str) or not any(floor["id"] == active for floor in floors):
        raise SessionError("activeFloorId 不在楼层里")
    return project


def _floor(project: dict, floor_id: str | None) -> dict:
    chosen = floor_id or project.get("activeFloorId")
    for floor in project["floors"]:
        if floor["id"] == chosen:
            return floor
    raise SessionError(f"楼层不存在: {chosen}")


def _bbox(floor: dict) -> dict | None:
    xs: list[float] = []
    ys: list[float] = []
    for wall in floor["walls"]:
        if not isinstance(wall, dict):
            continue
        for key in ("start", "end"):
            point = wall.get(key)
            if _point(point):
                xs.append(float(point["x"]))
                ys.append(float(point["y"]))
    if not xs:
        return None
    return {"minX": min(xs), "minY": min(ys), "maxX": max(xs), "maxY": max(ys)}


def summarize_project(project: dict, session_id: str, age_s: float) -> dict:
    floors = []
    for floor in project["floors"]:
        floors.append({
            "id": floor["id"],
            "name": floor.get("name") or "",
            "level": floor.get("level"),
            "walls": len(floor["walls"]),
            "doors": len(floor["doors"]),
            "windows": len(floor["windows"]),
            "rooms": len(floor["rooms"]),
            "stairs": len(floor["stairs"]),
        })
    active = _floor(project, None)
    return {
        "sessionId": session_id,
        "projectId": project["id"],
        "name": project.get("name") or "",
        "activeFloorId": project["activeFloorId"],
        "updatedAt": project.get("updatedAt"),
        "stale": age_s > 5,
        "floors": floors,
        "bbox": _bbox(active),
    }


def _compact_wall(wall: dict) -> dict:
    return {
        "id": wall.get("id"),
        "start": wall.get("start"),
        "end": wall.get("end"),
        "thickness": wall.get("thickness"),
        "height": wall.get("height"),
        "color": wall.get("color"),
    }


def _compact_opening(item: dict, kind: str) -> dict:
    row = {
        "id": item.get("id"),
        "kind": kind,
        "wallId": item.get("wallId"),
        "position": item.get("position"),
        "width": item.get("width"),
        "height": item.get("height"),
        "type": item.get("type"),
    }
    if kind == "window":
        row["sillHeight"] = item.get("sillHeight")
    return row


def _compact_room(room: dict) -> dict:
    row = {
        "id": room.get("id"),
        "name": room.get("name") or "",
        "color": room.get("color"),
        "floorTexture": room.get("floorTexture"),
        "walls": list(room.get("walls") or []),
    }
    polygon = room.get("floorPolygon")
    if isinstance(polygon, list):
        row["floorFacePoints"] = len(polygon)
    return row


def floor_detail(project: dict, floor_id: str | None, ids: list[str] | None, limit: int = DETAIL_LIMIT) -> dict:
    floor = _floor(project, floor_id)
    wanted = set(ids or [])
    walls = [wall for wall in floor["walls"] if isinstance(wall, dict) and (not wanted or wall.get("id") in wanted)]
    doors = [door for door in floor["doors"] if isinstance(door, dict) and (not wanted or door.get("id") in wanted)]
    windows = [item for item in floor["windows"] if isinstance(item, dict) and (not wanted or item.get("id") in wanted)]
    rooms = [room for room in floor["rooms"] if isinstance(room, dict) and (not wanted or room.get("id") in wanted)]
    truncated = not wanted and (len(walls) > limit or len(doors) > limit or len(windows) > limit or len(rooms) > limit)
    detail = {
        "floorId": floor["id"],
        "name": floor.get("name") or "",
        "truncated": truncated,
        "counts": {
            "walls": len(floor["walls"]),
            "doors": len(floor["doors"]),
            "windows": len(floor["windows"]),
            "rooms": len(floor["rooms"]),
        },
    }
    if truncated:
        detail["wallIds"] = [wall.get("id") for wall in floor["walls"] if isinstance(wall, dict)]
        detail["note"] = f"超过 {limit}，请用 ids 取明细"
        return detail
    detail["walls"] = [_compact_wall(wall) for wall in walls[:limit]]
    detail["doors"] = [_compact_opening(door, "door") for door in doors[:limit]]
    detail["windows"] = [_compact_opening(item, "window") for item in windows[:limit]]
    detail["rooms"] = [_compact_room(room) for room in rooms[:limit]]
    return detail


def _require_fields(patch: dict, allowed: frozenset[str], label: str) -> None:
    if not isinstance(patch, dict):
        raise SessionError(f"{label} 不是对象")
    extra = set(patch) - allowed
    if extra:
        raise SessionError(f"{label} 有不支持的字段: {', '.join(sorted(extra))}")


def _wall_updates(patch: dict, existing: dict) -> dict:
    _require_fields(patch, WALL_FIELDS, "墙")
    if not isinstance(patch.get("id"), str) or not patch["id"]:
        raise SessionError("墙缺少 id")
    if patch["id"] != existing.get("id"):
        raise SessionError("墙 id 不一致")
    updates: dict[str, Any] = {}
    for key in ("start", "end"):
        if key in patch:
            if not _point(patch[key]):
                raise SessionError(f"墙 {patch['id']} 的 {key} 不是坐标")
            updates[key] = {"x": float(patch[key]["x"]), "y": float(patch[key]["y"])}
    start = updates.get("start") or existing.get("start")
    end = updates.get("end") or existing.get("end")
    if _point(start) and _point(end) and start["x"] == end["x"] and start["y"] == end["y"]:
        raise SessionError(f"墙 {patch['id']} 长度为 0")
    if "thickness" in patch:
        if not _num(patch["thickness"]) or not (0 < float(patch["thickness"]) <= 200):
            raise SessionError(f"墙 {patch['id']} 厚度无效")
        updates["thickness"] = float(patch["thickness"])
    if "height" in patch:
        if not _num(patch["height"]) or not (0 <= float(patch["height"]) <= 2000):
            raise SessionError(f"墙 {patch['id']} 高度无效")
        updates["height"] = float(patch["height"])
    for key in ("color", "interiorColor", "exteriorColor"):
        if key in patch:
            if not _color(patch[key]):
                raise SessionError(f"墙 {patch['id']} 颜色无效")
            updates[key] = patch[key]
    if not updates:
        raise SessionError(f"墙 {patch['id']} 没有可改的字段")
    return updates


def validate_wall_patches(project: dict, floor_id: str | None, patches: Any) -> dict:
    if not isinstance(patches, list) or not patches:
        raise SessionError("patches 不能为空")
    if len(patches) > MAX_PATCHES:
        raise SessionError(f"一次最多改 {MAX_PATCHES} 面墙")
    floor = _floor(project, floor_id)
    by_id = {wall.get("id"): wall for wall in floor["walls"] if isinstance(wall, dict)}
    cleaned = []
    for patch in patches:
        if not isinstance(patch, dict) or patch.get("id") not in by_id:
            missing = patch.get("id") if isinstance(patch, dict) else None
            raise SessionError(f"墙不存在: {missing}")
        updates = _wall_updates(patch, by_id[patch["id"]])
        cleaned.append({"id": patch["id"], **updates})
    return {"op": "set_walls", "floorId": floor["id"], "patches": cleaned}


def _opening_updates(patch: dict, kind: str, wall_ids: set[str], existing: dict | None) -> dict:
    allowed = DOOR_FIELDS if kind == "door" else WINDOW_FIELDS
    types = DOOR_TYPES if kind == "door" else WINDOW_TYPES
    label = "门" if kind == "door" else "窗"
    _require_fields(patch, allowed, label)
    creating = existing is None
    if creating:
        if not isinstance(patch.get("wallId"), str) or patch["wallId"] not in wall_ids:
            raise SessionError(f"{label} 的 wallId 不存在")
        if "position" not in patch:
            raise SessionError(f"新建{label}需要 position")
    updates: dict[str, Any] = {}
    if "wallId" in patch:
        if not isinstance(patch["wallId"], str) or patch["wallId"] not in wall_ids:
            raise SessionError(f"{label} 的 wallId 不存在")
        updates["wallId"] = patch["wallId"]
    if "position" in patch:
        if not _num(patch["position"]) or not (0 <= float(patch["position"]) <= 1):
            raise SessionError("position 超出 [0,1]，已拒绝")
        updates["position"] = float(patch["position"])
    for key, upper in (("width", 1000), ("height", 1000)):
        if key in patch:
            if not _num(patch[key]) or not (0 < float(patch[key]) <= upper):
                raise SessionError(f"{label} {key} 无效")
            updates[key] = float(patch[key])
    if kind == "window" and "sillHeight" in patch:
        if not _num(patch["sillHeight"]) or not (0 <= float(patch["sillHeight"]) <= 2000):
            raise SessionError("窗 sillHeight 无效")
        updates["sillHeight"] = float(patch["sillHeight"])
    if "type" in patch:
        if patch["type"] not in types:
            raise SessionError(f"{label} type 无效")
        updates["type"] = patch["type"]
    if not creating and not updates:
        raise SessionError(f"{label}没有可改的字段")
    if "id" in patch and patch["id"] is not None and not isinstance(patch["id"], str):
        raise SessionError(f"{label} id 无效")
    row = {"kind": kind, **updates}
    if isinstance(patch.get("id"), str) and patch["id"]:
        row["id"] = patch["id"]
    row["create"] = creating
    return row


def validate_openings(project: dict, floor_id: str | None, doors: Any, windows: Any) -> dict:
    door_list = doors or []
    window_list = windows or []
    if doors is None and windows is None:
        raise SessionError("需要 doors 或 windows")
    if not isinstance(door_list, list) or not isinstance(window_list, list):
        raise SessionError("doors / windows 必须是数组")
    if not door_list and not window_list:
        raise SessionError("没有要改的门窗")
    if len(door_list) + len(window_list) > MAX_PATCHES:
        raise SessionError(f"一次最多改 {MAX_PATCHES} 个门窗")
    floor = _floor(project, floor_id)
    wall_ids = {wall.get("id") for wall in floor["walls"] if isinstance(wall, dict)}
    door_ids = {door.get("id"): door for door in floor["doors"] if isinstance(door, dict)}
    window_ids = {item.get("id"): item for item in floor["windows"] if isinstance(item, dict)}
    cleaned = []
    for patch in door_list:
        if not isinstance(patch, dict):
            raise SessionError("门不是对象")
        ident = patch.get("id")
        if isinstance(ident, str) and ident:
            if ident not in door_ids:
                raise SessionError(f"门不存在: {ident}")
            cleaned.append(_opening_updates(patch, "door", wall_ids, door_ids[ident]))
        else:
            cleaned.append(_opening_updates(patch, "door", wall_ids, None))
    for patch in window_list:
        if not isinstance(patch, dict):
            raise SessionError("窗不是对象")
        ident = patch.get("id")
        if isinstance(ident, str) and ident:
            if ident not in window_ids:
                raise SessionError(f"窗不存在: {ident}")
            cleaned.append(_opening_updates(patch, "window", wall_ids, window_ids[ident]))
        else:
            cleaned.append(_opening_updates(patch, "window", wall_ids, None))
    return {"op": "set_openings", "floorId": floor["id"], "openings": cleaned}


def validate_room(project: dict, floor_id: str | None, patch: Any) -> dict:
    if not isinstance(patch, dict):
        raise SessionError("房间不是对象")
    _require_fields(patch, ROOM_FIELDS, "房间")
    if not isinstance(patch.get("id"), str) or not patch["id"]:
        raise SessionError("房间缺少 id")
    floor = _floor(project, floor_id)
    if not any(isinstance(room, dict) and room.get("id") == patch["id"] for room in floor["rooms"]):
        raise SessionError("房间不存在，不会新建房间")
    updates: dict[str, Any] = {"id": patch["id"]}
    if "name" in patch:
        if not isinstance(patch["name"], str) or len(patch["name"]) > 80 or "\n" in patch["name"]:
            raise SessionError("房间名无效")
        updates["name"] = patch["name"]
    if "color" in patch:
        if not _color(patch["color"]):
            raise SessionError("房间颜色无效")
        updates["color"] = patch["color"]
    if "floorTexture" in patch:
        if not _text(patch["floorTexture"], 64):
            raise SessionError("floorTexture 无效")
        updates["floorTexture"] = patch["floorTexture"]
    if len(updates) == 1:
        raise SessionError("房间没有可改的字段")
    return {"op": "set_room", "floorId": floor["id"], "room": updates}


def validate_new_walls(project: dict, floor_id: str | None, walls: Any) -> dict:
    if not isinstance(walls, list) or not walls:
        raise SessionError("walls 不能为空")
    if len(walls) > MAX_PATCHES:
        raise SessionError(f"一次最多加 {MAX_PATCHES} 面墙")
    floor = _floor(project, floor_id)
    existing = {wall.get("id") for wall in floor["walls"] if isinstance(wall, dict)}
    cleaned = []
    seen = set()
    for wall in walls:
        if not isinstance(wall, dict):
            raise SessionError("墙不是对象")
        _require_fields(wall, NEW_WALL_FIELDS, "墙")
        if not _point(wall.get("start")) or not _point(wall.get("end")):
            raise SessionError("新墙需要 start 和 end")
        start, end = wall["start"], wall["end"]
        if float(start["x"]) == float(end["x"]) and float(start["y"]) == float(end["y"]):
            raise SessionError("新墙长度为 0")
        row: dict[str, Any] = {
            "start": {"x": float(start["x"]), "y": float(start["y"])},
            "end": {"x": float(end["x"]), "y": float(end["y"])},
        }
        if "id" in wall and wall["id"] is not None:
            if not isinstance(wall["id"], str) or not wall["id"] or len(wall["id"]) > 80:
                raise SessionError("新墙 id 无效")
            if wall["id"] in existing or wall["id"] in seen:
                raise SessionError(f"墙 id 已存在: {wall['id']}")
            row["id"] = wall["id"]
            seen.add(wall["id"])
        if "thickness" in wall:
            if not _num(wall["thickness"]) or not (0 < float(wall["thickness"]) <= 200):
                raise SessionError("新墙厚度无效")
            row["thickness"] = float(wall["thickness"])
        if "height" in wall:
            if not _num(wall["height"]) or not (0 <= float(wall["height"]) <= 2000):
                raise SessionError("新墙高度无效")
            row["height"] = float(wall["height"])
        if "color" in wall:
            if not _color(wall["color"]):
                raise SessionError("新墙颜色无效")
            row["color"] = wall["color"]
        cleaned.append(row)
    return {"op": "add_walls", "floorId": floor["id"], "walls": cleaned}


def validate_upsert_rooms(project: dict, floor_id: str | None, rooms: Any) -> dict:
    if not isinstance(rooms, list) or not rooms:
        raise SessionError("rooms 不能为空")
    if len(rooms) > MAX_PATCHES:
        raise SessionError(f"一次最多改 {MAX_PATCHES} 个房间")
    floor = _floor(project, floor_id)
    wall_ids = {wall.get("id") for wall in floor["walls"] if isinstance(wall, dict)}
    room_ids = {room.get("id") for room in floor["rooms"] if isinstance(room, dict)}
    cleaned = []
    seen = set()
    for room in rooms:
        if not isinstance(room, dict):
            raise SessionError("房间不是对象")
        _require_fields(room, UPSERT_ROOM_FIELDS, "房间")
        if not isinstance(room.get("id"), str) or not room["id"] or len(room["id"]) > 80 or room["id"] in seen:
            raise SessionError("房间 id 无效")
        seen.add(room["id"])
        creating = room["id"] not in room_ids
        row: dict[str, Any] = {"id": room["id"], "create": creating}
        if "name" in room:
            if not isinstance(room["name"], str) or len(room["name"]) > 80 or "\n" in room["name"] or "\r" in room["name"]:
                raise SessionError("房间名无效")
            row["name"] = room["name"]
        if "color" in room:
            if not _color(room["color"]):
                raise SessionError("房间颜色无效")
            row["color"] = room["color"]
        if "floorTexture" in room:
            if room["floorTexture"] not in FLOOR_TEXTURES:
                raise SessionError("floorTexture 无效")
            row["floorTexture"] = room["floorTexture"]
        if "walls" in room:
            walls = room["walls"]
            if not isinstance(walls, list) or not walls or len(walls) > 80 or not all(isinstance(item, str) and item in wall_ids for item in walls):
                raise SessionError("房间 walls 必须是已有墙 id")
            row["walls"] = list(walls)
        elif creating:
            raise SessionError("新建房间需要 walls")
        if "area" in room:
            if not _num(room["area"]) or float(room["area"]) < 0:
                raise SessionError("房间面积无效")
            row["area"] = float(room["area"])
        if "floorOpening" in room:
            if not isinstance(room["floorOpening"], bool):
                raise SessionError("floorOpening 无效")
            row["floorOpening"] = room["floorOpening"]
        if creating and "floorTexture" not in row:
            row["floorTexture"] = "none"
        if not creating and len(row) == 2:
            raise SessionError("房间没有可改的字段")
        cleaned.append(row)
    return {"op": "upsert_rooms", "floorId": floor["id"], "rooms": cleaned}


def validate_room_face(project: dict, floor_id: str | None, arguments: Any) -> dict:
    if not isinstance(arguments, dict):
        raise SessionError("房间面不是对象")
    polygon = arguments.get("polygon")
    if not isinstance(polygon, list) or not (3 <= len(polygon) <= 80):
        raise SessionError("房间面至少要 3 个点")
    points = []
    for point in polygon:
        if not _point(point):
            raise SessionError("房间面顶点无效")
        points.append({"x": float(point["x"]), "y": float(point["y"])})
    signed = 0.0
    for index, point in enumerate(points):
        nxt = points[(index + 1) % len(points)]
        signed += point["x"] * nxt["y"] - nxt["x"] * point["y"]
    if abs(signed) < 1:
        raise SessionError("房间面面积为 0")
    floor = _floor(project, floor_id)
    existing = {room.get("id") for room in floor["rooms"] if isinstance(room, dict)}
    face: dict[str, Any] = {"polygon": points}
    if "id" in arguments and arguments["id"] is not None:
        if not isinstance(arguments["id"], str) or not arguments["id"] or len(arguments["id"]) > 80:
            raise SessionError("房间 id 无效")
        if arguments["id"] in existing:
            raise SessionError(f"房间 id 已存在: {arguments['id']}")
        face["id"] = arguments["id"]
    if "name" in arguments and arguments["name"] is not None:
        if not isinstance(arguments["name"], str) or len(arguments["name"]) > 80 or "\n" in arguments["name"]:
            raise SessionError("房间名无效")
        face["name"] = arguments["name"]
    if "color" in arguments and arguments["color"] is not None:
        if not _color(arguments["color"]):
            raise SessionError("房间颜色无效")
        face["color"] = arguments["color"]
    if "floorTexture" in arguments and arguments["floorTexture"] is not None:
        if arguments["floorTexture"] not in FLOOR_TEXTURES:
            raise SessionError("floorTexture 无效")
        face["floorTexture"] = arguments["floorTexture"]
    return {"op": "add_room_face", "floorId": floor["id"], "face": face}


def validate_screenshot(view: Any) -> dict:
    if view is None or view == "":
        view = "3d"
    if view not in {"2d", "3d", "both"}:
        raise SessionError("view 只能是 2d、3d 或 both")
    return {"op": "screenshot", "view": view}


def validate_load(project_url: Any) -> dict:
    if not isinstance(project_url, str) or not loopback_http_url(project_url):
        raise SessionError("projectUrl 只能是本机 http 地址")
    return {"op": "load_project", "projectUrl": project_url}


class Hub:
    def __init__(self):
        self._lock = threading.Lock()
        self.sessions: dict[str, dict] = {}
        self._waiters: dict[str, threading.Event] = {}
        self._results: dict[str, dict] = {}

    def snapshot(self, session_id: str, project: dict | None, editor: str, heartbeat: bool) -> dict:
        if not isinstance(session_id, str) or not session_id or len(session_id) > 80:
            raise SessionError("sessionId 无效")
        now = time.time()
        with self._lock:
            current = self.sessions.get(session_id)
            if heartbeat:
                if current is None:
                    raise SessionError("会话不存在")
                current["seen"] = now
                if editor:
                    current["editor"] = editor
                return {"ok": True, "sessionId": session_id, "rev": current["rev"]}
            project = normalize_project(project)
            rev = 1 if current is None else current["rev"] + 1
            queued = [] if current is None else current["queued"]
            self.sessions[session_id] = {
                "project": project,
                "editor": editor,
                "seen": now,
                "rev": rev,
                "queued": queued,
            }
            return {"ok": True, "sessionId": session_id, "rev": rev}

    def _live(self, now: float) -> list[tuple[str, dict]]:
        return [
            (session_id, row)
            for session_id, row in self.sessions.items()
            if now - row["seen"] <= SNAPSHOT_STALE_S and row.get("project")
        ]

    def pick_session(self, session_id: str | None) -> tuple[str, dict]:
        now = time.time()
        with self._lock:
            live = self._live(now)
            if session_id:
                row = self.sessions.get(session_id)
                if row is None or now - row["seen"] > SNAPSHOT_STALE_S or not row.get("project"):
                    raise SessionError("没有打开的编辑器会话")
                return session_id, row
            if not live:
                raise SessionError("没有打开的编辑器会话")
            if len(live) > 1:
                raise SessionError("有多个编辑器会话，请传 sessionId")
            return live[0]

    def list_sessions(self) -> list[dict]:
        now = time.time()
        with self._lock:
            rows = []
            for session_id, row in self._live(now):
                project = row["project"]
                summary = summarize_project(project, session_id, now - row["seen"])
                summary["editor"] = row.get("editor") or ""
                summary["rev"] = row["rev"]
                rows.append(summary)
            return rows

    def read_project(self, session_id: str | None) -> tuple[str, dict, float]:
        sid, row = self.pick_session(session_id)
        age = time.time() - row["seen"]
        return sid, row["project"], age

    def submit(self, session_id: str | None, command: dict, timeout: float = TOOL_TIMEOUT_S) -> dict:
        sid, picked = self.pick_session(session_id)
        if time.time() - picked["seen"] > SNAPSHOT_STALE_S:
            # A background/closed tab stops polling: fail fast instead of blocking the caller.
            raise SessionError("编辑器会话已过期（页面在后台或已关闭）；请切回编辑器页，或改用 project_* 工具直接改工程文件")
        command = dict(command)
        command["id"] = uuid.uuid4().hex
        event = threading.Event()
        with self._lock:
            row = self.sessions.get(sid)
            if row is None:
                raise SessionError("没有打开的编辑器会话")
            self._waiters[command["id"]] = event
            row["queued"].append(command)
        if not event.wait(timeout):
            with self._lock:
                self._waiters.pop(command["id"], None)
                row = self.sessions.get(sid)
                if row is not None:
                    row["queued"] = [item for item in row["queued"] if item["id"] != command["id"]]
            raise SessionError("编辑器未在时限内应用")
        with self._lock:
            return self._results.pop(command["id"])

    def poll(self, session_id: str) -> list[dict]:
        with self._lock:
            row = self.sessions.get(session_id)
            if row is None:
                raise SessionError("会话不存在")
            queued = list(row["queued"])
            row["queued"] = []
            return queued

    def ack(self, session_id: str, command_id: str, ok: bool, error: str | None, summary: dict | None, project: dict | None) -> None:
        with self._lock:
            event = self._waiters.get(command_id)
            if event is None:
                raise SessionError("命令不存在或已结束")
            if project is not None:
                project = normalize_project(project)
                row = self.sessions.get(session_id)
                if row is not None:
                    row["project"] = project
                    row["seen"] = time.time()
                    row["rev"] += 1
            self._results[command_id] = {
                "ok": bool(ok),
                "error": error,
                "summary": summary or {},
                "sessionId": session_id,
            }
            event.set()
            self._waiters.pop(command_id, None)

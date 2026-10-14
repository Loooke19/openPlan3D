"""Apply editor MCP commands to an in-memory project dict (mirrors src/lib/editorMcp/apply.ts)."""

from __future__ import annotations

import copy
import math
from typing import Any


def _fail(message: str) -> dict[str, Any]:
    return {"ok": False, "error": message}


def project_counts(project: dict[str, Any]) -> dict[str, int]:
    floor = _active_floor(project)
    if not floor:
        return {"walls": 0, "doors": 0, "windows": 0, "rooms": 0}
    return {
        "walls": len(floor.get("walls") or []),
        "doors": len(floor.get("doors") or []),
        "windows": len(floor.get("windows") or []),
        "rooms": len(floor.get("rooms") or []),
    }


def _active_floor(project: dict[str, Any]) -> dict[str, Any] | None:
    floors = project.get("floors") or []
    active_id = project.get("activeFloorId")
    if active_id:
        for floor in floors:
            if floor.get("id") == active_id:
                return floor
    return floors[0] if floors else None


def _require_floor(project: dict[str, Any], floor_id: str | None) -> dict[str, Any]:
    floors = project.get("floors") or []
    target_id = floor_id or project.get("activeFloorId") or (floors[0]["id"] if floors else None)
    for floor in floors:
        if floor.get("id") == target_id:
            return floor
    raise ValueError("楼层不存在")


def _finite_point(value: Any) -> dict[str, float] | None:
    if not isinstance(value, dict):
        return None
    x, y = value.get("x"), value.get("y")
    if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
        return None
    if not math.isfinite(x) or not math.isfinite(y):
        return None
    return {"x": float(x), "y": float(y)}


def apply_command(project: dict[str, Any], command: dict[str, Any]) -> dict[str, Any]:
    work = copy.deepcopy(project)
    op = command.get("op")
    try:
        if op == "set_room":
            floor = _require_floor(work, command.get("floorId"))
            room_patch = command.get("room") or {}
            room_id = room_patch.get("id")
            if not isinstance(room_id, str):
                raise ValueError("房间缺少 id")
            rooms = floor.get("rooms") or []
            target = next((room for room in rooms if room.get("id") == room_id), None)
            if target is None:
                raise ValueError("房间不存在，不会新建房间")
            if "name" in room_patch and isinstance(room_patch["name"], str):
                target["name"] = room_patch["name"]
            if "color" in room_patch and isinstance(room_patch["color"], str):
                target["color"] = room_patch["color"]
            if "floorTexture" in room_patch and isinstance(room_patch["floorTexture"], str):
                target["floorTexture"] = room_patch["floorTexture"]
            return {"ok": True, "summary": {"changed": [room_id], "counts": project_counts(work)}, "project": work}

        if op == "set_walls":
            floor = _require_floor(work, command.get("floorId"))
            walls = floor.get("walls") or []
            by_id = {wall["id"]: wall for wall in walls if isinstance(wall, dict) and isinstance(wall.get("id"), str)}
            changed: list[str] = []
            for patch in command.get("patches") or []:
                if not isinstance(patch, dict):
                    raise ValueError("墙 patch 无效")
                wall_id = patch.get("id")
                if not isinstance(wall_id, str):
                    raise ValueError("墙缺少 id")
                wall = by_id.get(wall_id)
                if wall is None:
                    raise ValueError(f"墙不存在: {wall_id}")
                if "start" in patch:
                    start = _finite_point(patch["start"])
                    if start is None:
                        raise ValueError(f"墙 {wall_id} 的 start 不是坐标")
                    wall["start"] = start
                if "end" in patch:
                    end = _finite_point(patch["end"])
                    if end is None:
                        raise ValueError(f"墙 {wall_id} 的 end 不是坐标")
                    wall["end"] = end
                start = wall.get("start") or {}
                end = wall.get("end") or {}
                if start.get("x") == end.get("x") and start.get("y") == end.get("y"):
                    raise ValueError(f"墙 {wall_id} 长度为 0")
                changed.append(wall_id)
            return {"ok": True, "summary": {"changed": changed, "counts": project_counts(work)}, "project": work}

        raise ValueError("未知命令")
    except ValueError as error:
        return _fail(str(error))

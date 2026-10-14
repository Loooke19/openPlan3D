"""Safe read/write helpers for OpenPlan project.json (stdlib only)."""

from __future__ import annotations

import json
import os
import shutil
import time
from pathlib import Path
from typing import Any, Mapping


class ProjectValidationError(ValueError):
    pass


def _require_mapping(value: Any, path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ProjectValidationError(f"{path} must be an object")
    return value


def _require_text(value: Any, path: str, nonempty: bool = False) -> str:
    if not isinstance(value, str) or (nonempty and not value.strip()):
        raise ProjectValidationError(f"{path} must be {'nonempty ' if nonempty else ''}text")
    return value


def _require_number(value: Any, path: str) -> float:
    if not isinstance(value, (int, float)) or not float(value) == value or value != value:
        raise ProjectValidationError(f"{path} must be a finite number")
    return float(value)


def validate_project_structure(document: Any) -> dict[str, Any]:
    """Lightweight structural check aligned with the web editor's readProject rules."""
    project = _require_mapping(document, "document")
    _require_text(project.get("id"), "id", nonempty=True)
    if "name" not in project:
        project = {**project, "name": "Untitled Project"}
    _require_text(project["name"], "name")
    floors = project.get("floors")
    if not isinstance(floors, list) or len(floors) == 0:
        raise ProjectValidationError("floors must contain at least one floor")
    floor_ids: set[str] = set()
    for index, floor in enumerate(floors):
        path = f"floors[{index}]"
        floor_obj = _require_mapping(floor, path)
        floor_id = _require_text(floor_obj.get("id"), f"{path}.id", nonempty=True)
        if floor_id in floor_ids:
            raise ProjectValidationError(f"{path}.id duplicates another floor")
        floor_ids.add(floor_id)
        _require_text(floor_obj.get("name", f"Floor {index}"), f"{path}.name")
        for key in ("walls", "doors", "windows", "rooms", "furniture"):
            items = floor_obj.get(key, [])
            if items is None:
                continue
            if not isinstance(items, list):
                raise ProjectValidationError(f"{path}.{key} must be an array")
            seen: set[str] = set()
            for item_index, item in enumerate(items):
                item_path = f"{path}.{key}[{item_index}]"
                item_obj = _require_mapping(item, item_path)
                item_id = _require_text(item_obj.get("id"), f"{item_path}.id", nonempty=True)
                if item_id in seen:
                    raise ProjectValidationError(f"{item_path}.id duplicates another element on this floor")
                seen.add(item_id)
                if key == "walls":
                    for point_key in ("start", "end"):
                        point = _require_mapping(item_obj.get(point_key), f"{item_path}.{point_key}")
                        _require_number(point.get("x"), f"{item_path}.{point_key}.x")
                        _require_number(point.get("y"), f"{item_path}.{point_key}.y")
    return project


def load_project_file(path: Path) -> dict[str, Any]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    return validate_project_structure(raw)


def atomic_write_project(path: Path, document: Mapping[str, Any]) -> Path:
    """Backup existing file, validate, write via temp + os.replace. Returns backup path if created."""
    validated = validate_project_structure(document)
    payload = json.dumps(validated, ensure_ascii=False, indent=2) + "\n"
    json.loads(payload)

    path = path.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    backup: Path | None = None
    if path.exists():
        stamp = time.strftime("%Y%m%d-%H%M%S")
        backup = path.with_name(f"{path.name}.bak-{stamp}")
        shutil.copy2(path, backup)

    tmp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    try:
        tmp.write_text(payload, encoding="utf-8")
        json.loads(tmp.read_text(encoding="utf-8"))
        os.replace(tmp, path)
    except Exception:
        if tmp.exists():
            tmp.unlink()
        raise
    return backup or path


def index_project_files(data_dir: Path) -> dict[str, Path]:
    """Map project id -> project.json path under data_dir (any depth)."""
    root = data_dir.resolve()
    if not root.is_dir():
        return {}
    found: dict[str, Path] = {}
    for path in root.rglob("project.json"):
        if not path.is_file():
            continue
        try:
            project = load_project_file(path)
        except (OSError, json.JSONDecodeError, ProjectValidationError):
            continue
        project_id = project["id"]
        if project_id not in found:
            found[project_id] = path
    return found

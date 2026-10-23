#!/usr/bin/env python3
"""Minimal two-floor + elevator seed for openPlan nav simulation.

Copies floor-0 to floor-1, renames a reachable room to 中央电梯 on both
floors, and writes project.verticalLinks. Idempotent.
"""
from __future__ import annotations

import argparse
import copy
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT = ROOT / "data" / "kujiale-import" / "projects" / "f9e6bb1cdf994280b5f506c130ec2aeb" / "project.json"
ELEVATOR_ROOM = "room-16"
ELEVATOR_NAME = "中央电梯"
UPPER_RENAMES = {
    "room-1": "2F大厅",
    "room-8": "内科病房",
    "room-9": "外科病房",
    "room-10": "儿科病房",
    "room-15": "2F药房",
    "room-12": "2F输液室",
    "room-19": "2F污物间",
}


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def seed(path: Path) -> dict:
    project = json.loads(path.read_text())
    floors = [floor for floor in project.get("floors") or [] if isinstance(floor, dict)]
    if not floors:
        raise SystemExit("no floors")
    lower = floors[0]
    for room in lower.get("rooms") or []:
        if room.get("id") == ELEVATOR_ROOM:
            room["name"] = ELEVATOR_NAME
            break
    else:
        raise SystemExit(f"missing {ELEVATOR_ROOM}")

    upper = next((floor for floor in floors if floor.get("id") == "floor-1"), None)
    if upper is None:
        upper = copy.deepcopy(lower)
        upper["id"] = "floor-1"
        upper["name"] = "2F"
        upper["level"] = 1
        upper["elevation"] = float(lower.get("elevation") or 0) + 300
        floors.append(upper)
        project["floors"] = floors
    for room in upper.get("rooms") or []:
        rid = room.get("id")
        if rid == ELEVATOR_ROOM:
            room["name"] = ELEVATOR_NAME
        elif rid in UPPER_RENAMES:
            room["name"] = UPPER_RENAMES[rid]

    project["verticalLinks"] = [{
        "id": "link-central-elevator",
        "kind": "elevator",
        "name": ELEVATOR_NAME,
        "stops": [
            {"floorId": lower["id"], "roomId": ELEVATOR_ROOM},
            {"floorId": "floor-1", "roomId": ELEVATOR_ROOM},
        ],
    }]
    project["updatedAt"] = _now()
    path.write_text(json.dumps(project, ensure_ascii=False, indent=2) + "\n")
    return project


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", nargs="?", type=Path, default=DEFAULT)
    args = parser.parse_args()
    if not args.project.is_file():
        raise SystemExit(f"missing {args.project}")
    project = seed(args.project)
    print(json.dumps({
        "id": project.get("id"),
        "floors": [{"id": f.get("id"), "name": f.get("name")} for f in project["floors"]],
        "verticalLinks": project.get("verticalLinks"),
        "path": str(args.project),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

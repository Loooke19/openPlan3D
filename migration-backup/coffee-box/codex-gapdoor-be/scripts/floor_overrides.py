"""Manual corrections layered on top of the PDF recognition; re-import never overwrites them.

One JSON file per building and floor: ``<overrides dir>/<building>-<floor>.json`` (e.g. P1-1F.json).
Everything is keyed by floor coordinates (cm, same space as the imported floor), never by the
volatile ids of a given import, so a file keeps applying after the recognizer changes.

    {
      "walls_remove": [{"x": .., "y": .., "tol": 30}],            # walls passing within tol of the point
      # Or {"start": {"x":..,"y":..}, "end": {..}, "tol": 1}: trim only that collinear stretch.
      "walls_remove_box": [{"x0":..,"y0":..,"x1":..,"y1":..,"roomType":"void"}],
      "walls_add":    [{"start": {"x":..,"y":..}, "end": {..}, "thickness": 15}],
      "doors_add":    [{"x": .., "y": .., "width": 90}],            # on the nearest wall
      "rooms":        [{"x": .., "y": .., "name": "卫生间", "roomType": "toilet",
                        "floorOpening": false, "attachedTo": "诊室", "standalone": false}],
      "annotations":  [{"x": .., "y": .., "text": "开水炉", "poi": false}],
      "vertical_remove": [{"kind": "stairs", "x": .., "y": .., "tol": 150}],
      "vertical_stops": [{"link": "link-stairs-1", "x": .., "y": ..}],
      "vertical_add": [{"kind": "stairs"|"elevator", "link": "P1-stair-east",
                        "polygon": [{"x":..,"y":..}, ...]}],     # or "x"/"y"; drawn from the PDF
    }

``link`` ties stops on different floors into one vertical link regardless of their distance.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path

DEFAULT_DIR = Path(__file__).resolve().parent.parent / "data" / "overrides"
BOX_STUB_CM = 200.0


def overrides_dir() -> Path:
    return Path(os.environ.get("GIFU_OVERRIDES_DIR") or DEFAULT_DIR)


def load(building: str, floor_name: str) -> dict | None:
    if not building:
        return None
    path = overrides_dir() / f"{building}-{floor_name}.json"
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2))
    return math.hypot(px - ax - dx * t, py - ay - dy * t), t


def _pip(x, y, poly):
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-9) + xi:
            inside = not inside
        j = i
    return inside


def _area(poly):
    return abs(sum(poly[i][0] * poly[i - 1][1] - poly[i - 1][0] * poly[i][1] for i in range(len(poly)))) / 2


def _box_removes_wall(wall, box):
    inside = lambda p: box["x0"] <= p["x"] <= box["x1"] and box["y0"] <= p["y"] <= box["y1"]
    a, b = wall["start"], wall["end"]
    if inside(a) and inside(b):
        return True
    if inside(a) == inside(b):
        return False
    if inside(a):
        a, b = b, a
    t = 0.0
    for axis in ("x", "y"):
        if a[axis] < box[axis + "0"]:
            t = max(t, (box[axis + "0"] - a[axis]) / (b[axis] - a[axis]))
        elif a[axis] > box[axis + "1"]:
            t = max(t, (box[axis + "1"] - a[axis]) / (b[axis] - a[axis]))
    return t < 1 and t * math.hypot(b["x"] - a["x"], b["y"] - a["y"]) <= BOX_STUB_CM


def _faces(floor):
    from pdf_building import _room_faces
    return _room_faces(floor)


def connected_walls(floor):
    from openplan_project import detect_closed_rooms
    walls = floor.get("walls") or []
    hosts = {d.get("wallId") for d in floor.get("doors") or []}
    boundaries = {wid for face in detect_closed_rooms(walls) for wid in face["walls"]}
    edges = []
    for room in floor.get("rooms") or []:
        poly = room.get("floorPolygon") or []
        edges.extend(zip(poly, poly[1:] + poly[:1]))
        if room.get("doorAt"):
            p = room["doorAt"]
            hosts.update(w["id"] for w in walls if _seg_dist(p["x"], p["y"], w["start"]["x"], w["start"]["y"], w["end"]["x"], w["end"]["y"])[0] <= float(w.get("thickness") or 15) / 2 + 2)
    kept = []
    for wall in walls:
        if wall.get("drawn") or wall.get("manual") or wall["id"] in hosts or wall["id"] in boundaries:
            kept.append(wall)
            continue
        segments = [(w["start"], w["end"], float(w.get("thickness") or 15) / 2 + 2)
                    for w in walls if w is not wall]
        segments.extend((a, b, 2) for a, b in edges)
        if any(_seg_dist(p["x"], p["y"], a["x"], a["y"], b["x"], b["y"])[0] <= tol
               for p in (wall["start"], wall["end"]) for a, b, tol in segments):
            kept.append(wall)
    return kept


def _room_at(floor, x, y, faces=None):
    faces = _faces(floor) if faces is None else faces
    best = None
    for room in floor.get("rooms") or []:
        poly = faces.get(room.get("id"))
        if poly and _pip(x, y, poly) and (best is None or _area(poly) < best[0]):
            best = (_area(poly), room)
    return best[1] if best else None


def _rebuild_rooms(floor, old_faces, old_rooms=None, labels=()):
    """Match faces by overlap, retaining each old ID and its metadata at most once."""
    from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps
    from openplan_project import detect_closed_rooms
    old_rooms = (floor.get("rooms") or []) if old_rooms is None else old_rooms
    faces = detect_closed_rooms(floor["walls"])
    polygons = [[(p["x"], p["y"]) for p in face["polygon"]] for face in faces]
    old = [(r, old_faces[r["id"]]) for r in old_rooms if r["id"] in old_faces]
    points = [p for poly in polygons + [p for _, p in old] for p in poly]
    if not points:
        floor["rooms"] = [r for r in old_rooms if r.get("drawn")]
        return
    x0, y0 = min(x for x, _ in points), min(y for _, y in points)
    size = (int((max(x for x, _ in points) - x0) / 5) + 2,
            int((max(y for _, y in points) - y0) / 5) + 2)

    def mask(poly):
        im = Image.new("1", size)
        ImageDraw.Draw(im).polygon([((x - x0) / 5, (y - y0) / 5) for x, y in poly], fill=1)
        return im

    old_masks = [mask(poly) for _, poly in old]
    old_boxes = [im.getbbox() for im in old_masks]
    candidates = []
    for i, (face, poly) in enumerate(zip(faces, polygons)):
        im = mask(poly)
        box = im.getbbox()
        names = {item["name"] for item in labels if item.get("name") and _pip(item["x"], item["y"], poly)}
        for j, (room, _) in enumerate(old):
            ob = old_boxes[j]
            intersection = (max(box[0], ob[0]), max(box[1], ob[1]), min(box[2], ob[2]), min(box[3], ob[3]))
            if intersection[0] >= intersection[2] or intersection[1] >= intersection[3]:
                continue
            overlap = ImageChops.logical_and(im.crop(intersection), old_masks[j].crop(intersection))
            overlap = ImageOps.expand(overlap, 1).filter(ImageFilter.MinFilter(3)).histogram()[255]
            exact = set(face["walls"]) == set(room.get("walls") or [])
            if overlap or exact:
                same_name = bool(names & {room.get("name"), room.get("displayName")})
                manual = bool(room.get("displayName") or room.get("nameSource") == "manual")
                candidates.append((exact, manual, same_name, overlap, bool(room.get("drawn") or room.get("displayName")), i, j))
    matched, used = {}, set()
    for *_, i, j in sorted(candidates, reverse=True):
        if i not in matched and j not in used:
            matched[i] = old[j][0]
            used.add(j)
    ids = {r["id"] for r in old_rooms}
    number = max((int(rid[5:]) for rid in ids if rid.startswith("room-") and rid[5:].isdigit()), default=0)
    rooms = []
    for i, face in enumerate(faces):
        src = matched.get(i)
        if src:
            base = dict(src)
        else:
            number += 1
            base = {"id": f"room-{number}", "name": "", "floorTexture": "hospital-floor",
                    "color": "#dce8df", "roomType": "indoor"}
        if not base.get("drawn"):
            base.update({"walls": face["walls"], "area": round(face["area"] / 10000.0, 2)})
        rooms.append(base)
    retained = {r["id"] for r in rooms}
    rooms.extend(r for r in old_rooms if r.get("drawn") and r["id"] not in retained)
    floor["rooms"] = rooms


def generate_stairs(floors: list[dict], building: str = "") -> None:
    markers = {}
    link_floors = {}
    for floor in floors:
        ov = load(building, floor["name"]) or {}
        markers[floor["id"]] = [m for key in ("vertical_tag", "vertical_add") for m in ov.get(key, [])
                                if m["kind"] == "stairs" and m.get("link")]
        for m in markers[floor["id"]]:
            link_floors.setdefault(m["link"], set()).add(floor["id"])
    ordered = sorted(floors, key=lambda f: f["level"])
    for index, floor in enumerate(ordered):
        elevation = floor.get("elevation", floor["level"] * 300)
        above = ordered[index + 1] if index + 1 < len(ordered) else None
        below = ordered[index - 1] if index else None
        height = (above.get("elevation", above["level"] * 300) - elevation if above else
                  floor.get("height") or (elevation - below.get("elevation", below["level"] * 300) if below else 300))
        faces = _faces(floor)
        walls = {w["id"]: w for w in floor["walls"]}
        stairs = []
        outlines = []
        for room in floor["rooms"]:
            if room.get("name") != "楼梯":
                continue
            poly = faces[room["id"]]
            if any(len(link_floors[m["link"]]) == 1 and "x" in m and _pip(m["x"], m["y"], poly)
                   for m in markers[floor["id"]]):
                continue
            outlines.append((room["id"], poly, max(walls[w]["thickness"] for w in room["walls"]) + 10, None, None))
        for marker in markers[floor["id"]]:
            if marker.get("polygon") and len(link_floors[marker["link"]]) > 1:
                poly = [(p["x"], p["y"]) for p in marker["polygon"]]
                if not any(_pip(marker["x"], marker["y"], outline[1]) for outline in outlines):
                    outlines.append((marker["link"], poly, marker["thickness"] + 10, marker.get("stairType"), marker.get("rotation")))
        for outline_id, poly, margin, stair_type, rotation in outlines:
            boxes = []
            for a, b in zip(poly, poly[1:] + poly[:1]):
                angle = math.atan2(b[1] - a[1], b[0] - a[0])
                c, s = math.cos(angle), math.sin(angle)
                us = [x * c + y * s for x, y in poly]
                vs = [-x * s + y * c for x, y in poly]
                u0, u1, v0, v1 = min(us), max(us), min(vs), max(vs)
                boxes.append(((u1 - u0) * (v1 - v0), angle, u0, u1, v0, v1))
            _, angle, u0, u1, v0, v1 = min(boxes, key=lambda box: box[0])
            c, s = math.cos(angle), math.sin(angle)
            u, v = (u0 + u1) / 2, (v0 + v1) / 2
            short, long = sorted((u1 - u0, v1 - v0))
            long_angle = angle if u1 - u0 >= v1 - v0 else angle + math.pi / 2
            stairs.append({
                "id": f"stair-{outline_id}",
                "position": {"x": round(u * c - v * s, 2), "y": round(u * s + v * c, 2)},
                "rotation": rotation if rotation is not None else round((math.degrees(long_angle) - 90) % 180, 2),
                "width": round(short - margin, 2), "depth": round(long - margin, 2),
                "riserCount": round(height / 17), "direction": "up",
                "stairType": stair_type or ("straight" if long / short >= 1.8 else "u-shaped"),
            })
        floor["stairs"] = stairs


def apply(floor: dict, vertical: list[dict], ov: dict | None, previous_floor=None) -> dict:
    """Mutate ``floor`` and ``vertical`` in place; return a count of applied edits."""
    stats = {}
    if not ov:
        return stats
    walls = floor.setdefault("walls", [])
    previous_floor = previous_floor if previous_floor is not None else floor
    old_faces = _faces(previous_floor)
    old_rooms = list(previous_floor.get("rooms") or [])
    if previous_floor is not floor:
        drawn = {w["id"]: w for w in previous_floor.get("walls") or [] if w.get("drawn")}
        floor["walls"] = walls = [w for w in walls if w["id"] not in drawn] + list(drawn.values())
        drawn_doors = {d["id"]: d for d in previous_floor.get("doors") or [] if d.get("drawn")}
        floor["doors"] = [d for d in floor.get("doors") or [] if d["id"] not in drawn_doors] + list(drawn_doors.values())
    changed = False
    for item in ov.get("walls_remove") or []:
        tol = float(item.get("tol", 30))
        if "start" in item:
            a, b = item["start"], item["end"]
            dx, dy = b["x"] - a["x"], b["y"] - a["y"]
            length = math.hypot(dx, dy)
            ux, uy = dx / length, dy / length
            kept = []
            for wall in walls:
                s, e = wall["start"], wall["end"]
                if wall.get("drawn") or any(d.get("drawn") and d.get("wallId") == wall["id"] for d in floor.get("doors") or []):
                    kept.append(wall)
                    continue
                if max(abs((p["x"] - a["x"]) * uy - (p["y"] - a["y"]) * ux) for p in (s, e)) > tol:
                    kept.append(wall)
                    continue
                t0, t1 = ((p["x"] - a["x"]) * ux + (p["y"] - a["y"]) * uy for p in (s, e))
                lo, hi = sorted((t0, t1))
                cut0, cut1 = max(0, lo), min(length, hi)
                if cut1 <= cut0:
                    kept.append(wall)
                    continue
                pieces = []
                for k, (p, q) in enumerate(((lo, cut0), (cut1, hi))):
                    if q - p > 1:
                        piece = {**wall, "id": wall["id"] if not pieces else f"{wall['id']}~{k}",
                                 "start": {"x": a["x"] + ux * p, "y": a["y"] + uy * p},
                                 "end": {"x": a["x"] + ux * q, "y": a["y"] + uy * q}}
                        pieces.append((p, q, piece))
                        kept.append(piece)
                doors = []
                for door in floor.get("doors") or []:
                    if door.get("wallId") != wall["id"]:
                        doors.append(door)
                        continue
                    at = t0 + (t1 - t0) * float(door["position"])
                    for p, q, piece in pieces:
                        if p <= at <= q:
                            doors.append({**door, "wallId": piece["id"], "position": (at - p) / (q - p)})
                floor["doors"] = doors
                changed = True
                stats["walls_remove"] = stats.get("walls_remove", 0) + 1
            floor["walls"] = walls = kept
            continue
        drop = {w["id"] for w in walls
                if not w.get("drawn")
                and not any(d.get("drawn") and d.get("wallId") == w["id"] for d in floor.get("doors") or [])
                and _seg_dist(item["x"], item["y"], w["start"]["x"], w["start"]["y"], w["end"]["x"], w["end"]["y"])[0] <= tol}
        if drop:
            changed = True
            floor["walls"] = walls = [w for w in walls if w["id"] not in drop]
            floor["doors"] = [d for d in floor.get("doors") or [] if d.get("wallId") not in drop]
            stats["walls_remove"] = stats.get("walls_remove", 0) + len(drop)
    boxes = [{k: float(item[k]) for k in ("x0", "y0", "x1", "y1")}
             for item in ov.get("walls_remove_box") or [] if item.get("roomType") == "void"]
    if boxes:
        floor["footprintExclusions"] = boxes
    for item in ov.get("walls_remove_box") or []:
        drop = {w["id"] for w in walls if not w.get("drawn") and _box_removes_wall(w, item)
                and not any(d.get("drawn") and d.get("wallId") == w["id"] for d in floor.get("doors") or [])}
        if drop:
            changed = True
            floor["walls"] = walls = [w for w in walls if w["id"] not in drop]
            floor["doors"] = [d for d in floor.get("doors") or [] if d.get("wallId") not in drop]
            stats["walls_remove"] = stats.get("walls_remove", 0) + len(drop)
    style = {k: v for k, v in (walls[0] if walls else {}).items() if k not in ("id", "start", "end", "thickness")}
    for n, item in enumerate(ov.get("walls_add") or [], start=1):
        walls.append({**style, "id": f"wall-ov-{n}", "start": dict(item["start"]), "end": dict(item["end"]),
                      "thickness": float(item.get("thickness", 15)), "height": style.get("height", 280.0), "manual": True})
        changed = True
        stats["walls_add"] = n
    if changed or previous_floor is not floor:
        _rebuild_rooms(floor, old_faces, old_rooms, ov.get("rooms") or [])
    for n, item in enumerate(ov.get("doors_add") or [], start=1):
        best = None
        for w in walls:
            d, t = _seg_dist(item["x"], item["y"], w["start"]["x"], w["start"]["y"], w["end"]["x"], w["end"]["y"])
            if best is None or d < best[0]:
                best = (d, w, t)
        if best and best[0] <= float(item.get("tol", 60)):
            floor.setdefault("doors", []).append({
                "id": f"door-ov-{n}", "wallId": best[1]["id"], "position": round(best[2], 4),
                "width": float(item.get("width", 90)), "height": 210, "type": item.get("type", "single"),
                "swingDirection": "left", "flipSide": False})
            stats["doors_add"] = stats.get("doors_add", 0) + 1
    faces = _faces(floor)
    for item in ov.get("rooms") or []:
        room = _room_at(floor, item["x"], item["y"], faces)
        if room and not room.get("drawn"):
            for key in ("name", "roomType", "floorTexture", "floorOpening", "attachedTo", "standalone"):
                if key in item:
                    if key == "name" and (room.get("drawn") or room.get("displayName") or room.get("nameSource") == "manual"):
                        continue
                    room[key] = item[key]
            stats["rooms"] = stats.get("rooms", 0) + 1
    for n, item in enumerate(ov.get("annotations") or [], start=1):
        floor.setdefault("textAnnotations", []).append({
            "id": f"poi-ov-{n}", "x": item["x"], "y": item["y"], "text": item["text"],
            "poi": bool(item.get("poi")), "fontSize": 14, "color": "#555555", "rotation": 0})
        stats["annotations"] = n
    for item in ov.get("vertical_remove") or []:
        tol = float(item.get("tol", 150))
        keep = [v for v in vertical if not (v["kind"] == item.get("kind", v["kind"])
                                            and math.hypot(v["x"] - item["x"], v["y"] - item["y"]) <= tol)]
        stats["vertical_remove"] = stats.get("vertical_remove", 0) + len(vertical) - len(keep)
        vertical[:] = keep
    for item in ov.get("vertical_add") or []:
        poly = [(p["x"], p["y"]) for p in item.get("polygon") or []]
        x, y = (sum(p[0] for p in poly) / len(poly), sum(p[1] for p in poly) / len(poly)) if poly else (item["x"], item["y"])
        x, y = float(item.get("x", x)), float(item.get("y", y))
        room = _room_at(floor, x, y, faces)
        label = "电梯" if item["kind"] == "elevator" else "楼梯"
        if room and label not in str(room.get("name") or "") and item.get("nameRoom", True):
            room["name"] = item.get("name", label)
        entry = {"kind": item["kind"], "roomId": room["id"] if room else "", "x": round(x, 1), "y": round(y, 1),
                 "source": "override"}
        if item.get("link"):
            entry["link"] = item["link"]
        # an override replaces a recognised shaft of the same kind at the same spot
        vertical[:] = [v for v in vertical if not (v["kind"] == item["kind"] and math.hypot(v["x"] - x, v["y"] - y) <= 150)]
        vertical.append(entry)
        stats["vertical_add"] = stats.get("vertical_add", 0) + 1
    for item in ov.get("vertical_tag") or []:  # give a recognised shaft a link id
        for v in vertical:
            if v["kind"] == item["kind"] and math.hypot(v["x"] - item["x"], v["y"] - item["y"]) <= float(item.get("tol", 150)):
                v["link"] = item["link"]
    return stats


def apply_vertical_stops(floors: list[dict], links: list[dict], building: str) -> None:
    for floor in floors:
        for item in (load(building, floor["name"]) or {}).get("vertical_stops", []):
            link = next(link for link in links if link["id"] == item["link"])
            stop = next(stop for stop in link["stops"] if stop["floorId"] == floor["id"])
            room = _room_at(floor, item["x"], item["y"])
            stop.update(x=item["x"], y=item["y"], roomId=room["id"])


def write_stair_overrides(floors: list[dict], building: str) -> None:
    decoder = json.JSONDecoder()
    for floor in floors:
        path = overrides_dir() / f"{building}-{floor['name']}.json"
        source = path.read_text(encoding="utf-8")
        value = json.dumps(floor["stairs"], ensure_ascii=False, indent=1)
        offset = source.index("{") + 1
        while True:
            offset += len(source[offset:]) - len(source[offset:].lstrip())
            if source[offset] == "}":
                source = source[:offset] + ',\n "stairs": ' + value + '\n' + source[offset:]
                break
            key, end = decoder.raw_decode(source, offset)
            start = source.index(":", end) + 1
            start += len(source[start:]) - len(source[start:].lstrip())
            _, end = decoder.raw_decode(source, start)
            if key == "stairs":
                source = source[:start] + value + source[end:]
                break
            offset = end
            offset += len(source[offset:]) - len(source[offset:].lstrip())
            if source[offset] == ",":
                offset += 1
        path.write_text(source, encoding="utf-8")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("project", type=Path)
    args = parser.parse_args()
    project = json.loads(args.project.read_text(encoding="utf-8"))
    generate_stairs(project["floors"], project["name"])
    write_stair_overrides(project["floors"], project["name"])
    args.project.write_text(json.dumps(project, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({f["name"]: len(f["stairs"]) for f in project["floors"]}))

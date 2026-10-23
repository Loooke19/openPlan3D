"""Manual room names (editor / MCP) survive re-import.

Names set by a person (displayName, aliases) are recorded per source PDF (sha256) and floor,
keyed by stable room geometry (centroid + area), never by volatile room ids. After every
import they are applied on top of the automatic names; automatic naming never overwrites them.
"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

MATCH_CM = 120.0          # centroid tolerance between imports
AREA_RATIO = (0.75, 1.33)  # same room if areas agree within this ratio


def pdf_sha(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _room_points(floor: dict, room: dict) -> list[tuple[float, float]]:
    poly = room.get("polygon") or room.get("points")
    if poly:
        return [(float(p["x"]), float(p["y"])) for p in poly]
    walls = {w.get("id"): w for w in floor.get("walls") or []}
    pts = []
    for wid in room.get("walls") or []:
        w = walls.get(wid)
        if w:
            for k in ("start", "end"):
                if isinstance(w.get(k), dict):
                    pts.append((float(w[k]["x"]), float(w[k]["y"])))
    return pts


def room_key(floor: dict, room: dict):
    pts = _room_points(floor, room)
    if len(pts) < 2:
        return None
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    area = max(1.0, (max(xs) - min(xs)) * (max(ys) - min(ys)))
    return cx, cy, area


def _floor_tag(floor: dict) -> str:
    return str(floor.get("level") if floor.get("level") is not None else floor.get("name") or "")


def _store(root: Path, sha: str) -> Path:
    return Path(root) / f"{sha}.json"


def _load_all(root, sha: str) -> dict:
    try:
        return json.loads(_store(root, sha).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def load(root, sha: str) -> list[dict]:
    return _load_all(root, sha).get("rooms") or []


def _save_all(root, sha: str, data: dict) -> None:
    p = _store(root, sha)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(p)


def record_zones(root, project: dict) -> int:
    """Restricted zones set or confirmed by a person (source manual / not provisional) persist."""
    sha = project.get("sourceSha")
    if not sha:
        return 0
    data = _load_all(root, sha)
    level = {f.get("id"): _floor_tag(f) for f in project.get("floors") or []}
    zones = [{**z, "floor": level.get(z.get("floorId"), "")} for z in project.get("restrictedZones") or []
             if isinstance(z, dict) and (z.get("source") == "manual" or z.get("provisional") is False)]
    data["zones"] = zones
    data["zonesSet"] = True
    _save_all(root, sha, data)
    return len(zones)


def apply_zones(root, project: dict) -> bool:
    """Once a person has edited zones for this PDF, theirs replace the automatic suggestions."""
    data = _load_all(root, project.get("sourceSha") or "") if project.get("sourceSha") else {}
    if not data.get("zonesSet"):
        return False
    by_level = {_floor_tag(f): f.get("id") for f in project.get("floors") or []}
    project["restrictedZones"] = [
        {**{k: v for k, v in z.items() if k != "floor"}, "floorId": by_level.get(z.get("floor"), z.get("floorId"))}
        for z in data.get("zones") or []
    ]
    return True


def _match(entries, floor_tag, key, name=None):
    cx, cy, area = key
    best, best_d = None, MATCH_CM
    for e in entries:
        if e.get("floor") != floor_tag:
            continue
        d = math.hypot(e["cx"] - cx, e["cy"] - cy)
        ratio = area / max(1.0, e["area"])
        exact = d < 10 and 0.97 <= ratio <= 1.03
        # a cleared (mis-read) name only clears that very face, never a neighbour
        if e.get("cleared") and not exact:
            continue
        # an equal-sized neighbour (two equal rooms side by side) must not take another's name:
        # unless the geometry is the same face, the import's name must be one the entry knew
        if not exact and name and not e.get("cleared") \
                and name not in {e.get("printed"), e.get("displayName"), *(e.get("aliases") or [])}:
            continue
        if d <= best_d and AREA_RATIO[0] <= ratio <= AREA_RATIO[1]:
            best, best_d = e, d
    return best


def record(root, project: dict) -> int:
    """Remember every manually named room of `project` (displayName / aliases set)."""
    sha = project.get("sourceSha")
    if not sha:
        return 0
    entries = load(root, sha)
    n = 0
    for floor in project.get("floors") or []:
        tag = _floor_tag(floor)
        for room in floor.get("rooms") or []:
            if not (room.get("displayName") or room.get("aliases") or room.get("attachedTo") or room.get("standalone")
                    or room.get("nameSource") == "manual"):
                continue
            key = room_key(floor, room)
            if not key:
                continue
            item = {"floor": tag, "cx": round(key[0], 1), "cy": round(key[1], 1), "area": round(key[2], 1),
                    "printed": room.get("name") or "", "displayName": room.get("displayName") or "",
                    "aliases": list(room.get("aliases") or []),
                    "attachedTo": room.get("attachedTo") or "", "standalone": bool(room.get("standalone")),
                    "cleared": not (room.get("name") or room.get("displayName"))}
            # replace only this very face's entry; a neighbour within tolerance keeps its own
            old = next((e for e in entries if e.get("floor") == tag and math.hypot(e["cx"] - key[0], e["cy"] - key[1]) < 10
                        and 0.97 <= key[2] / max(1.0, e["area"]) <= 1.03), None)
            if old:
                entries[entries.index(old)] = item
            else:
                entries.append(item)
            n += 1
    data = _load_all(root, sha)
    data["rooms"] = entries
    _save_all(root, sha, data)
    return n


def apply(root, project: dict) -> int:
    """Put recorded manual names back onto a freshly imported project. Returns rooms changed."""
    sha = project.get("sourceSha")
    entries = load(root, sha) if sha else []
    n = 0
    for floor in project.get("floors") or []:
        tag = _floor_tag(floor)
        # one entry names one face: the closest room claims it (split faces stay unnamed)
        pairs = []
        for room in floor.get("rooms") or []:
            key = room_key(floor, room)
            e = _match(entries, tag, key, room.get("name") or None) if key else None
            if e:
                pairs.append((math.hypot(e["cx"] - key[0], e["cy"] - key[1]), id(e), room, e))
        taken = set()
        for _, eid, room, e in sorted(pairs, key=lambda t: t[0]):
            if eid in taken:
                continue
            taken.add(eid)
            if e.get("displayName"):
                room["displayName"] = e["displayName"]
                # name field synced to the display name by a person: keep it (old name stays an alias)
                if e.get("printed") == e["displayName"] and room.get("name") != e["displayName"]:
                    if room.get("name") and room["name"] not in (e.get("aliases") or []):
                        room["aliases"] = list(e.get("aliases") or []) + [room["name"]]
                    room["name"] = e["displayName"]
            if e.get("aliases"):
                room["aliases"] = list(e["aliases"])
            if e.get("attachedTo"):
                room["attachedTo"] = e["attachedTo"]
            if not e.get("cleared") and e.get("printed") and not room.get("name"):
                room["name"] = e["printed"]  # a name a person gave an unnamed face
            if e.get("cleared"):
                # a person cleared a mis-read name (fragment / corridor strip): keep it cleared
                room["name"] = ""
                room.pop("displayName", None)
            if e.get("standalone"):
                room["standalone"] = True
            room["nameSource"] = "manual"
            n += 1
    return n


def record_drawn(root, project: dict) -> int:
    """Rooms a person drew (editor/MCP, ``drawn: True``) are remembered per PDF + floor."""
    sha = project.get("sourceSha")
    if not sha:
        return 0
    data = _load_all(root, sha)
    out = []
    for floor in project.get("floors") or []:
        tag = _floor_tag(floor)
        for room in floor.get("rooms") or []:
            if room.get("drawn") and room.get("floorPolygon"):
                door_at = room.get("doorAt")
                if not door_at:
                    # keep where its door actually is (moved in the editor), not where auto-placement would put it
                    tagid = str(room.get("id", "")).replace("room-drawn-", "")
                    d = next((d for d in floor.get("doors") or [] if d.get("id") == f"door-drawn-{tagid}"), None)
                    pt = door_point(floor, d) if d else None
                    door_at = {"x": round(pt[0], 1), "y": round(pt[1], 1)} if pt else None
                out.append({"floor": tag, "key": str(room["id"]).removeprefix("room-drawn-"),
                            "rect": room["floorPolygon"], "name": room.get("name") or "",
                            "displayName": room.get("displayName") or "", "door": door_at,
                            "open": room.get("openSides") or [], "clear": bool(room.get("clearInside"))})
    data["drawn"] = out
    _save_all(root, sha, data)
    return len(out)


def apply_drawn(root, project: dict) -> int:
    """Re-draw remembered rooms on a fresh import, unless the importer now finds them itself."""
    import draw_rooms
    sha = project.get("sourceSha")
    items = _load_all(root, sha).get("drawn") or [] if sha else []
    by_tag = {_floor_tag(f): f for f in project.get("floors") or []}
    n = 0
    for it in items:
        floor = by_tag.get(it.get("floor"))
        if not floor:
            continue
        xs = [p["x"] for p in it["rect"]]; ys = [p["y"] for p in it["rect"]]
        key = ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, (max(xs) - min(xs)) * (max(ys) - min(ys)))
        found = None
        for room in floor.get("rooms") or []:
            if room.get("drawn"):
                continue
            k = room_key(floor, room)
            if k and (room.get("name") or "") == it["name"] and math.hypot(k[0] - key[0], k[1] - key[1]) < 60 \
                    and 0.8 <= k[2] / max(1.0, key[2]) <= 1.25:
                found = room
        if found:
            continue
        room = draw_rooms.add_drawn_room(floor, it["rect"], it["name"], it.get("displayName") or "", it.get("door"),
                                         key=it.get("key") or "",
                                         open_sides=it.get("open") or (), clear_inside=bool(it.get("clear")))
        if it.get("door"):
            room["doorAt"] = it["door"]
        n += 1
    return n


# ---------------------------------------------------------------------------
# Manual wall / door edits (added walls, added doors/openings, removed doors, rooms
# re-bounded by an added wall) survive re-import. Geometry is stored in plan cm, never by
# volatile ids: a door is re-attached to whichever wall it sits on in the fresh import.

DOOR_SNAP_CM = 20.0     # door point to wall centre line
DOOR_SAME_CM = 35.0     # an existing door this close is the same door (idempotent apply)
REMOVED_CM = 40.0       # tombstone radius for removed imported doors
_DOOR_KEYS = ("width", "height", "type", "swingDirection", "flipSide")


def _wall_pt(w: dict, t: float) -> tuple[float, float]:
    s, e = w["start"], w["end"]
    return float(s["x"]) + (float(e["x"]) - float(s["x"])) * t, float(s["y"]) + (float(e["y"]) - float(s["y"])) * t


def door_point(floor: dict, door: dict):
    w = next((w for w in floor.get("walls") or [] if w.get("id") == door.get("wallId")), None)
    if not w or not isinstance(w.get("start"), dict):
        return None
    return _wall_pt(w, float(door.get("position") or 0.5))


def _project_on(w: dict, x: float, y: float):
    sx, sy, ex, ey = float(w["start"]["x"]), float(w["start"]["y"]), float(w["end"]["x"]), float(w["end"]["y"])
    dx, dy = ex - sx, ey - sy
    L2 = dx * dx + dy * dy
    if L2 < 1:
        return None
    t = ((x - sx) * dx + (y - sy) * dy) / L2
    if t < 0 or t > 1:
        return None
    px, py = sx + dx * t, sy + dy * t
    return t, math.hypot(px - x, py - y)


def _manual_wall(w: dict) -> bool:
    # drawn-* walls belong to drawn rooms (re-created by apply_drawn); others drawn by a person
    return bool(w.get("drawn")) and not str(w.get("id", "")).startswith("drawn-")


def record_edits(root, project: dict) -> int:
    sha = project.get("sourceSha")
    if not sha:
        return 0
    data = _load_all(root, sha)
    walls, doors, removed, shapes, rwalls, notes = [], [], [], [], [], []
    for floor in project.get("floors") or []:
        tag = _floor_tag(floor)
        byid = {w.get("id"): w for w in floor.get("walls") or []}
        manual = {wid for wid, w in byid.items() if _manual_wall(w)}
        for wid in sorted(manual):
            w = byid[wid]
            walls.append({"floor": tag, "id": wid, **{k: w[k] for k in ("start", "end", "thickness", "height", "color", "texture") if k in w}})
        for d in floor.get("doors") or []:
            if not d.get("drawn") or str(d.get("id", "")).startswith("door-drawn-"):
                continue  # door-drawn-* belong to drawn rooms and come back with apply_drawn
            p = door_point(floor, d)
            if p:
                doors.append({"floor": tag, "id": d.get("id"), "x": round(p[0], 1), "y": round(p[1], 1),
                              **{k: d[k] for k in _DOOR_KEYS if k in d}})
        for t in floor.get("textAnnotations") or []:
            if t.get("manual"):  # an OCR label a person corrected or un-POI'd (相子 → 柜子, furniture)
                notes.append({"floor": tag, "x": float(t["x"]), "y": float(t["y"]), "text": t.get("text") or "",
                              "poi": bool(t.get("poi"))})
        for r in floor.get("removedWalls") or []:
            rwalls.append({"floor": tag, "start": r["start"], "end": r["end"]})
        for r in floor.get("removedDoors") or []:
            removed.append({"floor": tag, "x": float(r["x"]), "y": float(r["y"])})
        for room in floor.get("rooms") or []:
            if room.get("drawn") or not any(wid in manual for wid in room.get("walls") or []):
                continue
            segs = [[byid[w]["start"], byid[w]["end"]] for w in room.get("walls") or [] if w in byid]
            pts = [(float(p["x"]), float(p["y"])) for s in segs for p in s]
            shapes.append({"floor": tag, "name": room.get("name") or "", "segs": segs,
                           "cx": sum(p[0] for p in pts) / len(pts), "cy": sum(p[1] for p in pts) / len(pts)})
    data["edits"] = {"walls": walls, "doors": doors, "removedDoors": removed, "roomWalls": shapes,
                     "removedWalls": rwalls, "notes": notes}
    _save_all(root, sha, data)
    return len(walls) + len(doors) + len(removed) + len(shapes) + len(rwalls) + len(notes)


def _find_wall_for(floor: dict, x: float, y: float):
    best = None
    for w in floor.get("walls") or []:
        if not isinstance(w.get("start"), dict):
            continue
        pr = _project_on(w, x, y)
        if pr and pr[1] <= DOOR_SNAP_CM and (best is None or pr[1] < best[2]):
            best = (w, pr[0], pr[1])
    return best


def _same_seg(w: dict, seg, tol=8.0) -> bool:
    a, b = (float(w["start"]["x"]), float(w["start"]["y"])), (float(w["end"]["x"]), float(w["end"]["y"]))
    p, q = (float(seg[0]["x"]), float(seg[0]["y"])), (float(seg[1]["x"]), float(seg[1]["y"]))
    d = lambda u, v: math.hypot(u[0] - v[0], u[1] - v[1])
    return (d(a, p) < tol and d(b, q) < tol) or (d(a, q) < tol and d(b, p) < tol)


def apply_edits(root, project: dict) -> int:
    """Replay recorded wall/door edits onto a fresh import (idempotent). Returns edits applied."""
    sha = project.get("sourceSha")
    ed = (_load_all(root, sha).get("edits") or {}) if sha else {}
    by_tag = {_floor_tag(f): f for f in project.get("floors") or []}
    n = 0
    for w in ed.get("walls") or []:
        floor = by_tag.get(w.get("floor"))
        if not floor:
            continue
        walls = floor.setdefault("walls", [])
        if any(_same_seg(x, (w["start"], w["end"])) for x in walls if isinstance(x.get("start"), dict)):
            continue
        walls.append({**{k: v for k, v in w.items() if k != "floor"}, "drawn": True})
        n += 1
    for t in ed.get("notes") or []:
        floor = by_tag.get(t.get("floor"))
        hit = False
        for note in (floor or {}).get("textAnnotations") or []:
            if math.hypot(float(note.get("x", 1e9)) - t["x"], float(note.get("y", 1e9)) - t["y"]) <= 50:
                note.update(text=t["text"], poi=t["poi"], manual=True)
                n += 1
                hit = True
        if floor is not None and not hit:  # a person-added POI missing from the import (开水炉)
            floor.setdefault("textAnnotations", []).append(
                {"id": f"poi-manual-{int(t['x'])}_{int(t['y'])}", "x": t["x"], "y": t["y"], "text": t["text"],
                 "fontSize": 14, "color": "#555555", "rotation": 0, "poi": t["poi"], "manual": True})
            n += 1
    for r in ed.get("removedWalls") or []:
        # imported lines that are not walls (stair treads, furniture) a person deleted
        floor = by_tag.get(r.get("floor"))
        if not floor:
            continue
        gone = {w.get("id") for w in floor.get("walls") or [] if isinstance(w.get("start"), dict)
                and not w.get("drawn") and _same_seg(w, (r["start"], r["end"]))}
        if gone:
            floor["walls"] = [w for w in floor["walls"] if w.get("id") not in gone]
            floor["doors"] = [d for d in floor.get("doors") or [] if d.get("wallId") not in gone]
            for room in floor.get("rooms") or []:
                if room.get("walls"):
                    room["walls"] = [w for w in room["walls"] if w not in gone]
            n += len(gone)
        rw = floor.setdefault("removedWalls", [])
        if not any(_same_seg({"start": o["start"], "end": o["end"]}, (r["start"], r["end"]), 1.0) for o in rw):
            rw.append({"start": r["start"], "end": r["end"]})
    for r in ed.get("removedDoors") or []:
        floor = by_tag.get(r.get("floor"))
        if not floor:
            continue
        keep = []
        for d in floor.get("doors") or []:
            p = door_point(floor, d)
            if p and not d.get("drawn") and math.hypot(p[0] - r["x"], p[1] - r["y"]) <= REMOVED_CM:
                n += 1
                continue
            keep.append(d)
        floor["doors"] = keep
        floor.setdefault("removedDoors", [])
        if not any(math.hypot(o["x"] - r["x"], o["y"] - r["y"]) < 1 for o in floor["removedDoors"]):
            floor["removedDoors"].append({"x": r["x"], "y": r["y"]})
    for d in ed.get("doors") or []:
        floor = by_tag.get(d.get("floor"))
        if not floor:
            continue
        wall_of = {w.get("id"): w for w in floor.get("walls") or []}
        def _same(o):
            p = door_point(floor, o)
            if not p or math.hypot(p[0] - d["x"], p[1] - d["y"]) > DOOR_SAME_CM:
                return False
            pr = _project_on(wall_of[o["wallId"]], d["x"], d["y"])  # a twin wall 20 cm away is another door
            return bool(pr) and pr[1] < 8 and (o.get("type") == "opening") == (d.get("type") == "opening")
        if any(_same(o) for o in floor.get("doors") or []):
            continue
        hit = _find_wall_for(floor, d["x"], d["y"])
        if not hit:
            continue
        ids = {o.get("id") for o in floor.get("doors") or []}
        did = d.get("id") if d.get("id") not in ids else f"{d.get('id')}-r"
        floor.setdefault("doors", []).append({"id": did, "wallId": hit[0]["id"], "position": round(hit[1], 4),
                                              **{k: d[k] for k in _DOOR_KEYS if k in d}, "drawn": True})
        n += 1
    for s in ed.get("roomWalls") or []:
        floor = by_tag.get(s.get("floor"))
        if not floor:
            continue
        walls = [w for w in floor.get("walls") or [] if isinstance(w.get("start"), dict)]
        ids = []
        for seg in s["segs"]:
            w = next((w for w in walls if _same_seg(w, seg)), None)
            if w is None:
                ids = None
                break
            ids.append(w["id"])
        if not ids:
            continue
        # the imported room this was cut from: nearest non-drawn room whose wall points surround the centre
        best, bd = None, 1e18
        for room in floor.get("rooms") or []:
            if room.get("drawn"):
                continue
            pts = _room_points(floor, room)
            if len(pts) < 3:
                continue
            xs, ys = [p[0] for p in pts], [p[1] for p in pts]
            if not (min(xs) - 5 <= s["cx"] <= max(xs) + 5 and min(ys) - 5 <= s["cy"] <= max(ys) + 5):
                continue
            if set(room.get("walls") or []) == set(ids):
                best = None
                break
            a = (max(xs) - min(xs)) * (max(ys) - min(ys))
            if a < bd:
                best, bd = room, a
        if best is not None:
            best["walls"] = ids
            best.pop("area", None)
            n += 1
    return n

"""Manually drawn rooms (editor/MCP): a person traces a room the importer missed.

A drawn room is an axis-aligned rectangle (cm, plan space). Its sides snap to existing wall
centre-lines within SNAP_CM so it shares corners with the imported walls; sides not already
covered by a wall get a new thin partition wall. If none of its sides carries a door yet, a
door is put on the side facing the most open floor (or at ``door`` when given). The room is
stored with ``drawn: True`` + ``floorPolygon`` so re-imports can re-apply it (name_overrides).
"""
from __future__ import annotations

SNAP_CM = 18.0
COVER = 0.85


def _walls(floor):
    return [w for w in floor.get("walls") or [] if isinstance(w.get("start"), dict) and isinstance(w.get("end"), dict)]


def _axis_walls(floor, vertical):
    out = []
    for w in _walls(floor):
        a, b = w["start"], w["end"]
        if vertical and abs(a["x"] - b["x"]) < 2:
            out.append((w, (a["x"] + b["x"]) / 2, min(a["y"], b["y"]), max(a["y"], b["y"])))
        if not vertical and abs(a["y"] - b["y"]) < 2:
            out.append((w, (a["y"] + b["y"]) / 2, min(a["x"], b["x"]), max(a["x"], b["x"])))
    return out


def _snap(value, lo, hi, lines):
    best, bd = value, SNAP_CM
    for _w, c, a, b in lines:
        ov = min(hi, b) - max(lo, a)
        if ov > 0.3 * (hi - lo) and abs(c - value) < bd:
            best, bd = c, abs(c - value)
    return best


def _covered(c, lo, hi, lines):
    segs = sorted((max(lo, a), min(hi, b)) for _w, cc, a, b in lines if abs(cc - c) < 3 and min(hi, b) > max(lo, a))
    got, cur = 0.0, lo
    for a, b in segs:
        if b > cur:
            got += b - max(a, cur)
            cur = b
    return got >= COVER * (hi - lo), [w["id"] for w, cc, a, b in lines if abs(cc - c) < 3 and min(hi, b) > max(lo, a)]


def _clear_inside(floor, x0, y0, x1, y1, inset=6.0):
    """Remove the stretch of imported axis walls lying strictly inside a traced room (the
    importer's misplaced partitions); the parts outside stay. Doors on removed stretches go."""
    keep, removed = [], []
    for w in floor.get("walls") or []:
        a, b = w.get("start"), w.get("end")
        if w.get("drawn") or not (isinstance(a, dict) and isinstance(b, dict)):
            keep.append(w); continue
        vert = abs(a["x"] - b["x"]) < 2; horiz = abs(a["y"] - b["y"]) < 2
        if not (vert or horiz):
            keep.append(w); continue
        c = a["x"] if vert else a["y"]
        lo_c, hi_c = (x0, x1) if vert else (y0, y1)
        if not (lo_c + inset < c < hi_c - inset):
            keep.append(w); continue
        s0, s1 = sorted((a["y"], b["y"]) if vert else (a["x"], b["x"]))
        lo, hi = (y0, y1) if vert else (x0, x1)
        cut0, cut1 = max(s0, lo), min(s1, hi)
        if cut1 - cut0 < 1:
            keep.append(w); continue
        removed.append((w["id"], cut0, cut1, s0, s1, vert))
        for k, (p, q) in enumerate(((s0, cut0), (cut1, s1))):
            if q - p > 1:
                st, en = ({"x": c, "y": p}, {"x": c, "y": q}) if vert else ({"x": p, "y": c}, {"x": q, "y": c})
                keep.append({**w, "id": f"{w['id']}~{k}", "start": st, "end": en})
    floor["walls"] = keep
    if removed:
        gone = {r[0]: r for r in removed}
        doors = []
        for d in floor.get("doors") or []:
            r = gone.get(d.get("wallId"))
            if not r:
                doors.append(d); continue
            wid, cut0, cut1, s0, s1, vert = r
            at = s0 + (s1 - s0) * float(d.get("position") or 0.5)
            if cut0 <= at <= cut1:
                continue
            k = 0 if at < cut0 else 1
            p, q = (s0, cut0) if k == 0 else (cut1, s1)
            doors.append({**d, "wallId": f"{wid}~{k}", "position": round((at - p) / max(1.0, q - p), 4)})
        floor["doors"] = doors
    return len(removed)



def add_drawn_room(floor: dict, rect: list[dict], name: str, display: str = "", door: dict | None = None,
                   key: str = "", open_sides=(), clear_inside: bool = False) -> dict:
    xs = [p["x"] for p in rect]; ys = [p["y"] for p in rect]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    V, H = _axis_walls(floor, True), _axis_walls(floor, False)
    x0, x1 = _snap(x0, y0, y1, V), _snap(x1, y0, y1, V)
    y0, y1 = _snap(y0, x0, x1, H), _snap(y1, x0, x1, H)
    x0, x1, y0, y1 = (round(v, 1) for v in (x0, x1, y0, y1))
    if clear_inside:
        _clear_inside(floor, x0, y0, x1, y1)
        V, H = _axis_walls(floor, True), _axis_walls(floor, False)
    tag = key or f"{round(x0)}_{round(y0)}"
    thick = 12
    tmpl = next(iter(_walls(floor)), {})
    sides = [("n", False, y0, x0, x1), ("s", False, y1, x0, x1), ("w", True, x0, y0, y1), ("e", True, x1, y0, y1)]
    wall_ids, new = [], {}
    tmpl = next(iter(_walls(floor)), {})
    open_sides = set(open_sides or ())
    for sid, vert, c, lo, hi in sides:
        lines = V if vert else H
        ok, ids = _covered(c, lo, hi, lines)
        if ok:
            wall_ids += ids
            # close corner gaps: covering walls that stop short of the corner (> face epsilon)
            spans = [(max(lo, a), min(hi, b)) for _w, cc, a, b in lines if abs(cc - c) < 3 and min(hi, b) > max(lo, a)]
            first, last = min(a for a, _ in spans), max(b for _, b in spans)
            for k, (a, b) in enumerate(((lo, first), (last, hi))):
                if b - a > 1.0:
                    wid = f"drawn-{tag}-{sid}{k}"
                    st, en = ({"x": c, "y": a}, {"x": c, "y": b}) if vert else ({"x": a, "y": c}, {"x": b, "y": c})
                    floor.setdefault("walls", []).append({**{kk: v for kk, v in tmpl.items() if kk in ("height", "color", "texture", "material")},
                                                          "id": wid, "start": st, "end": en, "thickness": thick, "drawn": True})
                    wall_ids.append(wid)
            continue
        wid = f"drawn-{tag}-{sid}"
        s, e = ({"x": c, "y": lo}, {"x": c, "y": hi}) if vert else ({"x": lo, "y": c}, {"x": hi, "y": c})
        w = {**{k: v for k, v in tmpl.items() if k in ("height", "color", "texture", "material")},
             "id": wid, "start": s, "end": e, "thickness": thick, "drawn": True}
        floor.setdefault("walls", []).append(w)
        new[sid] = w
        wall_ids.append(wid)
    # Open sides (a hall entered straight from the corridor, printed with no wall line): the
    # gap still closes the outline (so the room has a face), but as a full-width opening.
    for w in list(floor.get("walls") or []):
        wid = str(w.get("id", ""))
        if any(wid.startswith(f"drawn-{tag}-{sid}") for sid in open_sides):
            L = ((w["end"]["x"] - w["start"]["x"]) ** 2 + (w["end"]["y"] - w["start"]["y"]) ** 2) ** 0.5
            vert = abs(w["start"]["x"] - w["end"]["x"]) < 2
            c = w["start"]["x"] if vert else w["start"]["y"]
            a0 = min(w["start"]["y"], w["end"]["y"]) if vert else min(w["start"]["x"], w["end"]["x"])
            a1 = a0 + L
            # the opening is the stretch with no imported wall on this line (largest gap)
            spans = sorted((max(a0, a), min(a1, b)) for _w, cc, a, b in (V if vert else H)
                           if abs(cc - c) < 3 and min(a1, b) > max(a0, a) and not _w.get("drawn"))
            gaps, cur = [], a0
            for a, b in spans:
                if a > cur:
                    gaps.append((cur, a))
                cur = max(cur, b)
            if a1 > cur:
                gaps.append((cur, a1))
            g = max(gaps, key=lambda t: t[1] - t[0], default=None)
            start_a = min(w["start"]["y"], w["end"]["y"]) if vert else min(w["start"]["x"], w["end"]["x"])
            if g and g[1] - g[0] > 40:
                mid = (g[0] + g[1]) / 2
                pos = (mid - start_a) / L
                if (w["end"]["y"] if vert else w["end"]["x"]) < (w["start"]["y"] if vert else w["start"]["x"]):
                    pos = 1 - pos
                w["opening"] = True
                floor.setdefault("doors", []).append({"id": f"door-drawn-{wid[6:]}-open", "wallId": wid, "position": round(pos, 4),
                                                      "width": round(g[1] - g[0] - 2, 1), "height": 240, "type": "opening",
                                                      "swingDirection": "left", "flipSide": False, "drawn": True})
    poly = [{"x": x0, "y": y0}, {"x": x1, "y": y0}, {"x": x1, "y": y1}, {"x": x0, "y": y1}]
    # A door: keep any imported door already on the outline, else add one.
    walls = {w["id"]: w for w in _walls(floor)}
    def on_outline(d):
        w = walls.get(d.get("wallId"))
        if not w:
            return False
        px = w["start"]["x"] + (w["end"]["x"] - w["start"]["x"]) * d.get("position", 0.5)
        py = w["start"]["y"] + (w["end"]["y"] - w["start"]["y"]) * d.get("position", 0.5)
        near = lambda a, b: abs(a - b) < 8
        return ((near(px, x0) or near(px, x1)) and y0 - 5 <= py <= y1 + 5) or ((near(py, y0) or near(py, y1)) and x0 - 5 <= px <= x1 + 5)
    has_door = any(on_outline(d) for d in floor.get("doors") or [])
    if door or not has_door:
        import math
        allw = _walls(floor)
        def dist_to_walls(px, py):
            best = 1e9
            for w in allw:
                ax, ay, bx, by = w["start"]["x"], w["start"]["y"], w["end"]["x"], w["end"]["y"]
                dx, dy = bx - ax, by - ay; L = dx * dx + dy * dy or 1
                t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L))
                best = min(best, math.hypot(px - ax - dx * t, py - ay - dy * t))
            return best
        mids = {"n": ((x0 + x1) / 2, y0, 0, -1), "s": ((x0 + x1) / 2, y1, 0, 1), "w": (x0, (y0 + y1) / 2, -1, 0), "e": (x1, (y0 + y1) / 2, 1, 0)}
        if door:
            sid = min(mids, key=lambda k: math.hypot(mids[k][0] - door["x"], mids[k][1] - door["y"]) if k in ("n", "s") else abs(mids[k][0] - door["x"]))
            px, py = (door["x"], mids[sid][1]) if sid in ("n", "s") else (mids[sid][0], door["y"])
        else:
            sid = max(mids, key=lambda k: dist_to_walls(mids[k][0] + mids[k][2] * 80, mids[k][1] + mids[k][3] * 80))
            px, py = mids[sid][0], mids[sid][1]
        # the wall carrying that point: a new side wall, else the imported wall under it
        host = new.get(sid)
        if host is None:
            for w in allw:
                ax, ay, bx, by = w["start"]["x"], w["start"]["y"], w["end"]["x"], w["end"]["y"]
                if sid in ("n", "s") and abs(ay - by) < 2 and abs(ay - py) < 4 and min(ax, bx) <= px <= max(ax, bx): host = w; break
                if sid in ("w", "e") and abs(ax - bx) < 2 and abs(ax - px) < 4 and min(ay, by) <= py <= max(ay, by): host = w; break
        if host is not None:
            ax, ay, bx, by = host["start"]["x"], host["start"]["y"], host["end"]["x"], host["end"]["y"]
            L = math.hypot(bx - ax, by - ay) or 1
            pos = ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / (L * L)
            width = min(100.0, max(70.0, (x1 - x0 if sid in ("n", "s") else y1 - y0) * 0.4))
            m = width / 2 / L + 0.02
            pos = min(1 - m, max(m, pos))
            floor.setdefault("doors", []).append({"id": f"door-drawn-{tag}", "wallId": host["id"], "position": round(pos, 4),
                                                  "width": width, "height": 210, "type": "single",
                                                  "swingDirection": "left", "flipSide": False, "drawn": True})
    room = {"id": f"room-drawn-{tag}", "name": name, "walls": wall_ids, "floorPolygon": poly,
            "area": round((x1 - x0) * (y1 - y0) / 10000, 2), "roomType": "room", "drawn": True, "nameSource": "manual"}
    if display:
        room["displayName"] = display
    if open_sides:
        room["openSides"] = sorted(open_sides)
    if clear_inside:
        room["clearInside"] = True
    floor["rooms"] = [r for r in floor.get("rooms") or [] if r.get("id") != room["id"]] + [room]
    return room


def remove_drawn_room(floor: dict, room_id: str) -> bool:
    room = next((r for r in floor.get("rooms") or [] if r.get("id") == room_id and r.get("drawn")), None)
    if not room:
        return False
    tag = room_id[len("room-drawn-"):]
    floor["rooms"] = [r for r in floor["rooms"] if r is not room]
    floor["walls"] = [w for w in floor.get("walls") or [] if not str(w.get("id", "")).startswith(f"drawn-{tag}-")]
    floor["doors"] = [d for d in floor.get("doors") or [] if d.get("id") != f"door-drawn-{tag}"
                      and not str(d.get("id", "")).startswith(f"door-drawn-{tag}-")]
    return True

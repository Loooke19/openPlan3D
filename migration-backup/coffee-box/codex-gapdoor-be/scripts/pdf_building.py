"""Multi-page CAD PDF → one openPlan building.

Every page becomes a floor. The floor comes from the sheet title at the foot
of the page (``五层现状平面图 1:100`` → 5F), never from the page number, so a
set printed top floor first still stacks 1F at the bottom. Pages of one set
share their sheet frame, so one centring origin keeps the floors on the same
axes, and elevators / stairs found at the same spot on several floors become
one multi-stop ``verticalLinks`` entry.
"""
from __future__ import annotations

import copy
import math
import re
import tempfile
import uuid
from collections import Counter, deque
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path

from openplan_project import attach_missing_pdf_doors, merge_overlapping_walls, recognize_pdf
import floor_overrides

FLOOR_HEIGHT_CM = 300.0
CM_PER_POINT_1_TO_1 = 2.54 / 72.0
# Sheet titles sit in the bottom band: the plan caption and the title block.
TITLE_BAND = (0.05, 0.76, 0.99, 0.97)
TITLE_DPI = 110
_SHAFT_MATCH_CM = 400.0
# Two shafts of one stairwell on the same floor (flights) can sit this far apart.
_SHAFT_CHAIN_CM = 900.0
_DOOR_WIDTH_CM = 100.0
_LANDING_CM = 600.0
_SEALED_RE = re.compile(r"空调|外机|原地面|屋顶|花园|室外|露台|阳台|管井|风井|烟道")

_CN_DIGITS = {"零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
_STOREY_RE = re.compile(r"(地下|负|[Bb])?\s*([一二两三四五六七八九十〇零\d]{1,3})\s*(?:层|楼|[Ff](?![a-z]))")
_SCALE_RE = re.compile(r"1\s*[:：]\s*(\d{2,4})(?!\d)")


def chinese_number(text: str) -> int | None:
    text = (text or "").strip()
    if text.isdigit():
        return int(text)
    if not text or any(ch not in _CN_DIGITS and ch != "十" for ch in text):
        return None
    if "十" not in text:
        value = 0
        for ch in text:
            value = value * 10 + _CN_DIGITS[ch]
        return value
    tens, _, ones = text.partition("十")
    return (_CN_DIGITS.get(tens, 1) if tens else 1) * 10 + (_CN_DIGITS.get(ones, 0) if ones else 0)


def parse_sheet_title(texts: list[str]) -> dict:
    """Storey and scale from OCR lines of one sheet foot.

    Lines naming a plan (``…平面图``) win over stray ``N层`` notes. Basements
    (``地下一层`` / ``B1``) are negative storeys.
    """
    lines = [re.sub(r"\s+", "", str(text or "")) for text in texts]
    lines = [line for line in lines if line]
    ranked = sorted(lines, key=lambda line: ("平面" not in line, "图" not in line))
    title, storey = "", None
    for line in ranked:
        match = _STOREY_RE.search(line)
        if not match:
            continue
        number = chinese_number(match.group(2))
        if not number or number > 200:
            continue
        storey = -number if match.group(1) else number
        title = line
        break
    scales = [int(m.group(1)) for line in lines for m in _SCALE_RE.finditer(line)]
    scale = Counter(scales).most_common(1)[0][0] if scales else None
    return {"title": title, "storey": storey, "scale": scale}


def storey_label(storey: int) -> str:
    return f"B{-storey}" if storey < 0 else f"{storey}F"


def storey_level(storey: int) -> int:
    return storey - 1 if storey > 0 else storey


def floor_id_for(level: int) -> str:
    return f"floor-{level}" if level >= 0 else f"floor-b{-level}"


def page_count(pdf_path) -> int:
    import fitz
    doc = fitz.open(str(pdf_path))
    try:
        return doc.page_count
    finally:
        doc.close()


def read_sheet_titles(pdf_path, pages=None) -> list[dict]:
    """OCR each page's foot. Pages without a readable storey get ``storey: None``."""
    import fitz
    from maker_ocr import recognize_image, resolve_ocr_backend
    backend = resolve_ocr_backend()
    doc = fitz.open(str(pdf_path))
    rows = []
    try:
        numbers = pages or range(1, doc.page_count + 1)
        for number in numbers:
            page = doc[number - 1]
            rect = page.rect
            x0, y0, x1, y1 = TITLE_BAND
            clip = fitz.Rect(rect.width * x0, rect.height * y0, rect.width * x1, rect.height * y1)
            texts = []
            if backend != "off":
                pix = page.get_pixmap(dpi=TITLE_DPI, clip=clip, alpha=False)
                with tempfile.TemporaryDirectory(prefix="sheet-title-") as folder:
                    png = Path(folder) / "title.png"
                    png.write_bytes(pix.tobytes("png"))
                    texts = [item.get("text") or "" for item in recognize_image(png, backend=backend)]
            texts += [line for line in page.get_text("text", clip=clip).splitlines() if line.strip()]
            rows.append({"page": number, **parse_sheet_title(texts)})
    finally:
        doc.close()
    return rows


def assign_floors(titles: list[dict]) -> list[dict]:
    """Give every page a unique level; pages without a storey go above the known ones."""
    taken: set[int] = set()
    out = []
    for row in titles:
        storey = row.get("storey")
        if storey is None:
            continue
        level = storey_level(storey)
        if level in taken:
            continue
        taken.add(level)
        out.append({**row, "level": level, "name": storey_label(storey), "detected": True})
    level = max(taken, default=-1) + 1
    for row in titles:
        if any(item["page"] == row["page"] for item in out):
            continue
        while level in taken:
            level += 1
        taken.add(level)
        out.append({**row, "level": level, "name": f"第{row['page']}页", "detected": False})
    out.sort(key=lambda item: item["level"])
    return out


def sheet_scale(titles: list[dict]) -> float | None:
    """Centimetres per PDF point from the most common ``1:N`` on the set."""
    scales = [row["scale"] for row in titles if row.get("scale")]
    if not scales:
        return None
    return Counter(scales).most_common(1)[0][0] * CM_PER_POINT_1_TO_1


def _components(grid):
    """8-connected walkable components: (label per cell, size per label)."""
    labels = [-1] * (grid.cols * grid.rows)
    sizes = []
    for start in range(len(labels)):
        if labels[start] >= 0 or not grid.walk[start]:
            continue
        label = len(sizes)
        labels[start] = label
        size = 0
        queue = deque([start])
        while queue:
            index = queue.popleft()
            size += 1
            col, row = index % grid.cols, index // grid.cols
            for dr in (-1, 0, 1):
                for dc in (-1, 0, 1):
                    c, r = col + dc, row + dr
                    if (dc or dr) and 0 <= c < grid.cols and 0 <= r < grid.rows:
                        nxt = r * grid.cols + c
                        if grid.walk[nxt] and labels[nxt] < 0:
                            labels[nxt] = label
                            queue.append(nxt)
        sizes.append(size)
    return labels, sizes


def _grid_and_main(floor):
    from floor_nav import build_grid
    grid = build_grid(floor)
    if not grid:
        return None, None, None
    labels, sizes = _components(grid)
    if not sizes:
        return grid, labels, None
    # The corridor network is the component most destinations open onto; a
    # large doorless face (a roof terrace, the site) can outsize it.
    reached = Counter()
    for dest in grid.destinations:
        dest = {**dest, **(dest.get("interior") or {})}
        label = _label_at(grid, labels, dest["x"], dest["y"])
        if label is not None:
            reached[label] += 1
    return grid, labels, max(range(len(sizes)), key=lambda label: (reached[label], sizes[label]))


def _label_at(grid, labels, x, y):
    col, row = grid.cell_at(x, y)
    if not (0 <= col < grid.cols and 0 <= row < grid.rows):
        return None
    label = labels[row * grid.cols + col]
    return label if label >= 0 else None


def _reaches_main(grid, labels, main, x, y) -> bool:
    from floor_nav import SNAP_CM, _nearest
    cell = _nearest(grid, *grid.cell_at(x, y), SNAP_CM / grid.cell)
    return bool(cell) and labels[cell[1] * grid.cols + cell[0]] == main


def _door_toward_main(floor, room, x, y, grid, labels, main):
    """Door on the room wall whose far side is the floor's main walkable area."""
    options = _doors_toward_main(floor, room, x, y, grid, labels, main)
    return options[0] if options else None


def _doors_toward_main(floor, room, x, y, grid, labels, main):
    """Every candidate door onto the main area, nearest wall first."""
    walls = {wall["id"]: wall for wall in floor.get("walls") or []}
    found = []
    for wall_id in room.get("walls") or []:
        wall = walls.get(wall_id)
        if not wall:
            continue
        x0, y0 = wall["start"]["x"], wall["start"]["y"]
        x1, y1 = wall["end"]["x"], wall["end"]["y"]
        dx, dy = x1 - x0, y1 - y0
        length = math.hypot(dx, dy)
        if length < _DOOR_WIDTH_CM * 0.8:
            continue
        t = ((x - x0) * dx + (y - y0) * dy) / (length * length)
        margin = (_DOOR_WIDTH_CM / 2 + 10) / length
        if margin >= 0.5:
            continue
        t = min(1 - margin, max(margin, t))
        fx, fy = x0 + dx * t, y0 + dy * t
        away = math.hypot(fx - x, fy - y)
        if away < 1:
            continue
        # Walk out past the wall's clearance band (cells next to a wall are not walkable,
        # so one fixed 30 cm probe can land in it and miss a lobby right outside).
        half = float(wall.get("thickness") or 15) / 2
        if not any(
            _label_at(grid, labels, fx + (fx - x) / away * (half + step), fy + (fy - y) / away * (half + step)) == main
            for step in (30, 60, 90, 120, 150, 180)
        ):
            continue
        found.append((away, wall_id, t, length))
    found.sort(key=lambda item: item[0])
    return [{
        "wallId": wall_id,
        "position": round(t, 4),
        "width": round(min(_DOOR_WIDTH_CM, length * 0.8), 1),
        "height": 210,
        "type": "single",
        "swingDirection": "left",
        "flipSide": False,
    } for _away, wall_id, t, length in found]


def _room_faces(floor):
    """room id -> closed-face polygon [(x, y)] (the room's real outline)."""
    from floor_nav import _match_room
    from openplan_project import detect_closed_rooms
    walls = [w for w in floor.get("walls") or [] if isinstance(w, dict)]
    rooms = [r for r in floor.get("rooms") or [] if isinstance(r, dict)]
    out = {}
    for face in detect_closed_rooms(walls) if len(walls) >= 3 else []:
        room = _match_room(face, rooms)
        if room and room.get("id") not in out:
            out[room["id"]] = [(p["x"], p["y"]) for p in face.get("polygon") or []]
    return out


def _door_points(floor):
    walls = {w.get("id"): w for w in floor.get("walls") or []}
    pts = []
    for d in floor.get("doors") or []:
        w = walls.get(d.get("wallId"))
        if w:
            t = float(d.get("position") or 0.5)
            pts.append((w["start"]["x"] + (w["end"]["x"] - w["start"]["x"]) * t,
                        w["start"]["y"] + (w["end"]["y"] - w["start"]["y"]) * t))
    return pts


def _seg_dist(px, py, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    L = dx * dx + dy * dy
    t = 0.0 if L == 0 else max(0.0, min(1.0, ((px - a[0]) * dx + (py - a[1]) * dy) / L))
    return math.hypot(px - a[0] - dx * t, py - a[1] - dy * t)


def _near_polygon(pt, poly, tol):
    return any(_seg_dist(pt[0], pt[1], poly[i], poly[(i + 1) % len(poly)]) <= tol for i in range(len(poly)))


def _door_on_corridor_wall(floor, room, poly, x, y, grid, labels, main):
    """Door in the middle of the room's longest outline edge whose outside is circulation
    (main walkable area, not inside another named room), placed on the wall under it."""
    from floor_nav import _point_in_polygon
    named = {r.get("id") for r in floor.get("rooms") or []
             if str(r.get("name") or "").strip() and not _CIRCULATION_RE.search(str(r.get("name")))}
    skip = [q for rid, q in _room_faces(floor).items() if rid != room.get("id") and rid in named]
    walls = [w for w in floor.get("walls") or [] if isinstance(w, dict)]
    best = None
    n = len(poly)
    for i in range(n):
        a, b = poly[i], poly[(i + 1) % n]
        dx, dy = b[0] - a[0], b[1] - a[1]
        length = math.hypot(dx, dy)
        if length < _DOOR_WIDTH_CM * 1.1:
            continue
        nx, ny = -dy / length, dx / length
        mx, my = a[0] + dx / 2, a[1] + dy / 2
        if (mx - x) * nx + (my - y) * ny < 0:
            nx, ny = -nx, -ny
        hits = 0
        for t in (0.3, 0.5, 0.7):
            px0, py0 = a[0] + dx * t, a[1] + dy * t
            for step in (30, 60, 90):
                px, py = px0 + nx * (10 + step), py0 + ny * (10 + step)
                if any(_point_in_polygon(px, py, q) for q in skip):
                    break
                if _label_at(grid, labels, px, py) == main:
                    hits += 1
                    break
        if hits >= 2 and (best is None or length > best[0]):
            best = (length, mx, my)
    if not best:
        return None
    _length, mx, my = best
    own = set(room.get("walls") or [])
    walls = [w for w in walls if w.get("id") in own] or walls
    wall = min(walls, key=lambda w: _seg_dist(mx, my, (w["start"]["x"], w["start"]["y"]), (w["end"]["x"], w["end"]["y"])), default=None)
    if not wall:
        return None
    x0, y0, x1, y1 = wall["start"]["x"], wall["start"]["y"], wall["end"]["x"], wall["end"]["y"]
    L = math.hypot(x1 - x0, y1 - y0)
    if L < 1:
        return None
    t = ((mx - x0) * (x1 - x0) + (my - y0) * (y1 - y0)) / (L * L)
    width = min(_DOOR_WIDTH_CM, _length * 0.8)
    margin = (width / 2 + 5) / L
    t = min(1 - margin, max(margin, t))
    return {"wallId": wall["id"], "position": round(t, 4), "width": round(width, 1),
            "height": 210, "type": "single", "swingDirection": "left", "flipSide": False, "inferred": True}


def _next_door_id(floor) -> str:
    used = {door.get("id") for door in floor.get("doors") or []}
    number = len(used) + 1
    while f"door-{number}" in used:
        number += 1
    return f"door-{number}"


_CIRCULATION_RE = re.compile(r"电梯|楼梯|梯间|候梯|前室|门厅|大厅|走廊|过道|lift|elevator|stair|lobby|hall", re.I)


def _landing_outside(floor, room, x, y, grid, labels, main, skip):
    """Main-area point straight out from the nearest shaft wall, i.e. in front of the lift.

    Probes outward from each wall of the shaft room past the wall's clearance band and
    ignores neighbouring named rooms, so a sealed shaft box in a lift lobby lands in the
    lobby instead of in the room on the far side of a shared wall.
    """
    from floor_nav import _point_in_polygon
    walls = {wall["id"]: wall for wall in floor.get("walls") or []}
    best = None
    for wall_id in room.get("walls") or []:
        wall = walls.get(wall_id)
        if not wall:
            continue
        x0, y0 = wall["start"]["x"], wall["start"]["y"]
        dx, dy = wall["end"]["x"] - x0, wall["end"]["y"] - y0
        length = math.hypot(dx, dy)
        if length < 1:
            continue
        t = min(1.0, max(0.0, ((x - x0) * dx + (y - y0) * dy) / (length * length)))
        fx, fy = x0 + dx * t, y0 + dy * t
        away = math.hypot(fx - x, fy - y)
        if away < 1:
            continue
        half = float(wall.get("thickness") or 15) / 2
        for step in (30, 60, 90, 120, 150, 180):
            px, py = fx + (fx - x) / away * (half + step), fy + (fy - y) / away * (half + step)
            if any(_point_in_polygon(px, py, polygon) for polygon in skip):
                break  # this wall faces a neighbouring room, not a landing
            if _label_at(grid, labels, px, py) != main:
                continue
            if best is None or away + step < best[0]:
                best = (away + step, grid.center(*grid.cell_at(px, py)))
            break
    return best[1] if best else None


def _other_room_polygons(floor, holder_id):
    """Polygons of the floor's named non-corridor rooms other than the shaft's own.

    A landing is where you step out of the lift; it is never inside a neighbouring
    room on the far side of a shared wall (e.g. the X-ray room next to the shaft).
    """
    from floor_nav import _doors_on_face, _is_corridor, _match_room
    from openplan_project import detect_closed_rooms
    walls = [wall for wall in floor.get("walls") or [] if isinstance(wall, dict)]
    by_id = {wall["id"]: wall for wall in walls if wall.get("id")}
    doors = [door for door in floor.get("doors") or [] if isinstance(door, dict)]
    rooms = [room for room in floor.get("rooms") or [] if isinstance(room, dict)]
    polygons = []
    for face in detect_closed_rooms(walls) if len(walls) >= 3 else []:
        room = _match_room(face, rooms)
        name = str((room or {}).get("name") or "").strip()
        if not room or room.get("id") == holder_id or not name or _CIRCULATION_RE.search(name):
            continue  # unnamed space, the shaft itself, or a lift / stair hall: a fine landing
        if _is_corridor(face, room, len(_doors_on_face(face, doors, by_id))):
            continue
        polygon = [(point["x"], point["y"]) for point in face.get("polygon") or []]
        if len(polygon) >= 3:
            polygons.append(polygon)
    return polygons


def _nearest_main(grid, labels, main, x, y, radius_cm, skip=()):
    from floor_nav import _point_in_polygon
    col, row = grid.cell_at(x, y)
    reach = int(radius_cm / grid.cell)
    best = None
    for dr in range(-reach, reach + 1):
        for dc in range(-reach, reach + 1):
            c, r = col + dc, row + dr
            if not (0 <= c < grid.cols and 0 <= r < grid.rows) or labels[r * grid.cols + c] != main:
                continue
            if skip:
                cx, cy = grid.center(c, r)
                if any(_point_in_polygon(cx, cy, polygon) for polygon in skip):
                    continue
            # Deep cells keep the stop off the wall face.
            score = dc * dc + dr * dr - 4 * min(grid.clear_at(c, r), 3)
            if best is None or score < best[0]:
                best = (score, c, r)
    return grid.center(best[1], best[2]) if best else None


def connect_shafts(floor: dict, vertical: list[dict]) -> dict:
    """Make every elevator / stairs stop reachable from the floor's main walkable area.

    CAD draws a shaft door as a gap, which wall healing closes, so a sealed
    shaft room gets a door on the wall facing the main area. A shaft that is
    not a room of its own (or still sealed) moves its stop to the nearest main
    area cell, i.e. its landing. Stops with no landing nearby are dropped.
    Returns ``{"doors": [...], "landings": n, "dropped": n}``.
    """
    report = {"doors": [], "landings": 0, "dropped": 0}
    rooms = {room.get("id"): room for room in floor.get("rooms") or []}
    kept = []
    for shaft in vertical:
        grid, labels, main = _grid_and_main(floor)
        if grid is None or main is None:
            report["dropped"] += 1
            continue
        if _reaches_main(grid, labels, main, shaft["x"], shaft["y"]):
            kept.append(shaft)
            continue
        room = rooms.get(shaft.get("roomId"))
        # Try walls nearest first, but keep a door only if the stop then reaches the main
        # area: the nearest wall can face a stair well or a sliver the grid cannot walk.
        reached = False
        for door in _doors_toward_main(floor, room, shaft["x"], shaft["y"], grid, labels, main) if room else []:
            door["id"] = _next_door_id(floor)
            floor.setdefault("doors", []).append(door)
            trial = _grid_and_main(floor)
            if trial[2] is not None and _reaches_main(*trial, shaft["x"], shaft["y"]):
                report["doors"].append(door["id"])
                grid, labels, main = trial
                reached = True
                break
            floor["doors"].remove(door)
        if reached:
            kept.append(shaft)
            continue
        grid, labels, main = _grid_and_main(floor)
        # A shaft drawn as its own sealed box inside the lift lobby stays unreachable even
        # after the lobby gets a door. Stand in the holder room (the lobby) rather than
        # the nearest walkable cell as the crow flies, which can lie across a wall in a
        # neighbouring room.
        lobby = next((d for d in grid.destinations if room and d["id"] == room.get("id")), None)
        if lobby:
            lobby = {**lobby, **(lobby.get("interior") or {})}  # judge the real room, not its fallback
        if lobby and _reaches_main(grid, labels, main, lobby["x"], lobby["y"]):
            kept.append({**shaft, "at": (shaft["x"], shaft["y"]), "x": lobby["x"], "y": lobby["y"]})
            report["landings"] += 1
            continue
        skip = _other_room_polygons(floor, shaft.get("roomId"))
        landing = (_landing_outside(floor, room, shaft["x"], shaft["y"], grid, labels, main, skip) if room else None) \
            or _nearest_main(grid, labels, main, shaft["x"], shaft["y"], _LANDING_CM, skip=skip)
        if not landing:
            report["dropped"] += 1
            continue
        report["landings"] += 1
        kept.append({
            **shaft, "roomId": "", "at": (shaft["x"], shaft["y"]),
            "x": round(landing[0], 1), "y": round(landing[1], 1),
        })
    vertical[:] = kept
    return report


def add_entrances(floor: dict) -> list[dict]:
    """Exterior doors of the ground floor become 出入口 POIs (searchable, routable).

    A door is exterior when one side of it lies inside the floor footprint and the other side
    outside. The POI stands 1 m inside the door. Works on any import: no names needed.
    """
    import math
    from floor_nav import _point_in_polygon
    footprint = floor.get("footprint") or []
    if len(footprint) < 3:
        return []
    walls = {w["id"]: w for w in floor.get("walls") or []}
    found = []
    for door in floor.get("doors") or []:
        wall = walls.get(door.get("wallId"))
        if not wall:
            continue
        sx, sy, ex, ey = wall["start"]["x"], wall["start"]["y"], wall["end"]["x"], wall["end"]["y"]
        length = math.hypot(ex - sx, ey - sy)
        if length < 1:
            continue
        t = float(door.get("position") or 0.5)
        px, py = sx + (ex - sx) * t, sy + (ey - sy) * t
        nx, ny = -(ey - sy) / length, (ex - sx) / length
        probe = float(wall.get("thickness") or 20) / 2 + 80
        a = _point_in_polygon(px + nx * probe, py + ny * probe, footprint)
        b = _point_in_polygon(px - nx * probe, py - ny * probe, footprint)
        if a == b:
            continue
        sign = 1 if a else -1
        inset = float(wall.get("thickness") or 20) / 2 + 100
        found.append({"x": px + nx * inset * sign, "y": py + ny * inset * sign, "w": float(door.get("width") or 90)})
    # One POI per entrance: merge doors within 4 m (double doors, vestibules).
    merged = []
    for e in sorted(found, key=lambda e: -e["w"]):
        if all(math.hypot(e["x"] - m["x"], e["y"] - m["y"]) > 400 for m in merged):
            merged.append(e)
    # Primary entrance (大门): the widest exterior door opening onto a public lobby, preferring the
    # biggest lobby; lobbies next to an infection-control cluster (一脱/二脱/采样…) are secondary.
    faces = _room_faces(floor)
    infection = [faces[r["id"]] for r in floor.get("rooms") or []
                 if r.get("id") in faces and _INFECTION_RE.search(str(r.get("name") or ""))]

    def _box(q):
        return min(x for x, _ in q), min(y for _, y in q), max(x for x, _ in q), max(y for _, y in q)

    def _gap(a, b):
        return math.hypot(max(0.0, max(a[0], b[0]) - min(a[2], b[2])), max(0.0, max(a[1], b[1]) - min(a[3], b[3])))

    lobbies = []
    for room in floor.get("rooms") or []:
        if re.search(r"门厅|大厅|入口", str(room.get("name") or "")) and room.get("id") in faces:
            q = faces[room["id"]]
            bx = _box(q)
            near_infection = sum(1 for f in infection if _gap(bx, _box(f)) <= _ZONE_GAP_CM) >= 2
            lobbies.append({"room": room, "c": (sum(x for x, _ in q) / len(q), sum(y for _, y in q) / len(q)),
                            "area": (bx[2] - bx[0]) * (bx[3] - bx[1]), "restricted": near_infection})
    for note in floor.get("textAnnotations") or []:
        if note.get("poi") and re.fullmatch(r"门厅|大厅|门诊大厅|入口大厅", str(note.get("text") or "")):
            c = (float(note["x"]), float(note["y"]))
            near_infection = sum(1 for f in infection if _gap((c[0], c[1], c[0], c[1]), _box(f)) <= _ZONE_GAP_CM) >= 2
            if not any(math.hypot(c[0] - l["c"][0], c[1] - l["c"][1]) < 300 for l in lobbies):
                lobbies.append({"room": note, "c": c, "area": 0.0, "restricted": near_infection})
    floor["_lobbies"] = lobbies

    def score(e):
        near = [l for l in lobbies if math.hypot(e["x"] - l["c"][0], e["y"] - l["c"][1]) <= 800]
        public = [l for l in near if not l["restricted"]]
        return (1 if public else 0, 0 if any(l["restricted"] for l in near) else 1, e["w"],
                max((l["area"] for l in public), default=0))

    notes = floor.setdefault("textAnnotations", [])
    pois = []
    if not merged:
        # Entrance drawn as an open gap (no door leaf): the lobby is the entrance.
        for item in list(floor.get("rooms") or []) + notes:
            label = str(item.get("name") or item.get("text") or "")
            if label in ("门厅", "大厅", "门诊大厅", "入口大厅"):
                item["aliases"] = sorted(set(item.get("aliases") or []) | {"出入口", "入口"})
        public = [l for l in lobbies if not l["restricted"]] or lobbies
        if public:
            # Main entrance = the public lobby (largest; an open gap has no door width to compare).
            best = max(public, key=lambda l: l["area"])
            floor["_primary_entrance"] = best["c"]
            best["room"]["aliases"] = sorted(set(best["room"].get("aliases") or []) | {"大门", "主入口"})
        return []
    primary = max(merged, key=score)
    floor["_primary_entrance"] = (primary["x"], primary["y"])
    ordered = [primary] + [e for e in merged if e is not primary]
    for n, e in enumerate(ordered):
        letter = chr(ord("A") + n) if n < 26 else str(n + 1)
        text = f"大门（出入口 {letter}）" if n == 0 else f"出入口 {letter}"
        aliases = ["出入口", "入口", "门口", f"出入口{letter}"] + (["大门", "正门", "主入口"] if n == 0 else [])
        poi = {"id": f"entrance-{n + 1}", "x": round(e["x"], 1), "y": round(e["y"], 1), "text": text,
               "fontSize": 14, "color": "#555555", "rotation": 0, "poi": True, "aliases": aliases,
               "primary": n == 0}
        notes.append(poi)
        pois.append(poi)
    return pois


def name_links(links: list[dict], floors: list[dict], north_bearing) -> None:
    """Patient names for stairs/lifts. Several of a kind: with a north arrow 「楼梯（北）」, without
    one 「楼梯 A」/「楼梯 B」 left→right on the drawing (never compass words). Use the
    lowest stop and its floor centre in drawing axes; upper-floor plan origins can differ. A link that alone
    reaches some floor records it in ``onlyTo`` (「只有这部楼梯能到 4 楼」)."""
    label = {"stairs": "楼梯", "elevator": "电梯", "escalator": "扶梯"}
    by_kind = {}
    for link in links:
        by_kind.setdefault(link.get("kind"), []).append(link)
    names = {f.get("id"): f.get("name") for f in floors}
    levels = {f["id"]: f["level"] for f in floors}
    centres = {}
    for floor in floors:
        xs = [p["x"] for w in floor["walls"] for p in (w["start"], w["end"])]
        ys = [p["y"] for w in floor["walls"] for p in (w["start"], w["end"])]
        centres[floor["id"]] = ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2) if xs else (0.0, 0.0)
    anchor = lambda link: min(link["stops"], key=lambda stop: levels[stop["floorId"]])
    for kind, group in by_kind.items():
        base = label.get(kind, "楼梯")
        coord = lambda l, k: anchor(l)[k]
        if len(group) == 1:
            group[0]["name"] = base
        else:
            sides = None
            if isinstance(north_bearing, (int, float)):
                sides = []
                for l in group:
                    stop = anchor(l)
                    cx, cy = centres[stop["floorId"]]
                    ang = math.degrees(math.atan2(stop["x"] - cx, -(stop["y"] - cy)))
                    sides.append(_COMPASS[int((ang % 360 + 22.5) // 45) % 8])
                if len(set(sides)) < len(sides):
                    sides = None
            if sides:
                for l, side in zip(group, sides):
                    l["name"] = f"{base}（{side}）"
            else:
                for n, l in enumerate(sorted(group, key=lambda l: (coord(l, "x"), coord(l, "y")))):
                    l["name"] = f"{base} {chr(ord('A') + n)}"
    for link in links:
        reach = {s["floorId"] for s in link["stops"]}
        others = set().union(*[{s["floorId"] for s in o["stops"]} for o in links if o is not link]) if len(links) > 1 else set()
        only = [names.get(fid) for fid in reach - others]
        if only and len(links) > 1:
            link["onlyTo"] = only


_COMPASS = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"]


def name_lobbies(floor: dict, north_bearing) -> None:
    """Several 门厅 on the ground floor: tell them apart by compass side; the one at the main
    entrance says so — 「门厅（北·主入口）」 / 「门厅（西南）」. Without a north arrow: （主入口）/ A, B."""
    lobbies = floor.pop("_lobbies", None) or []
    main = floor.pop("_primary_entrance", None)
    if len(lobbies) < 2:
        return
    xs = [p["x"] for w in floor.get("walls") or [] for p in (w["start"], w["end"])]
    ys = [p["y"] for w in floor.get("walls") or [] for p in (w["start"], w["end"])]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    main_lobby = min(lobbies, key=lambda l: math.hypot(l["c"][0] - main[0], l["c"][1] - main[1])) if main else None
    for n, l in enumerate(sorted(lobbies, key=lambda l: (l is not main_lobby, l["c"][0]))):
        room = l["room"]
        if room.get("displayName") or room.get("nameSource") == "manual":
            continue
        if isinstance(north_bearing, (int, float)):
            ang = math.degrees(math.atan2(l["c"][0] - cx, -(l["c"][1] - cy)))
            side = _COMPASS[int(((ang - north_bearing) % 360 + 22.5) // 45) % 8]
        else:
            side = chr(ord("A") + n)
        base = str(room.get("name") or room.get("text") or "门厅")
        label = f"{base}（{side}·主入口）" if l is main_lobby else f"{base}（{side}）"
        if "text" in room and "walls" not in room:
            room["text"] = label  # POI note: its text is its name
        else:
            room["displayName"] = label
        aliases = set(room.get("aliases") or []) | {base}
        if l is main_lobby:
            aliases |= {"主入口", "大门"}
        room["aliases"] = sorted(aliases)
        room["nameSource"] = "auto-lobby"


def infer_room_doors(floor: dict) -> list[str]:
    """Door named rooms the corridor cannot reach, on their wall facing it.

    CAD door symbols that recognition missed leave rooms sealed; the wall
    onto the main walkable area is where such a door almost always is.
    Outdoor plant decks and similar spaces stay closed.
    """
    grid, labels, main = _grid_and_main(floor)
    if grid is None or main is None:
        return []
    rooms = {room.get("id"): room for room in floor.get("rooms") or []}
    faces = _room_faces(floor)
    door_points = _door_points(floor)
    doors = []
    for dest in grid.destinations:
        dest = {**dest, **(dest.get("interior") or {})}  # sealed rooms: test from inside
        room = rooms.get(dest["id"])
        name = str((room or {}).get("name") or "").strip()
        if not room or not name or _SEALED_RE.search(name):
            continue
        poly = faces.get(room.get("id"))
        doorless = bool(poly) and not any(_near_polygon(pt, poly, 40) for pt in door_points)
        if not doorless and _reaches_main(grid, labels, main, dest["x"], dest["y"]):
            continue
        if doorless:
            # No door symbol at all (P3 2F 女卫): the raster may still leak in through a thin
            # wall, so do not trust reachability. Door the longest corridor-facing wall.
            door = _door_on_corridor_wall(floor, room, poly, dest["x"], dest["y"], grid, labels, main)
            if door:
                doors.append(door)
            continue
        door = _door_toward_main(floor, room, dest["x"], dest["y"], grid, labels, main)
        if door:
            doors.append(door)
    added = []
    for door in doors:
        door["id"] = _next_door_id(floor)
        floor.setdefault("doors", []).append(door)
        added.append(door["id"])
    return added


def link_shafts(floors: list[dict], vertical_by_floor: dict[str, list[dict]]) -> list[dict]:
    """One multi-stop link per shaft position, so a ride skips the floors between."""
    clusters: list[dict] = []
    for floor in sorted(floors, key=lambda item: item["level"]):
        for shaft in vertical_by_floor.get(floor["id"]) or []:
            sx, sy = shaft.get("at") or (shaft["x"], shaft["y"])
            home, best = None, _SHAFT_MATCH_CM
            tag = shaft.get("link")
            if tag:  # manual link id from overrides: same id = same shaft on every floor
                home = next((c for c in clusters if c.get("link") == tag), None)
                best = -1.0
            for cluster in clusters if not tag else ():
                if cluster.get("link"):
                    continue
                if cluster["kind"] != shaft["kind"] or floor["id"] in cluster["floors"]:
                    continue
                d = math.hypot(cluster["x"] - sx, cluster["y"] - sy)
                if d <= best:  # nearest shaft, not the first within range
                    home, best = cluster, d
            if home is None:
                home = {"kind": shaft["kind"], "x": sx, "y": sy, "floors": set(), "stops": [], "link": tag}
                clusters.append(home)
            home["floors"].add(floor["id"])
            stop = {"floorId": floor["id"], "x": float(shaft["x"]), "y": float(shaft["y"])}
            if shaft.get("roomId"):
                stop["roomId"] = shaft["roomId"]
            home["stops"].append(stop)
    # A long stairwell is sometimes detected as two shafts on one floor (one per flight), which
    # splits it into stacked links (1-2F + 2-3F). Chain clusters that meet on one shared floor
    # with nearby stops and no other overlap.
    level = {f["id"]: f["level"] for f in floors}
    merged = True
    while merged:
        merged = False
        for a in clusters:
            for b in clusters:
                if a is b or a["kind"] != b["kind"] or a.get("link") or b.get("link"):
                    continue
                shared = a["floors"] & b["floors"]
                if len(shared) != 1:
                    continue
                fid = next(iter(shared))
                if max(level[f] for f in a["floors"]) != level[fid] or min(level[f] for f in b["floors"]) != level[fid]:
                    continue
                sa = next(st for st in a["stops"] if st["floorId"] == fid)
                sb = next(st for st in b["stops"] if st["floorId"] == fid)
                if math.hypot(sa["x"] - sb["x"], sa["y"] - sb["y"]) > _SHAFT_CHAIN_CM:
                    continue
                a["stops"] += [st for st in b["stops"] if st["floorId"] != fid]
                a["floors"] |= b["floors"]
                clusters.remove(b)
                merged = True
                break
            if merged:
                break
    links = []
    counts: Counter = Counter()
    for cluster in clusters:
        if len(cluster["stops"]) < 2:
            continue
        counts[cluster["kind"]] += 1
        label = "电梯" if cluster["kind"] == "elevator" else "楼梯"
        links.append({
            "id": f"link-{cluster['kind']}-{counts[cluster['kind']]}",
            "kind": cluster["kind"],
            "name": label if counts[cluster["kind"]] == 1 else f"{label}{counts[cluster['kind']]}",
            "source": "override" if cluster.get("link") else "pdf-import",
            "stops": cluster["stops"],
        })
    return links


def _names_for_floor(room_names, row):
    if not room_names:
        return None
    for key in (row["name"], str(row.get("level")), f"{row.get('level')}F", "*"):
        if key in room_names:
            return list(room_names[key])
    return None


def suppress_corridor_spurs(floors, links):
    from shapely.geometry import LineString, Point, Polygon
    from floor_nav import _doors_on_face, _is_corridor, _match_room, _nav_doors, detect_closed_rooms

    for floor in floors:
        walls = floor["walls"]
        lines = {wall["id"]: LineString([(wall["start"]["x"], wall["start"]["y"]),
                                         (wall["end"]["x"], wall["end"]["y"])]) for wall in walls}
        by_id = {wall["id"]: wall for wall in walls}
        doors = _nav_doors(floor)
        corridors = []
        named_hall_walls = set()
        for face in detect_closed_rooms(walls):
            room = _match_room(face, floor["rooms"])
            count = len(_doors_on_face(face, doors, by_id))
            name = str((room or {}).get("name") or "")
            if _is_corridor(face, room, count) and (count >= 2 or re.search(r"门厅|过道|走廊|通道|大厅", name)) and not re.search(r"屋顶|室外|露台|花园", name):
                if re.search(r"门厅|过道|走廊|通道|大厅", name):
                    named_hall_walls.update(face["walls"])
                polygon = Polygon((point["x"], point["y"]) for point in face["polygon"])
                if polygon.area >= 50000:
                    corridors.append(polygon.buffer(20))
        stops = [Point(stop["x"], stop["y"]) for link in links if link.get("kind") == "stairs"
                 for stop in link.get("stops") or [] if stop.get("floorId") == floor["id"]]
        if not corridors or not stops:
            continue

        def overlap(line):
            return max((line.intersection(poly).length for poly in corridors), default=0)

        def end_gaps(wall):
            line = lines[wall["id"]]
            return [min((other.distance(end) for wid, other in lines.items() if wid != wall["id"]), default=1000)
                    for end in line.boundary.geoms]

        def by_stairs(line, radius):
            return any(line.distance(stop) < radius for stop in stops)

        selected = set()
        for wall in walls:
            line = lines[wall["id"]]
            if not (150 <= line.length <= 550 and by_stairs(line, 350) and overlap(line) >= 20):
                continue
            gaps = end_gaps(wall)
            thick = float(wall.get("thickness") or 15)
            if (thick >= 25 and max(gaps) >= 15) or (wall["id"] in named_hall_walls and min(gaps) > 30):
                selected.add(wall["id"])

        for wall in walls:
            line = lines[wall["id"]]
            if wall["id"] in selected or not (line.length <= 250 and by_stairs(line, 350) and overlap(line) >= 20):
                continue
            if max(end_gaps(wall)) < 15:
                continue
            if any(line.distance(lines[wid]) < 150 and abs(line.length - lines[wid].length) < 100
                   and abs((line.coords[-1][0] - line.coords[0][0]) * (lines[wid].coords[-1][1] - lines[wid].coords[0][1])
                           - (line.coords[-1][1] - line.coords[0][1]) * (lines[wid].coords[-1][0] - lines[wid].coords[0][0])) < line.length * lines[wid].length * 0.05
                   for wid in selected):
                selected.add(wall["id"])

        for wall in walls:
            line = lines[wall["id"]]
            if wall["id"] in selected or line.length > 220:
                continue
            if any(line.distance(lines[wid]) < 2 and
                   min(Point(line.coords[0]).distance(lines[wid].boundary), Point(line.coords[-1]).distance(lines[wid].boundary)) < 2 and
                   abs((line.coords[-1][0] - line.coords[0][0]) * (lines[wid].coords[-1][1] - lines[wid].coords[0][1])
                       - (line.coords[-1][1] - line.coords[0][1]) * (lines[wid].coords[-1][0] - lines[wid].coords[0][0])) < line.length * lines[wid].length * 0.05
                   for wid in selected):
                selected.add(wall["id"])

        for wall in walls:
            if wall["id"] in selected:
                wall["height"] = 0

        for wall in list(walls):
            line = lines[wall["id"]]
            if not (550 <= line.length <= 650 and 20 <= float(wall.get("thickness") or 15) <= 25
                    and by_stairs(line, 500) and overlap(line) >= 75):
                continue
            gaps = end_gaps(wall)
            if min(gaps) > 15 or max(gaps) < 75:
                continue
            free = 0 if gaps[0] > gaps[1] else 1
            target = Point(line.coords[free])
            candidates = []
            for other in walls:
                if other is wall:
                    continue
                other_line = lines[other["id"]]
                if 20 < other_line.distance(target) < 220 and other_line.distance(line) < 2:
                    cross = line.intersection(other_line.buffer(2))
                    if not cross.is_empty:
                        candidates.append((target.distance(cross), line.project(cross.centroid)))
            if not candidates:
                continue
            _, at = max(candidates)
            point = line.interpolate(at)
            if target.distance(point) < 50 or target.distance(point) > 220:
                continue
            original_end = dict(wall["start"] if free == 0 else wall["end"])
            cut = {"x": round(point.x, 2), "y": round(point.y, 2)}
            wall["start" if free == 0 else "end"] = cut
            virtual = {**wall, "id": wall["id"] + "~virtual", "height": 0,
                       "start": original_end if free == 0 else cut,
                       "end": cut if free == 0 else original_end}
            walls.append(virtual)
            for room in floor["rooms"]:
                if wall["id"] in room.get("walls", []):
                    room["walls"].append(virtual["id"])


def import_building(pdf_path, *, scale=None, name="", floor_height=FLOOR_HEIGHT_CM, progress=None, room_names=None,
                    previous_project=None) -> dict:
    """``room_names`` supplies OCR corrections; ``previous_project`` retains room identities,
    manual edits and the existing vertical graph on re-import.
    """
    """Return ``{project, floors, links, scale}`` for every page of ``pdf_path``.

    ``scale`` is centimetres per PDF point; without it the sheets' ``1:N`` is used.
    ``progress(done, total, text)`` is called before each page.
    """
    total = page_count(pdf_path)
    if progress:
        progress(0, total + 1, "读取页底图名")
    titles = assign_floors(read_sheet_titles(pdf_path))
    if scale is None:
        scale = sheet_scale(titles)
    if not scale:
        raise ValueError("scale")
    origin = None
    floors, report, vertical_by_floor = [], [], {}
    for done, row in enumerate(sorted(titles, key=lambda item: item["page"]), start=1):
        if progress:
            progress(done, total + 1, f"识别第 {row['page']} 页 · {row['name']}")
        result = recognize_pdf(
            pdf_path, None, 0, mode="generate", floor_name=row["name"],
            page_index=row["page"], scale=scale, origin=origin,
            extra_names=_names_for_floor(room_names, row),
        )
        origin = result["origin"]
        floor = result["project"]["floors"][0]
        floor["id"] = floor_id_for(row["level"])
        floor["name"] = row["name"]
        floor["level"] = row["level"]
        floor["elevation"] = round(row["level"] * floor_height, 1)
        floor["height"] = floor_height
        vertical = result["vertical"]
        previous_floor = next((f for f in (previous_project or {}).get("floors", []) if f["name"] == row["name"]), None)
        override_stats = floor_overrides.apply(floor, vertical, floor_overrides.load(name, row["name"]), previous_floor)
        floor["walls"] = merge_overlapping_walls(floor["walls"], floor["doors"], floor["rooms"])
        attach_missing_pdf_doors(floor, result["doorCandidates"])
        floor["rooms"] = [room for room in floor["rooms"] if room.get("name") or room.get("displayName") or room.get("area", 0) >= 0.5]
        shafts = {"doors": [], "landings": 0} if previous_floor is not None else connect_shafts(floor, vertical)
        inferred = infer_room_doors(floor)
        if row["level"] == min(r["level"] for r in titles):
            add_entrances(floor)
        vertical_by_floor[floor["id"]] = vertical
        floors.append(floor)
        report.append({
            "page": row["page"],
            "floorId": floor["id"],
            "name": row["name"],
            "title": row.get("title") or "",
            "detected": row["detected"],
            "level": row["level"],
            "elevators": sum(item["kind"] == "elevator" for item in vertical),
            "stairs": sum(item["kind"] == "stairs" for item in vertical),
            "shaftDoors": shafts["doors"],
            "shaftLandings": shafts["landings"],
            "inferredDoors": inferred,
            "overrides": override_stats,
            "walls": len(floor.get("walls") or []),
            "rooms": len(floor.get("rooms") or []),
            "doors": len(floor.get("doors") or []),
            "namedRooms": sum(bool(r.get("displayName") or r.get("name")) for r in floor.get("rooms") or []),
        })
    floors.sort(key=lambda item: item["level"])
    floor_overrides.generate_stairs(floors, name)
    links = copy.deepcopy(previous_project.get("verticalLinks") or []) if previous_project is not None else link_shafts(floors, vertical_by_floor)
    ground = next((floor for floor in floors if floor["level"] >= 0), floors[0])
    now = datetime.now(timezone.utc).isoformat()
    try:
        from north_arrow import detect_north
        north = detect_north(pdf_path)
    except Exception:
        north = None
    for floor in floors:
        name_lobbies(floor, north["bearing"] if north else None)
    name_links(links, floors, north["bearing"] if north else None)
    from floor_nav import prepare_floor
    for floor in floors:
        prepare_floor(floor)
    if previous_project is not None:
        links = deepcopy(previous_project.get("verticalLinks") or [])
    floor_overrides.apply_vertical_stops(floors, links, name)
    suppress_corridor_spurs(floors, links)
    project = {
        "id": uuid.uuid4().hex,
        "name": re.sub(r"\s+", " ", (name or "").strip())[:40] or "导入的楼",
        "floors": floors,
        "activeFloorId": ground["id"],
        "verticalLinks": links,
        "restrictedZones": suggest_restricted_zones(floors),
        **({"northBearing": north["bearing"], "northSource": {"page": north["page"], "at": north["at"]}} if north else {}),
        "createdAt": now,
        "updatedAt": now,
    }
    report.sort(key=lambda item: item["level"])
    return {"project": project, "floors": report, "links": links, "scale": round(scale, 5), "north": north}


_INFECTION_RE = re.compile(r"一脱|二脱|脱衣|缓冲间|采样|留观|隔离|发热|穿衣")
_ZONE_GAP_CM = 600.0
_ZONE_PAD_CM = 100.0


def suggest_restricted_zones(floors: list[dict], links: list[dict] | None = None) -> list[dict]:
    """Infection-control clusters (一脱/二脱/缓冲/采样/留观 …, ≥3 rooms within 6 m of each other)
    become a PROVISIONAL 限制通行区: the cluster bbox padded 1 m, plus stair rooms touching it."""
    zones = []
    for floor in floors:
        faces = _room_faces(floor)
        rooms = [r for r in floor.get("rooms") or [] if r.get("id") in faces]
        seeds = [r for r in rooms if _INFECTION_RE.search(str(r.get("name") or ""))]
        boxes = {}
        for r in seeds:
            q = faces[r["id"]]
            boxes[r["id"]] = [min(a for a, _ in q), min(b for _, b in q), max(a for a, _ in q), max(b for _, b in q)]
        def gap(a, b):
            dx = max(0.0, max(a[0], b[0]) - min(a[2], b[2]))
            dy = max(0.0, max(a[1], b[1]) - min(a[3], b[3]))
            return math.hypot(dx, dy)
        groups = []
        for rid, box in boxes.items():
            hit = [g for g in groups if any(gap(box, boxes[o]) <= _ZONE_GAP_CM for o in g)]
            merged = {rid}.union(*hit) if hit else {rid}
            groups = [g for g in groups if g not in hit] + [merged]
        for g in groups:
            if len(g) < 3:
                continue
            bb = [min(boxes[i][0] for i in g), min(boxes[i][1] for i in g), max(boxes[i][2] for i in g), max(boxes[i][3] for i in g)]
            for r in rooms:  # stairs right next to the cluster belong to it
                if re.search(r"楼梯|梯间", str(r.get("name") or "")):
                    q = faces[r["id"]]
                    rb = [min(a for a, _ in q), min(b for _, b in q), max(a for a, _ in q), max(b for _, b in q)]
                    if gap(bb, rb) <= _ZONE_GAP_CM / 2:
                        bb = [min(bb[0], rb[0]), min(bb[1], rb[1]), max(bb[2], rb[2]), max(bb[3], rb[3])]
            x0, y0, x1, y1 = bb[0] - _ZONE_PAD_CM, bb[1] - _ZONE_PAD_CM, bb[2] + _ZONE_PAD_CM, bb[3] + _ZONE_PAD_CM
            zones.append({
                "id": f"zone-{floor.get('id')}-{len(zones) + 1}",
                "floorId": floor.get("id"),
                "name": "限制通行区",
                "polygon": [{"x": round(x0, 1), "y": round(y0, 1)}, {"x": round(x1, 1), "y": round(y0, 1)},
                            {"x": round(x1, 1), "y": round(y1, 1)}, {"x": round(x0, 1), "y": round(y1, 1)}],
                "source": "auto",
                "provisional": True,
                "rooms": sorted(str(next((r.get("name") for r in rooms if r.get("id") == i), "")) for i in g),
            })
    return zones

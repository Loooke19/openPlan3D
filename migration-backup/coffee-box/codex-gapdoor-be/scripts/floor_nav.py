"""Floor navigation for an openPlan project.

Walkable space prefers corridors. Ordinary rooms are not thoroughfares:
with recognized doors, the path stays in the corridor and only enters a
door when the start / end (or a via) is inside that room — one spur from
the nearest door to the room center, never door-to-door through the room.
Doorless closed faces stay as isolated islands. Every wall band is blocked
(inflated to at least ~½ cell so thin walls still seal the grid); doors
reopen only at openings. Paths are 8-connected with wall-clearance cost,
string-pulled through door centers (never hugging jambs).

Floors connect only through vertical links (elevator / stairs / escalator):
same-named facility rooms pair automatically, and ``project.verticalLinks``
holds hand-made pairs. A cross-floor trip is per-floor legs joined by rides.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import secrets
from heapq import heappop, heappush

from PIL import Image, ImageDraw

from openplan_project import ROOM_COLORS, detect_closed_rooms
from floor_overrides import connected_walls
from shapely.geometry import Polygon, LineString, Point, box
from shapely import intersects_xy
import numpy as np
from shapely.ops import unary_union

CELL_CM = 20.0
MAX_CELLS = 800
SNAP_CM = 160.0
MIN_ROOM_CM = 80.0
# Half-width of the in-room spur from the access door to the destination (cm).
SPUR_HALF_CM = 55.0
# Disk at the room center so destination snaps stay on the spur.
DEST_PAD_CM = 70.0
# Paint walls at least this fraction of a cell wide so midline cells get sealed.
_WALL_CELL_COVER = 0.55
# Keep string-pulled chords this far from wall bands (cm), except inside door clears.
# ~half of a narrow hospital corridor (~120 cm) so pulled chords stay off jambs.
_CLEARANCE_PAD_CM = 28.0
# Auto-check / scrape threshold: open samples must stay this far from wall faces.
_MIN_CLEAR_CM = 25.0
# Extra A* cost near walls so routes prefer corridor / room centers.
_WALL_COST = 3.4
# Soft hospital-map fills (same family as Maker / openPlan ROOM_COLORS).
_DEFAULT_FILL = "#e9e7e4"
_PUBLIC_SPACE_RE = re.compile(r"门厅|大厅|候诊|大堂|前厅|lobby|waiting hall", re.I)

_CORRIDOR_RE = re.compile(
    r"走廊|过道|通道|连廊|门厅|候诊|大厅|走道|corridor|hallway|lobby|atrium",
    re.I,
)
# Named private rooms must keep an access spur — the multi-door hall heuristic otherwise
# promotes them to corridors (P2 3F 病房8 has 3 jambs and a large face).
_PRIVATE_ROOM_RE = re.compile(
    r"病房|诊室|办公|治疗|手术|处置|护士|药房|检验|放射|CT|DR|B超|超声|病房",
    re.I,
)

_CACHE: dict[tuple, "FloorGrid"] = {}


class FloorGrid:
    def __init__(self, floor, cell, origin, cols, rows, walk, destinations, clearance=None):
        self.floor = floor
        self.cell = cell
        self.origin_x, self.origin_y = origin
        self.cols = cols
        self.rows = rows
        self.walk = walk
        self.destinations = destinations
        self.clearance = clearance  # cells from nearest blocked cell; None → treat as 1

    def walkable(self, col, row) -> bool:
        if col < 0 or row < 0 or col >= self.cols or row >= self.rows:
            return False
        return self.walk[row * self.cols + col] == 1

    def clear_at(self, col, row) -> int:
        if not self.clearance:
            return 1
        if col < 0 or row < 0 or col >= self.cols or row >= self.rows:
            return 0
        return self.clearance[row * self.cols + col]

    def main_component(self) -> set:
        """Cells of the largest connected walkable region (the building's circulation)."""
        cached = getattr(self, "_main", None)
        if cached is not None:
            return cached
        seen = bytearray(self.cols * self.rows)
        best: list = []
        for start in range(self.cols * self.rows):
            if seen[start] or self.walk[start] != 1:
                continue
            comp, stack = [], [start]
            seen[start] = 1
            while stack:
                i = stack.pop()
                comp.append(i)
                c, r = i % self.cols, i // self.cols
                for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nc, nr = c + dc, r + dr
                    if 0 <= nc < self.cols and 0 <= nr < self.rows:
                        j = nr * self.cols + nc
                        if not seen[j] and self.walk[j] == 1:
                            seen[j] = 1
                            stack.append(j)
            if len(comp) > len(best):
                best = comp
        self._main = set(best)
        return self._main

    def cell_at(self, x, y):
        return int((x - self.origin_x) / self.cell), int((y - self.origin_y) / self.cell)

    def center(self, col, row):
        return (
            self.origin_x + (col + 0.5) * self.cell,
            self.origin_y + (row + 0.5) * self.cell,
        )


def select_floor(project: dict, floor_id: str | None = None) -> dict:
    floors = [floor for floor in project.get("floors") or [] if isinstance(floor, dict)]
    wanted = (floor_id or "").strip()
    if wanted:
        for floor in floors:
            if floor.get("id") == wanted:
                return floor
    active = project.get("activeFloorId") or ""
    for floor in floors:
        if floor.get("id") == active:
            return floor
    return floors[0] if floors else {}


def _walls(floor: dict) -> list[dict]:
    walls = []
    for wall in floor.get("walls") or []:
        if not isinstance(wall, dict):
            continue
        start, end = wall.get("start") or {}, wall.get("end") or {}
        if "x" not in start or "y" not in start or "x" not in end or "y" not in end:
            continue
        walls.append(wall)
    return walls


def floor_surface(floor, faces=None):
    walls = connected_walls(floor) if faces is None else _walls(floor)
    faces = detect_closed_rooms(walls) if faces is None else faces
    rooms = floor.get("rooms") or []
    solid, void = [], []
    for face in faces:
        room = _match_room(face, rooms) or {}
        poly = Polygon([(p["x"], p["y"]) for p in face["polygon"]]).buffer(0)
        (void if room.get("floorOpening") or room.get("roomType") == "void" else solid).append(poly)
    for room in rooms:
        if len(room.get("floorPolygon") or []) >= 3:
            poly = Polygon([(p["x"], p["y"]) for p in room["floorPolygon"]]).buffer(0)
            (void if room.get("floorOpening") or room.get("roomType") == "void" else solid).append(poly)
    solid.extend(Polygon([(p["x"], p["y"]) for p in poly]).buffer(0)
                 for poly in floor.get("walkableRegions") or [])
    surface = unary_union(solid).buffer(10, join_style=2)
    surface = surface.union(surface.buffer(240, join_style=2).buffer(-240, join_style=2))
    public = [Point(a["x"], a["y"]) for a in floor.get("textAnnotations") or []
              if _PUBLIC_SPACE_RE.search(a.get("text") or "")]
    if public:
        bridged = surface.buffer(600, join_style=2).buffer(-600, join_style=2).difference(surface)
        regions = [bridged] if bridged.geom_type == "Polygon" else getattr(bridged, "geoms", [])
        surface = surface.union(unary_union([region for region in regions
                                            if any(region.covers(point) for point in public)]))
    thresholds = []
    for opening in _openings({**floor, "walls": walls}):
        ux, uy, x, y = opening["ux"], opening["uy"], opening["x"], opening["y"]
        half = opening["width"] / 2 + 2
        poly = Polygon(_quad(x - ux * half, y - uy * half, x + ux * half, y + uy * half,
                             opening["across"] / 2 + 10))
        if surface.intersects(poly):
            thresholds.append(poly)
    surface = unary_union([surface, *thresholds])
    footprint = floor.get("footprint") or []
    if len(footprint) >= 3:
        surface = surface.intersection(Polygon([(p["x"], p["y"]) for p in footprint]).buffer(0))
    void.extend(box(b["x0"], b["y0"], b["x1"], b["y1"]) for b in floor.get("footprintExclusions") or [])
    return surface.difference(unary_union(void))


def prepare_floor(floor):
    floor["walls"] = connected_walls(floor)
    surface = floor_surface(floor)
    polygons = [surface] if surface.geom_type == "Polygon" else list(surface.geoms)
    points = lambda ring: [{"x": x, "y": y} for x, y in list(ring.coords)[:-1]]
    floor["floorRegions"] = [{"polygon": points(p.exterior), "holes": [points(r) for r in p.interiors]}
                             for p in polygons if not p.is_empty and p.geom_type == "Polygon"]


def _bounds(walls: list[dict]):
    xs, ys = [], []
    for wall in walls:
        xs += [float(wall["start"]["x"]), float(wall["end"]["x"])]
        ys += [float(wall["start"]["y"]), float(wall["end"]["y"])]
    pad = 40.0
    return min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad


def _quad(x0, y0, x1, y1, across):
    dx, dy = x1 - x0, y1 - y0
    length = math.hypot(dx, dy) or 1.0
    nx, ny = -dy / length * across, dx / length * across
    return [(x0 + nx, y0 + ny), (x1 + nx, y1 + ny), (x1 - nx, y1 - ny), (x0 - nx, y0 - ny)]


def _px(origin_x, origin_y, cell, points):
    return [((x - origin_x) / cell, (y - origin_y) / cell) for x, y in points]


def _despike_faces(faces):
    """Drop zero-width spikes from face outlines (a partition stub traced out and back, e.g.
    P1 1F 西药房 -327.6,250.7 → -327.6,488.1 → back): vertex whose two neighbours coincide
    or that reverses direction on one line."""
    for face in faces or []:
        pg = face.get("polygon") or []
        changed = True
        while changed and len(pg) > 3:
            changed = False
            n = len(pg)
            for i in range(n):
                a, b, c = pg[i - 1], pg[i], pg[(i + 1) % n]
                abx, aby = b["x"] - a["x"], b["y"] - a["y"]
                bcx, bcy = c["x"] - b["x"], c["y"] - b["y"]
                cross = abx * bcy - aby * bcx
                dot = abx * bcx + aby * bcy
                if abs(a["x"] - c["x"]) < 1 and abs(a["y"] - c["y"]) < 1 or (abs(cross) < 1.0 and dot < 0) \
                        or (abs(abx) < 0.5 and abs(aby) < 0.5):
                    del pg[i]
                    changed = True
                    break
            # coincident neighbours leave a duplicate point; merge
            pg[:] = [q for k, q in enumerate(pg) if not (abs(q["x"] - pg[k - 1]["x"]) < 0.5 and abs(q["y"] - pg[k - 1]["y"]) < 0.5)] or pg
        face["polygon"] = pg
    return faces



def _match_room(face, rooms):
    # A drawn room (editor/MCP) owns the face whose outline it traced.
    poly = face.get("polygon") or []
    if poly:
        fx = [p["x"] for p in poly]; fy = [p["y"] for p in poly]
        for room in rooms:
            fp = room.get("floorPolygon") if room.get("drawn") else None
            if not fp:
                continue
            rx = [p["x"] for p in fp]; ry = [p["y"] for p in fp]
            if all(abs(a - b) < 25 for a, b in ((min(fx), min(rx)), (max(fx), max(rx)), (min(fy), min(ry)), (max(fy), max(ry)))):
                return room
        # looser: the traced rect's centre lies in this face and the areas roughly agree
        def _pip(x, y, pg):
            c = False
            for i in range(len(pg)):
                a, b = pg[i], pg[i - 1]
                if (a["y"] > y) != (b["y"] > y) and x < (b["x"] - a["x"]) * (y - a["y"]) / ((b["y"] - a["y"]) or 1e-9) + a["x"]:
                    c = not c
            return c
        farea = abs(sum(poly[i - 1]["x"] * p["y"] - p["x"] * poly[i - 1]["y"] for i, p in enumerate(poly))) / 2
        for room in rooms:
            fp = room.get("floorPolygon") if room.get("drawn") else None
            if not fp:
                continue
            rx = [p["x"] for p in fp]; ry = [p["y"] for p in fp]
            cx, cy = (min(rx) + max(rx)) / 2, (min(ry) + max(ry)) / 2
            rarea = (max(rx) - min(rx)) * (max(ry) - min(ry))
            if _pip(cx, cy, poly) and 0.55 <= farea / max(rarea, 1) <= 1.8:
                return room
    keys = set(face.get("walls") or [])
    for room in rooms:
        if not room.get("drawn") and keys == set(room.get("walls") or []):
            return room
    best = None
    score = 0
    for room in rooms:
        if room.get("drawn"):
            continue
        overlap = len(keys & set(room.get("walls") or []))
        if overlap > score:
            score = overlap
            best = room
    return best if score else None


def _room_fill_color(room, index: int) -> str:
    """Maker-style soft fill: saved room.color, else cycling hospital palette."""
    if room and isinstance(room.get("color"), str) and room["color"].startswith("#"):
        return room["color"]
    if ROOM_COLORS:
        return ROOM_COLORS[index % len(ROOM_COLORS)]
    return _DEFAULT_FILL


def _nav_rooms(floor: dict, walls: list[dict] | None = None) -> list[dict]:
    """Closed-face polygons with fill colors for the 2D nav plan (Maker fills)."""
    walls = walls if walls is not None else _walls(floor)
    faces = _despike_faces(detect_closed_rooms(walls))
    rooms = [room for room in floor.get("rooms") or [] if isinstance(room, dict)]
    out = []
    number = 0
    used_ids: set[str] = set()
    for face in faces:
        polygon = face.get("polygon") or []
        if len(polygon) < 3:
            continue
        xs = [point["x"] for point in polygon]
        ys = [point["y"] for point in polygon]
        if min(max(xs) - min(xs), max(ys) - min(ys)) < MIN_ROOM_CM:
            continue
        room = _match_room(face, rooms)
        if (room or {}).get("floorOpening"):
            continue
        room_id = str(room.get("id") or "") if room else ""
        matched = bool(room_id and room_id not in used_ids)
        if not matched:
            room_id = f"face-{number + 1}"
            while room_id in used_ids:
                room_id += "-extra"
        used_ids.add(room_id)
        name = str(room.get("name") or "").strip() if matched else ""
        out.append({
            "id": room_id,
            "name": name,
            "fillColor": _room_fill_color(room, number),
            "polygon": [
                {"x": round(float(point["x"]), 1), "y": round(float(point["y"]), 1)}
                for point in polygon
            ],
        })
        number += 1
    return out


def _face_bounds(face: dict):
    polygon = face.get("polygon") or []
    if len(polygon) < 3:
        return 0.0, 0.0, 0.0
    xs = [float(point["x"]) for point in polygon]
    ys = [float(point["y"]) for point in polygon]
    width = max(xs) - min(xs)
    height = max(ys) - min(ys)
    return width, height, abs(float(face.get("area") or 0.0))


def _face_centroid(face: dict):
    polygon = face.get("polygon") or []
    xs = [float(point["x"]) for point in polygon]
    ys = [float(point["y"]) for point in polygon]
    return sum(xs) / len(xs), sum(ys) / len(ys)


def _near_polygon_edge(x, y, polygon, tol: float) -> bool:
    points = [(float(p["x"]), float(p["y"])) for p in polygon]
    if len(points) < 2:
        return False
    best = 1e18
    for index, (x0, y0) in enumerate(points):
        x1, y1 = points[(index + 1) % len(points)]
        dx, dy = x1 - x0, y1 - y0
        length_sq = dx * dx + dy * dy
        if length_sq <= 1e-9:
            dist = math.hypot(x - x0, y - y0)
        else:
            t = max(0.0, min(1.0, ((x - x0) * dx + (y - y0) * dy) / length_sq))
            dist = math.hypot(x - (x0 + t * dx), y - (y0 + t * dy))
        if dist < best:
            best = dist
    return best <= tol


PUBLIC_SPACE_RE = re.compile(r"走廊|过道|通道|大厅|门厅|候诊|等候|休息区|前室|楼梯|电梯|出入口|入口")


# Kinds of small rooms that are typically attached to a host room (en-suite toilet, duty room…).
ATTACHABLE_RE = re.compile(r"卫|厕|冲洗|淋浴|值班|控制|更衣|储|库|污洗|洁具")
NON_PARENT_RE = re.compile(r"卫|厕|空调|管道|井|楼梯|电梯|清洁|洁具|前室|缓冲")


def _area(poly) -> float:
    a = 0.0
    for i in range(len(poly)):
        x0, y0 = poly[i][0], poly[i][1]
        x1, y1 = poly[(i + 1) % len(poly)][0], poly[(i + 1) % len(poly)][1]
        a += x0 * y1 - x1 * y0
    return abs(a) / 2


def _looks_room(name: str) -> bool:
    return bool(re.search(r"(室|间|房|科|诊|处|库|站|中心)$", re.sub(r"[\d一二三四五六七八九十]+$", "", name)))


_DEBUG_PRIVATE = bool(os.environ.get('NAV_DEBUG_PRIVATE'))


def _private_faces(classified) -> dict:
    """``{id(face): "in:<room name>" | "twin"}``.

    * en-suite: every door of the face leads into one other named, non-corridor room
      (病房内卫) — reachable only through that room, so not a public toilet;
    * twin: a doorless face carrying the same name as a touching face with doors (a bed
      partition cut one ward in two).
    """
    def name_of(room):
        return str((room or {}).get("displayName") or (room or {}).get("name") or "").strip()

    def face_at(x, y, skip):
        for face, room, _d, corridor, poly in classified:
            if face is not skip and _point_in_polygon(x, y, poly):
                return face, room, corridor, None, poly
        return None

    out = {}
    for face, room, face_doors, corridor, poly in classified:
        name = name_of(room)
        if corridor or not name:
            continue
        if face_doors:
            parents = set()
            seen_names = []  # neighbour names through each door (ward 卫 fallback below)
            for d in face_doors:
                nx, ny = -d["uy"], d["ux"]
                off = float(d["wall"].get("thickness") or 15) / 2 + 45
                other = None
                for k in (1, -1):
                    px, py = d["cx"] + nx * off * k, d["cy"] + ny * off * k
                    if _point_in_polygon(px, py, poly):
                        continue
                    other = face_at(px, py, face)
                    break
                oname = name_of(other[1]) if other else ""
                seen_names.append(oname)
                if _DEBUG_PRIVATE and re.search("卫|值班|冲洗|控制", name):
                    print("PRIV", name, [round(v) for v in poly[0]], "->", oname, bool(other and other[2]),
                          round(_area(other[4])) if other else None, round(_area(poly)))
                # The grid may flag a big named room (检验室) as corridor; a printed room name that
                # is not a circulation word still makes it a room for this rule.
                if other and not oname and not other[2] and re.search(r"卫|厕", name) and _area(other[4]) > _area(poly) * 0.8:
                    parents.add("房间")  # unnamed room segment (ward split by a partition)
                    continue
                if (not other or not oname or oname == name or PUBLIC_SPACE_RE.search(oname) or NON_PARENT_RE.search(oname)
                        or (other[2] and not _looks_room(oname)) or _area(other[4]) <= _area(poly) * 0.8):
                    parents = None
                    break
                parents.add(oname)
            # Ward en-suite: a bare 卫/卫生间 with a door into a 病房 (grid often flags wards as
            # corridor, or a second door edge lands in the neighbouring 卫/清洁) and none onto
            # public circulation belongs to the ward.
            if (not parents and re.fullmatch(r"卫(生间)?[A-Za-z0-9]?", name or "") and _area(poly) <= 8e4
                    and any(re.search(r"病房|病室", n or "") for n in seen_names)
                    and not any(n and PUBLIC_SPACE_RE.search(n) for n in seen_names)):
                parents = {"病房"}
            # Rule: a room reachable only through other rooms is a child (attached), not public.
            # Attached rooms are small (值班室/卫生间/冲洗 ≤ 15 ㎡) and never vertical circulation.
            if parents and _area(poly) <= 15e4 and not PUBLIC_SPACE_RE.search(name) and not re.search(r"楼梯|电梯|梯间", name):
                parent = sorted(parents)[0]
                # Same name as the room it opens into: one room split by a partition, not a child.
                out[id(face)] = "twin" if parent == name_of(room) else "in:" + parent
        else:
            # Doorless small room: the importer already doors every room facing circulation,
            # so what is left is reached only through a neighbour (药房值班室/冲洗/控制室).
            if (_area(poly) <= 15e4 and ATTACHABLE_RE.search(name) and not PUBLIC_SPACE_RE.search(name)
                    and not re.search(r"楼梯|电梯|梯间|井|空调|管道", name)):
                out[id(face)] = "in:房间"
                continue
            xs = [p[0] for p in poly]; ys = [p[1] for p in poly]
            for other, oroom, odoors, ocorr, opoly in classified:
                if other is face or not odoors or name_of(oroom) != name:
                    continue
                if any(_near_polygon_edge(x, y, [{"x": a, "y": b} for a, b in opoly], tol=40.0) for x, y in poly):
                    out[id(face)] = "twin"
                    break
    return out


def _doors_on_face(face: dict, doors: list[dict], by_id: dict) -> list[dict]:
    """Doors whose wall is in the face, or whose opening sits on the face edge.

    Shared corridor/room wall segments often keep a different wall id on the
    face than the door's wallId, so geometry matching is required. Prefer
    wall-id hits: edge matching alone pulls in neighbouring rooms' doors and
    steals the access spur (P2 3F 病房8 → door-15 on the next bay).
    """
    wall_ids = set(face.get("walls") or [])
    polygon = face.get("polygon") or []
    on_wall_hits = []
    on_edge_hits = []
    for door in doors:
        wall = by_id.get(door.get("wallId"))
        if not wall:
            continue
        x0, y0 = float(wall["start"]["x"]), float(wall["start"]["y"])
        x1, y1 = float(wall["end"]["x"]), float(wall["end"]["y"])
        dx, dy = x1 - x0, y1 - y0
        length = math.hypot(dx, dy) or 1.0
        along = min(1.0, max(0.0, float(door.get("position") or 0.5)))
        cx, cy = x0 + dx * along, y0 + dy * along
        thick = float(wall.get("thickness") or 15.0)
        on_wall = wall.get("id") in wall_ids
        on_edge = _near_polygon_edge(cx, cy, polygon, tol=max(40.0, thick + 20.0))
        if not on_wall and not on_edge:
            continue
        item = {
            "door": door,
            "wall": wall,
            "cx": cx,
            "cy": cy,
            "ux": dx / length,
            "uy": dy / length,
            "width": max(60.0, float(door.get("width") or 80.0)),
        }
        if on_wall:
            on_wall_hits.append(item)
        else:
            on_edge_hits.append(item)
    return on_wall_hits or on_edge_hits


def _is_placeholder_name(name: str) -> bool:
    return bool(re.fullmatch(r"(?i)(?:room\s*\d+|房间\s*\d+)(?:（door-\d+）)?", name.strip()))


def _is_corridor(face: dict, room: dict | None, door_count: int) -> bool:
    """Corridors / halls are the primary walkable network."""
    if (room or {}).get("floorOpening"):
        return False
    if (room or {}).get("roomType") == "corridor":
        return True
    name = str((room or {}).get("name") or "")
    if (room or {}).get("floorOpening"):
        return False
    if (room or {}).get("roomType") == "corridor":
        return True
    if _CORRIDOR_RE.search(name):
        return True
    # A printed room name (诊室/急诊/化验室/残卫…) is the PDF saying "enclosed room": the shape
    # rules below are only for unnamed faces, else a 3-door clinic or a long toilet becomes corridor.
    private = bool(
        (room or {}).get("roomType") == "room"
        or _PRIVATE_ROOM_RE.search(name)
        or (re.search(r"[\u4e00-\u9fff]", name) and not re.search(r"(区|台|厅|廊|道|场|处)$", name)
            and not _is_placeholder_name(name))
    )
    width, height, area = _face_bounds(face)
    minor, major = sorted((width, height))
    # Long circulation strip (same idea as openplan_project.room_floor_texture).
    if not private and minor >= 90 and major >= 480 and major / max(minor, 1) >= 2.4:
        return True
    # Wide multi-door hall: do not treat as a shortcut room.
    if (
        not private
        and door_count >= 3
        and minor >= 160
        and major >= 320
        and area >= 80_000
    ):
        return True
    return False


def _paint_strip(draw, origin_x, origin_y, cell, x0, y0, x1, y1, half_width):
    draw.polygon(
        _px(origin_x, origin_y, cell, _quad(x0, y0, x1, y1, half_width)),
        fill=255,
    )


def _paint_disk(draw, origin_x, origin_y, cell, x, y, radius_cm):
    cx = (x - origin_x) / cell
    cy = (y - origin_y) / cell
    r = max(1.0, radius_cm / cell)
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)


def _spur_hits_wall(x0: float, y0: float, x1: float, y1: float, walls: list[dict], openings: list[dict]) -> bool:
    """True if the door→center spur crosses a wall outside a door clear."""
    return _segment_hits_wall((x0, y0), (x1, y1), walls, openings, pad=0.0)


def _point_in_polygon(x: float, y: float, polygon: list) -> bool:
    """Ray-cast inclusion for a room face polygon ({x,y} or (x,y))."""
    if len(polygon) < 3:
        return False
    pts = []
    for point in polygon:
        if isinstance(point, dict):
            pts.append((float(point["x"]), float(point["y"])))
        else:
            pts.append((float(point[0]), float(point[1])))
    inside = False
    j = len(pts) - 1
    for i, (xi, yi) in enumerate(pts):
        xj, yj = pts[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi):
            inside = not inside
        j = i
    return inside


def _fill_room_spur(
    walk: bytearray,
    cols: int,
    rows: int,
    origin_x: float,
    origin_y: float,
    cell: float,
    polygon: list,
    access: dict,
    cx: float,
    cy: float,
    walls: list[dict],
    openings: list[dict],
):
    """A* inside the room face from the access door to the center; thicken the path.

    Avoids door→center chords that cut through internal wall bands.
    """
    walls = [
        {**wall, "thickness": 2 * _wall_paint_half(float(wall.get("thickness") or 15.0), cell)}
        for wall in walls
    ]

    def cell_at(x, y):
        return (
            int(math.floor((x - origin_x) / cell)),
            int(math.floor((y - origin_y) / cell)),
        )

    def center(col, row):
        return origin_x + (col + 0.5) * cell, origin_y + (row + 0.5) * cell

    def allowed(col, row):
        if col < 0 or row < 0 or col >= cols or row >= rows:
            return False
        x, y = center(col, row)
        if _point_blocked_by_walls(x, y, walls, openings):
            return False
        if _point_in_door_clear(x, y, openings):
            return True
        return _point_in_polygon(x, y, polygon)

    start = cell_at(access["cx"], access["cy"])
    goal = cell_at(cx, cy)
    if not allowed(*goal):
        # Center may sit on a sealed wall sample — search nearby inside the room.
        best = None
        best_d = 1e18
        for dr in range(-3, 4):
            for dc in range(-3, 4):
                nxt = (goal[0] + dc, goal[1] + dr)
                if not allowed(*nxt):
                    continue
                d = dc * dc + dr * dr
                if d < best_d:
                    best_d = d
                    best = nxt
        if not best:
            return
        goal = best
    if not allowed(*start):
        for dr in range(-3, 4):
            for dc in range(-3, 4):
                nxt = (start[0] + dc, start[1] + dr)
                if allowed(*nxt):
                    start = nxt
                    break
            else:
                continue
            break
        else:
            return

    costs = {start: 0.0}
    previous = {}
    queue = [(0.0, start)]
    found = None
    while queue:
        _score, current = heappop(queue)
        if current == goal:
            found = current
            break
        if costs.get(current, 1e18) + 1e-9 < _score - math.hypot(goal[0] - current[0], goal[1] - current[1]):
            continue
        for dc, dr, step in (
            (1, 0, 1.0), (-1, 0, 1.0), (0, 1, 1.0), (0, -1, 1.0),
            (1, 1, 1.414), (1, -1, 1.414), (-1, 1, 1.414), (-1, -1, 1.414),
        ):
            nxt = (current[0] + dc, current[1] + dr)
            if not allowed(*nxt):
                continue
            if dc and dr and not (allowed(current[0] + dc, current[1]) and allowed(current[0], current[1] + dr)):
                continue
            cost = costs[current] + step
            if cost >= costs.get(nxt, 1e18):
                continue
            costs[nxt] = cost
            previous[nxt] = current
            heappush(queue, (cost + math.hypot(goal[0] - nxt[0], goal[1] - nxt[1]), nxt))
    if found is None:
        return
    path = [found]
    while path[-1] in previous:
        path.append(previous[path[-1]])
    path.reverse()
    radius = max(1, int(math.ceil(max(SPUR_HALF_CM, access["width"] / 2 + 8.0) / cell)))
    pad = max(1, int(math.ceil(DEST_PAD_CM / cell)))
    for col, row in path:
        for dr in range(-radius, radius + 1):
            for dc in range(-radius, radius + 1):
                if dc * dc + dr * dr > radius * radius:
                    continue
                nc, nr = col + dc, row + dr
                if not allowed(nc, nr):
                    continue
                walk[nr * cols + nc] = 1
    gc, gr = goal
    for dr in range(-pad, pad + 1):
        for dc in range(-pad, pad + 1):
            if dc * dc + dr * dr > pad * pad:
                continue
            nc, nr = gc + dc, gr + dr
            if allowed(nc, nr):
                walk[nr * cols + nc] = 1


def _access_door(
    face_doors: list[dict],
    cx: float,
    cy: float,
    corridor_polygons: list,
    walls: list[dict] | None = None,
    openings: list[dict] | None = None,
) -> dict:
    """Prefer corridor-facing doors whose spur to the center stays clear of walls."""
    walls = walls or []
    openings = openings or []

    def score(opening):
        on_corridor = any(
            _near_polygon_edge(opening["cx"], opening["cy"], polygon, tol=50.0)
            for polygon in corridor_polygons
        )
        blocked = 1 if (walls and _spur_hits_wall(opening["cx"], opening["cy"], cx, cy, walls, openings)) else 0
        to_center = (opening["cx"] - cx) ** 2 + (opening["cy"] - cy) ** 2
        door = opening.get("door") or {}
        # Prefer the authored doorAt on drawn rooms over a secondary jamb on a shared wall.
        authored = 0 if door.get("fromDoorAt") or str(door.get("id") or "").startswith("doorAt-") else 1
        # Corridor-facing first; straight-line wall hits are OK — spur uses in-room A*.
        return (0 if on_corridor else 1, authored, blocked, to_center)

    return min(face_doors, key=score)


def _poi_norm(text) -> str:
    return re.sub(r"[\s（）()·\-_/]|\d+(\.\d+)?㎡|\d+", "", str(text or ""))


def _entrance_cell(grid, x: float, y: float):
    main = grid.main_component()
    fp = [(float(p["x"]), float(p["y"])) for p in grid.floor.get("footprint") or [] if isinstance(p, dict)]
    best = None
    for op in _openings(grid.floor):
        nx, ny = -op["uy"], op["ux"]
        reach = float(op.get("across") or 20) / 2 + 30
        sides = []
        for sgn in (1, -1):
            sx, sy = op["x"] + nx * reach * sgn, op["y"] + ny * reach * sgn
            c = grid.cell_at(sx, sy)
            inside_main = c is not None and grid.walkable(*c) and (c[1] * grid.cols + c[0]) in main
            outside = (not _point_in_polygon(sx, sy, fp)) if len(fp) >= 3 else not inside_main
            sides.append((inside_main, outside, c))
        if sides[0][0] == sides[1][0]:
            continue
        inner = sides[0] if sides[0][0] else sides[1]
        outer = sides[1] if sides[0][0] else sides[0]
        if not outer[1]:
            continue
        d = math.hypot(op["x"] - x, op["y"] - y)
        if best is None or d < best[0]:
            best = (d, inner[2])
    return best[1] if best and best[0] < 600 else None


def build_grid(floor: dict) -> FloorGrid | None:
    floor = {**floor, "walls": connected_walls(floor)}
    walls = _walls(floor)
    if len(walls) < 3:
        return None
    min_x, min_y, max_x, max_y = _bounds(walls)
    span = max(max_x - min_x, max_y - min_y, CELL_CM)
    cell = CELL_CM if span / CELL_CM <= MAX_CELLS else span / MAX_CELLS
    cols = max(1, int(math.ceil((max_x - min_x) / cell)))
    rows = max(1, int(math.ceil((max_y - min_y) / cell)))
    image = Image.new("L", (cols, rows), 0)
    draw = ImageDraw.Draw(image)
    faces = _despike_faces(detect_closed_rooms(walls))
    by_id = {wall["id"]: wall for wall in walls if wall.get("id")}
    doors = _nav_doors(floor)
    rooms = [room for room in floor.get("rooms") or [] if isinstance(room, dict)]

    classified = []
    corridor_polygons: list[list[dict]] = []
    openings_early = _openings(floor)
    for face in faces:
        polygon = [(point["x"], point["y"]) for point in face.get("polygon") or []]
        if len(polygon) < 3:
            continue
        room = _match_room(face, rooms)
        face_doors = _doors_on_face(face, doors, by_id)
        is_corridor = _is_corridor(face, room, len(face_doors))
        classified.append((face, room, face_doors, is_corridor, polygon))
        if is_corridor:
            corridor_polygons.append(face.get("polygon") or [])

    # 0) Only room/circulation coverage, clipped to the drawing footprint.
    surface = floor_surface(floor, faces)
    xs = min_x + (np.arange(cols) + 0.5) * cell
    ys = min_y + (np.arange(rows) + 0.5) * cell
    coverage = Image.fromarray((intersects_xy(surface, xs[None, :], ys[:, None]) * 255).astype(np.uint8))
    image.paste(coverage)
    # 1) Corridors (and doorless islands) fully walkable.
    #    Room spurs are painted after walls so inflated wall bands cannot cut them.
    for face, room, face_doors, is_corridor, polygon in classified:
        if is_corridor:
            draw.polygon(_px(min_x, min_y, cell, polygon), fill=255)
            continue
        draw.polygon(_px(min_x, min_y, cell, polygon), fill=0 if face_doors else 255)

    # 2) Every wall band blocks. Inflate thin walls so cell centers seal.
    # 3) Doors reopen only the opening footprint.
    for wall in walls:
        if wall.get("height") == 0:
            continue
        start, end = wall["start"], wall["end"]
        thick = float(wall.get("thickness") or 15.0)
        thick = min(120.0, max(8.0, thick))
        half = _wall_paint_half(thick, cell)
        draw.polygon(
            _px(min_x, min_y, cell, _quad(start["x"], start["y"], end["x"], end["y"], half)),
            fill=0,
        )
    # Reopen from the same opening set LOS/string-pull use (doors[] + room.doorAt + twins).
    for opening in openings_early:
        ux, uy = float(opening["ux"]), float(opening["uy"])
        cx, cy = float(opening["x"]), float(opening["y"])
        half_w = float(opening["width"]) / 2.0 + 2.0
        half_t = max(float(opening["across"]), 16.0) / 2.0 + cell * 0.15
        quad = _quad(cx - ux * half_w, cy - uy * half_w, cx + ux * half_w, cy + uy * half_w, half_t)
        draw.polygon(_px(min_x, min_y, cell, quad), fill=255)

    walk = bytearray(cols * rows)
    pixels = image.tobytes()
    for index, value in enumerate(pixels):
        walk[index] = 1 if value else 0
    openings = _openings(floor)
    # Geometry seal: raster bleed / fat door quads must not leave wall-band cells walkable.
    # Door clear only reopens the door's own (parallel) wall — not a perpendicular corner wall
    # that happens to overlap the door's axis-aligned clear box.
    for row in range(rows):
        for col in range(cols):
            index = row * cols + col
            if not walk[index]:
                continue
            x = min_x + (col + 0.5) * cell
            y = min_y + (row + 0.5) * cell
            if _point_blocked_by_walls(x, y, walls, openings, pad=0.0):
                walk[index] = 0

    # 4) Room access spurs after seal. Door clears already open the jamb;
    #    in-room A* reaches the center without cutting internal wall bands.
    access_by_face: dict[int, dict] = {}
    for face, room, face_doors, is_corridor, polygon in classified:
        if (room or {}).get("floorOpening") or is_corridor or not face_doors:
            continue
        cx, cy = _face_centroid(face)
        access = _access_door(face_doors, cx, cy, corridor_polygons, walls, openings_early)
        access_by_face[id(face)] = access
        # Every door of the room reaches its centre, not only the chosen access door: when the
        # access pick lands on a door into a side room, the corridor door must still lead in.
        for door in [access] + [d for d in face_doors if d is not access]:
            _fill_room_spur(
                walk, cols, rows, min_x, min_y, cell,
                face.get("polygon") or polygon,
                door, cx, cy, walls, openings_early,
            )
    voids = Image.new("L", (cols, rows))
    void_draw = ImageDraw.Draw(voids)
    for face, room, _, _, polygon in classified:
        if (room or {}).get("floorOpening"):
            void_draw.polygon(_px(min_x, min_y, cell, polygon), fill=255)
    for index, value in enumerate(voids.tobytes()):
        if value:
            walk[index] = 0
    for index, value in enumerate(coverage.tobytes()):
        if not value:
            walk[index] = 0
    for box in floor.get("footprintExclusions") or []:
        for row in range(rows):
            y = min_y + (row + 0.5) * cell
            if box["y0"] <= y <= box["y1"]:
                for col in range(cols):
                    x = min_x + (col + 0.5) * cell
                    if box["x0"] <= x <= box["x1"]:
                        walk[row * cols + col] = 0
    clearance = _clearance_map(walk, cols, rows)
    private = _private_faces(classified)
    destinations = []
    grid = FloorGrid(floor, cell, (min_x, min_y), cols, rows, walk, destinations, clearance)
    number = 1
    used_ids: set[str] = set()
    # Names printed inside a closed but unnamed face (OCR put them in textAnnotations because no
    # room polygon matched) name that face, so the place gets a highlight and an arrival door.
    bound_notes: set[int] = set()
    named_faces: list = []  # (polygon pts, normalised names) of every named face, for OCR POI dedupe
    free_notes = [n for n in (floor.get("textAnnotations") or [])
                  if n.get("poi") and str(n.get("text") or "").strip() and not str(n.get("id") or "").startswith("entrance")]
    for face in faces:
        if (_match_room(face, rooms) or {}).get("floorOpening"):
            continue
        polygon = face.get("polygon") or []
        room = _match_room(face, rooms)
        if (room or {}).get("floorOpening") or (room or {}).get("roomType") == "shaft":
            continue
        if len(polygon) < 3:
            continue
        xs = [point["x"] for point in polygon]
        ys = [point["y"] for point in polygon]
        if min(max(xs) - min(xs), max(ys) - min(ys)) < MIN_ROOM_CM:
            continue
        raw_x = sum(xs) / len(xs)
        raw_y = sum(ys) / len(ys)
        snapped = _nearest(grid, *grid.cell_at(raw_x, raw_y), SNAP_CM / cell)
        if not snapped:
            continue
        sealed_at = None
        if (snapped[1] * grid.cols + snapped[0]) not in grid.main_component():
            # Room interior sealed off (door missed at import): arrive at the nearest reachable
            # spot instead of failing with 'blocked'. The interior point is kept for door repair.
            sealed_at = grid.center(*snapped)
            snapped = _nearest_main(grid, *snapped, 1500 / cell) or snapped
        point = grid.center(*snapped)
        room = _match_room(face, rooms)
        if private.get(id(face)) == "twin":
            continue  # half of one room split by a low partition: the doored half is the room
        name = ""
        original = ""
        aliases: list = []
        color = "#dce8df"
        dest_id = f"face-{number}"
        if room:
            candidate = str(room.get("id") or "")
            if candidate and candidate not in used_ids:
                dest_id = candidate
                # displayName (editor-corrected, e.g. 心里→心理) wins; the printed name stays searchable.
                original = str(room.get("name") or "").strip()
                name = str(room.get("displayName") or "").strip() or original
                aliases = [str(a).strip() for a in (room.get("aliases") or []) if str(a).strip()]
            if isinstance(room.get("color"), str) and room["color"].startswith("#"):
                color = room["color"]
        while dest_id in used_ids:
            dest_id += "-extra"
        used_ids.add(dest_id)
        if not name:
            pts = [(q["x"], q["y"]) for q in polygon]
            inside = [n for n in free_notes if id(n) not in bound_notes and _point_in_polygon(float(n["x"]), float(n["y"]), pts)]
            if len(inside) == 1:
                bound_notes.add(id(inside[0]))
                name = original = str(inside[0]["text"]).strip()
                aliases = list(inside[0].get("aliases") or [])
        if name:
            from hospital_lexicon import fix_misreads
            name, bad = fix_misreads(name)
            aliases = list(dict.fromkeys([*aliases, *bad]))
            named_faces.append(([(q["x"], q["y"]) for q in polygon],
                                {_poi_norm(n) for n in [name, original, *aliases] if _poi_norm(n)}))
        if re.match(r"^(room|房间)\s*\d+$", name, re.I):
            name = ""  # editor placeholder 「Room 3」 is never a searchable name
        if not name:
            name = f"房间 {number}"
        extra = {}
        if original and original != name:
            extra["originalName"] = original
        if aliases:
            extra["aliases"] = aliases
        manual_parent = str((room or {}).get("attachedTo") or "").strip()
        if (room or {}).get("standalone"):
            pass  # a person marked it a public destination (e.g. 残卫 off the corridor)
        elif manual_parent:
            extra["ensuite"] = True
            extra["parentName"] = manual_parent
        elif isinstance(private.get(id(face)), str) and private[id(face)].startswith("in:"):
            # En-suite (only door opens into another room): listed under its room, not public.
            extra["ensuite"] = True
            extra["parentName"] = private[id(face)][3:]
        if sealed_at:
            extra["interior"] = {"x": round(sealed_at[0], 1), "y": round(sealed_at[1], 1)}
        access = access_by_face.get(id(face))
        if access:
            extra["accessDoor"] = {
                "id": (access.get("door") or {}).get("id"),
                "x": round(float(access["cx"]), 1),
                "y": round(float(access["cy"]), 1),
            }
        destinations.append({
            **extra,
            "id": dest_id,
            "name": name,
            "x": round(point[0], 1),
            "y": round(point[1], 1),
            "color": color,
            "category": _category(name),
        })
        number += 1
    # Named spots printed in open space (门厅、导医台) carry no closed face: textAnnotations
    # flagged as POIs become destinations at their walkable snap point.
    _HIDDEN_POIS[:] = [h for h in _HIDDEN_POIS if h["floorId"] != floor.get("id")]
    for note in floor.get("textAnnotations") or []:
        if not note.get("poi") or not str(note.get("text") or "").strip() or id(note) in bound_notes:
            continue
        # The OCR label printed inside a room that already carries the same name (西药房 in 西药房,
        # 储藏(3) in 储藏(3)) would list the place twice: the room is the destination.
        key = _poi_norm(note["text"])
        if key and any(_point_in_polygon(float(note["x"]), float(note["y"]), pts) and
                       any(key == n or (min(len(key), len(n)) >= 2 and (key in n or n in key)) for n in names)
                       for pts, names in named_faces):
            continue
        # Search hygiene (generic, no inventory): an OCR label is a destination only when it reads
        # like a hospital place (lexicon word / room-type suffix / facility type) or is an alias of
        # the room it sits in. Furniture (柜子) and misreads (相子) stay on the plan, unsearchable.
        if not _poi_searchable(note, named_faces):
            _HIDDEN_POIS.append({"floorId": floor.get("id"), "id": note.get("id"), "text": str(note["text"]).strip(),
                                 "x": float(note["x"]), "y": float(note["y"])})
            continue
        # POIs (entrances, open-space labels) snap into the main walkable region, so a door
        # vestibule or an outside pocket never strands them (route 'blocked').
        snapped = None
        if str(note.get("id") or "").startswith("entrance") or _category(str(note["text"])) == "entrance":
            # An entrance label printed out on the forecourt: arrive at the nearest door on the
            # building edge (main circulation on one side, outside on the other), not at whatever
            # room happens to be the closest walkable cell (P2 大门 landed by 楼梯B, 12 m off).
            snapped = _entrance_cell(grid, float(note["x"]), float(note["y"]))
        snapped = snapped or _nearest_main(grid, *grid.cell_at(float(note["x"]), float(note["y"])), 1500 / cell)
        if not snapped:
            continue
        px, py = grid.center(*snapped)
        from hospital_lexicon import fix_misreads
        name, bad = fix_misreads(str(note["text"]).strip())
        note_aliases = list(dict.fromkeys([*(note.get("aliases") or []), *bad]))
        destinations.append({
            "id": str(note.get("id") or f"poi-{number}"),
            "name": name,
            "x": round(px, 1), "y": round(py, 1),
            "color": "#e7e2d6",
            "category": _category(name),
            **({"aliases": note_aliases} if note_aliases else {}),
        })
        number += 1
    return grid


_HIDDEN_POIS: list = []  # last build's unsearchable OCR labels (acceptance report)
_NOT_PLACES = {"柜子", "货架", "器械柜", "衣柜", "储物柜", "鞋柜", "上空", "天井", "原地面"}
_EXTRA_PLACE_WORDS = ("开水炉", "开水器", "饮水机", "自助机", "导医台", "导诊台", "服务台", "咨询台", "挂号", "收费", "取药",
                      "急诊", "门诊", "药房", "护士站", "分诊")


def _poi_searchable(note: dict, named_faces) -> bool:
    from hospital_lexicon import known, looks_complete
    text = str(note.get("text") or "").strip()
    if str(note.get("id") or "").startswith("entrance") or _category(text) != "room":
        return True  # entrances, toilets, lifts, stairs, pharmacy, service desks
    if note.get("manual"):
        return bool(note.get("poi"))
    norm = re.sub(r"[\s（）()·、，,/／]", "", text)
    if not norm or norm in _NOT_PLACES:
        return False
    if any(w in norm for w in _EXTRA_PLACE_WORDS):
        return True
    if known(norm) or looks_complete(norm):
        return True
    key = _poi_norm(text)
    for pts, names in named_faces:  # an alias of the room it is printed in
        if key in names and _point_in_polygon(float(note["x"]), float(note["y"]), pts):
            return True
    return False


def _nearest(grid: FloorGrid, col, row, radius):
    if grid.walkable(col, row):
        return col, row
    limit = int(max(1, radius))
    best = None
    best_d = 1e9
    for dr in range(-limit, limit + 1):
        for dc in range(-limit, limit + 1):
            if dc * dc + dr * dr > limit * limit:
                continue
            nxt = (col + dc, row + dr)
            if not grid.walkable(*nxt):
                continue
            dist = dc * dc + dr * dr
            if dist < best_d:
                best_d = dist
                best = nxt
    return best


def _nearest_main(grid: FloorGrid, col, row, radius):
    main = grid.main_component()
    limit = int(max(1, radius))
    best, best_d = None, 1e18
    for dr in range(-limit, limit + 1):
        for dc in range(-limit, limit + 1):
            c, r = col + dc, row + dr
            if not (0 <= c < grid.cols and 0 <= r < grid.rows) or (r * grid.cols + c) not in main:
                continue
            d = dc * dc + dr * dr
            if d < best_d:
                best, best_d = (c, r), d
    return best or _nearest(grid, col, row, radius)


def _cache_key(project, floor):
    geometry = json.dumps(
        {key: floor.get(key) or [] for key in ("walls", "doors", "rooms", "footprint", "footprintExclusions", "walkableRegions")},
        sort_keys=True, ensure_ascii=False, separators=(",", ":"),
    )
    return (
        str(project.get("id") or ""),
        str(floor.get("id") or ""),
        hashlib.blake2b(geometry.encode("utf-8"), digest_size=16).hexdigest(),
    )


def grid_for(project: dict, floor_id: str | None = None) -> FloorGrid | None:
    floor = select_floor(project, floor_id)
    key = _cache_key(project, floor)
    cached = _CACHE.get(key)
    if cached:
        return cached
    grid = build_grid(floor)
    if grid is None:
        return None
    # 3 hospitals × up to ~6 floors: a cap of 8 thrashed and rebuilt grids (seconds each) on
    # every hospital / floor switch.
    if len(_CACHE) > 48:
        _CACHE.clear()
    _CACHE[key] = grid
    return grid


def _nav_doors(floor: dict) -> list[dict]:
    """``doors[]`` plus ``room.doorAt`` rows snapped onto the host wall.

    Drawn rooms often only store the jamb as ``doorAt``. Without a doors[] row the
    face has no access spur, so A* enters through a neighbour door / east jamb and
    the blue line looks like it ignores the visible corridor door.
    """
    walls = {wall.get("id"): wall for wall in _walls(floor) if wall.get("id")}
    wall_list = list(walls.values())
    doors: list[dict] = [dict(door) for door in (floor.get("doors") or []) if isinstance(door, dict)]
    existing: list[tuple[float, float]] = []
    for door in doors:
        wall = walls.get(door.get("wallId"))
        if not wall:
            continue
        x0, y0 = float(wall["start"]["x"]), float(wall["start"]["y"])
        x1, y1 = float(wall["end"]["x"]), float(wall["end"]["y"])
        along = min(1.0, max(0.0, float(door.get("position") or 0.5)))
        existing.append((x0 + (x1 - x0) * along, y0 + (y1 - y0) * along))
    for room in floor.get("rooms") or []:
        if not isinstance(room, dict):
            continue
        door_at = _point(room.get("doorAt"))
        if not door_at:
            continue
        if any(math.hypot(px - door_at[0], py - door_at[1]) <= 40.0 for px, py in existing):
            continue
        host = _host_wall_for_point(wall_list, door_at[0], door_at[1], pad=30.0)
        if not host or not host.get("id"):
            continue
        x0, y0 = float(host["start"]["x"]), float(host["start"]["y"])
        x1, y1 = float(host["end"]["x"]), float(host["end"]["y"])
        dx, dy = x1 - x0, y1 - y0
        length_sq = dx * dx + dy * dy
        if length_sq <= 1e-9:
            continue
        t = max(0.0, min(1.0, ((door_at[0] - x0) * dx + (door_at[1] - y0) * dy) / length_sq))
        rid = room.get("id") or room.get("name") or "room"
        doors.append({
            "id": f"doorAt-{rid}",
            "wallId": host["id"],
            "position": t,
            "width": float(room.get("doorWidth") or 100.0),
            "height": 210,
            "type": "single",
            "fromDoorAt": True,
        })
        existing.append((x0 + dx * t, y0 + dy * t))
    return doors


def _opening_from_wall_point(wall: dict, x: float, y: float, *, door_id, width: float, door_type: str = "single") -> dict:
    x0, y0 = float(wall["start"]["x"]), float(wall["start"]["y"])
    x1, y1 = float(wall["end"]["x"]), float(wall["end"]["y"])
    dx, dy = x1 - x0, y1 - y0
    length = math.hypot(dx, dy) or 1.0
    # Snap onto the wall centreline so drawn doorAt jitter still hits the host face.
    t = ((x - x0) * dx + (y - y0) * dy) / (length * length)
    t = min(1.0, max(0.0, t))
    px, py = x0 + dx * t, y0 + dy * t
    return {
        "id": door_id,
        "wallIds": [wall["id"]] if wall.get("id") else [],
        "x": round(px, 1),
        "y": round(py, 1),
        "ux": round(dx / length, 4),
        "uy": round(dy / length, 4),
        "width": round(min(400.0 if door_type == "opening" else 120.0, max(60.0, float(width or 80.0))), 1),
        "across": round(float(wall.get("thickness") or 15.0) + 8.0, 1),
    }


def _host_wall_for_point(walls: list[dict], x: float, y: float, pad: float = 30.0):
    """Nearest wall band under ``(x, y)``, or None."""
    best, best_dist = None, 1e9
    for wall in walls:
        if not _point_in_single_wall_band(x, y, wall, pad=pad):
            continue
        x0, y0 = float(wall["start"]["x"]), float(wall["start"]["y"])
        x1, y1 = float(wall["end"]["x"]), float(wall["end"]["y"])
        dx, dy = x1 - x0, y1 - y0
        length_sq = dx * dx + dy * dy
        if length_sq <= 1e-9:
            dist = math.hypot(x - x0, y - y0)
        else:
            t = max(0.0, min(1.0, ((x - x0) * dx + (y - y0) * dy) / length_sq))
            dist = math.hypot(x - (x0 + t * dx), y - (y0 + t * dy))
        if dist < best_dist:
            best, best_dist = wall, dist
    return best


def _openings(floor: dict) -> list[dict]:
    walls = {wall.get("id"): wall for wall in _walls(floor) if wall.get("id")}
    openings = []
    for door in _nav_doors(floor):
        wall = walls.get(door.get("wallId"))
        if not wall or wall.get("height") == 0:
            continue
        x0, y0 = float(wall["start"]["x"]), float(wall["start"]["y"])
        x1, y1 = float(wall["end"]["x"]), float(wall["end"]["y"])
        dx, dy = x1 - x0, y1 - y0
        length = math.hypot(dx, dy) or 1.0
        along = min(1.0, max(0.0, float(door.get("position") or 0.5)))
        openings.append(_opening_from_wall_point(
            wall, x0 + dx * along, y0 + dy * along,
            door_id=door.get("id"),
            width=float(door.get("width") or 80.0),
            door_type=str(door.get("type") or "single"),
        ))
    # Double walls (a drawn room edge traced ~10-40 cm beside the imported wall): a door on one
    # face must also pierce its twin, or the room is sealed behind a sliver (P1 1F 治疗室1,
    # 2F 收费处). Extend the opening across both faces.
    wall_list = list(walls.values())
    for op in list(openings):
        ux, uy = op["ux"], op["uy"]
        nx, ny = -uy, ux
        for wall in wall_list:
            x0, y0 = float(wall["start"]["x"]), float(wall["start"]["y"])
            x1, y1 = float(wall["end"]["x"]), float(wall["end"]["y"])
            length = math.hypot(x1 - x0, y1 - y0)
            if length < 1 or abs(abs((x1 - x0) * ux + (y1 - y0) * uy) / length - 1.0) > 0.01:
                continue
            off = (x0 - op["x"]) * nx + (y0 - op["y"]) * ny
            if not (8.0 < abs(off) <= 45.0):
                continue
            t = ((op["x"] - x0) * (x1 - x0) + (op["y"] - y0) * (y1 - y0)) / (length * length)
            if not (0.0 <= t <= 1.0):
                continue
            px, py = x0 + (x1 - x0) * t, y0 + (y1 - y0) * t
            if _point_in_door_clear(px, py, openings):
                continue
            twin_ids = list(op.get("wallIds") or [])
            wid = wall.get("id")
            if wid and wid not in twin_ids:
                twin_ids.append(wid)
            openings.append({
                "id": f"{op['id']}-twin", "x": round((op["x"] + px) / 2, 1), "y": round((op["y"] + py) / 2, 1),
                "ux": ux, "uy": uy, "width": op["width"],
                "across": round(abs(off) + float(wall.get("thickness") or 15.0) + 8.0, 1),
                "twin": True, "wallIds": twin_ids,
            })
    return openings


def nav_view(project: dict, floor_id: str | None = None) -> dict:
    floor = select_floor(project, floor_id)
    floors = [
        {"id": item.get("id") or "", "name": item.get("name") or item.get("id") or "楼层"}
        for item in project.get("floors") or []
        if isinstance(item, dict)
    ]
    walls = _walls(floor)
    view = {
        "projectId": project.get("id") or "",
        "name": project.get("name") or "未命名",
        "floorId": floor.get("id") or "",
        "floorName": floor.get("name") or floor.get("id") or "楼层",
        "floors": floors,
        "empty": len(walls) < 3,
        "bounds": None,
        "walls": [],
        "rooms": [],
        "openings": [],
        "destinations": [],
        "places": [p for p in all_places(project) if is_destination(p.get("name"))],
        "verticalLinks": [
            {**link, "restricted": True} if any(stop_in_zone(st, z) for st in link["stops"] for z in restricted_zones(project, st["floorId"])) else link
            for link in vertical_links(project)
        ],
        "restrictedZones": [
            {k: v for k, v in z.items() if k != "_poly"} for z in restricted_zones(project)
        ],
        # Drawing's north (0 = page up, clockwise); null = no north arrow → no 东西南北 in copy.
        "northBearing": project.get("northBearing"),
    }
    grid = grid_for(project, floor.get("id"))
    if not grid:
        return view
    min_x, min_y, max_x, max_y = _bounds(walls)
    view["bounds"] = {
        "minX": round(min_x, 1),
        "minY": round(min_y, 1),
        "maxX": round(max_x, 1),
        "maxY": round(max_y, 1),
    }
    walls = _walls(grid.floor)
    view["walls"] = [
        {
            "start": {"x": wall["start"]["x"], "y": wall["start"]["y"]},
            "end": {"x": wall["end"]["x"], "y": wall["end"]["y"]},
            "thickness": wall.get("thickness") or 15,
        }
        for wall in walls if wall.get("height") != 0
    ]
    view["rooms"] = _nav_rooms(floor, walls)
    view["openings"] = _openings(floor)
    view["destinations"] = [d for d in grid.destinations if is_destination(d.get("name"))]
    view["empty"] = False
    return view


def _point(value):
    if isinstance(value, dict):
        try:
            x, y = float(value.get("x")), float(value.get("y"))
        except (TypeError, ValueError):
            return None
    elif isinstance(value, (tuple, list)) and len(value) >= 2:
        try:
            x, y = float(value[0]), float(value[1])
        except (TypeError, ValueError):
            return None
    else:
        return None
    if not math.isfinite(x) or not math.isfinite(y) or abs(x) > 1e7 or abs(y) > 1e7:
        return None
    return x, y


def _wall_paint_half(thickness: float, cell: float) -> float:
    """Half-width used when rasterizing a wall so thin walls still seal cells."""
    return max(float(thickness) / 2.0, float(cell) * _WALL_CELL_COVER)


def _point_in_opening(x: float, y: float, opening: dict) -> bool:
    dx = x - opening["x"]
    dy = y - opening["y"]
    along = dx * opening["ux"] + dy * opening["uy"]
    across = dx * (-opening["uy"]) + dy * opening["ux"]
    half_w = float(opening["width"]) / 2.0 + 2.0
    half_across = max(float(opening["across"]), 16.0) / 2.0 + 2.0
    return abs(along) <= half_w and abs(across) <= half_across


def _point_in_door_clear(x: float, y: float, openings: list[dict]) -> bool:
    return any(_point_in_opening(x, y, opening) for opening in openings)


def _wall_aligned_with_opening(wall: dict, opening: dict) -> bool:
    """True when ``wall`` is the door's host face or a parallel twin — not a perpendicular corner wall.

    Door clear is an axis-aligned box in the door frame; near corners that box overlaps
    abutting walls. Only the door's own (parallel) wall(s) may be traversed there.
    """
    wall_ids = opening.get("wallIds") or []
    wid = wall.get("id")
    if wid and wid in wall_ids:
        return True
    x0, y0 = float(wall["start"]["x"]), float(wall["start"]["y"])
    x1, y1 = float(wall["end"]["x"]), float(wall["end"]["y"])
    dx, dy = x1 - x0, y1 - y0
    length = math.hypot(dx, dy)
    if length < 1.0:
        return False
    ux, uy = float(opening["ux"]), float(opening["uy"])
    if abs(abs((dx * ux + dy * uy) / length) - 1.0) > 0.05:
        return False
    nx, ny = -uy, ux
    # Perpendicular offset of the wall line from the door center.
    off = (x0 - float(opening["x"])) * nx + (y0 - float(opening["y"])) * ny
    half_across = max(float(opening["across"]), 16.0) / 2.0 + float(wall.get("thickness") or 15.0) / 2.0 + 4.0
    if abs(off) > half_across:
        return False
    t = ((float(opening["x"]) - x0) * dx + (float(opening["y"]) - y0) * dy) / (length * length)
    return -0.02 <= t <= 1.02


def _door_allows_wall(x: float, y: float, wall: dict, openings: list[dict]) -> bool:
    if wall.get("exclusion"):
        return False
    for opening in openings:
        if not _point_in_opening(x, y, opening):
            continue
        if _wall_aligned_with_opening(wall, opening):
            return True
    return False


def _point_in_single_wall_band(x: float, y: float, wall: dict, pad: float = 0.0) -> bool:
    if wall.get("height") == 0:
        return False
    if box := wall.get("exclusion"):
        return box["x0"] - pad <= x <= box["x1"] + pad and box["y0"] - pad <= y <= box["y1"] + pad
    x0, y0 = float(wall["start"]["x"]), float(wall["start"]["y"])
    x1, y1 = float(wall["end"]["x"]), float(wall["end"]["y"])
    dx, dy = x1 - x0, y1 - y0
    length_sq = dx * dx + dy * dy
    if length_sq <= 1e-9:
        return math.hypot(x - x0, y - y0) <= float(wall.get("thickness") or 15.0) / 2 + pad
    thick = float(wall.get("thickness") or 15.0) / 2.0 + pad
    t = ((x - x0) * dx + (y - y0) * dy) / length_sq
    if t < 0.0:
        dist = math.hypot(x - x0, y - y0)
    elif t > 1.0:
        dist = math.hypot(x - x1, y - y1)
    else:
        dist = math.hypot(x - (x0 + t * dx), y - (y0 + t * dy))
    return dist <= thick


def _point_in_wall_band(x: float, y: float, walls: list[dict], pad: float = 0.0) -> bool:
    return any(_point_in_single_wall_band(x, y, wall, pad=pad) for wall in walls)


def _point_blocked_by_walls(
    x: float, y: float, walls: list[dict], openings: list[dict], pad: float = 0.0
) -> bool:
    """True when the sample sits in a wall band that no *aligned* door opening clears."""
    for wall in walls:
        if not _point_in_single_wall_band(x, y, wall, pad=pad):
            continue
        if _door_allows_wall(x, y, wall, openings):
            continue
        return True
    return False


# Wall-collision index: _segment_hits_wall used to test every sample (every 4 cm) against
# every wall on the floor (~170), which was >90 % of route time (string-pull calls it O(n^2)).
# Walls are prepared once per wall list and filtered by the segment's bounding box; the
# per-sample band test is the same math as _point_in_single_wall_band, so results are identical.
_WALL_PREP: dict[int, tuple] = {}


def _prepared_walls(walls: list[dict]):
    hit = _WALL_PREP.get(id(walls))
    if hit is not None and hit[0] is walls and hit[1] == len(walls):
        return hit[2]
    prepared = []
    for wall in walls:
        if wall.get("height") == 0:
            continue
        x0, y0 = float(wall["start"]["x"]), float(wall["start"]["y"])
        x1, y1 = float(wall["end"]["x"]), float(wall["end"]["y"])
        dx, dy = x1 - x0, y1 - y0
        half = float(wall.get("thickness") or 15.0) / 2.0
        prepared.append((x0, y0, x1, y1, dx, dy, dx * dx + dy * dy, half,
                         min(x0, x1) - half, max(x0, x1) + half, min(y0, y1) - half, max(y0, y1) + half, wall))
    if len(_WALL_PREP) > 64:
        _WALL_PREP.clear()
    _WALL_PREP[id(walls)] = (walls, len(walls), prepared)
    return prepared


def _segment_hits_wall(a, b, walls: list[dict], openings: list[dict], pad: float = 0.0) -> bool:
    ax, ay = a
    bx, by = b
    length = math.hypot(bx - ax, by - ay)
    steps = max(2, int(length / 4.0))
    lo_x, hi_x = min(ax, bx) - pad, max(ax, bx) + pad
    lo_y, hi_y = min(ay, by) - pad, max(ay, by) + pad
    cands = [w for w in _prepared_walls(walls)
             if w[8] <= hi_x and w[9] >= lo_x and w[10] <= hi_y and w[11] >= lo_y]
    for *_, wall in cands:
        if "floorSurface" in wall and not wall["floorSurface"].covers(LineString([a, b])):
            return True
        if box := wall.get("exclusion"):
            lo, hi = 0.0, 1.0
            for origin, delta, lower, upper in ((ax, bx - ax, box["x0"] - pad, box["x1"] + pad),
                                                (ay, by - ay, box["y0"] - pad, box["y1"] + pad)):
                if abs(delta) < 1e-9:
                    if not lower <= origin <= upper:
                        hi = -1
                        break
                else:
                    entry, exit = sorted(((lower - origin) / delta, (upper - origin) / delta))
                    lo, hi = max(lo, entry), min(hi, exit)
            if lo <= hi:
                return True
    cands = [w for w in cands if not w[-1].get("exclusion") and "floorSurface" not in w[-1]]
    if not cands:
        return False
    near_ops = []
    for opening in openings or ():
        r = float(opening["width"]) / 2.0 + max(float(opening["across"]), 16.0) / 2.0 + 4.0
        if (opening["x"] + r >= lo_x and opening["x"] - r <= hi_x
                and opening["y"] + r >= lo_y and opening["y"] - r <= hi_y):
            near_ops.append(opening)
    hypot = math.hypot
    for index in range(1, steps):
        t = index / steps
        x = ax + (bx - ax) * t
        y = ay + (by - ay) * t
        for x0, y0, x1, y1, dx, dy, length_sq, half, mnx, mxx, mny, mxy, wall in cands:
            thick = half + pad
            if x < mnx - pad or x > mxx + pad or y < mny - pad or y > mxy + pad:
                continue
            if length_sq <= 1e-9:
                dist = hypot(x - x0, y - y0)
            else:
                u = ((x - x0) * dx + (y - y0) * dy) / length_sq
                if u < 0.0:
                    dist = hypot(x - x0, y - y0)
                elif u > 1.0:
                    dist = hypot(x - x1, y - y1)
                else:
                    dist = hypot(x - (x0 + u * dx), y - (y0 + u * dy))
            if dist > thick:
                continue
            if near_ops and _door_allows_wall(x, y, wall, near_ops):
                continue
            return True
    return False


def _clearance_map(walk: bytearray, cols: int, rows: int) -> list[int]:
    """Distance in cells from each cell to the nearest blocked cell (0 on obstacles)."""
    from collections import deque

    dist = [0] * (cols * rows)
    queue: deque[int] = deque()
    for index, value in enumerate(walk):
        if value:
            dist[index] = 10**9
        else:
            dist[index] = 0
            queue.append(index)
    while queue:
        index = queue.popleft()
        row = index // cols
        col = index % cols
        for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nc, nr = col + dc, row + dr
            if nc < 0 or nr < 0 or nc >= cols or nr >= rows:
                continue
            nxt = nr * cols + nc
            if dist[nxt] <= dist[index] + 1:
                continue
            dist[nxt] = dist[index] + 1
            queue.append(nxt)
    return dist


def _simplify(points):
    if len(points) <= 2:
        return points
    kept = [points[0]]
    for index in range(1, len(points) - 1):
        ax = points[index][0] - kept[-1][0]
        ay = points[index][1] - kept[-1][1]
        bx = points[index + 1][0] - points[index][0]
        by = points[index + 1][1] - points[index][1]
        if abs(ax * by - ay * bx) > 1.0:
            kept.append(points[index])
    kept.append(points[-1])
    return kept


def _string_pull(points, walls: list[dict], openings: list[dict], pad: float = _CLEARANCE_PAD_CM):
    """Pull long clear chords (with wall clearance) to remove stair-step jogs."""
    if len(points) <= 2:
        return list(points)
    out = [points[0]]
    anchor = 0
    while anchor < len(points) - 1:
        farthest = anchor + 1
        for index in range(len(points) - 1, anchor, -1):
            if not _segment_hits_wall(points[anchor], points[index], walls, openings, pad=pad):
                farthest = index
                break
        out.append(points[farthest])
        anchor = farthest
    return out


def _path_uses_door(points, opening: dict) -> bool:
    """Detect a segment crossing the finite opening, including simplified long runs."""
    ux, uy = float(opening["ux"]), float(opening["uy"])
    nx, ny = -uy, ux
    ox, oy = float(opening["x"]), float(opening["y"])
    half_along = float(opening["width"]) / 2.0 + 24.0
    for p, q in zip(points, points[1:]):
        a = (p[0] - ox) * nx + (p[1] - oy) * ny
        b = (q[0] - ox) * nx + (q[1] - oy) * ny
        if a * b > 0 or abs(a - b) < 1e-9:
            continue
        t = a / (a - b)
        along = (p[0] + t * (q[0] - p[0]) - ox) * ux + (p[1] + t * (q[1] - p[1]) - oy) * uy
        if abs(along) <= half_along:
            return True
    return False


def _via_door_centers(points, openings: list[dict]):
    """Collapse path runs that enter a used door's clear into that door's center.

    A door is used only when the path has points on both sides of its wall —
    so corridor skims that overlap a door clear into the hall are ignored.
    """
    if len(points) < 2 or not openings:
        return list(points)
    used = [opening for opening in openings if _path_uses_door(points, opening)]
    if not used:
        return list(points)
    out = []
    index = 0
    while index < len(points):
        point = points[index]
        hit = None
        for opening in used:
            if _point_in_door_clear(point[0], point[1], [opening]):
                hit = opening
                break
        if hit is None:
            out.append(point)
            index += 1
            continue
        center = (float(hit["x"]), float(hit["y"]))
        index += 1
        while index < len(points) and _point_in_door_clear(points[index][0], points[index][1], [hit]):
            index += 1
        if not out or math.hypot(out[-1][0] - center[0], out[-1][1] - center[1]) > 8.0:
            out.append(center)
    return out


def _is_door_center(point, openings: list[dict], tol: float = 1.5) -> bool:
    return any(
        math.hypot(point[0] - float(opening["x"]), point[1] - float(opening["y"])) <= tol
        for opening in openings
    )


def _align_door_approaches(points, openings: list[dict], walls: list[dict], reach_cm: float = 160.0):
    """Pull approach/exit vertices onto each door's through-midline.

    Walks outward from every door-center anchor (not only ±1 neighbour) so a
    jog like x=-881→-890 just before the jamb becomes a straight through-door
    run — thick bloom ribbons otherwise look like they scrape the jamb.
    """
    if len(points) < 3 or not openings:
        return list(points)
    out = [list(point) for point in points]
    for index, point in enumerate(out):
        opening = next(
            (
                candidate
                for candidate in openings
                if math.hypot(point[0] - float(candidate["x"]), point[1] - float(candidate["y"])) <= 1.5
            ),
            None,
        )
        if opening is None:
            continue
        ox, oy = float(opening["x"]), float(opening["y"])
        ux, uy = float(opening["ux"]), float(opening["uy"])
        nx, ny = -uy, ux  # across (through door)
        half_along = float(opening["width"]) / 2.0 + 60.0
        for direction in (-1, 1):
            j = index + direction
            while 0 <= j < len(out):
                if _is_door_center(out[j], openings):
                    break
                qx, qy = out[j]
                across = (qx - ox) * nx + (qy - oy) * ny
                along = (qx - ox) * ux + (qy - oy) * uy
                if abs(across) > reach_cm or abs(along) > half_along:
                    break
                candidate = (ox + nx * across, oy + ny * across)
                adjacent = [out[other] for other in (j - 1, j + 1) if 0 <= other < len(out)]
                if any(_segment_hits_wall(candidate, adj, walls, openings) for adj in adjacent):
                    break
                out[j] = list(candidate)
                j += direction
    return [(point[0], point[1]) for point in out]


def _simplify_clear(points, walls: list[dict], openings: list[dict]):
    """Center door crossings, align approaches, then string-pull between anchors."""
    centered = _align_door_approaches(_via_door_centers(points, openings), openings, walls)
    if len(centered) <= 2:
        return centered
    mandatory = {0, len(centered) - 1}
    for index, point in enumerate(centered):
        if _is_door_center(point, openings):
            mandatory.add(index)
    ordered = sorted(mandatory)
    out = [centered[0]]
    for left, right in zip(ordered, ordered[1:]):
        chunk = centered[left : right + 1]
        pulled = _string_pull(chunk, walls, openings, pad=_CLEARANCE_PAD_CM)
        out.extend(pulled[1:])
    # String-pull can reintroduce lateral jogs into the door; snap approaches again.
    return _align_door_approaches(out, openings, walls)


def _astar(grid: FloorGrid, start, end, banned=frozenset(), penalty=None):
    if start == end:
        return [start]
    costs = {start: 0.0}
    previous = {}
    queue = [(0.0, start)]
    # 8-connected; diagonals require both orthos walkable (no corner cut through walls).
    steps = (
        (1, 0, 1.0), (-1, 0, 1.0), (0, 1, 1.0), (0, -1, 1.0),
        (1, 1, 1.414), (1, -1, 1.414), (-1, 1, 1.414), (-1, -1, 1.414),
    )
    # Same search as before with the grid lookups inlined (flat arrays, no method calls).
    cols, rows, walk = grid.cols, grid.rows, grid.walk
    clearance = grid.clearance
    ex, ey = end
    hypot = math.hypot
    pop, push = heappop, heappush
    get = costs.get
    wall_cost, zone_cost = _WALL_COST, _ZONE_COST

    def ok(c, r):
        return 0 <= c < cols and 0 <= r < rows and walk[r * cols + c] == 1

    while queue:
        _score, current = pop(queue)
        cc, cr = current
        base = get(current, 1e18)
        if base + 1e-9 < _score - hypot(ex - cc, ey - cr):
            continue
        if current == end:
            path = [current]
            while current in previous:
                current = previous[current]
                path.append(current)
            return path[::-1]
        for dc, dr, step in steps:
            nc, nr = cc + dc, cr + dr
            if not (0 <= nc < cols and 0 <= nr < rows):
                continue
            index = nr * cols + nc
            if walk[index] != 1:
                continue
            nxt = (nc, nr)
            if banned and (current, nxt) in banned:
                continue
            if dc and dr and not (ok(cc + dc, cr) and ok(cc, cr + dr)):
                continue
            # Prefer cells farther from walls (corridor / room center).
            clear = max(1, clearance[index] if clearance else 1)
            cost = base + step * (1.0 + wall_cost / clear)
            if penalty is not None and penalty[index]:
                cost += step * zone_cost
            if cost >= get(nxt, 1e18):
                continue
            costs[nxt] = cost
            previous[nxt] = current
            push(queue, (cost + hypot(ex - nc, ey - nr), nxt))
    return None


def _nearest_reachable(grid: FloorGrid, start, target, banned, radius):
    """Closest cell to ``target`` (within radius cells) connected to ``start`` without ``banned`` steps."""
    seen = {start}
    stack = [start]
    best, best_d = None, (radius + 1) ** 2
    while stack:
        cur = stack.pop()
        d = (cur[0] - target[0]) ** 2 + (cur[1] - target[1]) ** 2
        if d < best_d:
            best, best_d = cur, d
        for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nxt = (cur[0] + dc, cur[1] + dr)
            if nxt in seen or not grid.walkable(*nxt) or (cur, nxt) in banned:
                continue
            seen.add(nxt)
            stack.append(nxt)
    return best


def _access_door_near(grid: FloorGrid, point, *, max_dist: float = 120.0):
    """Access door for a room destination near ``point``, if authored/detected."""
    best = None
    best_d = max_dist
    for dest in grid.destinations or []:
        door = dest.get("accessDoor")
        if not isinstance(door, dict):
            continue
        try:
            dx = float(dest["x"]) - point[0]
            dy = float(dest["y"]) - point[1]
            door_pt = (float(door["x"]), float(door["y"]))
        except (KeyError, TypeError, ValueError):
            continue
        dist = math.hypot(dx, dy)
        if dist > best_d:
            continue
        # Only force the via when the stop is inside the room (away from the jamb).
        if math.hypot(door_pt[0] - point[0], door_pt[1] - point[1]) < 50.0:
            continue
        best = door_pt
        best_d = dist
    return best


def _grid_geometry(grid: FloorGrid):
    """Walls + openings for a cached grid (same floor geometry), built once instead of per leg."""
    geom = grid.__dict__.get("_nav_geometry")
    if geom is None:
        walls = _walls(grid.floor)
        surface = floor_surface(grid.floor)
        if not surface.is_empty:
            x0, y0, x1, y1 = surface.bounds
            walls.append({"start": {"x": x0, "y": y0}, "end": {"x": x1, "y": y1},
                          "thickness": 0, "floorSurface": surface})
        for box in grid.floor.get("footprintExclusions") or []:
            walls.append({"start": {"x": box["x0"], "y": box["y0"]},
                          "end": {"x": box["x1"], "y": box["y1"]}, "thickness": 0, "exclusion": box})
        geom = (walls, _openings(grid.floor))
        grid.__dict__["_nav_geometry"] = geom
    return geom


def _side_gap(grid: FloorGrid, x: float, y: float, nx: float, ny: float, limit: float = 600.0):
    """Free distance from (x, y) along (nx, ny) until a blocked cell; None when open past limit."""
    step = grid.cell * 0.5
    d = step
    while d <= limit:
        col, row = grid.cell_at(x + nx * d, y + ny * d)
        if not grid.walkable(col, row):
            return d
        d += step
    return None


_CENTER_MIN_SEG_CM = 150.0
_CENTER_MAX_SHIFT_CM = 150.0
_CENTER_LEAD_CM = 120.0


_SNAP_STEP_CM = 40.0
_SNAP_MAX_WIDTH_CM = 450.0


def _rdp(points, eps):
    if len(points) < 3:
        return list(points)
    (ax, ay), (bx, by) = points[0], points[-1]
    L = math.hypot(bx - ax, by - ay) or 1e-9
    best, idx = -1.0, 0
    for i in range(1, len(points) - 1):
        px, py = points[i]
        d = abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / L
        if d > best:
            best, idx = d, i
    if best <= eps:
        return [points[0], points[-1]]
    return _rdp(points[: idx + 1], eps)[:-1] + _rdp(points[idx:], eps)


_LINE_MERGE_CM = 35.0


def _axis_lines(p, q, samples):
    """Turn midline samples into straight, axis-aligned corridor lines: one line per passage
    (median of its samples), right-angle corners between passages, a clean jog where the
    passage steps. Endpoints are joined orthogonally. No samples → keep the chord."""
    if not samples:
        return [p, q]
    groups = []  # [axis, [values], first (x, y), last (x, y)]
    for x, y, axis in samples:
        value = y if axis == 1 else x
        if groups and groups[-1][0] == axis and abs(sorted(groups[-1][1])[len(groups[-1][1]) // 2] - value) < _LINE_MERGE_CM:
            groups[-1][1].append(value)
            groups[-1][3] = (x, y)
        else:
            groups.append([axis, [value], (x, y), (x, y)])
    # Tiny groups are pocket noise, not passages.
    groups = [g for g in groups if len(g[1]) >= 2] or groups
    lines = [(g[0], sorted(g[1])[len(g[1]) // 2], g[2], g[3]) for g in groups]
    on = lambda axis, c, pt: (pt[0], c) if axis == 1 else (c, pt[1])
    out = [p, on(lines[0][0], lines[0][1], p)]
    for (a0, c0, _f0, l0), (a1, c1, f1, _l1) in zip(lines, lines[1:]):
        if a0 != a1:
            out.append((c1, c0) if a0 == 1 else (c0, c1))
        else:
            mid = ((l0[0] + f1[0]) / 2, (l0[1] + f1[1]) / 2)
            out.append(on(a0, c0, mid))
            out.append(on(a1, c1, mid))
    out.append(on(lines[-1][0], lines[-1][1], q))
    out.append(q)
    return _simplify(_dedupe(out))


def _dedupe(points):
    out = []
    for pt in points:
        if not out or math.hypot(pt[0] - out[-1][0], pt[1] - out[-1][1]) > 1.0:
            out.append(pt)
    return out


def _snap_oblique_runs(pts, grid: FloorGrid, walls, openings, is_fixed):
    """A long oblique chord cuts across corridors. Resample it, pull every sample onto the
    midline of the passage it sits in (across the narrower axis), then re-simplify. Any
    rebuilt run that would touch a wall keeps the original chord."""
    out = [pts[0]]
    for p, q in zip(pts, pts[1:]):
        length = math.hypot(q[0] - p[0], q[1] - p[1])
        ang = math.degrees(math.atan2(abs(q[1] - p[1]), abs(q[0] - p[0])))
        if length < 2 * _CENTER_MIN_SEG_CM or not (1.5 < ang < 88.5):
            out.append(q)
            continue
        n = max(2, int(length // _SNAP_STEP_CM))
        run = [p]
        for i in range(1, n):
            t = i / n
            x, y = p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t
            if min(t * length, (1 - t) * length) < _CENTER_LEAD_CM:
                continue
            gx = (_side_gap(grid, x, y, 1, 0), _side_gap(grid, x, y, -1, 0))
            gy = (_side_gap(grid, x, y, 0, 1), _side_gap(grid, x, y, 0, -1))
            wx = sum(gx) if None not in gx else math.inf
            wy = sum(gy) if None not in gy else math.inf
            if wy < wx and wy <= _SNAP_MAX_WIDTH_CM:
                run.append([x, y + (gy[0] - gy[1]) / 2, 1])
            elif wx < wy and wx <= _SNAP_MAX_WIDTH_CM:
                run.append([x + (gx[0] - gx[1]) / 2, y, 0])
            else:
                run.append([x, y, -1])
        run = _axis_lines(p, q, [smp for smp in run[1:] if smp[2] >= 0])
        if any(_segment_hits_wall(a, b, walls, openings) for a, b in zip(run, run[1:])):
            out.append(q)
        else:
            out.extend(run[1:])
    return out


_RUN_MAX_ANGLE = 15.0
_RUN_MAX_JOG_CM = 90.0


def _seg_axis(p, q):
    dx, dy = abs(q[0] - p[0]), abs(q[1] - p[1])
    ang = math.degrees(math.atan2(dy, dx))
    if ang <= _RUN_MAX_ANGLE:
        return 1
    if ang >= 90 - _RUN_MAX_ANGLE:
        return 0
    return -1


def _straighten_runs(points, grid: FloorGrid, walls, openings, is_fixed):
    """One straight axis line per corridor run. A run is a chain of near-horizontal (or
    near-vertical) segments joined only by short jogs; it is replaced by a single line on the
    passage midline (median of measured midpoints), entered and left at right angles. Fixed
    points (leg ends, door centres) stay; a chain that would touch a wall is left as it was."""
    pts = list(points)
    if len(pts) < 3:
        return pts
    out = [pts[0]]
    i = 0
    n = len(pts)
    while i < n - 1:
        axis = _seg_axis(pts[i], pts[i + 1])
        if axis < 0:
            out.append(pts[i + 1]); i += 1; continue
        j = i + 1
        while j < n - 1:
            nxt = _seg_axis(pts[j], pts[j + 1])
            seg_len = math.hypot(pts[j + 1][0] - pts[j][0], pts[j + 1][1] - pts[j][1])
            if nxt == axis or (seg_len <= _RUN_MAX_JOG_CM and j + 1 < n - 1 and _seg_axis(pts[j + 1], pts[j + 2]) == axis):
                j += 1
            else:
                break
        chain = pts[i:j + 1]
        k = 1 - axis  # coordinate held constant on the line: y for horizontal (axis 1 -> index 1)
        k = 1 if axis == 1 else 0
        span = abs(chain[-1][1 - k] - chain[0][1 - k])
        if j - i < 2 and span < _CENTER_MIN_SEG_CM:
            out.extend(chain[1:]); i = j; continue
        mids = []
        steps = max(3, int(span // _SNAP_STEP_CM))
        for t in range(1, steps):
            u = chain[0][1 - k] + (chain[-1][1 - k] - chain[0][1 - k]) * t / steps
            # current coordinate on the chain at u
            v = None
            for a, b in zip(chain, chain[1:]):
                lo, hi = sorted((a[1 - k], b[1 - k]))
                if lo <= u <= hi and hi - lo > 1e-6:
                    v = a[k] + (b[k] - a[k]) * (u - a[1 - k]) / (b[1 - k] - a[1 - k]); break
            if v is None:
                continue
            x, y = (u, v) if axis == 1 else (v, u)
            nx, ny = (0, 1) if axis == 1 else (1, 0)
            g1, g2 = _side_gap(grid, x, y, nx, ny), _side_gap(grid, x, y, -nx, -ny)
            if g1 is not None and g2 is not None and g1 + g2 <= _SNAP_MAX_WIDTH_CM:
                mids.append(v + (g1 - g2) / 2)
        if len(mids) < 2:
            out.extend(chain[1:]); i = j; continue
        mids.sort()
        c = mids[len(mids) // 2]
        line = lambda pt: (pt[0], c) if axis == 1 else (c, pt[1])
        a0, b0 = chain[0], chain[-1]
        rebuilt = [a0, line(a0), line(b0), b0]
        if not is_fixed(a0) and len(out) >= 2:
            # previous vertex is free: move it onto the line instead of adding a jog
            rebuilt = [line(a0), line(b0), b0]
            out[-1] = line(a0)
        if not is_fixed(b0) and j < n - 1:
            rebuilt = rebuilt[:-1]
            pts[j] = line(b0)
        test = _dedupe([out[-2] if len(out) >= 2 else out[-1]] + rebuilt + ([pts[j + 1]] if j < n - 1 else []))
        if any(_segment_hits_wall(a, b, walls, openings) for a, b in zip(test, test[1:])):
            out.extend(chain[1:])
            pts[j] = chain[-1]
        else:
            out.extend(rebuilt[1:] if rebuilt[0] == out[-1] else rebuilt)
        i = j
    return _simplify(_dedupe(out))


def _path_clearance(path, grid: FloorGrid) -> float:
    """Smallest wall clearance (cells) met along a polyline."""
    best = math.inf
    for a, b in zip(path, path[1:]):
        n = max(1, int(math.hypot(b[0] - a[0], b[1] - a[1]) // 20.0))
        for i in range(n + 1):
            x, y = a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n
            best = min(best, grid.clear_at(*grid.cell_at(x, y)))
    return best


def _ortho_options(p, q, grid: FloorGrid, midlines: bool = True):
    """Monotone L / Z replacements for p→q, including Zs whose long leg runs on a passage
    midline crossed by the chord. All have the same length |dx| + |dy|."""
    dx, dy = q[0] - p[0], q[1] - p[1]
    mx, my = (p[0] + q[0]) / 2, (p[1] + q[1]) / 2
    xs, ys = set(), set()
    n = max(2, int(math.hypot(dx, dy) // _SNAP_STEP_CM)) if midlines else 0
    for i in range(1, n):
        x, y = p[0] + dx * i / n, p[1] + dy * i / n
        gy = (_side_gap(grid, x, y, 0, 1), _side_gap(grid, x, y, 0, -1))
        gx = (_side_gap(grid, x, y, 1, 0), _side_gap(grid, x, y, -1, 0))
        if None not in gy and sum(gy) <= _SNAP_MAX_WIDTH_CM:
            ys.add(round(y + (gy[0] - gy[1]) / 2))
        if None not in gx and sum(gx) <= _SNAP_MAX_WIDTH_CM:
            xs.add(round(x + (gx[0] - gx[1]) / 2))
    lo_x, hi_x = sorted((p[0], q[0]))
    lo_y, hi_y = sorted((p[1], q[1]))
    options = [
        (0, [p, (q[0], p[1]), q]),
        (0, [p, (p[0], q[1]), q]),
        (0, [p, (mx, p[1]), (mx, q[1]), q]),
        (0, [p, (p[0], my), (q[0], my), q]),
    ]
    options += [(1, [p, (p[0], y), (q[0], y), q]) for y in ys if lo_y <= y <= hi_y]
    options += [(1, [p, (x, p[1]), (x, q[1]), q]) for x in xs if lo_x <= x <= hi_x]
    return options


def _best_ortho(p, q, grid: FloorGrid, walls, openings, min_clear=0.0, midlines=True):
    best, best_key = None, None
    for on_mid, path in _ortho_options(p, q, grid, midlines):
        if any(_segment_hits_wall(a, b, walls, openings) for a, b in zip(path, path[1:])):
            continue
        clear = _path_clearance(path, grid)
        if clear < min_clear:
            continue
        # enough clearance first, then a leg on a passage midline, then fewest bends
        key = (min(clear, 60.0 / grid.cell), on_mid, -len(_simplify(_dedupe(path))))
        if best_key is None or key > best_key:
            best, best_key = path, key
    return best


def _orthogonalize(points, grid: FloorGrid, walls, openings):
    """Every oblique segment (open halls, door mitres) becomes an axis-aligned L or Z; if all
    candidates touch a wall the segment stays as it is."""
    if len(points) < 2:
        return points
    out = [points[0]]
    for p, q in zip(points, points[1:]):
        if abs(q[0] - p[0]) < 1.0 or abs(q[1] - p[1]) < 1.0:
            out.append(q)
            continue
        best = _best_ortho(p, q, grid, walls, openings)
        out.extend(best[1:] if best else [q])
    return _ortho_pull(_simplify(_dedupe(out)), grid, walls, openings)


def _plen(points):
    return sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(points, points[1:]))


def _ortho_pull(points, grid: FloorGrid, walls, openings):
    """Orthogonal string-pull: replace any stretch by a shorter wall-free L/Z between its ends
    (with real clearance), so A*'s detours through the middle of halls collapse onto the
    direct corridor. Farthest reachable vertex first, like a normal string-pull."""
    pts = list(points)
    if len(pts) < 4:
        return pts
    out = [pts[0]]
    i = 0
    min_clear = 50.0 / grid.cell
    while i < len(pts) - 1:
        nxt, repl = i + 1, None
        for j in range(min(len(pts) - 1, i + 6), i + 1, -1):
            cur = _plen(pts[i:j + 1])
            if abs(pts[j][0] - pts[i][0]) + abs(pts[j][1] - pts[i][1]) > cur - 30.0:
                continue
            path = _best_ortho(pts[i], pts[j], grid, walls, openings, min_clear, midlines=False)
            if path is None and (abs(pts[j][0] - pts[i][0]) < 1.0 or abs(pts[j][1] - pts[i][1]) < 1.0):
                if not _segment_hits_wall(pts[i], pts[j], walls, openings) and _path_clearance([pts[i], pts[j]], grid) >= min_clear:
                    path = [pts[i], pts[j]]
            if path:
                nxt, repl = j, path
                break
        out.extend(repl[1:] if repl else [pts[nxt]])
        i = nxt
    return _simplify(_dedupe(out))


def _center_in_corridors(points, grid: FloorGrid, walls, openings):
    """Slide each straight run onto the passage midline (equal free space either side).

    Ends of the leg and door centres stay put; a long run touching one gets a short lead-in
    vertex so only the run itself moves. Any move that would cross a wall is undone."""
    if len(points) < 2:
        return points
    fixed_pts = [tuple(points[0]), tuple(points[-1])]
    fixed_pts += [tuple(p) for p in points if _is_door_center(p, openings)]
    is_fixed = lambda p: any(abs(p[0] - q[0]) < 1e-6 and abs(p[1] - q[1]) < 1e-6 for q in fixed_pts)
    pts = [tuple(points[0])]
    for p, q in zip(points, points[1:]):
        length = math.hypot(q[0] - p[0], q[1] - p[1])
        if length > _CENTER_MIN_SEG_CM + 2 * _CENTER_LEAD_CM:
            ux, uy = (q[0] - p[0]) / length, (q[1] - p[1]) / length
            if is_fixed(p):
                pts.append((p[0] + ux * _CENTER_LEAD_CM, p[1] + uy * _CENTER_LEAD_CM))
            if is_fixed(q):
                pts.append((q[0] - ux * _CENTER_LEAD_CM, q[1] - uy * _CENTER_LEAD_CM))
        pts.append(tuple(q))
    pts = _snap_oblique_runs(pts, grid, walls, openings, is_fixed)
    shift = [[0.0, 0.0] for _ in pts]
    for i in range(len(pts) - 1):
        p, q = pts[i], pts[i + 1]
        length = math.hypot(q[0] - p[0], q[1] - p[1])
        if length < _CENTER_MIN_SEG_CM or is_fixed(p) or is_fixed(q):
            continue
        ux, uy = (q[0] - p[0]) / length, (q[1] - p[1]) / length
        nx, ny = -uy, ux
        offs = []
        for t in (0.2, 0.35, 0.5, 0.65, 0.8):
            x, y = p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t
            left, right = _side_gap(grid, x, y, nx, ny), _side_gap(grid, x, y, -nx, -ny)
            if left is not None and right is not None:
                offs.append((left - right) / 2)
        if len(offs) < 3:
            continue
        offs.sort()
        off = offs[len(offs) // 2]
        if abs(off) < grid.cell or abs(off) > _CENTER_MAX_SHIFT_CM:
            continue
        for k in (i, i + 1):
            shift[k][0] += nx * off
            shift[k][1] += ny * off
    moved = [(p[0] + s[0], p[1] + s[1]) for p, s in zip(pts, shift)]
    for _ in range(len(moved)):
        bad = [i for i in range(len(moved) - 1)
               if (moved[i] != pts[i] or moved[i + 1] != pts[i + 1])
               and _segment_hits_wall(moved[i], moved[i + 1], walls, openings)]
        if not bad:
            break
        for i in bad:
            moved[i], moved[i + 1] = pts[i], pts[i + 1]
    return _orthogonalize(_straighten_runs(_simplify(_dedupe(moved)), grid, walls, openings, is_fixed), grid, walls, openings)


def _leg(grid: FloorGrid, start, end, penalty=None, _door_via: bool = True):
    return _leg_raw(grid, start, end, penalty, _door_via)


def _leg_raw(grid: FloorGrid, start, end, penalty=None, _door_via: bool = True):
    a = _point(start)
    b = _point(end)
    if not a or not b:
        return None, "off-plan"
    # Enter/leave private rooms through their access door — not a neighbour room's jamb
    # that A* prefers for clearance cost (P2 3F 病房8 via 办公2).
    if _door_via:
        vias = []
        start_door = _access_door_near(grid, a)
        end_door = _access_door_near(grid, b)
        if start_door:
            vias.append(start_door)
        if end_door and (not start_door or math.hypot(end_door[0] - start_door[0], end_door[1] - start_door[1]) > 30.0):
            vias.append(end_door)
        if vias:
            points = []
            cursor = a
            for via in (*vias, b):
                chunk, err = _leg(grid, cursor, via, penalty=penalty, _door_via=False)
                if not chunk:
                    points = []
                    break
                if points and chunk:
                    points.extend(chunk[1:])
                else:
                    points.extend(chunk)
                cursor = via
            if points:
                walls, openings = _grid_geometry(grid)
                simplified = _simplify_clear(points, walls, openings)
                if not any(_segment_hits_wall(p, q, walls, openings) for p, q in zip(simplified, simplified[1:])):
                    tighter = _string_pull(simplified, walls, openings, pad=_CLEARANCE_PAD_CM)
                    if not any(_segment_hits_wall(p, q, walls, openings) for p, q in zip(tighter, tighter[1:])):
                        simplified = tighter
                    return simplified, None
                if any(_segment_hits_wall(p, q, walls, openings) for p, q in zip(points, points[1:])):
                    # via route crosses a wall: a direct plan wins only when it is clean
                    direct, _err = _leg_raw(grid, a, b, penalty, False)
                    if direct and not any(_segment_hits_wall(p, q, walls, openings) for p, q in zip(direct, direct[1:])):
                        return direct, None
                return points, None
    radius = SNAP_CM / grid.cell
    start_cell = _nearest(grid, *grid.cell_at(*a), radius)
    end_cell = _nearest(grid, *grid.cell_at(*b), radius)
    if not start_cell or not end_cell:
        return None, "off-plan"
    path = _astar(grid, start_cell, end_cell, penalty=penalty)
    keep_a = keep_b = True
    if not path:
        # A stop inside a sealed pocket (room whose door the import missed, raw place
        # coordinates): fall back to the nearest spot on the building's circulation.
        main = grid.main_component()
        if (start_cell[1] * grid.cols + start_cell[0]) not in main:
            start_cell = _nearest_main(grid, *start_cell, 1500 / grid.cell) or start_cell
            keep_a = False
        if (end_cell[1] * grid.cols + end_cell[0]) not in main:
            end_cell = _nearest_main(grid, *end_cell, 1500 / grid.cell) or end_cell
            keep_b = False
        path = _astar(grid, start_cell, end_cell, penalty=penalty) if not (keep_a and keep_b) else None
    if not path:
        return None, "blocked"
    # The raster can leak through a thin wall between two cells; ban such steps and re-plan.
    walls, openings = _grid_geometry(grid)
    banned = set()
    for _ in range(12):
        leaks = [(c, n) for c, n in zip(path, path[1:])
                 if _segment_hits_wall(grid.center(*c), grid.center(*n), walls, openings)]
        if not leaks:
            break
        for c, n in leaks:
            banned.add((c, n)); banned.add((n, c))
        path = _astar(grid, start_cell, end_cell, frozenset(banned), penalty)
        if not path:
            # The destination was only 'reachable' through the leak: stop at the closest
            # cell the walker can really reach (outside that room).
            near = _nearest_reachable(grid, start_cell, end_cell, frozenset(banned), 1500 / grid.cell)
            path = _astar(grid, start_cell, near, frozenset(banned), penalty) if near else None
            if not path:
                return None, "blocked"
            end_cell, keep_b = near, False
    points = []
    first, last = grid.center(*path[0]), grid.center(*path[-1])
    if keep_a and grid.walkable(*grid.cell_at(*a)) and not _segment_hits_wall(a, first, walls, openings):
        points.append(a)
    for col, row in path:
        points.append(grid.center(col, row))
    if keep_b and grid.walkable(*grid.cell_at(*b)) and not _segment_hits_wall(last, b, walls, openings):
        points.append(b)
    simplified = _simplify_clear(points, walls, openings)
    if any(_segment_hits_wall(a, b, walls, openings) for a, b in zip(simplified, simplified[1:])):
        # Door-center nudging failed: keep A* polyline, then line-of-sight pull (pad then bare).
        base = _simplify(points)
        for pad in (_CLEARANCE_PAD_CM, 0.0):
            pulled = _string_pull(base, walls, openings, pad=pad)
            if not any(_segment_hits_wall(a, b, walls, openings) for a, b in zip(pulled, pulled[1:])):
                simplified = pulled
                break
        else:
            simplified = base
            if any(_segment_hits_wall(a, b, walls, openings) for a, b in zip(simplified, simplified[1:])):
                return None, "blocked"
    else:
        # Extra LOS pull removes residual stair-step jogs when clearance already held.
        tighter = _string_pull(simplified, walls, openings, pad=_CLEARANCE_PAD_CM)
        if not any(_segment_hits_wall(a, b, walls, openings) for a, b in zip(tighter, tighter[1:])):
            simplified = tighter
    return simplified, None


def route_view(
    project: dict,
    floor_id: str | None,
    start,
    end,
    vias=None,
    accessible: bool = False,
    stairs_only: bool = False,
) -> dict:
    """A* route through ``vias`` (at most 6); stops may carry their own ``floor``.

    Stops on different floors are joined by vertical links, so the result is
    per-floor ``legs`` plus the ``transfers`` between them. The top-level
    ``polyline`` / ``usedDoorIds`` are the first leg's, for single-floor callers.
    ``accessible`` rides elevators only.
    ``stairs_only`` rides stairs only (no elevator / escalator).
    """
    default = str(select_floor(project, floor_id).get("id") or "")
    stops = [start, *(vias or [])[:6], end]
    placed = [(_stop_floor(project, stop, default), stop) for stop in stops]
    # Accessible (lift-only) wins over stairs-only when both are set.
    trip = _Trip(project, accessible=accessible, stairs_only=bool(stairs_only) and not accessible)
    for fid, stop in (placed[0], placed[-1]):
        trip.allow_endpoint(fid, stop)
    for (floor_a, a), (floor_b, b) in zip(placed, placed[1:]):
        if floor_a == floor_b:
            points, reason = trip.walk(floor_a, a, b)
            if not points:
                return {"ok": False, "reason": reason or "blocked"}
            trip.add_walk(floor_a, points)
            continue
        reason = trip.ride(floor_a, a, floor_b, b)
        if reason:
            return {"ok": False, "reason": reason}
    return trip.result()


# Rides cost path-equivalent centimetres (walking ≈ 120 cm/s): an elevator
# charges its wait once, stairs charge effort per storey.
VERTICAL_KINDS = {
    "elevator": {"label": "电梯", "base": 1200.0, "perFloor": 300.0, "accessible": True},
    "escalator": {"label": "扶梯", "base": 300.0, "perFloor": 900.0, "accessible": False},
    "stairs": {"label": "楼梯", "base": 300.0, "perFloor": 1500.0, "accessible": False},
}
MAX_VERTICAL_LINKS = 64
_TRANSIT_WALK_CM = 20000.0
# Same-named shafts on one floor pair with the nearest one above / below.
_SHAFT_ALIGN_CM = 400.0
_FLOOR_TAG_RE = re.compile(r"(?i)[（(]?\s*b?\d+\s*(?:f|层|楼)\s*[）)]?")


def _floors_by_id(project: dict) -> dict[str, dict]:
    return {
        str(floor.get("id")): floor
        for floor in project.get("floors") or []
        if isinstance(floor, dict) and floor.get("id")
    }


def _floor_level(floor: dict, index: int) -> float:
    level = floor.get("level")
    return float(level) if isinstance(level, (int, float)) and math.isfinite(level) else float(index)


def _floor_levels(project: dict) -> dict[str, float]:
    return {
        floor_id: _floor_level(floor, index)
        for index, (floor_id, floor) in enumerate(_floors_by_id(project).items())
    }


def _stop_floor(project: dict, stop, default: str) -> str:
    wanted = str(stop.get("floor") or stop.get("floorId") or "") if isinstance(stop, dict) else ""
    return wanted if wanted in _floors_by_id(project) else default


# Spaces nobody navigates to (still walls/floors, just not in the destination list).
NON_DESTINATION_RE = re.compile(r"空调外机|空调机位|公共过道|走廊|过道|原地面|屋顶花园|屋面|屋顶|花坛|管道井|水井|电井|风井|上空|冲洗台|设备平台|平台|雨棚|天井|庭院|柜子|货架|器械柜|^室$|^间$")


def is_destination(name) -> bool:
    name = str(name or "").strip()
    return bool(name) and not _is_placeholder_name(name) and not NON_DESTINATION_RE.search(name)


def all_places(project: dict) -> list[dict]:
    """Destinations of every floor, tagged with their floor."""
    places = []
    for floor_id, floor in _floors_by_id(project).items():
        grid = grid_for(project, floor_id)
        if not grid:
            continue
        floor_name = str(floor.get("name") or floor_id)
        zones = restricted_zones(project, floor_id)
        seen = []
        for dest in grid.destinations:
            # Two faces of one toilet block snapped to the same door point read as identical
            # rows (「卫生间 · 2F · 27 米」×2): one destination.
            if any(o["name"] == dest.get("name") and math.hypot(o["x"] - dest["x"], o["y"] - dest["y"]) < 60
                   and not o.get("ensuite") and not dest.get("ensuite") for o in seen):
                continue
            seen.append(dest)
            place = {**dest, "floorId": floor_id, "floorName": floor_name}
            location = dest.get("interior") or dest
            if any(_point_in_polygon(location["x"], location["y"], z["_poly"]) for z in zones):
                place["restricted"] = True
                place["tag"] = ZONE_LABEL
            places.append(place)
    return places


def _link_name_key(name: str) -> str:
    return re.sub(r"[\s\-·_:：]+", "", _FLOOR_TAG_RE.sub("", str(name or ""))).lower()


def _link_stop(floor_id: str, floor_name: str, place: dict | None, stop: dict) -> dict | None:
    if place:
        return {
            "floorId": floor_id,
            "floorName": floor_name,
            "placeId": place["id"],
            "name": place["name"],
            "x": stop.get("x", place["x"]),
            "y": stop.get("y", place["y"]),
        }
    point = _point(stop)
    if not point:
        return None
    return {
        "floorId": floor_id,
        "floorName": floor_name,
        "placeId": "",
        "name": str(stop.get("name") or "").strip(),
        "x": round(point[0], 1),
        "y": round(point[1], 1),
    }


def _manual_links(project: dict, places: dict, floors: dict, levels: dict) -> list[dict]:
    links = []
    for index, raw in enumerate(project.get("verticalLinks") or []):
        if not isinstance(raw, dict):
            continue
        kind = raw.get("kind") if raw.get("kind") in VERTICAL_KINDS else "elevator"
        stops = []
        for stop in raw.get("stops") or []:
            if not isinstance(stop, dict):
                continue
            floor_id = str(stop.get("floorId") or "")
            if floor_id not in floors or any(item["floorId"] == floor_id for item in stops):
                continue
            place = places.get((floor_id, str(stop.get("roomId") or stop.get("placeId") or "")))
            resolved = _link_stop(floor_id, str(floors[floor_id].get("name") or floor_id), place, stop)
            if resolved:
                stops.append(resolved)
        if len(stops) < 2:
            continue
        stops.sort(key=lambda item: levels.get(item["floorId"], 0.0))
        source = str(raw.get("source") or "manual").strip() or "manual"
        if source == "auto":
            source = "manual"
        links.append({
            "id": str(raw.get("id") or f"link-{index + 1}"),
            "kind": kind,
            "kindLabel": VERTICAL_KINDS[kind]["label"],
            "name": str(raw.get("name") or "").strip() or stops[0]["name"] or VERTICAL_KINDS[kind]["label"],
            "source": source,
            "stops": stops,
            **({"onlyTo": [str(x) for x in raw["onlyTo"]]} if isinstance(raw.get("onlyTo"), list) and raw["onlyTo"] else {}),
        })
    return links


def _auto_links(candidates: list[dict], levels: dict) -> list[dict]:
    """Pair same-named elevator / stairs rooms across floors.

    One per floor pairs by name alone (imported floors rarely share an origin);
    several per floor pair by position, assuming the shafts line up.
    """
    groups: dict[tuple, list[dict]] = {}
    for place in candidates:
        groups.setdefault((place["category"], _link_name_key(place["name"])), []).append(place)
    links = []
    for (kind, _name), members in groups.items():
        members.sort(key=lambda place: levels.get(place["floorId"], 0.0))
        per_floor: dict[str, int] = {}
        for place in members:
            per_floor[place["floorId"]] = per_floor.get(place["floorId"], 0) + 1
        clusters: list[list[dict]] = []
        if max(per_floor.values()) <= 1:
            clusters.append(members)
        else:
            for place in members:
                home = None
                for cluster in clusters:
                    if any(item["floorId"] == place["floorId"] for item in cluster):
                        continue
                    anchor = cluster[-1]
                    if math.hypot(anchor["x"] - place["x"], anchor["y"] - place["y"]) <= _SHAFT_ALIGN_CM:
                        home = cluster
                        break
                if home is None:
                    clusters.append([place])
                else:
                    home.append(place)
        for cluster in clusters:
            if len(cluster) < 2:
                continue
            links.append({
                "id": f"auto-{kind}-{len(links) + 1}",
                "kind": kind,
                "kindLabel": VERTICAL_KINDS[kind]["label"],
                "name": cluster[0]["name"],
                "source": "auto",
                "stops": [
                    _link_stop(place["floorId"], place["floorName"], place, place)
                    for place in cluster
                ],
            })
    return links


def vertical_links(project: dict) -> list[dict]:
    """Hand-made ``verticalLinks`` first, then auto pairs of unclaimed rooms."""
    floors = _floors_by_id(project)
    if len(floors) < 2:
        return []
    levels = _floor_levels(project)
    listed = all_places(project)
    places = {(place["floorId"], place["id"]): place for place in listed}
    manual = _manual_links(project, places, floors, levels)
    claimed = {(stop["floorId"], stop["placeId"]) for link in manual for stop in link["stops"]}
    # A stair/lift room standing where a listed link already stops is that link, not a new one
    # (imported links store x/y stops without a roomId; pairing it again made a duplicate stair).
    stops_at = [(stop["floorId"], stop["x"], stop["y"]) for link in manual for stop in link["stops"]]
    candidates = [
        place for place in listed
        if place.get("category") in VERTICAL_KINDS and (place["floorId"], place["id"]) not in claimed
        and not any(f == place["floorId"] and math.hypot(x - place["x"], y - place["y"]) <= _SHAFT_ALIGN_CM for f, x, y in stops_at)
    ]
    if any(link.get("source") == "pdf-import" for link in manual):
        # The PDF importer already chained every shaft it could align; pairing leftover
        # same-named rooms by name alone teleported across the building (P1 楼梯 1F NW → 2F SW).
        return manual
    return manual + _auto_links(candidates, levels)


def add_vertical_link(project: dict, body) -> dict:
    """Append a hand-made link; stops name a destination id or an x/y point."""
    if not isinstance(body, dict):
        raise ValueError("link")
    kind = str(body.get("kind") or "elevator")
    if kind not in VERTICAL_KINDS:
        raise ValueError("kind")
    floors = _floors_by_id(project)
    places = {(place["floorId"], place["id"]): place for place in all_places(project)}
    stops = []
    for stop in body.get("stops") or []:
        if not isinstance(stop, dict):
            raise ValueError("stop")
        floor_id = str(stop.get("floorId") or "")
        if floor_id not in floors or any(item["floorId"] == floor_id for item in stops):
            raise ValueError("floor")
        place_id = str(stop.get("roomId") or stop.get("placeId") or "")
        place = places.get((floor_id, place_id))
        if place:
            stops.append({"floorId": floor_id, "roomId": place_id, "x": place["x"], "y": place["y"]})
            continue
        point = _point(stop)
        if not point:
            raise ValueError("stop")
        stops.append({"floorId": floor_id, "x": round(point[0], 1), "y": round(point[1], 1)})
    if len(stops) < 2:
        raise ValueError("stops")
    links = project.get("verticalLinks")
    if not isinstance(links, list):
        links = []
    if len(links) >= MAX_VERTICAL_LINKS:
        raise ValueError("full")
    link = {
        "id": f"link-{secrets.token_hex(4)}",
        "kind": kind,
        "name": re.sub(r"\s+", " ", str(body.get("name") or "").strip())[:40],
        "source": "manual",
        "stops": stops,
    }
    links.append(link)
    project["verticalLinks"] = links
    return link


def _resolve_bind_stop(floors: dict, places: dict, raw) -> dict:
    if not isinstance(raw, dict):
        raise ValueError("stop")
    floor_id = str(raw.get("floorId") or raw.get("floor") or "")
    if floor_id not in floors:
        raise ValueError("floor")
    place_id = str(raw.get("roomId") or raw.get("placeId") or "")
    place = places.get((floor_id, place_id)) if place_id else None
    if place:
        return {"floorId": floor_id, "roomId": place_id, "x": place["x"], "y": place["y"]}
    point = _point(raw)
    if not point:
        raise ValueError("stop")
    return {"floorId": floor_id, "x": round(point[0], 1), "y": round(point[1], 1)}


def _stops_match(existing: dict, wanted: dict, align_cm: float = _SHAFT_ALIGN_CM) -> bool:
    if existing.get("floorId") != wanted.get("floorId"):
        return False
    existing_room = str(existing.get("roomId") or existing.get("placeId") or "")
    wanted_room = str(wanted.get("roomId") or wanted.get("placeId") or "")
    if existing_room and wanted_room:
        return existing_room == wanted_room
    if wanted_room and existing_room == wanted_room:
        return True
    return math.hypot(float(existing.get("x", 0)) - float(wanted["x"]), float(existing.get("y", 0)) - float(wanted["y"])) <= align_cm


def _ordered_floor_ids(project: dict) -> list[str]:
    levels = _floor_levels(project)
    return [floor_id for floor_id, _level in sorted(levels.items(), key=lambda item: item[1])]


def _adjacent_floors(project: dict, floor_a: str, floor_b: str) -> bool:
    order = _ordered_floor_ids(project)
    try:
        return abs(order.index(floor_a) - order.index(floor_b)) == 1
    except ValueError:
        return False


def _find_raw_link_index(links: list, stop: dict) -> int:
    for index, raw in enumerate(links):
        if not isinstance(raw, dict):
            continue
        for item in raw.get("stops") or []:
            if isinstance(item, dict) and _stops_match(item, stop):
                return index
    return -1


def _put_stop(raw: dict, stop: dict) -> None:
    stops = [item for item in (raw.get("stops") or []) if isinstance(item, dict)]
    kept = [item for item in stops if item.get("floorId") != stop["floorId"]]
    kept.append(dict(stop))
    raw["stops"] = kept


def _prune_empty_links(links: list) -> list:
    kept = []
    for raw in links:
        if not isinstance(raw, dict):
            continue
        stops = [item for item in (raw.get("stops") or []) if isinstance(item, dict) and item.get("floorId")]
        if len(stops) < 2:
            continue
        raw["stops"] = stops
        kept.append(raw)
    return kept


def bind_adjacent_vertical_link(project: dict, body) -> dict:
    """Bind one adjacent-floor edge with one-to-one replace semantics.

    Multi-stop shafts stay multi-stop: binding 2F↔3F updates those floors'
    stops inside the shaft that owns ``from``. If ``to`` already belonged to
    another shaft, it is moved (removed from the other). Default UX is
    replace-on-rebind — an existing upward/downward neighbor is overwritten.
    """
    if not isinstance(body, dict):
        raise ValueError("link")
    floors = _floors_by_id(project)
    places = {(place["floorId"], place["id"]): place for place in all_places(project)}
    from_stop = _resolve_bind_stop(floors, places, body.get("from"))
    to_stop = _resolve_bind_stop(floors, places, body.get("to"))
    if from_stop["floorId"] == to_stop["floorId"]:
        raise ValueError("floor")
    if not _adjacent_floors(project, from_stop["floorId"], to_stop["floorId"]):
        raise ValueError("adjacent")
    kind = str(body.get("kind") or "")
    if kind not in VERTICAL_KINDS:
        for candidate in (from_stop, to_stop):
            place = places.get((candidate["floorId"], str(candidate.get("roomId") or "")))
            guessed = (place or {}).get("category")
            if guessed in VERTICAL_KINDS:
                kind = guessed
                break
        else:
            kind = "elevator"
    name = re.sub(r"\s+", " ", str(body.get("name") or "").strip())[:40]
    links = project.get("verticalLinks")
    if not isinstance(links, list):
        links = []
    from_index = _find_raw_link_index(links, from_stop)
    to_index = _find_raw_link_index(links, to_stop)
    replaced = False

    def _edge_replaced(home: dict, stop: dict) -> bool:
        old = next(
            (
                item for item in home.get("stops") or []
                if isinstance(item, dict) and item.get("floorId") == stop["floorId"]
            ),
            None,
        )
        if old is None:
            return False
        old_room = str(old.get("roomId") or old.get("placeId") or "")
        new_room = str(stop.get("roomId") or stop.get("placeId") or "")
        if old_room and new_room:
            return old_room != new_room
        return not _stops_match(old, stop)

    if from_index >= 0:
        home = links[from_index]
        if _edge_replaced(home, to_stop):
            replaced = True
        if to_index >= 0 and to_index != from_index:
            other = links[to_index]
            other["stops"] = [
                item for item in (other.get("stops") or [])
                if not (isinstance(item, dict) and item.get("floorId") == to_stop["floorId"])
            ]
            replaced = True
        _put_stop(home, from_stop)
        _put_stop(home, to_stop)
        if home.get("kind") not in VERTICAL_KINDS:
            home["kind"] = kind
        if name:
            home["name"] = name
        if not home.get("source") or home.get("source") == "auto":
            home["source"] = "editor"
        link = home
    elif to_index >= 0:
        home = links[to_index]
        if _edge_replaced(home, from_stop):
            replaced = True
        _put_stop(home, from_stop)
        _put_stop(home, to_stop)
        if home.get("kind") not in VERTICAL_KINDS:
            home["kind"] = kind
        if name:
            home["name"] = name
        if not home.get("source") or home.get("source") == "auto":
            home["source"] = "editor"
        link = home
    else:
        if len(links) >= MAX_VERTICAL_LINKS:
            raise ValueError("full")
        link = {
            "id": f"link-{secrets.token_hex(4)}",
            "kind": kind,
            "name": name or VERTICAL_KINDS[kind]["label"],
            "source": "editor",
            "stops": [from_stop, to_stop],
        }
        links.append(link)
    project["verticalLinks"] = _prune_empty_links(links)
    return {"link": link, "replaced": replaced, "links": vertical_links(project)}


def remove_vertical_link(project: dict, link_id: str) -> bool:
    links = project.get("verticalLinks")
    if not isinstance(links, list):
        return False
    kept = [link for link in links if not (isinstance(link, dict) and link.get("id") == link_id)]
    if len(kept) == len(links):
        return False
    project["verticalLinks"] = kept
    return True


def _polyline_length(points) -> float:
    return sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(points, points[1:]))



# ---- Restricted zones (限制通行区): infection-control clusters etc. -------------------------
ZONE_LABEL = "限制通行区域"
_ZONE_COST = 8.0  # walking through a zone costs this many times more (avoid unless needed)


def restricted_zones(project: dict, floor_id: str | None = None) -> list[dict]:
    out = []
    for z in project.get("restrictedZones") or []:
        if not isinstance(z, dict) or (floor_id and z.get("floorId") != floor_id):
            continue
        poly = [(float(p["x"]), float(p["y"])) for p in z.get("polygon") or [] if isinstance(p, dict)]
        if len(poly) >= 3:
            out.append({**z, "_poly": poly})
    return out


_ZONE_LINK_REACH_CM = 300.0  # a stair landing just outside a zone's box is that zone's stair


def stop_in_zone(stop, zone: dict) -> bool:
    """Stairs/lifts whose landing is inside or right next to a zone are restricted with it
    (the import's zone box can stop short of the stair shaft, P1 SW stair)."""
    x, y = float(stop["x"]), float(stop["y"])
    if _point_in_polygon(x, y, zone["_poly"]):
        return True
    xs = [p[0] for p in zone["_poly"]]; ys = [p[1] for p in zone["_poly"]]
    dx = max(0.0, min(xs) - x, x - max(xs)); dy = max(0.0, min(ys) - y, y - max(ys))
    return math.hypot(dx, dy) <= _ZONE_LINK_REACH_CM


def zone_at(project: dict, floor_id: str, point) -> dict | None:
    pt = _point(point)
    if not pt:
        return None
    for z in restricted_zones(project, floor_id):
        if _point_in_polygon(pt[0], pt[1], z["_poly"]):
            return z
    return None


def _zone_penalty(grid: "FloorGrid", zones: list[dict]):
    if not zones:
        return None
    key = tuple(z.get("id") for z in zones)
    cache = grid.__dict__.setdefault("_zone_pen", {})
    if key in cache:
        return cache[key]
    pen = bytearray(grid.cols * grid.rows)
    for z in zones:
        xs = [p[0] for p in z["_poly"]]; ys = [p[1] for p in z["_poly"]]
        c0, r0 = grid.cell_at(min(xs), min(ys)); c1, r1 = grid.cell_at(max(xs), max(ys))
        for r in range(max(0, min(r0, r1)), min(grid.rows, max(r0, r1) + 1)):
            for c in range(max(0, min(c0, c1)), min(grid.cols, max(c0, c1) + 1)):
                x, y = grid.center(c, r)
                if _point_in_polygon(x, y, z["_poly"]):
                    pen[r * grid.cols + c] = 1
    cache[key] = pen
    return pen


class _Trip:
    """Per-floor legs of one route, joined by vertical rides."""

    def __init__(self, project: dict, accessible: bool = False, stairs_only: bool = False):
        self.project = project
        self.accessible = accessible
        self.stairs_only = stairs_only
        self.legs: list[dict] = []
        self.transfers: list[dict] = []
        self._walks: dict[tuple, tuple] = {}
        self._links: list[dict] | None = None
        self.allowed_zones: set = set()  # zones the trip starts or ends in

    def allow_endpoint(self, floor_id: str, point) -> None:
        z = zone_at(self.project, floor_id, point)
        if z:
            self.allowed_zones.add(z.get("id"))

    def _blocked_zones(self, floor_id: str) -> list[dict]:
        return [z for z in restricted_zones(self.project, floor_id) if z.get("id") not in self.allowed_zones]

    def links(self) -> list[dict]:
        if self._links is None:
            def ok(link):
                kind = link["kind"]
                if self.accessible and not VERTICAL_KINDS[kind]["accessible"]:
                    return False
                if self.stairs_only and kind != "stairs":
                    return False
                # Stairs / lifts inside a restricted zone are restricted too.
                return not any(z for stop in link["stops"] for z in self._blocked_zones(stop["floorId"])
                               if stop_in_zone(stop, z))
            self._links = [link for link in vertical_links(self.project) if ok(link)]
        return self._links

    def walk(self, floor_id: str, a, b):
        key = (floor_id, _point(a), _point(b))
        if key not in self._walks:
            grid = grid_for(self.project, floor_id)
            pen = _zone_penalty(grid, self._blocked_zones(floor_id)) if grid else None
            self._walks[key] = _leg(grid, a, b, pen) if grid else (None, "empty")
        return self._walks[key]

    def add_walk(self, floor_id: str, points) -> None:
        last = len(self.legs) - 1
        rode_since = bool(self.transfers) and self.transfers[-1]["afterLeg"] == last
        if self.legs and self.legs[-1]["floorId"] == floor_id and not rode_since:
            self.legs[-1]["points"].extend(points[1:])
        else:
            self.legs.append({"floorId": floor_id, "points": list(points)})

    def ride(self, floor_a: str, a, floor_b: str, b) -> str | None:
        """Dijkstra over link stops; walks are per-floor A*. Returns a failure reason."""
        links = self.links()
        levels = _floor_levels(self.project)
        start, end = ("start",), ("end",)

        def floor_of(node):
            if node == start:
                return floor_a
            if node == end:
                return floor_b
            return links[node[0]]["stops"][node[1]]["floorId"]

        def point_of(node):
            if node == start:
                return a
            if node == end:
                return b
            return links[node[0]]["stops"][node[1]]

        dist = {start: 0.0}
        previous: dict[tuple, tuple] = {}
        queue = [(0.0, 0, start)]
        counter = 1
        while queue:
            cost, _order, node = heappop(queue)
            if cost > dist.get(node, 1e18) + 1e-9:
                continue
            if node == end:
                break
            floor_id = floor_of(node)
            edges = []
            targets = [end] if floor_id == floor_b else []
            targets += [
                (li, si)
                for li, link in enumerate(links)
                if len(node) == 1 or node[0] != li
                for si, stop in enumerate(link["stops"])
                if stop["floorId"] == floor_id
            ]
            # Changing shafts on a floor between start and end would show that
            # floor mid-route, so it is only taken when no direct ride exists.
            detour = 0.0 if floor_id in (floor_a, floor_b) else _TRANSIT_WALK_CM
            for target in targets:
                points, _reason = self.walk(floor_id, point_of(node), point_of(target))
                if points:
                    # A walk that only got 'near' its target (sealed pocket / leak fallback) is a
                    # last resort, not a shortcut: a stair stop in a pocket must not beat the real
                    # path from the lift (P2 5F→3F ended 6–9 m from the room through a wall).
                    tx, ty = _point(point_of(target)) or (points[-1][0], points[-1][1])
                    gap = math.hypot(points[-1][0] - tx, points[-1][1] - ty)
                    sx, sy = _point(point_of(node)) or (points[0][0], points[0][1])
                    gap += math.hypot(points[0][0] - sx, points[0][1] - sy)
                    short = 0.0 if gap <= 250 else 50000.0 + gap * 10
                    edges.append((target, _polyline_length(points) + detour + short, ("walk", floor_id, points)))
            if len(node) == 2:
                link = links[node[0]]
                kind = VERTICAL_KINDS[link["kind"]]
                here = link["stops"][node[1]]
                for sj, stop in enumerate(link["stops"]):
                    if sj == node[1]:
                        continue
                    storeys = max(1.0, abs(levels.get(stop["floorId"], 0.0) - levels.get(here["floorId"], 0.0)))
                    edges.append(((node[0], sj), kind["base"] + kind["perFloor"] * storeys, ("ride", node[0], node[1], sj)))
            for target, step, how in edges:
                total = cost + step
                if total + 1e-9 >= dist.get(target, 1e18):
                    continue
                dist[target] = total
                previous[target] = (node, how)
                heappush(queue, (total, counter, target))
                counter += 1
        if end not in dist:
            touches = {stop["floorId"] for link in links for stop in link["stops"]}
            return "no-link" if floor_a not in touches or floor_b not in touches else "blocked"
        pieces = []
        node = end
        while node != start:
            node, how = previous[node]
            pieces.append(how)
        for how in reversed(pieces):
            if how[0] == "walk":
                self.add_walk(how[1], how[2])
                continue
            link = links[how[1]]
            here, there = link["stops"][how[2]], link["stops"][how[3]]
            self.transfers.append({
                "afterLeg": len(self.legs) - 1,
                "linkId": link["id"],
                "kind": link["kind"],
                "kindLabel": link["kindLabel"],
                "name": link["name"],
                "source": link["source"],
                "fromFloorId": here["floorId"],
                "fromFloorName": here["floorName"],
                "toFloorId": there["floorId"],
                "toFloorName": there["floorName"],
                "from": {"x": here["x"], "y": here["y"]},
                "to": {"x": there["x"], "y": there["y"]},
                "storeys": round(abs(levels.get(there["floorId"], 0.0) - levels.get(here["floorId"], 0.0))),
                **({"onlyTo": link["onlyTo"]} if link.get("onlyTo") else {}),
                "direction": "up" if levels.get(there["floorId"], 0.0) > levels.get(here["floorId"], 0.0) else "down",
            })
        return None

    def result(self) -> dict:
        if not self.legs or (len(self.legs) == 1 and len(self.legs[0]["points"]) < 2):
            return {"ok": False, "reason": "blocked"}
        floors = _floors_by_id(self.project)
        legs = []
        total = 0.0
        for leg in self.legs:
            points = leg["points"] if len(leg["points"]) > 1 else leg["points"] * 2
            oblique_pair = len(points) == 2 and math.dist(*points) > 30 and min(
                abs(points[0][0] - points[1][0]), abs(points[0][1] - points[1][1])) > 5
            grid = grid_for(self.project, leg["floorId"]) if len(points) > 2 or oblique_pair else None
            if grid:
                walls, openings = _grid_geometry(grid)
                raw = _simplify(points)
                points = _center_in_corridors(raw, grid, walls, openings)
                # Centring must not cost real distance: past +8% over the raw route walked at
                # right angles, keep the raw route and only square it.
                manhattan = sum(abs(b[0] - a[0]) + abs(b[1] - a[1]) for a, b in zip(raw, raw[1:]))
                if _plen(points) > 1.08 * manhattan:
                    squared = _orthogonalize(raw, grid, walls, openings)
                    if _plen(squared) < _plen(points):
                        points = squared
                # Centring / line-of-sight pulls (door vias) can leave an oblique or wall-touching
                # segment: take the first clean candidate, else the first that clears every wall.
                def _hits(pts):
                    return any(_segment_hits_wall(p, q, walls, openings) for p, q in zip(pts, pts[1:]))

                def _oblique(pts):
                    return any(math.dist(p, q) > 30 and min(abs(p[0] - q[0]), abs(p[1] - q[1])) > 5
                               for p, q in zip(pts, pts[1:]))
                if _hits(points) or _oblique(points):
                    pool = [points, _orthogonalize(points, grid, walls, openings), _orthogonalize(raw, grid, walls, openings), raw]
                    points = next((c for c in pool if not _hits(c) and not _oblique(c)), None) \
                        or next((c for c in pool if not _hits(c)), points)
                expanded = [points[0]]
                for p, q in zip(points, points[1:]):
                    crossings = []
                    for opening in openings:
                        if not _path_uses_door([p, q], opening):
                            continue
                        ox, oy = opening["x"], opening["y"]
                        a = -(p[0] - ox) * opening["uy"] + (p[1] - oy) * opening["ux"]
                        b = -(q[0] - ox) * opening["uy"] + (q[1] - oy) * opening["ux"]
                        t = a / (a - b)
                        if 0 < t < 1:
                            crossings.append((t, (p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]))))
                    expanded.extend(crossing for _, crossing in sorted(crossings))
                    expanded.append(q)
                points = expanded
            floor = floors.get(leg["floorId"]) or {}
            length = _polyline_length(points)
            total += length
            legs.append({
                "floorId": leg["floorId"],
                "floorName": str(floor.get("name") or leg["floorId"]),
                "lengthCm": round(length),
                "polyline": [{"x": round(x, 1), "y": round(y, 1)} for x, y in points],
                "usedDoorIds": [
                    opening["id"] for opening in _openings(floor)
                    if opening.get("id") and _path_uses_door(points, opening)
                ],
            })
        first = legs[0]
        return {
            "ok": True,
            "lengthCm": round(total),
            "polyline": first["polyline"],
            "usedDoorIds": first["usedDoorIds"],
            "floorId": first["floorId"],
            "crossFloor": len(legs) > 1,
            "legs": legs,
            "transfers": self.transfers,
        }


# MapDocument units are openPlan centimetres divided by this factor so scene3d
# wall height / walk speed stay in the same ballpark as Maker PDF maps.
MAP_UNIT_CM = 5.0

_FACILITY_RULES = (
    (("无障碍卫生间", "无障碍厕所", "accessible"), "accessible-restroom"),
    (("卫生间", "厕所", "洗手间", "wc", "toilet", "restroom"), "restroom"),
    (("电梯", "升降机"), "elevator"),
    (("扶梯", "自动扶梯"), "escalator"),
    (("楼梯",), "stairs"),
    (("入口", "出口", "大门", "entrance", "exit"), "entrance"),
    (("药房", "取药"), "pharmacy"),
    (("便利店", "商店", "咖啡"), "shop"),
    (("咨询", "服务台", "问询", "导诊", "挂号"), "service"),
)


def _category(name: str) -> str:
    text = str(name or "").strip().lower()
    if not text:
        return "room"
    for needles, category in _FACILITY_RULES:
        if any(needle in text for needle in needles):
            return category
    return "room"


def _hex_rgb(value, fallback=(0.863, 0.863, 0.863)):
    if not isinstance(value, str) or not value.startswith("#"):
        return list(fallback)
    hex_color = value[1:]
    if len(hex_color) == 3:
        hex_color = "".join(ch * 2 for ch in hex_color)
    if len(hex_color) != 6:
        return list(fallback)
    try:
        return [int(hex_color[i : i + 2], 16) / 255.0 for i in (0, 2, 4)]
    except ValueError:
        return list(fallback)


def _norm(bounds, x, y):
    min_x, min_y, max_x, max_y = bounds
    span_x = max(1.0, max_x - min_x)
    span_y = max(1.0, max_y - min_y)
    return [
        round((float(x) - min_x) / span_x, 6),
        round((float(y) - min_y) / span_y, 6),
    ]


def map_document(project: dict, floor_id: str | None = None) -> dict:
    """Build a Maker-compatible MapDocument from one openPlan floor."""
    floor = select_floor(project, floor_id)
    walls = _walls(floor)
    floors = [
        {"id": item.get("id") or "", "name": item.get("name") or item.get("id") or "楼层"}
        for item in project.get("floors") or []
        if isinstance(item, dict)
    ]
    empty = {
        "schemaVersion": "1.0.0",
        "id": project.get("id") or "openplan",
        "name": project.get("name") or "未命名",
        "status": "empty",
        "floorId": floor.get("id") or "",
        "floor": {
            "id": floor.get("id") or "",
            "code": floor.get("name") or floor.get("id") or "",
            "name": floor.get("name") or floor.get("id") or "楼层",
            "description": "openPlan 单层",
        },
        "floors": floors,
        "source": {
            "sourceKind": "openplan",
            "pdfSize": [100, 100],
            "imageSize": [100, 100],
        },
        "calibration": {"metersPerMapUnit": MAP_UNIT_CM / 100.0, "source": "openplan-cm"},
        "geometry": {
            "buildingBoundary": [[0, 0], [1, 0], [1, 1], [0, 1]],
            "obstacles": [],
            "wallSegments": [],
            "clearance": 0,
        },
        "pois": [],
        "doors": [],
        "graph": {"nodes": [], "edges": []},
        "notes": "openPlan floor → MapDocument; cross-floor deferred",
        "empty": True,
        "cmBounds": None,
    }
    if len(walls) < 3:
        return empty
    bounds = _bounds(walls)
    min_x, min_y, max_x, max_y = bounds
    span_x = max(1.0, max_x - min_x)
    span_y = max(1.0, max_y - min_y)
    pdf_size = [round(span_x / MAP_UNIT_CM, 2), round(span_y / MAP_UNIT_CM, 2)]
    grid = grid_for(project, floor.get("id"))
    faces = _despike_faces(detect_closed_rooms(walls))
    rooms = [room for room in floor.get("rooms") or [] if isinstance(room, dict)]
    obstacles = []
    number = 1
    for face in faces:
        polygon = face.get("polygon") or []
        if len(polygon) < 3:
            continue
        xs = [point["x"] for point in polygon]
        ys = [point["y"] for point in polygon]
        if min(max(xs) - min(xs), max(ys) - min(ys)) < MIN_ROOM_CM:
            continue
        room = _match_room(face, rooms)
        room_id = str(room.get("id") or f"face-{number}") if room else f"face-{number}"
        color = _room_fill_color(room, number - 1)
        obstacles.append({
            "id": room_id,
            "kind": "room",
            "color": _hex_rgb(color),
            "fillColor": color,
            "polygon": [_norm(bounds, point["x"], point["y"]) for point in polygon],
            "sourceObject": "openplan-room",
        })
        number += 1
    wall_segments = []
    if not obstacles:
        wall_segments = [
            [
                _norm(bounds, wall["start"]["x"], wall["start"]["y"]),
                _norm(bounds, wall["end"]["x"], wall["end"]["y"]),
            ]
            for wall in walls
        ]
    doors = []
    for index, opening in enumerate(_openings(floor)):
        doors.append({
            "id": f"door-{index + 1}",
            "position": _norm(bounds, opening["x"], opening["y"]),
            "widthMapUnits": round(float(opening["width"]) / MAP_UNIT_CM, 2),
            "provenance": "openplan-door",
        })
    destinations = list(grid.destinations) if grid else []
    pois = []
    nodes = []
    for dest in destinations:
        category = _category(dest.get("name"))
        position = _norm(bounds, dest["x"], dest["y"])
        poi_id = str(dest.get("id") or f"poi-{len(pois) + 1}")
        node_id = f"poi:{poi_id}"
        pois.append({
            "id": poi_id,
            "name": dest.get("name") or poi_id,
            "category": category,
            "position": position,
            "labelPosition": position,
            "roomId": poi_id,
            "nodeId": node_id,
            "floorId": floor.get("id") or "",
            "anchorStatus": "visible",
            "fillColor": dest.get("color"),
        })
        nodes.append({"id": node_id, "position": position, "kind": "poi"})
    boundary = [[0, 0], [1, 0], [1, 1], [0, 1]]
    return {
        "schemaVersion": "1.0.0",
        "id": project.get("id") or "openplan",
        "name": project.get("name") or "未命名",
        "status": "ready",
        "floorId": floor.get("id") or "",
        "floor": {
            "id": floor.get("id") or "",
            "code": floor.get("name") or floor.get("id") or "",
            "name": floor.get("name") or floor.get("id") or "楼层",
            "description": "openPlan 单层",
        },
        "floors": floors,
        "source": {
            "sourceKind": "openplan",
            "pdfSize": pdf_size,
            "imageSize": pdf_size,
        },
        "calibration": {
            "metersPerMapUnit": MAP_UNIT_CM / 100.0,
            "source": "openplan-cm",
        },
        "geometry": {
            "buildingBoundary": boundary,
            "obstacles": obstacles,
            "wallSegments": [],
            "clearance": 0,
        },
        "pois": pois,
        "doors": doors,
        "graph": {"nodes": nodes, "edges": []},
        "notes": "openPlan floor → MapDocument; cross-floor deferred",
        "empty": False,
        "cmBounds": {
            "minX": round(min_x, 1),
            "minY": round(min_y, 1),
            "maxX": round(max_x, 1),
            "maxY": round(max_y, 1),
        },
        "mapUnitCm": MAP_UNIT_CM,
    }


def to_normalized(doc: dict, x_cm: float, y_cm: float):
    bounds = doc.get("cmBounds")
    if not bounds:
        return None
    return _norm(
        (bounds["minX"], bounds["minY"], bounds["maxX"], bounds["maxY"]),
        x_cm,
        y_cm,
    )

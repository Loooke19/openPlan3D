"""Vector CAD PDF → openPlan3D Project JSON + Maker-style display document.

Scale comes from a ruler segment in PDF points and a real length in millimetres.
openPlan coordinates are centimetres, y downward (same as PDF user space).
Display geometry stays in normalized page coordinates for preview/scene3d.js.
Navigation graph is left empty.
"""
from __future__ import annotations

import math
import os
import re
import uuid
from datetime import datetime, timezone

import numpy as np

from maker_cad import (
    CAD_BODY_INSET,
    _covered_intervals,
    _wall_run_clusters,
    cad_structure_rooms,
    load_cad_vector_content,
)

WALL_COLOR = "#e2e6e3"
WALL_TEXTURE = "hospital-wall"
WALL_HEIGHT_CM = 280.0
MIN_THICK_PT = float(__import__("os").environ.get("OP_MIN_THICK_PT", "1.4"))
MAX_THICK_PT = float(__import__("os").environ.get("OP_MAX_THICK_PT", "18.0"))
MIN_OVERLAP_PT = float(__import__("os").environ.get("OP_MIN_OVERLAP_PT", "20.0"))
MIN_RUN_PT = 8.0
HEAL_PT = 14.0
ROOM_COLORS = ("#dce8df", "#dce7ee", "#e7e3ee", "#eee5d5", "#f0e4d3", "#cbdedc")
# openPlan joins endpoints within 5cm. Stay under that after rounding.
_JOIN_CM = 4.5
# Collinear breaks up to a wide door opening become one wall so the room loop closes.
_BRIDGE_CM = 240.0
_LATERAL_CM = 8.0
# A break wider than any door is a corridor crossing the wall line; one this
# wide with perpendicular walls at both ends is one too.
_DOOR_MAX_CM = 200.0
_CORRIDOR_MIN_CM = 120.0
_CAP_CM = 40.0
# Corner gaps are about one wall thickness in centimetres (the centerline stops at the face).
_EXTEND_MIN_CM = 200.0
_EXTEND_MAX_CM = 320.0
_SLIVER_CM = 100.0


def cm_per_point(length_pt: float, length_mm: float) -> float:
    if length_pt <= 1.0 or length_mm <= 0:
        raise ValueError("ruler")
    return (length_mm / 10.0) / length_pt


def floor_meta(name: str | None) -> tuple[str, int]:
    text = re.sub(r"\s+", " ", (name or "").strip())[:40] or "1F"
    match = re.search(r"(\d+)", text)
    level = max(0, int(match.group(1)) - 1) if match else 0
    return text, level


def _body_crop(page_size, inset=CAD_BODY_INSET):
    width, height = page_size
    x0, y0, x1, y1 = inset
    return {
        "x": width * x0,
        "y": height * y0,
        "width": width * (x1 - x0),
        "height": height * (y1 - y0),
    }


def _clip_segments(segments, crop, pad=12.0):
    if segments is None or len(segments) == 0:
        return np.zeros((0, 5))
    x0 = crop["x"] - pad
    y0 = crop["y"] - pad
    x1 = crop["x"] + crop["width"] + pad
    y1 = crop["y"] + crop["height"] + pad
    kept = []
    for row in segments:
        mx = (float(row[0]) + float(row[2])) / 2
        my = (float(row[1]) + float(row[3])) / 2
        if x0 <= mx <= x1 and y0 <= my <= y1:
            kept.append((float(row[0]), float(row[1]), float(row[2]), float(row[3]), float(row[4])))
    if not kept:
        return np.zeros((0, 5))
    return np.array(kept, dtype=float)


def _free_spans(used, lo, hi):
    """Parts of [lo, hi] that are not already paired."""
    free = [(lo, hi)]
    for a, b in used:
        nxt = []
        for x0, x1 in free:
            if b <= x0 or a >= x1:
                nxt.append((x0, x1))
                continue
            if a > x0:
                nxt.append((x0, a))
            if b < x1:
                nxt.append((b, x1))
        free = nxt
    return [(a, b) for a, b in free if b - a >= MIN_RUN_PT]


def centerlines_from_segments(segments, boundary=None) -> list[tuple[float, float, float, float, float]]:
    """Axis-aligned double-line pairs → (x0, y0, x1, y1, thickness_pt).

    A stroke at one coordinate can be the face of different walls along its
    length. Pair each overlap on its own, so a long run elsewhere cannot
    consume the whole stroke and drop a shorter room wall.
    """
    if segments is None or len(segments) == 0:
        return []
    pairs = []
    thin = []
    for vertical in (True, False):
        clusters = _wall_run_clusters(segments, vertical=vertical)
        runs = []
        for fi, pieces in clusters:
            for a0, a1 in _covered_intervals(pieces):
                if a1 - a0 >= MIN_RUN_PT:
                    runs.append((fi, a0, a1))
        runs.sort(key=lambda item: item[0])
        for i, (fi, a0, a1) in enumerate(runs):
            for j in range(i + 1, len(runs)):
                fj, b0, b1 = runs[j]
                thick = abs(fj - fi)
                if thick < MIN_THICK_PT:
                    continue
                if thick > MAX_THICK_PT:
                    break
                lo, hi = max(a0, b0), min(a1, b1)
                if hi - lo < MIN_OVERLAP_PT:
                    continue
                pairs.append((hi - lo, vertical, i, j, (fi + fj) / 2, thick, lo, hi))
        # Thin partitions (glazed / light walls) are drawn as 2–4 strokes 1–3 pt apart; the
        # cluster merge fuses them into one run, so they never pair. Recover them from the spread.
        for fi, pieces in clusters:
            thin.extend((vertical, fixed, lo, hi, spread) for fixed, lo, hi, spread in _thin_partition_runs(pieces))
    pairs.sort(key=lambda item: item[0], reverse=True)
    used = {}
    raw = []
    for _overlap, vertical, i, j, fixed, thick, lo, hi in pairs:
        left = _free_spans(used.get((vertical, i), ()), lo, hi)
        right = _free_spans(used.get((vertical, j), ()), lo, hi)
        for a0, a1 in left:
            for b0, b1 in right:
                start, end = max(a0, b0), min(a1, b1)
                if end - start < MIN_RUN_PT:
                    continue
                used.setdefault((vertical, i), []).append((start, end))
                used.setdefault((vertical, j), []).append((start, end))
                if vertical:
                    raw.append((fixed, start, fixed, end, thick))
                else:
                    raw.append((start, fixed, end, fixed, thick))
    for vertical, fixed, lo, hi, spread in thin:
        mid = (fixed, (lo + hi) / 2) if vertical else ((lo + hi) / 2, fixed)
        if boundary and len(boundary) >= 3 and not (
                _point_in_poly(mid[0], mid[1], boundary) and _dist_to_poly(mid[0], mid[1], boundary) >= THIN_INSET_PT):
            continue  # facade edges (canopy, planter curb, steps) are not interior partitions
        spans = [(lo, hi)]
        for x0, y0, x1, y1, thick in raw:  # a paired wall already covers this stroke bundle
            if vertical != (abs(x1 - x0) < abs(y1 - y0)):
                continue
            f = (x0 + x1) / 2 if vertical else (y0 + y1) / 2
            if abs(f - fixed) > thick / 2 + spread / 2 + 1.0:
                continue
            a, b = sorted((y0, y1) if vertical else (x0, x1))
            spans = [piece for s0, s1 in spans for piece in ((s0, min(s1, a)), (max(s0, b), s1)) if piece[1] - piece[0] >= MIN_OVERLAP_PT]
        for a, b in spans:
            if b - a <= THIN_GAP_MAX_PT and _fills_wall_gap(raw, vertical, fixed, spread, a, b):
                continue  # door-leaf / frame strokes inside the door break of a real wall
            raw.append((fixed, a, fixed, b, spread) if vertical else (a, fixed, b, fixed, spread))
    return _heal_and_split(raw)


THIN_SOLID_PT = 25.0  # one unbroken stroke at least this long (≈90 cm at 1:100)
THIN_INSET_PT = 15.0  # recovered thin partitions must lie this far inside the footprint
THIN_MIN_STROKES = 2  # strokes of one fused cluster that overlap along the run and sit ≥ MIN_THICK_PT apart


THIN_GAP_MAX_PT = 45.0  # a thin run this short between two collinear wall ends is a door break


def _fills_wall_gap(raw, vertical, fixed, spread, lo, hi, tol=3.0):
    """A paired wall on the same line ends at ``lo`` AND another starts at ``hi``."""
    left = right = False
    for x0, y0, x1, y1, thick in raw:
        if vertical != (abs(x1 - x0) < abs(y1 - y0)):
            continue
        f = (x0 + x1) / 2 if vertical else (y0 + y1) / 2
        if abs(f - fixed) > thick / 2 + spread / 2 + 1.0:
            continue
        a, b = sorted((y0, y1) if vertical else (x0, x1))
        left = left or abs(b - lo) <= tol
        right = right or abs(a - hi) <= tol
    return left and right


def _thin_partition_runs(pieces):
    """Spans where ≥2 distinct parallel strokes of one fused cluster overlap → (fixed, lo, hi, spread).

    Clusters fuse by fixed coordinate over the whole sheet, so a stray stroke elsewhere (text,
    hatch) can chain two wall faces into one cluster; the faces are still told apart here.
    """
    # Only solid strokes: dashed axis / hidden lines come as many short dashes and must not
    # pair with the wall face they run along.
    pieces = [piece for piece in pieces if piece[1] - piece[0] >= THIN_SOLID_PT]
    events = sorted({p for a, b, _f in pieces for p in (a, b)})
    out = []
    for a, b in zip(events, events[1:]):
        if b - a < 0.5:
            continue
        m = (a + b) / 2
        lines = sorted({round(f, 1) for s0, s1, f in pieces if s0 - 0.3 <= m <= s1 + 0.3})
        if len(lines) < THIN_MIN_STROKES or not MIN_THICK_PT <= lines[-1] - lines[0] <= MAX_THICK_PT:
            continue
        spread, fixed = lines[-1] - lines[0], (lines[-1] + lines[0]) / 2
        if out and abs(out[-1][0] - fixed) < 0.6 and a - out[-1][2] <= 0.6:
            out[-1] = (out[-1][0], out[-1][1], b, max(out[-1][3], spread))
        else:
            out.append((fixed, a, b, spread))
    return [item for item in out if item[2] - item[1] >= MIN_OVERLAP_PT]


def _as_axes(lines):
    horiz, vert = [], []
    for x0, y0, x1, y1, thick in lines:
        if abs(y1 - y0) <= abs(x1 - x0):
            a, b = sorted((x0, x1))
            if b - a >= MIN_RUN_PT:
                horiz.append([a, (y0 + y1) / 2, b, thick])
        else:
            a, b = sorted((y0, y1))
            if b - a >= MIN_RUN_PT:
                vert.append([(x0 + x1) / 2, a, b, thick])
    return horiz, vert


def _heal(horiz, vert, snap=HEAL_PT):
    for _ in range(2):
        for h in horiz:
            y = h[1]
            for index in (0, 2):
                x = h[index]
                best = None
                for v in vert:
                    dx = abs(v[0] - x)
                    if dx > snap:
                        continue
                    if v[1] - snap <= y <= v[2] + snap and (best is None or dx < best[0]):
                        best = (dx, v)
                if not best:
                    continue
                v = best[1]
                h[index] = v[0]
                v[1] = min(v[1], y)
                v[2] = max(v[2], y)
        for v in vert:
            x = v[0]
            for index in (1, 2):
                y = v[index]
                best = None
                for h in horiz:
                    dy = abs(h[1] - y)
                    if dy > snap:
                        continue
                    if h[0] - snap <= x <= h[2] + snap and (best is None or dy < best[0]):
                        best = (dy, h)
                if not best:
                    continue
                h = best[1]
                v[index] = h[1]
                h[0] = min(h[0], x)
                h[2] = max(h[2], x)


def _heal_and_split(lines):
    horiz, vert = _as_axes(lines)
    _heal(horiz, vert)
    for h in horiz:
        cuts = [h[0], h[2]]
        for v in vert:
            if h[0] - 0.5 <= v[0] <= h[2] + 0.5 and v[1] - 0.5 <= h[1] <= v[2] + 0.5:
                cuts.append(min(h[2], max(h[0], v[0])))
        h.append(sorted(set(round(c, 2) for c in cuts)))
    for v in vert:
        cuts = [v[1], v[2]]
        for h in horiz:
            if v[1] - 0.5 <= h[1] <= v[2] + 0.5 and h[0] - 0.5 <= v[0] <= h[2] + 0.5:
                cuts.append(min(v[2], max(v[1], h[1])))
        v.append(sorted(set(round(c, 2) for c in cuts)))
    out = []
    for x0, y, x1, thick, cuts in horiz:
        pts = [c for c in cuts if x0 - 0.01 <= c <= x1 + 0.01]
        for a, b in zip(pts, pts[1:]):
            if b - a >= MIN_RUN_PT:
                out.append((a, y, b, y, thick))
    for x, y0, y1, thick, cuts in vert:
        pts = [c for c in cuts if y0 - 0.01 <= c <= y1 + 0.01]
        for a, b in zip(pts, pts[1:]):
            if b - a >= MIN_RUN_PT:
                out.append((x, a, x, b, thick))
    return out


def _norm(x, y, size):
    return [round(x / size[0], 6), round(y / size[1], 6)]


def _attach_doors(doors, lines, scale, boundary=None):
    attached = []
    for door in doors:
        mid = door.get("mid") or door.get("center")
        if not mid:
            continue
        mx, my = float(mid[0]), float(mid[1])
        horizontal = abs(float(door.get("axis", [1, 0])[0])) > 0.5
        best = None
        for index, (x0, y0, x1, y1, thick) in enumerate(lines):
            wall_h = abs(y1 - y0) <= abs(x1 - x0)
            if wall_h != horizontal:
                continue
            if wall_h:
                a, b = (x0, x1) if x0 <= x1 else (x1, x0)
                y = (y0 + y1) / 2
                lateral = abs(my - y)
                beyond = max(a - mx, mx - b, 0.0)
                span = b - a
                along = 0.0 if span <= 0 else (min(b, max(a, mx)) - a) / span
            else:
                a, b = (y0, y1) if y0 <= y1 else (y1, y0)
                x = (x0 + x1) / 2
                lateral = abs(mx - x)
                beyond = max(a - my, my - b, 0.0)
                span = b - a
                along = 0.0 if span <= 0 else (min(b, max(a, my)) - a) / span
            width = float(door.get("width") or 20)
            limit_cm = 25 if door.get("source") == "cad-wall-gap" else 45
            if lateral * scale > limit_cm or beyond * scale > width * scale / 2 + 10:
                continue
            if boundary and len(boundary) >= 3:
                px = min(b, max(a, mx)) if wall_h else (x0 + x1) / 2
                py = (y0 + y1) / 2 if wall_h else min(b, max(a, my))
                nx, ny = (0, 25) if wall_h else (25, 0)
                if not (_point_in_poly(px + nx, py + ny, boundary) and _point_in_poly(px - nx, py - ny, boundary)):
                    if lateral > max(10.0, thick * 1.6) or beyond > 3:
                        continue
            dist = math.hypot(lateral, beyond)
            if best is None or dist < best[0]:
                best = (dist, index, along, span)
        if not best:
            continue
        _dist, index, along, span = best
        width_cm = max(60.0, min(220.0, float(door.get("width") or 20) * scale))
        wall_cm = span * scale
        if wall_cm < width_cm + 20:
            width_cm = max(60.0, wall_cm * 0.45)
        kind = "double" if door.get("double") else "opening" if door.get("source") == "cad-wall-gap" else "single"
        attached.append({
            "wallIndex": index,
            "position": round(min(0.92, max(0.08, along)), 4),
            "width": round(width_cm, 1),
            "type": kind,
        })
    return attached


def attach_missing_pdf_doors(floor, candidates):
    walls = [w for w in floor.get("walls") or [] if w.get("height", 1) > 0]
    lines = [(w["start"]["x"], w["start"]["y"], w["end"]["x"], w["end"]["y"], w.get("thickness", 12)) for w in walls]
    boundary = [(p["x"], p["y"]) for p in floor.get("footprint") or []]
    existing = []
    by_id = {w["id"]: w for w in walls}
    for door in floor.get("doors") or []:
        wall = by_id.get(door.get("wallId"))
        if wall:
            t = door["position"]
            existing.append((wall["start"]["x"] * (1 - t) + wall["end"]["x"] * t,
                             wall["start"]["y"] * (1 - t) + wall["end"]["y"] * t))
    next_id = max((int(door["id"].split("-")[-1]) for door in floor.get("doors") or []
                   if door.get("id", "").split("-")[-1].isdigit()), default=0)
    for candidate in candidates:
        x, y = candidate["mid"]
        if any(math.hypot(x - dx, y - dy) <= max(80, candidate["width"] * 0.75) for dx, dy in existing):
            continue
        attached = _attach_doors([candidate], lines, 1, boundary)
        if not attached:
            continue
        fit = attached[0]
        wall = walls[fit["wallIndex"]]
        dx = wall["end"]["x"] - wall["start"]["x"]
        dy = wall["end"]["y"] - wall["start"]["y"]
        length = math.hypot(dx, dy)
        px = wall["start"]["x"] + dx * fit["position"]
        py = wall["start"]["y"] + dy * fit["position"]
        if boundary and not (_point_in_poly(px - dy / length * 80, py + dx / length * 80, boundary)
                             and _point_in_poly(px + dy / length * 80, py - dx / length * 80, boundary)):
            continue
        next_id += 1
        floor["doors"].append({"id": f"door-{next_id}", "wallId": wall["id"],
                               "position": fit["position"], "width": fit["width"], "height": 210,
                               "type": fit["type"], "swingDirection": "left", "flipSide": False})
        existing.append((px, py))


def _walls_cm(lines, scale):
    walls = []
    for index, (x0, y0, x1, y1, thick) in enumerate(lines):
        length = math.hypot(x1 - x0, y1 - y0) * scale
        if length < 20:
            continue
        walls.append({
            "id": f"wall-{index + 1}",
            "start": {"x": round(x0 * scale, 2), "y": round(y0 * scale, 2)},
            "end": {"x": round(x1 * scale, 2), "y": round(y1 * scale, 2)},
            "thickness": round(max(10.0, min(40.0, thick * scale)), 2),
            "height": WALL_HEIGHT_CM,
            "color": WALL_COLOR,
            "interiorColor": WALL_COLOR,
            "exteriorColor": WALL_COLOR,
            "texture": WALL_TEXTURE,
            "interiorTexture": WALL_TEXTURE,
            "exteriorTexture": WALL_TEXTURE,
            "_index": index,
        })
    return walls


def merge_overlapping_walls(walls, doors=(), rooms=()):
    """Union collinear overlaps and door-spanning joins, preserving door coordinates."""
    parent = list(range(len(walls)))
    original = {w["id"]: (dict(w["start"]), dict(w["end"])) for w in walls}
    door_hosts = {}
    for door in doors:
        door_hosts.setdefault(door["wallId"], []).append(door)

    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, a in enumerate(walls):
        ax, ay = a["start"]["x"], a["start"]["y"]
        dx, dy = a["end"]["x"] - ax, a["end"]["y"] - ay
        length = math.hypot(dx, dy)
        ux, uy = dx / length, dy / length
        for j in range(i + 1, len(walls)):
            b = walls[j]
            bx, by = b["start"]["x"], b["start"]["y"]
            ex, ey = b["end"]["x"], b["end"]["y"]
            if abs((bx - ax) * uy - (by - ay) * ux) > 0.05 or abs((ex - ax) * uy - (ey - ay) * ux) > 0.05:
                continue
            lo, hi = sorted(((bx - ax) * ux + (by - ay) * uy, (ex - ax) * ux + (ey - ay) * uy))
            overlap = min(length, hi) - max(0, lo)
            spans_join = False
            if abs(overlap) <= 0.05:
                for host in (a, b):
                    start, end = original[host["id"]]
                    for door in door_hosts.get(host["id"], ()):
                        x = start["x"] + door["position"] * (end["x"] - start["x"])
                        y = start["y"] + door["position"] * (end["y"] - start["y"])
                        center = (x - ax) * ux + (y - ay) * uy
                        left, right = center - door["width"] / 2, center + door["width"] / 2
                        if min(right, length) - max(left, 0) > 10 and min(right, hi) - max(left, lo) > 10:
                            spans_join = True
            if overlap > 0.05 or spans_join:
                parent[root(j)] = root(i)

    groups = {}
    for i, wall in enumerate(walls):
        groups.setdefault(root(i), []).append(wall)
    result, replacements = [], {}
    for members in groups.values():
        keeper = members[0]
        ax, ay = keeper["start"]["x"], keeper["start"]["y"]
        dx, dy = keeper["end"]["x"] - ax, keeper["end"]["y"] - ay
        length = math.hypot(dx, dy)
        ux, uy = dx / length, dy / length
        extent = [(p["x"] - ax) * ux + (p["y"] - ay) * uy for w in members for p in (w["start"], w["end"])]
        lo, hi = min(extent), max(extent)
        for wall in members:
            replacements[wall["id"]] = (keeper["id"], ax, ay, ux, uy, lo, hi)
        if len(members) > 1:
            keeper["start"] = {"x": round(ax + lo * ux, 2), "y": round(ay + lo * uy, 2)}
            keeper["end"] = {"x": round(ax + hi * ux, 2), "y": round(ay + hi * uy, 2)}
            keeper["thickness"] = max(w["thickness"] for w in members)
        result.append(keeper)
    for door in doors:
        start, end = original[door["wallId"]]
        x = start["x"] + door["position"] * (end["x"] - start["x"])
        y = start["y"] + door["position"] * (end["y"] - start["y"])
        door["wallId"], ax, ay, ux, uy, lo, hi = replacements[door["wallId"]]
        door["position"] = round(((x - ax) * ux + (y - ay) * uy - lo) / (hi - lo), 4)
    for room in rooms:
        room["walls"] = list(dict.fromkeys(replacements[wid][0] for wid in room["walls"]))
    return result


def _point_in_poly(x, y, poly):
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi):
            inside = not inside
        j = i
    return inside


def _dist_to_poly(x, y, poly):
    best = 1e9
    for i in range(len(poly)):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % len(poly)]
        dx, dy = x1 - x0, y1 - y0
        length_sq = dx * dx + dy * dy
        t = 0.0 if length_sq <= 1e-9 else max(0.0, min(1.0, ((x - x0) * dx + (y - y0) * dy) / length_sq))
        best = min(best, math.hypot(x - (x0 + t * dx), y - (y0 + t * dy)))
    return best


def _inside_footprint(x_pt, y_pt, boundary, pad=18.0):
    if not boundary or len(boundary) < 3:
        return True
    if _point_in_poly(x_pt, y_pt, boundary):
        return True
    return _dist_to_poly(x_pt, y_pt, boundary) <= pad


def _as_cm_segments(lines, scale):
    segments = []
    for x0, y0, x1, y1, thick in lines:
        ax, ay, bx, by = x0 * scale, y0 * scale, x1 * scale, y1 * scale
        if math.hypot(bx - ax, by - ay) < 15:
            continue
        horizontal = abs(by - ay) <= abs(bx - ax)
        if horizontal:
            if bx < ax:
                ax, bx = bx, ax
            ay = by = (ay + by) / 2
        else:
            if by < ay:
                ay, by = by, ay
            ax = bx = (ax + bx) / 2
        segments.append({
            "a": ax, "b": ay, "c": bx, "d": by,
            "thick": max(8.0, thick * scale),
            "h": horizontal,
        })
    return segments


def _capped(x, y, horizontal, cross):
    """A perpendicular wall passes the run end at (x, y)."""
    for seg in cross:
        if horizontal:
            if abs(seg["a"] - x) <= _CAP_CM and seg["b"] - _CAP_CM <= y <= seg["d"] + _CAP_CM:
                return True
        elif abs(seg["b"] - y) <= _CAP_CM and seg["a"] - _CAP_CM <= x <= seg["c"] + _CAP_CM:
            return True
    return False


_OPEN_FROM_ROUND = 2  # rounds before this stretch targets only by _TARGET_SLACK_CM
_TARGET_SLACK_CM = 40.0  # corner stretch of the target wall that is always allowed


def _merge_axis(segments, horizontal, cross=(), opening_gaps=None, scale=1.0, boundary=None, stairs=(), doors=()):
    """Join collinear runs across door breaks.

    A break wider than a door, or capped by perpendicular walls at both ends,
    is a corridor crossing the wall line and stays open.
    """
    if not segments:
        return []
    parent = list(range(len(segments)))

    def find(index):
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(i, j):
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[rj] = ri

    fixed = [((seg["b"] if horizontal else seg["a"])) for seg in segments]
    for i in range(len(segments)):
        for j in range(i + 1, len(segments)):
            if abs(fixed[i] - fixed[j]) <= _LATERAL_CM:
                union(i, j)
    groups = {}
    for index, seg in enumerate(segments):
        groups.setdefault(find(index), []).append(seg)
    merged = []
    for group in groups.values():
        group.sort(key=lambda seg: seg["a"] if horizontal else seg["b"])
        run = dict(group[0])
        for seg in group[1:]:
            if horizontal:
                gap = seg["a"] - run["c"]
                same = abs(seg["b"] - run["b"]) <= _LATERAL_CM
            else:
                gap = seg["b"] - run["d"]
                same = abs(seg["a"] - run["a"]) <= _LATERAL_CM
            corridor = gap > _DOOR_MAX_CM
            opening = False
            if opening_gaps is not None and same and 70 <= gap <= 180:
                x = (run["c"] + seg["a"]) / 2 if horizontal else run["a"]
                y = run["b"] if horizontal else (run["d"] + seg["b"]) / 2
                px, py = x / scale, y / scale
                ends_capped = (_capped(run["c"] if horizontal else run["a"], run["b"] if horizontal else run["d"], horizontal, cross)
                               and _capped(seg["a"], seg["b"], horizontal, cross))
                near_door = any((abs(float(d.get("axis", [1, 0])[0])) > 0.5) == horizontal
                                and math.hypot(px - (d.get("mid") or d.get("center"))[0],
                                               py - (d.get("mid") or d.get("center"))[1]) <= gap / scale / 2 + 12
                                for d in doors if d.get("mid") or d.get("center"))
                in_stair = any(_dist_to_poly(px, py, stair.get("polygonPdf") or []) <= 12
                               for stair in stairs if len(stair.get("polygonPdf") or []) >= 3)
                backed = any(8 < abs((other["b"] if horizontal else other["a"]) - (run["b"] if horizontal else run["a"])) < 50
                             and (other["a"] if horizontal else other["b"]) <= (run["c"] if horizontal else run["d"]) + 10
                             and (other["c"] if horizontal else other["d"]) >= (seg["a"] if horizontal else seg["b"]) - 10
                             for other in segments)
                left_run = (run["c"] - run["a"]) if horizontal else (run["d"] - run["b"])
                right_run = (seg["c"] - seg["a"]) if horizontal else (seg["d"] - seg["b"])
                wall_heads = min(left_run, right_run) >= max(70, gap * 0.8)
                opening = ((ends_capped or near_door or wall_heads) and not in_stair and not backed
                           and (not boundary or (_point_in_poly(px, py, boundary) and _dist_to_poly(px, py, boundary) >= 25)))
                if opening:
                    opening_gaps.append({"mid": [px, py], "axis": [1, 0] if horizontal else [0, 1],
                                         "width": gap / scale, "source": "cad-wall-gap"})
            if same and not corridor and gap >= _CORRIDOR_MIN_CM:
                if horizontal:
                    corridor = _capped(run["c"], run["b"], True, cross) and _capped(seg["a"], seg["b"], True, cross)
                else:
                    corridor = _capped(run["a"], run["d"], False, cross) and _capped(seg["a"], seg["b"], False, cross)
            if same and gap <= _BRIDGE_CM and (opening or not corridor):
                if horizontal:
                    run["c"] = max(run["c"], seg["c"])
                    run["b"] = run["d"] = (run["b"] + seg["b"]) / 2
                else:
                    run["d"] = max(run["d"], seg["d"])
                    run["a"] = run["c"] = (run["a"] + seg["a"]) / 2
                run["thick"] = max(run["thick"], seg["thick"])
            else:
                merged.append(run)
                run = dict(seg)
        merged.append(run)
    return merged


def _stretch_crosses(segments, other, along, seg):
    """Would stretching ``other`` to ``along`` cut through a wall parallel to ``seg``?"""
    if other["h"]:
        fixed, lo, hi = other["b"], other["a"], other["c"]
    else:
        fixed, lo, hi = other["a"], other["b"], other["d"]
    a, b = (along, lo) if along < lo else (hi, along)
    for wall in segments:
        if wall is seg or wall is other or wall["h"] == other["h"]:
            continue
        if other["h"]:
            pos, w0, w1 = wall["a"], wall["b"], wall["d"]
        else:
            pos, w0, w1 = wall["b"], wall["a"], wall["c"]
        if a + 1.0 < pos < b - 1.0 and w0 - 1.0 <= fixed <= w1 + 1.0:
            return True
    return False


def _extend_corners(segments):
    """Lengthen a free end onto the nearest perpendicular wall. Never shorten.

    The wall it lands on may be stretched to meet it: freely by a corner's worth
    (``_TARGET_SLACK_CM``), farther only through open space (the stretch crosses no wall).
    Stretching through walls let extensions feed each other into a grid of phantom walls in
    dense small-room blocks. The last round lifts the open-space test once.
    """
    for round_index in range(4):
        wide = round_index >= _OPEN_FROM_ROUND
        moved = False
        for seg in segments:
            limit = min(_EXTEND_MAX_CM, max(_EXTEND_MIN_CM, seg["thick"] * 3.5))
            proposals = []
            for end in ("start", "end"):
                if seg["h"]:
                    x = seg["a"] if end == "start" else seg["c"]
                    y = seg["b"]
                else:
                    x = seg["a"]
                    y = seg["b"] if end == "start" else seg["d"]
                best = None
                for other in segments:
                    if other is seg or other["h"] == seg["h"]:
                        continue
                    if seg["h"]:
                        target = other["a"]
                        if end == "start" and target >= seg["a"] - 0.5:
                            continue
                        if end == "end" and target <= seg["c"] + 0.5:
                            continue
                        dist = abs(x - target)
                        along = y
                        lo, hi = other["b"], other["d"]
                    else:
                        target = other["b"]
                        if end == "start" and target >= seg["b"] - 0.5:
                            continue
                        if end == "end" and target <= seg["d"] + 0.5:
                            continue
                        dist = abs(y - target)
                        along = x
                        lo, hi = other["a"], other["c"]
                    if dist < 0.5 or dist > limit:
                        continue
                    slack = min(limit, max(_TARGET_SLACK_CM, seg["thick"] * 2.0))
                    if along < lo - limit or along > hi + limit:
                        continue
                    stretch = max(lo - along, along - hi, 0.0)
                    if stretch > slack and (not wide or _stretch_crosses(segments, other, along, seg)):
                        continue
                    if best is None or dist < best[0]:
                        best = (dist, other, along, target)
                if best:
                    proposals.append((end, best))
            for end, (_dist, other, along, target) in proposals:
                if seg["h"]:
                    if end == "start":
                        seg["a"] = target
                    else:
                        seg["c"] = target
                    if along < other["b"]:
                        other["b"] = along
                    elif along > other["d"]:
                        other["d"] = along
                else:
                    if end == "start":
                        seg["b"] = target
                    else:
                        seg["d"] = target
                    if along < other["a"]:
                        other["a"] = along
                    elif along > other["c"]:
                        other["c"] = along
                moved = True
        if not moved:
            break
    return segments


def _snap_and_split(segments):
    # Drop an endpoint onto a wall it nearly touches before clustering.
    for seg in segments:
        for end in ("start", "end"):
            if seg["h"]:
                x = seg["a"] if end == "start" else seg["c"]
                y = seg["b"]
            else:
                x = seg["a"]
                y = seg["b"] if end == "start" else seg["d"]
            for other in segments:
                if other is seg:
                    continue
                if other["h"]:
                    if abs(y - other["b"]) > _JOIN_CM:
                        continue
                    if other["a"] + _JOIN_CM < x < other["c"] - _JOIN_CM:
                        y = other["b"]
                else:
                    if abs(x - other["a"]) > _JOIN_CM:
                        continue
                    if other["b"] + _JOIN_CM < y < other["d"] - _JOIN_CM:
                        x = other["a"]
            if seg["h"]:
                if end == "start":
                    seg["a"] = x
                else:
                    seg["c"] = x
                seg["b"] = seg["d"] = y
            else:
                seg["a"] = seg["c"] = x
                if end == "start":
                    seg["b"] = y
                else:
                    seg["d"] = y
    points = []
    for seg in segments:
        if seg["h"] and seg["c"] < seg["a"]:
            seg["a"], seg["c"] = seg["c"], seg["a"]
        if not seg["h"] and seg["d"] < seg["b"]:
            seg["b"], seg["d"] = seg["d"], seg["b"]
        points.append((seg["a"], seg["b"]))
        points.append((seg["c"], seg["d"]))
    parent = list(range(len(points)))

    def find(index):
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(i, j):
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[rj] = ri

    for i in range(len(points)):
        for j in range(i + 1, len(points)):
            if math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1]) <= _JOIN_CM:
                union(i, j)
    # Pull an endpoint onto a wall it almost touches, so T-junctions share a vertex.
    extras = {id(seg): [] for seg in segments}
    for index, (x, y) in enumerate(points):
        for seg in segments:
            if seg["h"]:
                if abs(y - seg["b"]) > _JOIN_CM:
                    continue
                lo, hi = seg["a"], seg["c"]
                if x <= lo + _JOIN_CM or x >= hi - _JOIN_CM:
                    continue
                t = (x - lo) / (hi - lo or 1)
                extras[id(seg)].append((t, find(index)))
            else:
                if abs(x - seg["a"]) > _JOIN_CM:
                    continue
                lo, hi = seg["b"], seg["d"]
                if y <= lo + _JOIN_CM or y >= hi - _JOIN_CM:
                    continue
                t = (y - lo) / (hi - lo or 1)
                extras[id(seg)].append((t, find(index)))
    clusters = {}
    for index in range(len(points)):
        root = find(index)
        clusters.setdefault(root, []).append(points[index])
    canon = {}
    for root, members in clusters.items():
        canon[root] = (
            round(sum(p[0] for p in members) / len(members), 2),
            round(sum(p[1] for p in members) / len(members), 2),
        )
    out = []
    for seg_index, seg in enumerate(segments):
        start_root = find(seg_index * 2)
        end_root = find(seg_index * 2 + 1)
        cuts = [(0.0, start_root), (1.0, end_root)]
        for t, root in extras[id(seg)]:
            cuts.append((t, root))
        cuts.sort(key=lambda item: item[0])
        seen = []
        for t, root in cuts:
            if seen and abs(t - seen[-1][0]) < 1e-4:
                continue
            seen.append((t, root))
        for (t0, r0), (t1, r1) in zip(seen, seen[1:]):
            p0, p1 = canon[r0], canon[r1]
            if math.hypot(p1[0] - p0[0], p1[1] - p0[1]) < 15:
                continue
            if seg["h"]:
                y = round((p0[1] + p1[1]) / 2, 2)
                x0, x1 = sorted((p0[0], p1[0]))
                out.append((x0, y, x1, y, seg["thick"]))
            else:
                x = round((p0[0] + p1[0]) / 2, 2)
                y0, y1 = sorted((p0[1], p1[1]))
                out.append((x, y0, x, y1, seg["thick"]))
    return out


def _keep_main_building(segments, fenced=False):
    """Drop wall groups that are not part of the building.

    ``fenced`` means the lines were already clipped to the building footprint;
    then a wing that only touches the rest through an open hall still counts.
    """
    if not segments:
        return []
    parent = list(range(len(segments)))

    def find(index):
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(i, j):
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[rj] = ri

    def touches(p, seg, tol=_JOIN_CM):
        # endpoint on (or within tol of) the other segment: corners, T-junctions and the
        # cm-level rounding left by snapping all connect, not only bit-identical endpoints
        x0, y0, x1, y1 = seg[:4]
        dx, dy = x1 - x0, y1 - y0
        length2 = dx * dx + dy * dy
        t = 0.0 if length2 == 0 else max(0.0, min(1.0, ((p[0] - x0) * dx + (p[1] - y0) * dy) / length2))
        return math.hypot(p[0] - x0 - dx * t, p[1] - y0 - dy * t) <= tol

    for i in range(len(segments)):
        a = segments[i]
        for j in range(i + 1, len(segments)):
            b = segments[j]
            if (touches(a[:2], b) or touches(a[2:4], b) or touches(b[:2], a) or touches(b[2:4], a)):
                union(i, j)
    groups = {}
    for index in range(len(segments)):
        groups.setdefault(find(index), []).append(segments[index])
    ranked = sorted(groups.values(), key=len, reverse=True)
    largest = ranked[0]

    def bbox(group):
        xs, ys = [], []
        for x0, y0, x1, y1, _t in group:
            xs += [x0, x1]
            ys += [y0, y1]
        return min(xs), min(ys), max(xs), max(ys)

    if fenced:
        return [seg for group in ranked if group is largest or len(group) > 2 for seg in group]
    lx0, ly0, lx1, ly1 = bbox(largest)
    kept = []
    for group in ranked:
        if group is largest or len(group) >= max(4, int(len(largest) * 0.12)):
            x0, y0, x1, y1 = bbox(group)
            outside = x1 < lx0 - 200 or x0 > lx1 + 200 or y1 < ly0 - 200 or y0 > ly1 + 200
            if group is not largest and (outside or len(group) <= 2):
                continue
            kept.extend(group)
        elif len(group) > 2:
            x0, y0, x1, y1 = bbox(group)
            outside = x1 < lx0 - 200 or x0 > lx1 + 200 or y1 < ly0 - 200 or y0 > ly1 + 200
            if not outside:
                kept.extend(group)
    return kept


def repair_wall_lines(lines, scale, boundary=None, opening_gaps=None, doors=(), stairs=()):
    """Close corner gaps, bridge door breaks, and drop walls outside the building.

    Coordinates stay in PDF points. Joins are decided in centimetres so they
    land inside openPlan's 5cm endpoint epsilon.
    """
    if not lines or scale <= 0:
        return []
    kept = [line for line in lines if _inside_footprint((line[0] + line[2]) / 2, (line[1] + line[3]) / 2, boundary)]
    # A tiny or shifted footprint must not erase the drawing. Only trust it
    # when it already covers most of the extracted walls.
    fenced = bool(boundary) and len(boundary) >= 3 and len(kept) >= max(4, int(len(lines) * 0.45))
    if not fenced:
        kept = list(lines)
    segments = _as_cm_segments(kept, scale)
    raw = segments
    across = [seg for seg in raw if seg["h"]]
    down = [seg for seg in raw if not seg["h"]]
    segments = _merge_axis(across, True, down, opening_gaps, scale, boundary, stairs, doors)
    segments += _merge_axis(down, False, across, opening_gaps, scale, boundary, stairs, doors)
    _extend_corners(segments)
    snapped = _snap_and_split(segments)
    snapped = _keep_main_building(snapped, fenced)
    repaired = []
    for x0, y0, x1, y1, thick in snapped:
        repaired.append((x0 / scale, y0 / scale, x1 / scale, y1 / scale, thick / scale))
    return repaired


def _shoelace(points):
    area = 0.0
    for i, point in enumerate(points):
        nxt = points[(i + 1) % len(points)]
        area += point[0] * nxt[1] - nxt[0] * point[1]
    return area / 2


_CORRIDOR_RE = re.compile(r"走廊|过道|通道|连廊|门厅|候诊")
CORRIDOR_TEXTURE = "hospital-floor"


def room_floor_texture(polygon, name=""):
    """Hospital tile for rooms and circulation; matches openPlan hospital-floor preset."""
    if _CORRIDOR_RE.search(name or ""):
        return CORRIDOR_TEXTURE
    xs = [point["x"] for point in polygon]
    ys = [point["y"] for point in polygon]
    width = max(xs) - min(xs) if xs else 0
    height = max(ys) - min(ys) if ys else 0
    minor, major = sorted((width, height))
    if minor >= 90 and major >= 480 and major / max(minor, 1) >= 2.4:
        return CORRIDOR_TEXTURE
    return "hospital-floor"


GAP_CLOSE_CM = float(__import__("os").environ.get("OP_GAP_CM", "60"))
GAP_SIDE_CM = 30.0


def close_wall_gaps(walls, max_gap=GAP_CLOSE_CM):
    """Bridge dangling wall ends to the wall they almost meet (generic segmentation repair).

    CAD partitions often stop a few cm–half a metre short of the wall they abut (pen offsets,
    hatch boundaries), so the room never closes and the face detector merges it with its
    neighbours and the corridor (P1 3F surgery block). A dangling end is extended along its own
    direction up to ``max_gap`` to the first wall it hits, or failing that joined to the nearest
    wall point within ``GAP_SIDE_CM``. Adds short bridge walls; existing walls/doors are untouched.
    """
    import math

    segs = [(w, float(w["start"]["x"]), float(w["start"]["y"]), float(w["end"]["x"]), float(w["end"]["y"])) for w in walls]

    def near(px, py, skip):
        best = (1e18, None)
        for w, ax, ay, bx, by in segs:
            if w is skip:
                continue
            dx, dy = bx - ax, by - ay
            L = dx * dx + dy * dy
            t = 0.0 if L == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L))
            qx, qy = ax + dx * t, ay + dy * t
            d = math.hypot(px - qx, py - qy)
            if d < best[0]:
                best = (d, (qx, qy))
        return best

    def ray(px, py, ux, uy, skip):
        best = None
        for w, ax, ay, bx, by in segs:
            if w is skip:
                continue
            ex, ey = bx - ax, by - ay
            den = ux * ey - uy * ex
            if abs(den) < 1e-9:
                continue
            t = ((ax - px) * ey - (ay - py) * ex) / den
            u = ((ax - px) * uy - (ay - py) * ux) / den
            if 0 < t <= max_gap and -0.01 <= u <= 1.01 and (best is None or t < best):
                best = t
        return best

    bridges = []
    n = 0
    for w, ax, ay, bx, by in segs:
        L = math.hypot(bx - ax, by - ay)
        if L < 1:
            continue
        for (px, py), (ux, uy) in (((ax, ay), ((ax - bx) / L, (ay - by) / L)), ((bx, by), ((bx - ax) / L, (by - ay) / L))):
            d, _q = near(px, py, w)
            if d <= 1.0 or d > max_gap:
                continue  # joined already, or a real opening/door gap
            t = ray(px, py, ux, uy, w)
            if t is not None:
                q = (px + ux * t, py + uy * t)
            elif d <= GAP_SIDE_CM:
                q = _q
            else:
                continue
            n += 1
            bridges.append({**{k: v for k, v in w.items() if k not in ("id", "start", "end")},
                            "id": f"{w['id']}-gap{n}", "start": {"x": round(px, 2), "y": round(py, 2)},
                            "end": {"x": round(q[0], 2), "y": round(q[1], 2)}, "gapBridge": True})
    return bridges


def _split_walls_at_junctions(walls, epsilon=5.0):
    """Cut walls where another wall ends or crosses, so each room is its own face.

    A divider that runs through a long wall is not a vertex until it is split.
    Without that cut the cycle walk skips the rooms on either side.
    """
    segments = []
    for wall in walls:
        segments.append({
            "id": wall["id"],
            "x0": float(wall["start"]["x"]),
            "y0": float(wall["start"]["y"]),
            "x1": float(wall["end"]["x"]),
            "y1": float(wall["end"]["y"]),
            "cuts": [],
        })

    def add_cut(segment, t, x, y):
        if t <= 0.004 or t >= 0.996:
            return
        for existing, _px, _py in segment["cuts"]:
            if abs(existing - t) < 1e-4:
                return
        segment["cuts"].append((t, x, y))

    points = []
    for wall in walls:
        points.append((float(wall["start"]["x"]), float(wall["start"]["y"])))
        points.append((float(wall["end"]["x"]), float(wall["end"]["y"])))
    for segment in segments:
        dx = segment["x1"] - segment["x0"]
        dy = segment["y1"] - segment["y0"]
        length_sq = dx * dx + dy * dy
        if length_sq < epsilon * epsilon:
            continue
        length = math.sqrt(length_sq)
        for x, y in points:
            if abs(x - segment["x0"]) < epsilon and abs(y - segment["y0"]) < epsilon:
                continue
            if abs(x - segment["x1"]) < epsilon and abs(y - segment["y1"]) < epsilon:
                continue
            t = ((x - segment["x0"]) * dx + (y - segment["y0"]) * dy) / length_sq
            if t <= epsilon / length or t >= 1 - epsilon / length:
                continue
            px = segment["x0"] + t * dx
            py = segment["y0"] + t * dy
            if math.hypot(x - px, y - py) < epsilon:
                add_cut(segment, t, x, y)
    for index, left in enumerate(segments):
        lax = left["x1"] - left["x0"]
        lay = left["y1"] - left["y0"]
        for right in segments[index + 1:]:
            if left["id"] == right["id"]:
                continue
            rbx = right["x1"] - right["x0"]
            rby = right["y1"] - right["y0"]
            denom = lax * rby - lay * rbx
            if abs(denom) <= 1e-6:
                continue
            qx = right["x0"] - left["x0"]
            qy = right["y0"] - left["y0"]
            t = (qx * rby - qy * rbx) / denom
            u = (qx * lay - qy * lax) / denom
            if t <= 0.004 or t >= 0.996 or u <= 0.004 or u >= 0.996:
                continue
            x = left["x0"] + t * lax
            y = left["y0"] + t * lay
            add_cut(left, t, x, y)
            add_cut(right, u, x, y)
    pieces = []
    for segment in segments:
        cuts = sorted(segment["cuts"], key=lambda item: item[0])
        chain = [(segment["x0"], segment["y0"])]
        chain.extend((x, y) for _t, x, y in cuts)
        chain.append((segment["x1"], segment["y1"]))
        for (x0, y0), (x1, y1) in zip(chain, chain[1:]):
            if math.hypot(x1 - x0, y1 - y0) < 8:
                continue
            pieces.append({
                "id": segment["id"],
                "start": {"x": x0, "y": y0},
                "end": {"x": x1, "y": y1},
            })
    return pieces


def detect_closed_rooms(walls):
    """Minimal interior faces, matching openPlan's cycle walk (y grows downward).

    Each room's ``walls`` list is the source wall ids of that face, which is
    what the editor uses to attach a floor. ``polygon`` is in the same
    centimetre space as the walls and is not part of the openPlan schema.
    Walls are split at T-junctions and crossings first, otherwise a divider
    that passes through a longer wall never becomes a room corner.
    """
    if len(walls) < 3:
        return []
    epsilon = 5.0
    verts = []

    def vid(x, y):
        for index, (px, py) in enumerate(verts):
            if abs(px - x) < epsilon and abs(py - y) < epsilon:
                return index
        verts.append((x, y))
        return len(verts) - 1

    edges = []
    for wall in _split_walls_at_junctions(walls, epsilon):
        a = vid(wall["start"]["x"], wall["start"]["y"])
        b = vid(wall["end"]["x"], wall["end"]["y"])
        if a == b:
            continue
        edges.append((a, b, wall["id"]))
    adj = {index: [] for index in range(len(verts))}
    for a, b, wall_id in edges:
        ang_ab = math.atan2(verts[b][1] - verts[a][1], verts[b][0] - verts[a][0])
        ang_ba = math.atan2(verts[a][1] - verts[b][1], verts[a][0] - verts[b][0])
        adj[a].append((b, wall_id, ang_ab))
        adj[b].append((a, wall_id, ang_ba))
    for neighbors in adj.values():
        neighbors.sort(key=lambda item: item[2])
    used = set()
    rooms = []
    max_steps = len(edges) + 1
    for a, b, _wall_id in edges:
        for start, nxt in ((a, b), (b, a)):
            key = (start, nxt)
            if key in used:
                continue
            cycle = [start]
            wall_ids = []
            cur, nxt_v = start, nxt
            valid = True
            for _step in range(max_steps):
                directed = (cur, nxt_v)
                if directed in used:
                    valid = False
                    break
                used.add(directed)
                cycle.append(nxt_v)
                for to, wall_id, _ang in adj[cur]:
                    if to == nxt_v:
                        wall_ids.append(wall_id)
                        break
                if nxt_v == start and len(cycle) > 3:
                    break
                in_angle = math.atan2(verts[cur][1] - verts[nxt_v][1], verts[cur][0] - verts[nxt_v][0])
                neighbors = adj[nxt_v]
                if not neighbors:
                    valid = False
                    break
                best_i = -1
                best_delta = 1e9
                for index, (to, _wid, ang) in enumerate(neighbors):
                    if to == cur and len(neighbors) > 1:
                        continue
                    delta = in_angle - ang
                    if delta <= 1e-9:
                        delta += math.pi * 2
                    if delta < best_delta:
                        best_delta = delta
                        best_i = index
                if best_i < 0:
                    valid = False
                    break
                cur = nxt_v
                nxt_v = neighbors[best_i][0]
            if not valid or cycle[-1] != start or len(cycle) < 4:
                continue
            poly = [verts[index] for index in cycle[:-1]]
            signed = _shoelace(poly)
            if signed <= 0 or signed < 1000 or signed > 10_000_000:
                continue
            unique = []
            for wall_id in wall_ids:
                if wall_id not in unique:
                    unique.append(wall_id)
            signature = tuple(sorted(unique))
            if any(tuple(sorted(room["walls"])) == signature for room in rooms):
                continue
            rooms.append({
                "walls": unique,
                "area": signed,
                "polygon": [{"x": x, "y": y} for x, y in poly],
            })
    rooms.sort(key=lambda room: room["area"], reverse=True)
    return rooms


def _drop_sliver_walls(walls):
    """Remove faces thinner than a real room so they do not become stray floors.

    A void between two copies of the same wall is a cycle openPlan would fill.
    Walls that also bound a real room stay.
    """
    for _ in range(4):
        rooms = detect_closed_rooms(walls)
        fat, thin = set(), set()
        for room in rooms:
            xs = [point["x"] for point in room["polygon"]]
            ys = [point["y"] for point in room["polygon"]]
            minor = min(max(xs) - min(xs), max(ys) - min(ys))
            (thin if minor < _SLIVER_CM else fat).update(room["walls"])
        drop = thin - fat
        if not drop:
            break
        walls = [wall for wall in walls if wall["id"] not in drop]
    return walls


def _center_walls(walls, origin=None):
    if not walls:
        return (0.0, 0.0) if origin is None else origin
    if origin is None:
        xs, ys = [], []
        for wall in walls:
            xs += [wall["start"]["x"], wall["end"]["x"]]
            ys += [wall["start"]["y"], wall["end"]["y"]]
        cx = (min(xs) + max(xs)) / 2
        cy = (min(ys) + max(ys)) / 2
    else:
        cx, cy = origin
    for wall in walls:
        wall["start"] = {"x": round(wall["start"]["x"] - cx, 2), "y": round(wall["start"]["y"] - cy, 2)}
        wall["end"] = {"x": round(wall["end"]["x"] - cx, 2), "y": round(wall["end"]["y"] - cy, 2)}
    return cx, cy


def _match_room_walls(rect, walls, lines, scale):
    x0, y0, x1, y1 = rect
    ids = []
    for wall, line in zip(walls, lines):
        lx0, ly0, lx1, ly1, _t = line
        horizontal = abs(ly1 - ly0) <= abs(lx1 - lx0)
        if horizontal:
            y = (ly0 + ly1) / 2
            a, b = sorted((lx0, lx1))
            near = min(abs(y - y0), abs(y - y1)) <= 10
            overlap = min(b, x1) - max(a, x0)
            if near and overlap > 12:
                ids.append(wall["id"])
        else:
            x = (lx0 + lx1) / 2
            a, b = sorted((ly0, ly1))
            near = min(abs(x - x0), abs(x - x1)) <= 10
            overlap = min(b, y1) - max(a, y0)
            if near and overlap > 12:
                ids.append(wall["id"])
    return ids


def _apply_pdf_room_names(rooms, pdf_path, page_index, scale, extra_names=None):
    """Name faces from the PDF and report whether OCR actually ran.

    Polygons are still in pre-center centimetres (PDF points × scale).
    """
    report = {"ocrBackend": "off", "ocrStatus": "unavailable", "ocrLabels": 0, "namedRooms": 0}
    if not rooms or scale <= 0:
        report["ocrStatus"] = "no-rooms"
        return report
    choice = os.environ.get("CAD_OCR_BACKEND", "auto").strip().lower()
    if choice in {"off", "none", "0", "skip"}:
        report["ocrStatus"] = "disabled"
        return report
    try:
        from maker_ocr import openplan_room_labels, resolve_ocr_backend
        report["ocrBackend"] = resolve_ocr_backend()
        if report["ocrBackend"] == "off":
            return report
        pts = [(pt["x"] / scale, pt["y"] / scale) for room in rooms for pt in room["polygon"]]
        pad = 40.0
        box = (min(p[0] for p in pts) - pad, min(p[1] for p in pts) - pad,
               max(p[0] for p in pts) + pad, max(p[1] for p in pts) + pad) if pts else None
        labels = openplan_room_labels(pdf_path, page_index, box=box, extra_names=extra_names)
    except Exception as exc:
        report["ocrStatus"] = "error"
        report["ocrError"] = str(exc)
        return report
    report["ocrStatus"] = "complete"
    report["ocrLabels"] = len(labels)
    from hospital_lexicon import known, lexicon
    words = lexicon(extra_names)
    _restore_womens_toilets(labels)
    used = set()
    # Smallest rooms first: a label inside a niche belongs to the niche, not the hall around it.
    order = sorted(range(len(rooms)), key=lambda i: abs(_ring_area([(p["x"], p["y"]) for p in rooms[i]["polygon"]])))
    for index in order:
        room = rooms[index]
        ring = [(point["x"], point["y"]) for point in room["polygon"]]
        xs, ys = [p[0] for p in ring], [p[1] for p in ring]
        if xs and min(max(xs) - min(xs), max(ys) - min(ys)) < _SLIVER_CM:
            continue  # slivers lose their name later; leave the label for a POI
        hits = []
        for k, label in enumerate(labels):
            if k in used:
                continue
            if _point_in_poly(float(label["x"]) * scale, float(label["y"]) * scale, ring):
                hits.append(k)
        if not hits:
            continue
        hits.sort(key=lambda k: (not known(labels[k]["text"], words), -len(labels[k]["text"]), labels[k]["text"]))
        best = labels[hits[0]]
        used.add(hits[0])
        room["name"] = best["text"]
        if best.get("raw") and best["raw"] != best["text"]:
            room["ocrText"] = best["raw"]
        report["namedRooms"] += 1
    # A name with no face of its own (label just outside a mis-closed room, or on the door
    # side): give it to the nearest still-unnamed enclosed room within 3 m of the label.
    for k, label in enumerate(labels):
        if k in used or not _open_label_is_place(label["text"]):
            continue
        px, py = float(label["x"]) * scale, float(label["y"]) * scale
        best, best_d = None, 300.0
        for room in rooms:
            if room.get("name"):
                continue
            ring = [(p["x"], p["y"]) for p in room["polygon"]]
            xs, ys = [p[0] for p in ring], [p[1] for p in ring]
            if min(max(xs) - min(xs), max(ys) - min(ys)) < _SLIVER_CM:
                continue
            d = _dist_to_ring(px, py, ring)
            if d < best_d:
                best, best_d = room, d
        if best is not None:
            best["name"] = label["text"]
            used.add(k)
            report["namedRooms"] += 1
    # Second look: small closed rooms still unnamed get their own crop OCR (sheet tiles miss
    # short labels squeezed between fixtures, e.g. 女卫 next to the urinals).
    try:
        from maker_ocr import ocr_page_lines, room_labels_from_lines
        for room in rooms:
            if room.get("name"):
                continue
            ring = [(p["x"] / scale, p["y"] / scale) for p in room["polygon"]]
            xs, ys = [p[0] for p in ring], [p[1] for p in ring]
            w, h = max(xs) - min(xs), max(ys) - min(ys)
            if not (8 <= w <= 160 and 8 <= h <= 160) or min(w, h) * scale < _SLIVER_CM:
                continue
            found = room_labels_from_lines(ocr_page_lines(pdf_path, page_index, box=(min(xs), min(ys), max(xs), max(ys)), dpi=250), extra_names)
            inside = [l for l in found if _point_in_poly(l["x"], l["y"], ring) and re.search(r"[\u4e00-\u9fff]", l["text"])]
            if inside:
                inside.sort(key=lambda l: (not known(l["text"], words), -len(l["text"])))
                room["name"] = inside[0]["text"]
                report["namedRooms"] += 1
    except Exception:
        pass
    _restore_womens_toilet_rooms(rooms)
    # Names printed in open space (门厅, 导医台, 候诊区 in a hall) have no closed face of their own:
    # keep them as point POIs so they are searchable and routable.
    report["openLabels"] = [
        {"text": l["text"], "x": float(l["x"]) * scale, "y": float(l["y"]) * scale}
        for k, l in enumerate(labels) if k not in used and len(l["text"]) >= 2
    ]
    return report


def _restore_womens_toilets(labels):
    """CAD single-stroke 「女」 is often dropped by OCR, leaving a lone 「卫」 beside 「男卫」.

    For each 男卫 on the sheet without a 女卫, the nearest lone 卫 within ~40 pt (a few metres)
    becomes 女卫. Lone 卫 elsewhere (ward en-suites) are left alone.
    """
    if any(l["text"] == "女卫" for l in labels):
        return
    lone = [l for l in labels if l["text"] == "卫"]
    for man in [l for l in labels if l["text"] == "男卫"]:
        near = sorted(lone, key=lambda l: math.hypot(l["x"] - man["x"], l["y"] - man["y"]))
        if near and math.hypot(near[0]["x"] - man["x"], near[0]["y"] - man["y"]) <= 160:
            near[0]["raw"] = near[0].get("raw") or "卫"
            near[0]["text"] = "女卫"
            lone.remove(near[0])


def _restore_womens_toilet_rooms(rooms):
    """Same 女卫 rule on named rooms (crop OCR also reads only 「卫」)."""
    if any(r.get("name") == "女卫" for r in rooms):
        return
    def centre(r):
        pts = r["polygon"]
        return sum(p["x"] for p in pts) / len(pts), sum(p["y"] for p in pts) / len(pts)
    lone = [r for r in rooms if r.get("name") == "卫"]
    for man in [r for r in rooms if r.get("name") == "男卫"]:
        mx, my = centre(man)
        near = sorted(lone, key=lambda r: math.hypot(centre(r)[0] - mx, centre(r)[1] - my))
        if near and math.hypot(centre(near[0])[0] - mx, centre(near[0])[1] - my) <= 1200:
            near[0]["name"] = "女卫"
            lone.remove(near[0])


def _open_label_is_place(text):
    """A free-standing label worth a POI: a lexicon place, or ends like one (…台/…厅/…区)."""
    from hospital_lexicon import known, looks_complete
    if re.search(r"上空|花坛|庭院|天井|设备|空调|原地面|玻璃|窗|满足|平台|做法|详见|改造|管道井", text):
        return False  # not somewhere a patient walks to
    if known(text) or (looks_complete(text) and len(text) <= 12):
        return True
    # Short CJK room words (推拿、休息、打包) whose wall split CAD did not close: keep as a spot.
    return bool(re.fullmatch(r"[\u4e00-\u9fff]{2,8}[0-9一二三四五六七八九十]?", text)) and not re.search(r"上空|花坛|庭院|设备|空调|原地面|玻璃|窗|满足|平台|做法|详见|改造", text)


def _dist_to_ring(px, py, ring):
    best = float("inf")
    for i in range(len(ring)):
        (x0, y0), (x1, y1) = ring[i], ring[(i + 1) % len(ring)]
        dx, dy = x1 - x0, y1 - y0
        t = max(0.0, min(1.0, ((px - x0) * dx + (py - y0) * dy) / (dx * dx + dy * dy or 1)))
        best = min(best, math.hypot(px - x0 - t * dx, py - y0 - t * dy))
    return best


def _ring_area(ring):
    return sum(ring[i][0] * ring[(i + 1) % len(ring)][1] - ring[(i + 1) % len(ring)][0] * ring[i][1] for i in range(len(ring))) / 2


_SHAFT_MIN_PT = 25.0
_SHAFT_MAX_PT = 140.0
_STAIR_NAME_RE = re.compile(r"楼梯|梯间|stair", re.I)
# A shaft inside a larger face (a corridor or hall) stays a point stop there.
_SHAFT_ROOM_MAX_CM2 = 400_000.0


def _elevator_crosses(segments):
    """Centres (PDF points) of CAD elevator symbols: an X drawn corner to corner.

    Both diagonals share one bounding box and slope opposite ways.
    """
    diagonals = []
    for x0, y0, x1, y1, _width in segments if segments is not None else []:
        dx, dy = x1 - x0, y1 - y0
        w, h = abs(dx), abs(dy)
        if not (_SHAFT_MIN_PT <= w <= _SHAFT_MAX_PT and _SHAFT_MIN_PT <= h <= _SHAFT_MAX_PT):
            continue
        if not 0.3 < w / h < 3.3:
            continue
        box = (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))
        diagonals.append((box, dx * dy > 0))
    centres = []
    for i, (box, rising) in enumerate(diagonals):
        for other, other_rising in diagonals[i + 1:]:
            if rising == other_rising or any(abs(a - b) > 3.0 for a, b in zip(box, other)):
                continue
            cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
            if all(math.hypot(cx - x, cy - y) > 10 for x, y in centres):
                centres.append((cx, cy))
    return centres


def _vertical_shafts(segments, stairs, rooms, scale):
    """Elevator and stairs positions (pre-centre cm) and the closed room holding each.

    Holding rooms are named 电梯 / 楼梯 so navigation lists them.
    """
    found = []
    for x, y in _elevator_crosses(segments):
        found.append(("elevator", x * scale, y * scale))
    for stair in stairs or []:
        poly = stair.get("polygonPdf") or []
        if len(poly) < 3:
            continue
        found.append(("stairs", sum(p[0] for p in poly) / len(poly) * scale, sum(p[1] for p in poly) / len(poly) * scale))
    # Two flights of one stairwell (or a cut first flight) are one stair: merge within 3 m.
    merged = []
    for kind, x, y in found:
        near = next((m for m in merged if m[0] == kind == "stairs" and math.hypot(m[1] - x, m[2] - y) <= 300), None)
        if near:
            near[1], near[2], near[3] = (near[1] * near[3] + x) / (near[3] + 1), (near[2] * near[3] + y) / (near[3] + 1), near[3] + 1
        else:
            merged.append([kind, x, y, 1])
    found = [(k, x, y) for k, x, y, _n in merged]
    shafts = []
    for kind, x, y in found:
        holder = None
        for index, room in enumerate(rooms or []):
            if room["area"] > _SHAFT_ROOM_MAX_CM2:
                continue
            if _point_in_poly(x, y, [(point["x"], point["y"]) for point in room["polygon"]]):
                if holder is None or room["area"] < rooms[holder]["area"]:
                    holder = index
        if holder is not None:
            room = rooms[holder]
            name = room.get("name") or ""
            if kind == "elevator" and "电梯" not in name:
                room["name"] = "电梯"
            elif kind == "stairs" and not _STAIR_NAME_RE.search(name):
                room["name"] = "楼梯"
        shafts.append({"kind": kind, "x": x, "y": y, "room": holder})
    return shafts


def recognize_pdf(
    pdf_path, ruler, length_mm, mode="generate", floor_name=None, page_index=1, background=None,
    scale=None, origin=None, extra_names=None,
):
    """Return ``{project, display, stats, origin, vertical}``.

    ``ruler`` is ``(x1, y1, x2, y2)`` in PDF points. ``mode`` is ``generate`` or ``underlay``.
    ``background`` is an optional openPlan BackgroundImage dict (underlay stub).
    ``scale`` (cm per point) replaces the ruler when given. ``origin`` (cm) is the
    shift that centres the plan; pages of one building pass the same origin so
    their floors stack on the same axes. ``vertical`` lists elevator and stairs
    rooms in the output coordinates.
    """
    if scale is None:
        length_pt = math.hypot(ruler[2] - ruler[0], ruler[3] - ruler[1])
        scale = cm_per_point(length_pt, length_mm)
    name, level = floor_meta(floor_name)
    now = datetime.now(timezone.utc).isoformat()
    project_id = uuid.uuid4().hex
    floor_id = f"floor-{level}"
    content = load_cad_vector_content(pdf_path, page_index)
    if not content or content.get("segments") is None:
        raise RuntimeError("pdf-vectors-missing")
    page_size = content["pageSize"]
    crops = [
        _body_crop(page_size),
        _body_crop(page_size, (0.06, 0.08, 0.94, 0.90)),
    ]
    chosen = None
    structure = None
    for crop in crops:
        clipped = _clip_segments(content["segments"], crop)
        candidate = {"crop": crop, "clipped": clipped}
        if mode == "generate" and len(clipped):
            area = crop["width"] * crop["height"]
            try:
                structure_try = cad_structure_rooms(content, crop, area)
            except Exception:
                structure_try = None
            candidate["structure"] = structure_try
        else:
            candidate["structure"] = None
        lines = centerlines_from_segments(clipped, (candidate["structure"] or {}).get("boundary")) if mode == "generate" else []
        candidate["lines"] = lines
        # A crop whose structure found rooms carries doors and stairs; fewer
        # centerlines there beat more lines from a crop that found none.
        # Rank by how much structure each crop explains: a crop that clips the plan can still
        # return a couple of rooms (P1 2F: 2 rooms / 2 doors vs 40+ / 30+ on the wider crop).
        found = candidate["structure"] or {}
        rank = (min(len(found.get("rooms") or []), 10), len(found.get("doors") or []), len(lines))
        if chosen is None or rank > chosen["rank"]:
            candidate["rank"] = rank
            chosen = candidate
            structure = candidate["structure"]
        if len(lines) >= 12 and structure and len(structure.get("rooms") or []) >= 10:
            break
    lines = chosen["lines"] if chosen else []
    crop = chosen["crop"] if chosen else crops[0]
    doors_in = []
    rooms_in = []
    stairs_in = []
    boundary = None
    if mode == "generate" and structure:
        doors_in = structure.get("doors") or []
        rooms_in = structure.get("rooms") or []
        stairs_in = structure.get("stairs") or []
        boundary = structure.get("boundary")
    inferred_gaps = []
    if mode == "generate":
        lines = repair_wall_lines(lines, scale, boundary, inferred_gaps, doors_in, stairs_in)
    walls = _walls_cm(lines, scale) if mode == "generate" else []
    compact = []
    for wall in walls:
        wall.pop("_index")
        compact.append(wall)
    walls = _drop_sliver_walls(merge_overlapping_walls(compact)) if compact else []
    kept_lines = [
        (w["start"]["x"] / scale, w["start"]["y"] / scale,
         w["end"]["x"] / scale, w["end"]["y"] / scale, w["thickness"] / scale)
        for w in walls
    ]
    attached = _attach_doors(doors_in, kept_lines, scale, boundary) if walls else []
    for gap in _attach_doors(inferred_gaps, kept_lines, scale, boundary) if walls else []:
        x0, y0, x1, y1, _ = kept_lines[gap["wallIndex"]]
        gx = x0 + gap["position"] * (x1 - x0)
        gy = y0 + gap["position"] * (y1 - y0)
        if any(door["wallIndex"] == gap["wallIndex"]
               and math.hypot(gx - (x0 + door["position"] * (x1 - x0)),
                              gy - (y0 + door["position"] * (y1 - y0))) * scale < max(60, gap["width"] / 2)
               for door in attached):
            continue
        attached.append(gap)
    id_by_index = {i: wall["id"] for i, wall in enumerate(walls)}
    doors = []
    for n, door in enumerate(attached, start=1):
        wall_id = id_by_index.get(door["wallIndex"])
        if not wall_id:
            continue
        doors.append({
            "id": f"door-{n}",
            "wallId": wall_id,
            "position": door["position"],
            "width": door["width"],
            "height": 210,
            "type": door["type"],
            "swingDirection": "left",
            "flipSide": False,
        })
    walls = merge_overlapping_walls(walls + close_wall_gaps(walls), doors)
    closed = detect_closed_rooms(walls) if walls else []
    fallback_faces = [
        {"polygon": [{"x": float(x) * scale, "y": float(y) * scale} for x, y in room.get("polygonPdf") or []]}
        for room in rooms_in
    ] if not closed else []
    ocr_report = _apply_pdf_room_names(closed or fallback_faces, pdf_path, page_index, scale, extra_names)
    shafts = _vertical_shafts(content["segments"], stairs_in, closed, scale) if mode == "generate" else []
    open_rooms = []
    room_ids_by_closed_index = {}
    display_rooms = []
    for n, room in enumerate(closed):
        color = ROOM_COLORS[n % len(ROOM_COLORS)]
        name = room.get("name") or ""
        if not name and room["area"] < 5000:
            continue
        xs = [point["x"] for point in room["polygon"]]
        ys = [point["y"] for point in room["polygon"]]
        sliver = min(max(xs) - min(xs), max(ys) - min(ys)) < _SLIVER_CM
        record = {
            "id": f"room-{n + 1}",
            "name": "" if sliver else name,
            "walls": room["walls"],
            "floorTexture": "none" if sliver else room_floor_texture(room["polygon"], name),
            "area": 0 if sliver else round(room["area"] / 10000.0, 2),
            "color": color,
            "roomType": "indoor",
        }
        if sliver:
            record["floorOpening"] = True
        open_rooms.append(record)
        if not sliver:
            room_ids_by_closed_index[n] = record["id"]
        if sliver:
            continue
        display_rooms.append({
            "id": f"cad-fill-{n}",
            "kind": "room",
            "polygon": [_norm(point["x"] / scale, point["y"] / scale, page_size) for point in room["polygon"]],
            "color": _hex_rgb(color),
        })
    if not open_rooms:
        for n, room in enumerate(rooms_in):
            poly = room.get("polygonPdf") or []
            if len(poly) < 4:
                continue
            xs = [p[0] for p in poly]
            ys = [p[1] for p in poly]
            rect = (min(xs), min(ys), max(xs), max(ys))
            wall_ids = _match_room_walls(rect, walls, kept_lines, scale)
            color = ROOM_COLORS[n % len(ROOM_COLORS)]
            area_cm = max(0.0, (rect[2] - rect[0]) * (rect[3] - rect[1]) * scale * scale)
            open_rooms.append({
                "id": f"room-{n + 1}",
                "name": fallback_faces[n].get("name") or "",
                "walls": wall_ids,
                "floorTexture": "hospital-floor",
                "area": round(area_cm / 10000.0, 2),
                "color": color,
                "roomType": "indoor",
            })
            display_rooms.append({
                "id": f"cad-fill-{n}",
                "kind": "room",
                "polygon": [_norm(x, y, page_size) for x, y in poly],
                "color": _hex_rgb(color),
            })
    origin_x, origin_y = _center_walls(walls, origin)
    vertical = []
    for shaft in shafts:
        index = shaft["room"]
        room_id = ""
        if index in room_ids_by_closed_index:
            room_id = room_ids_by_closed_index[index]
        vertical.append({
            "kind": shaft["kind"],
            "roomId": room_id,
            "x": round(shaft["x"] - origin_x, 1),
            "y": round(shaft["y"] - origin_y, 1),
        })
    if background and (origin_x or origin_y):
        position = background.get("position") or {}
        background["position"] = {
            "x": round(float(position.get("x") or 0) - origin_x, 2),
            "y": round(float(position.get("y") or 0) - origin_y, 2),
        }
    pois = []
    for n, stair in enumerate(stairs_in):
        poly = stair.get("polygonPdf") or []
        if len(poly) < 4:
            continue
        cx = sum(p[0] for p in poly) / len(poly)
        cy = sum(p[1] for p in poly) / len(poly)
        display_rooms.append({
            "id": f"cad-stair-{n}",
            "kind": "stairs",
            "polygon": [_norm(x, y, page_size) for x, y in poly],
            "color": [0.82, 0.89, 0.92],
        })
        pois.append({
            "id": f"poi-stair-{n}",
            "name": "楼梯",
            "category": "stairs",
            "position": _norm(cx, cy, page_size),
        })
    if boundary and len(boundary) >= 4:
        ring = [_norm(x, y, page_size) for x, y in boundary]
    else:
        ring = [
            _norm(crop["x"], crop["y"], page_size),
            _norm(crop["x"] + crop["width"], crop["y"], page_size),
            _norm(crop["x"] + crop["width"], crop["y"] + crop["height"], page_size),
            _norm(crop["x"], crop["y"] + crop["height"], page_size),
        ]
    floor = {
        "id": floor_id,
        "name": name,
        "level": level,
        "elevation": 0,
        "walls": walls,
        "rooms": open_rooms,
        "doors": doors,
        "windows": [],
        "furniture": [],
        "stairs": [],
        "columns": [],
        "guides": [],
        "measurements": [],
        "annotations": [],
        "textAnnotations": [
            {"id": f"poi-{n}", "x": round(item["x"] - origin_x, 1), "y": round(item["y"] - origin_y, 1),
             "text": item["text"], "fontSize": 14, "color": "#555555", "rotation": 0, "poi": True}
            for n, item in enumerate(ocr_report.pop("openLabels", None) or [], start=1)
            if mode == "generate" and _open_label_is_place(item["text"])
        ],
        "groups": [],
    }
    if background:
        floor["backgroundImage"] = background
    if mode == "generate" and boundary and len(boundary) >= 3 and walls:
        # Navigation walks the footprint where CAD left halls and corridors open.
        floor["footprint"] = [
            {"x": round(x * scale - origin_x, 1), "y": round(y * scale - origin_y, 1)}
            for x, y in boundary
        ]
    ocr_report["namedRooms"] = sum(bool(room.get("name")) for room in open_rooms)
    project = {
        "id": project_id,
        "name": name,
        "floors": [floor],
        "activeFloorId": floor_id,
        "createdAt": now,
        "updatedAt": now,
    }
    display_doors = []
    for door in doors_in:
        mid = door.get("mid")
        if not mid:
            continue
        display_doors.append({
            "id": door.get("id") or f"door-{len(display_doors)+1}",
            "position": _norm(mid[0], mid[1], page_size),
            "widthMapUnits": round(float(door.get("width") or 12), 2),
        })
    display = {
        "schemaVersion": "1.0.0",
        "id": project_id,
        "name": name,
        "floorId": name,
        "underlay": mode != "generate",
        "source": {
            "pdfSize": [round(page_size[0], 2), round(page_size[1], 2)],
            "sourceKind": "cad",
            "page": page_index,
        },
        "geometry": {
            "buildingBoundary": ring,
            "obstacles": display_rooms,
            "wallSegments": [
                [_norm(x0, y0, page_size), _norm(x1, y1, page_size)]
                for x0, y0, x1, y1, _t in kept_lines
            ] if not display_rooms else [],
        },
        "pois": pois,
        "doors": display_doors,
        "graph": {"nodes": [], "edges": []},
    }
    return {
        "project": project,
        "display": display,
        "origin": (origin_x, origin_y),
        "doorCandidates": [{**door, "mid": [door["mid"][0] * scale - origin_x,
                                               door["mid"][1] * scale - origin_y],
                            "width": float(door.get("width") or 20) * scale}
                           for door in doors_in + inferred_gaps if door.get("mid")],
        "vertical": vertical,
        "stats": {
            "walls": len(walls),
            "rooms": len(open_rooms),
            "doors": len(doors),
            "stairs": len(pois),
            "cmPerPoint": round(scale, 5),
            "mode": mode,
            **ocr_report,
        },
    }


def _hex_rgb(value: str):
    value = value.lstrip("#")
    return [int(value[i:i + 2], 16) / 255 for i in (0, 2, 4)]

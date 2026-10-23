"""Build a navigable MapDocument from a cropped PDF page.

Uses native vector fills and the text layer. Does not call cloud APIs. CAD pages with no text layer may use on-device Vision OCR.
Does not import or overwrite the Gifu demo adapter in data/.
"""
from __future__ import annotations

from collections import deque
import logging
import math
import re
import unicodedata

import numpy as np
import pdfplumber
from PIL import Image, ImageDraw, ImageFilter

from build_map import (
    build_graph,
    closest_boundary,
    components,
    contains,
    path_to_skeleton,
    simplify,
    skeletonize,
)
from maker_cad import (
    cad_content_crop_hiding_rulers,
    cad_linework_rooms,
    filter_labels_to_crop,
    filter_rooms_to_crop,
    probe_pdf_optional_content,
)
from maker_ocr import (
    cad_ocr_for_page,
    clip_cad_rooms_to_labels,
    is_equipment_label,
    name_cad_left_wing_rooms,
)
from maker_pdf import PdfRejected
from maker_store import empty_edits, normalize_crop, normalize_floor, normalize_room_color, normalize_source_kind

logging.getLogger("pdfminer").setLevel(logging.ERROR)

MAX_ROOMS = 120
MAX_LABELS = 160
SNAP_LIMIT = 72
SNAP_LIMIT_HARD = 140
MAX_BRIDGE_CELLS = 16
CROP_PAD_X = 80
CROP_PAD_Y_TOP = 40
CROP_PAD_Y_BOTTOM = 12
VECTOR_RASTER_DPI = 150  # Hi-res raster for supplemental room fills and label tolerance.
WALKABLE_RASTER_DPI = 120  # Hi-res walkable mask before grid downsample.
DARK_FILL_MAX = 0.25  # Skip near-black structural fills that render as 3D black blocks.
RASTER_MIN_ROOM_AREA = 180  # PDF units²; catches small fills missed by coarse vector bounds.
RASTER_MIN_FILL_RATIO = 0.2  # Drop hollow envelopes whose bbox is mostly empty.
ENVELOPE_MIN_RATIO = 0.28  # Large vector fills are the building outline, not a room.
ENVELOPE_MAX_RATIO = 0.96
ENVELOPE_MIN_PTS = 8
CROP_EDGE_TOL = 2.5  # Never treat the manual crop rectangle as outer walls.

RADICALS = str.maketrans({
    "⼊": "入",
    "⼝": "口",
    "⼼": "心",
    "⽀": "支",
    "⼆": "二",
    "⼤": "大",
    "⼩": "小",
    "⼾": "户",
    "⾨": "门",
    "⻄": "西",
    "⽩": "白",
    "⾯": "面",
    "⼯": "工",
    "⾃": "自",
    "⽣": "生",
})

FACILITY_NAMES = {
    "entrance": "出入口",
    "restroom": "卫生间",
    "accessible-restroom": "无障碍卫生间",
    "elevator": "电梯",
    "stairs": "楼梯",
    "escalator": "扶梯",
    "pharmacy": "药房",
    "shop": "商店",
    "reception": "接待处",
    "department": "科室",
    "room": "房间",
    "office": "办公",
    "service": "设施",
}

FACILITY_CATEGORIES = set(FACILITY_NAMES)


def _norm(point, size):
    return [round(point[0] / size[0], 7), round(point[1] / size[1], 7)]


def _rgb(color):
    if color is None:
        return None
    if isinstance(color, (int, float)):
        return [float(color)] * 3
    if isinstance(color, (list, tuple)) and len(color) >= 3:
        return [float(channel) for channel in color[:3]]
    if isinstance(color, (list, tuple)) and len(color) == 1:
        return [float(color[0])] * 3
    return None


def clean_label_text(text):
    text = unicodedata.normalize("NFKC", str(text or "")).translate(RADICALS)
    text = text.replace(" ", "").replace("\u2003", "").replace("\u3000", "").strip()
    text = re.sub(r"([\u4e00-\u9fff])\1+", r"\1", text)
    text = re.sub(r"、+$", "、", text)
    return text.strip(" ·,;|/、")


def classify_label(text):
    lowered = text.lower()
    if any(token in text for token in ("入口", "出口")) or "entrance" in lowered:
        return "entrance"
    if any(token in text for token in ("无障碍", "多功能厕所")) or "accessible" in lowered:
        return "accessible-restroom"
    if any(token in text for token in ("卫生间", "厕所", "化粧")) or "wc" in lowered or "restroom" in lowered:
        return "restroom"
    if "扶梯" in text or "escalator" in lowered:
        return "escalator"
    if "电梯" in text or "elevator" in lowered:
        return "elevator"
    if "楼梯" in text or "stairs" in lowered:
        return "stairs"
    if "药房" in text or "pharmacy" in lowered:
        return "pharmacy"
    if any(token in text for token in ("咖啡", "便利店", "商店", "邮局", "饭店")) or "shop" in lowered:
        return "shop"
    if any(token in text for token in ("接待", "挂号", "缴费", "问讯", "咨询", "信息")):
        return "reception"
    if any(token in text for token in ("庭院", "中庭")):
        return "courtyard"
    return "department"


def _bbox(pts):
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def _closed_ring(pts):
    ring = [[float(x), float(y)] for x, y in pts]
    if len(ring) > 3 and ring[0] == ring[-1]:
        ring = ring[:-1]
    return ring


def _polygon_pts(obj):
    pts = obj.get("pts")
    if pts and len(pts) >= 3:
        return _closed_ring(pts)
    x0, y0 = float(obj["x0"]), float(obj["top"])
    x1, y1 = float(obj["x1"]), float(obj["bottom"])
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


def _is_axis_aligned_rect(pts, tol=CROP_EDGE_TOL):
    if len(pts) not in (4, 5):
        return False
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)
    return all(min(abs(p[0] - x0), abs(p[0] - x1)) <= tol for p in pts) and all(
        min(abs(p[1] - y0), abs(p[1] - y1)) <= tol for p in pts
    )


def _matches_rect(pts, x, y, width, height, tol=CROP_EDGE_TOL):
    if not pts or not _is_axis_aligned_rect(pts, tol):
        return False
    x0, y0, x1, y1 = _bbox(pts)
    return (
        abs(x0 - x) <= tol
        and abs(y0 - y) <= tol
        and abs(x1 - (x + width)) <= tol
        and abs(y1 - (y + height)) <= tol
    )


def _is_crop_rectangle(pts, crop, tol=CROP_EDGE_TOL):
    return _matches_rect(pts, crop["x"], crop["y"], crop["width"], crop["height"], tol)


def _cross(origin, a, b):
    return (a[0] - origin[0]) * (b[1] - origin[1]) - (a[1] - origin[1]) * (b[0] - origin[0])


def _convex_hull(points):
    unique = sorted({(round(p[0], 3), round(p[1], 3)) for p in points})
    if len(unique) <= 2:
        return [list(point) for point in unique]
    lower = []
    for point in unique:
        while len(lower) >= 2 and _cross(lower[-2], lower[-1], point) <= 0:
            lower.pop()
        lower.append(point)
    upper = []
    for point in reversed(unique):
        while len(upper) >= 2 and _cross(upper[-2], upper[-1], point) <= 0:
            upper.pop()
        upper.append(point)
    return [list(point) for point in lower[:-1] + upper[:-1]]


def _is_envelope_fill(color, area, crop_area, npts, width, height, crop):
    if not color or npts < ENVELOPE_MIN_PTS:
        return False
    if min(color) >= 0.93 or _is_dark_structural(color):
        return False
    ratio = area / max(crop_area, 1e-6)
    if ratio < ENVELOPE_MIN_RATIO or ratio > ENVELOPE_MAX_RATIO:
        return False
    if _is_legend_bar(color, width, height, crop):
        return False
    return True


def _choose_building_boundary(crop, envelopes, rooms):
    """Outer walls come from in-crop vector fills / CAD footprint, never the crop rectangle.

    Prefer a rectilinear footprint (no diagonal bevels) when available. Convex hull
    is last resort because CAD room AABBs produce slanted outer edges.
    """
    ranked = sorted(envelopes, key=lambda item: (-item["area"], -len(item["polygonPdf"])))
    for item in ranked:
        ring = item["polygonPdf"]
        if _is_crop_rectangle(ring, crop):
            continue
        # Prefer footprints that are already axis-aligned (CAD structure / vector envelopes).
        if _is_rectilinear(ring) or str(item.get("sourceObject") or "") == "cad-footprint":
            return ring
    for item in ranked:
        if not _is_crop_rectangle(item["polygonPdf"], crop):
            return item["polygonPdf"]
    orth = _orthogonal_hull(rooms)
    if orth and len(orth) >= 4 and not _is_crop_rectangle(orth, crop):
        return orth
    hull_pts = []
    for room in rooms:
        hull_pts.extend(room["polygonPdf"])
    hull = _convex_hull(hull_pts)
    if len(hull) >= 3 and not _is_crop_rectangle(hull, crop):
        return hull
    if ranked:
        return ranked[0]["polygonPdf"]
    if rooms:
        return list(rooms[0]["polygonPdf"])
    return None


def _is_rectilinear(pts, tol=1.5):
    if len(pts) < 4:
        return False
    for i, point in enumerate(pts):
        nxt = pts[(i + 1) % len(pts)]
        if abs(point[0] - nxt[0]) > tol and abs(point[1] - nxt[1]) > tol:
            return False
    return True


def _orthogonal_hull(rooms, pad=8.0):
    """Axis-aligned envelope of room rectangles (Manhattan outline, no diagonals)."""
    boxes = []
    for room in rooms or []:
        pts = room.get("polygonPdf") or []
        if len(pts) < 2:
            continue
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        boxes.append((min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad))
    if not boxes:
        return None
    x0 = min(b[0] for b in boxes)
    y0 = min(b[1] for b in boxes)
    x1 = max(b[2] for b in boxes)
    y1 = max(b[3] for b in boxes)
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


def _merge_cad_doors(existing, cad_doors, size, rooms):
    """Prefer swing-arc openings; keep POI-inferred doors that don't collide."""
    merged = []
    used = set()
    for index, door in enumerate(cad_doors or []):
        mid = door.get("mid") or door.get("center")
        if not mid:
            continue
        opening = door.get("opening") or [mid, mid]
        width = float(door.get("width") or door.get("radius") or 20)
        # Snap to nearest room so the 3D wall cut has an obstacleId.
        room_id = None
        best = None
        for room in rooms or []:
            dist = _dist_to_polygon(mid, room["polygonPdf"])
            if best is None or dist < best[0]:
                best = (dist, room["id"])
        if best and best[0] <= max(36.0, width):
            room_id = best[1]
        merged.append({
            "id": f"door:cad-{index}",
            "poiId": None,
            "obstacleId": room_id,
            "position": _norm(mid, size),
            "corridorAnchor": _norm(opening[1] if opening else mid, size),
            "opening": [_norm(opening[0], size), _norm(opening[1], size)],
            "widthMapUnits": round(width, 3),
            "provenance": door.get("source") or "cad-swing-arc",
            "opensRoomInterior": True,
            "confidence": door.get("confidence", 0.55),
        })
        used.add((round(mid[0] / 8), round(mid[1] / 8)))
    for door in existing or []:
        pos = door.get("position") or [0, 0]
        key = (round(pos[0] * size[0] / 8), round(pos[1] * size[1] / 8))
        if key in used:
            continue
        merged.append(door)
    return merged


def _centroid(pts):
    x0, y0, x1, y1 = _bbox(pts)
    return [(x0 + x1) / 2, (y0 + y1) / 2]


def _overlap_ratio(obj, crop):
    x0, y0, x1, y1 = obj["x0"], obj["top"], obj["x1"], obj["bottom"]
    ox0, oy0 = max(x0, crop["x"]), max(y0, crop["y"])
    ox1, oy1 = min(x1, crop["x"] + crop["width"]), min(y1, crop["y"] + crop["height"])
    overlap = max(0, ox1 - ox0) * max(0, oy1 - oy0)
    area = max(1e-6, (x1 - x0) * (y1 - y0))
    return overlap / area


def _is_legend_bar(color, width, height, crop):
    return (
        color[2] > 0.45
        and color[2] > color[0] + 0.18
        and color[2] > color[1] + 0.12
        and height > 70
        and width > crop["width"] * 0.55
    )


def _raster_scale(dpi):
    return dpi / 72.0


def _is_dark_structural(color):
    """Near-black or dark-gray fills are linework/frames, not room floors."""
    if not color:
        return True
    if max(color) <= DARK_FILL_MAX:
        return True
    if min(color) <= 0.02 and max(color) <= 0.15:
        return True
    return False


def _is_room_fill_color(color):
    if not color or _is_dark_structural(color) or min(color) >= 0.93:
        return False
    return True


def _room_from_bounds(x0, y0, x1, y1, color, source, area=None):
    area = area if area is not None else abs((x1 - x0) * (y1 - y0))
    return {
        "id": source,
        "kind": "counter" if area < 700 else "room",
        "polygonPdf": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
        "color": [round(channel, 4) for channel in color],
        "area": area,
        "sourceObject": source,
    }


def _raster_supplement_rooms(page, crop, crop_area, dpi=VECTOR_RASTER_DPI):
    """Find room fills rasterized at hi-res that vector extraction may miss."""
    scale = _raster_scale(dpi)
    try:
        raster = page.to_image(resolution=dpi)
    except Exception:
        return []
    arr = np.array(raster.original.convert("RGB"))
    x0 = int(crop["x"] * scale)
    y0 = int(crop["y"] * scale)
    x1 = int((crop["x"] + crop["width"]) * scale)
    y1 = int((crop["y"] + crop["height"]) * scale)
    cropped = arr[y0:y1, x0:x1]
    if cropped.size == 0:
        return []
    red, green, blue = cropped[:, :, 0], cropped[:, :, 1], cropped[:, :, 2]
    valid = ~((red > 235) & (green > 235) & (blue > 235))
    valid &= ~((red < 64) & (green < 64) & (blue < 64))
    buckets = (red // 20) * 20, (green // 20) * 20, (blue // 20) * 20
    step = 2
    min_pixels = max(6, int(RASTER_MIN_ROOM_AREA * scale * scale / (step * step)))
    max_pixels = int(crop_area * 0.72 * scale * scale / (step * step))
    rooms = []
    seen = set()
    for cr, cg, cb in zip(*(bucket[valid] for bucket in buckets)):
        key = (int(cr), int(cg), int(cb))
        if key in seen:
            continue
        native_color = [float(cr) / 255.0, float(cg) / 255.0, float(cb) / 255.0]
        if not _is_room_fill_color(native_color):
            continue
        seen.add(key)
        mask = valid & (buckets[0] == cr) & (buckets[1] == cg) & (buckets[2] == cb)
        small = mask[::step, ::step]
        labels, sizes = components(small)
        for label_id, count in enumerate(sizes, start=1):
            if count < min_pixels or count > max_pixels:
                continue
            ys, xs = np.nonzero(labels == label_id)
            px0, py0 = int(xs.min() * step), int(ys.min() * step)
            px1, py1 = int((xs.max() + 1) * step), int((ys.max() + 1) * step)
            bbox_px = max(1, (px1 - px0) * (py1 - py0))
            fill_ratio = (count * step * step) / bbox_px
            if fill_ratio < RASTER_MIN_FILL_RATIO:
                continue
            pdf_x0 = crop["x"] + px0 / scale
            pdf_y0 = crop["y"] + py0 / scale
            pdf_x1 = crop["x"] + px1 / scale
            pdf_y1 = crop["y"] + py1 / scale
            width = pdf_x1 - pdf_x0
            height = pdf_y1 - pdf_y0
            area = width * height
            if area < RASTER_MIN_ROOM_AREA or area > crop_area * 0.72:
                continue
            if _is_legend_bar(native_color, width, height, crop):
                continue
            rooms.append(_room_from_bounds(
                pdf_x0, pdf_y0, pdf_x1, pdf_y1, native_color,
                f"raster-{dpi}-{len(rooms)}",
                area=area,
            ))
    return rooms


def _build_walkable_canvas(size, crop, rooms, dpi=WALKABLE_RASTER_DPI, boundary=None):
    """Rasterize walkable space at hi-res so thin corridors survive downsampling."""
    scale = _raster_scale(dpi)
    width = max(1, int(math.ceil(size[0] * scale)))
    height = max(1, int(math.ceil(size[1] * scale)))
    canvas = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(canvas)
    outline = boundary if boundary and len(boundary) >= 3 else [
        (crop["x"], crop["y"]),
        (crop["x"] + crop["width"], crop["y"]),
        (crop["x"] + crop["width"], crop["y"] + crop["height"]),
        (crop["x"], crop["y"] + crop["height"]),
    ]
    draw.polygon([(point[0] * scale, point[1] * scale) for point in outline], fill=255)
    for room in rooms:
        draw.polygon([(point[0] * scale, point[1] * scale) for point in room["polygonPdf"]], fill=0)
    closed = canvas.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.MinFilter(3))
    return closed, scale


def _is_raster_room(room):
    return str(room.get("sourceObject") or room.get("id") or "").startswith("raster-")


def _is_facility_room(room):
    kind = room.get("kind")
    source = str(room.get("sourceObject") or room.get("id") or "")
    return kind in {"stairs", "elevator", "escalator"} or source.startswith(("cad-stair-", "cad-elevator-"))


def _dedupe_rooms(rooms):
    """Keep detailed rooms. Vector polygons win over raster bboxes; enclosing blobs drop."""
    kept = []
    ordered = sorted(
        rooms,
        key=lambda item: (
            2 if _is_facility_room(item) else 0 if _is_raster_room(item) else 1,
            item["area"],
        ),
        reverse=True,
    )
    for room in ordered:
        if _is_facility_room(room):
            center = _centroid(room["polygonPdf"])
            if any(
                _is_facility_room(other)
                and abs(_centroid(other["polygonPdf"])[0] - center[0]) < 12
                and abs(_centroid(other["polygonPdf"])[1] - center[1]) < 12
                for other in kept
            ):
                continue
            kept.append(room)
            continue
        ax0, ay0, ax1, ay1 = _bbox(room["polygonPdf"])
        area_a = max(1e-6, (ax1 - ax0) * (ay1 - ay0))
        duplicate = False
        for other in kept:
            if _is_facility_room(other):
                continue
            bx0, by0, bx1, by1 = _bbox(other["polygonPdf"])
            ix0, iy0 = max(ax0, bx0), max(ay0, by0)
            ix1, iy1 = min(ax1, bx1), min(ay1, by1)
            inter = max(0, ix1 - ix0) * max(0, iy1 - iy0)
            area_b = max(1e-6, (bx1 - bx0) * (by1 - by0))
            if inter / area_a > 0.82:
                duplicate = True
                break
            if inter / area_b > 0.82 and area_a > area_b * 1.5:
                duplicate = True
                break
        if not duplicate:
            kept.append(room)
    child_count = [0] * len(kept)
    for index, parent in enumerate(kept):
        if _is_facility_room(parent):
            continue
        px0, py0, px1, py1 = _bbox(parent["polygonPdf"])
        for other_index, child in enumerate(kept):
            if other_index == index or _is_facility_room(child) or child["area"] >= parent["area"] * 0.85:
                continue
            cx0, cy0, cx1, cy1 = _bbox(child["polygonPdf"])
            child_area = max(1e-6, (cx1 - cx0) * (cy1 - cy0))
            ix0, iy0 = max(px0, cx0), max(py0, cy0)
            ix1, iy1 = min(px1, cx1), min(py1, cy1)
            inter = max(0, ix1 - ix0) * max(0, iy1 - iy0)
            if inter / child_area > 0.82:
                child_count[index] += 1
    kept = [
        room
        for room, count in zip(kept, child_count)
        if count < 3 or not _is_raster_room(room) or _is_facility_room(room)
    ]
    kept.sort(key=lambda item: -item["area"])
    return kept[:MAX_ROOMS]


def _in_padded_crop(x, y, x0, y0, x1, y1, crop, size):
    left = crop["x"] - CROP_PAD_X
    right = crop["x"] + crop["width"] + 16
    top = crop["y"] - CROP_PAD_Y_TOP
    bottom = crop["y"] + crop["height"] + CROP_PAD_Y_BOTTOM
    cx = (x0 + x1) / 2
    cy = (y0 + y1) / 2
    if left <= cx <= right and top <= cy <= bottom:
        return True
    ox0, oy0 = max(x0, crop["x"]), max(y0, crop["y"])
    ox1, oy1 = min(x1, crop["x"] + crop["width"]), min(y1, crop["y"] + crop["height"])
    return ox1 > ox0 and oy1 > oy0


def _keep_token(text):
    if not text:
        return False
    if text.isdigit() and len(text) <= 2:
        return False
    if len(text) == 1 and text not in "出入口厅楼":
        return False
    # Same appliance filter as maker_ocr.classify (冰箱/开水/电脑…; keep 空调外机).
    if is_equipment_label(text):
        return False
    return True


def _is_cjk(text):
    return bool(re.search(r"[\u4e00-\u9fff]", text))


def cluster_glyphs(glyphs):
    """Join nearby glyphs into words, including vertical CJK stacks."""
    if not glyphs:
        return []
    ordered = sorted(glyphs, key=lambda item: (round(item["y"] / max(item["size"], 1)), item["x"]))
    lines = []
    for glyph in ordered:
        placed = False
        for line in lines:
            last = line[-1]
            size = max(last["size"], glyph["size"], 1)
            same_line = abs(glyph["y"] - last["y"]) <= size * 0.48
            gap = glyph["x0"] - last["x1"]
            if same_line and -0.35 * size <= gap <= size * 0.9:
                line.append(glyph)
                placed = True
                break
        if not placed:
            lines.append([glyph])

    def vertical_seed(line):
        text = "".join(item["text"] for item in line)
        return len(line) <= 2 and len(text) <= 2 and _is_cjk(text)

    used = [False] * len(lines)
    labels = []
    for index, line in enumerate(lines):
        if used[index]:
            continue
        stack = list(line)
        used[index] = True
        if vertical_seed(line):
            changed = True
            while changed:
                changed = False
                cx = sum(item["x"] for item in stack) / len(stack)
                bottom = max(item["bottom"] for item in stack)
                size = max(item["size"] for item in stack)
                for other_index, other in enumerate(lines):
                    if used[other_index] or not vertical_seed(other):
                        continue
                    ocx = sum(item["x"] for item in other) / len(other)
                    otop = min(item["top"] for item in other)
                    if abs(ocx - cx) <= size * 0.75 and -0.2 * size <= otop - bottom <= size * 1.7:
                        stack.extend(other)
                        used[other_index] = True
                        changed = True
        stack.sort(key=lambda item: (item["y"], item["x"]))
        text = clean_label_text("".join(item["text"] for item in stack))
        if not _keep_token(text):
            continue
        labels.append({
            "text": text,
            "x": sum(item["x"] for item in stack) / len(stack),
            "y": sum(item["y"] for item in stack) / len(stack),
            "size": max(item["size"] for item in stack),
            "x0": min(item["x0"] for item in stack),
            "x1": max(item["x1"] for item in stack),
            "top": min(item["top"] for item in stack),
            "bottom": max(item["bottom"] for item in stack),
        })
    return labels


def _label_from_word(word):
    text = clean_label_text(word.get("text"))
    if not _keep_token(text):
        return None
    return {
        "text": text,
        "x": (float(word["x0"]) + float(word["x1"])) / 2,
        "y": (float(word["top"]) + float(word["bottom"])) / 2,
        "size": float(word["bottom"]) - float(word["top"]),
        "x0": float(word["x0"]),
        "x1": float(word["x1"]),
        "top": float(word["top"]),
        "bottom": float(word["bottom"]),
    }


def _near_labels(a, b):
    overlap_x = min(a["x1"], b["x1"]) - max(a["x0"], b["x0"])
    overlap_y = min(a["bottom"], b["bottom"]) - max(a["top"], b["top"])
    if overlap_x > 0 and overlap_y > 0:
        return True
    return math.hypot(a["x"] - b["x"], a["y"] - b["y"]) <= max(a["size"], b["size"], 8) * 1.2


def merge_label_sources(clustered, words):
    kept = list(clustered)
    for word in words:
        rival = next((item for item in kept if _near_labels(word, item)), None)
        if rival is None:
            kept.append(word)
            continue
        if len(word["text"]) > len(rival["text"]) + 1:
            kept[kept.index(rival)] = word
    return kept


def _dist_to_polygon(point, polygon):
    if contains(point, polygon):
        return 0.0
    return math.dist(point, closest_boundary(point, polygon))


def nearest_room(point, rooms, max_dist=28):
    inside = [room for room in rooms if contains(point, room["polygonPdf"])]
    if inside:
        return min(inside, key=lambda room: room["area"]), 0.0
    best = None
    for room in rooms:
        distance = _dist_to_polygon(point, room["polygonPdf"])
        if best is None or distance < best[0]:
            best = (distance, room)
    if best and best[0] <= max_dist:
        return best[1], best[0]
    return None, None


def _merge_room_fragments(labels, rooms):
    for label in labels:
        room, distance = nearest_room((label["x"], label["y"]), rooms)
        label["roomId"] = room["id"] if room else None
        label["roomDist"] = distance
    grouped = {}
    leftover = []
    for label in labels:
        if label.get("roomId"):
            grouped.setdefault(label["roomId"], []).append(label)
        else:
            leftover.append(label)
    merged = list(leftover)
    suffix = re.compile(r"^[（(].+[）)]$")
    for group in grouped.values():
        group.sort(key=lambda item: (item["y"], item["x"]))
        skip = set()
        for index, label in enumerate(group):
            if index in skip:
                continue
            text = label["text"]
            for other_index in range(index + 1, len(group)):
                if other_index in skip:
                    continue
                other = group[other_index]
                close = abs(other["y"] - label["y"]) <= max(label["size"], other["size"]) * 1.8
                if suffix.match(other["text"]) and close:
                    text += other["text"]
                    skip.add(other_index)
                elif (
                    len(other["text"]) <= 2
                    and len(text) <= 4
                    and close
                    and _is_cjk(text)
                    and _is_cjk(other["text"])
                    # Keep repeated niche names (五个「储藏」) as separate labels —
                    # CAD often maps them all onto one parent fill (cad-fill-*).
                    and other["text"] != text
                    and not text.endswith(other["text"])
                ):
                    text += other["text"]
                    skip.add(other_index)
            label = dict(label)
            label["text"] = clean_label_text(text)
            if _keep_token(label["text"]):
                merged.append(label)
    return merged


def extract_page(pdf_path, page_index, crop, source_kind=None):
    extract_page.calibration = None
    extract_page.rulersHidden = None
    extract_page.cadDoors = None
    extract_page.cadStructure = None
    kind = normalize_source_kind(source_kind)
    try:
        with pdfplumber.open(str(pdf_path)) as document:
            if page_index < 1 or page_index > len(document.pages):
                raise PdfRejected("没有这一页。")
            page = document.pages[page_index - 1]
            size = [float(page.width), float(page.height)]
            crop = normalize_crop(crop, size)
            crop_area = crop["width"] * crop["height"]
            rooms = []
            envelopes = []
            for kind_obj, objects in (("rect", page.rects), ("curve", page.curves)):
                for index, obj in enumerate(objects):
                    if not obj.get("fill"):
                        continue
                    color = _rgb(obj.get("non_stroking_color"))
                    if not color:
                        continue
                    if _overlap_ratio(obj, crop) < 0.35:
                        continue
                    width = float(obj.get("width") or 0)
                    height = float(obj.get("height") or 0)
                    area = abs(width * height)
                    ring = _polygon_pts(obj)
                    if _is_envelope_fill(color, area, crop_area, len(ring), width, height, crop):
                        envelopes.append({
                            "polygonPdf": ring,
                            "area": area,
                            "sourceObject": f"{kind_obj}[{index}]",
                        })
                        continue
                    if not _is_room_fill_color(color):
                        continue
                    if len(ring) < 3:
                        continue
                    if area < 250 or area > crop_area * 0.72:
                        continue
                    if _is_legend_bar(color, width, height, crop):
                        continue
                    rooms.append({
                        "id": f"{kind_obj}-{index}",
                        "kind": "counter" if area < 700 else "room",
                        "polygonPdf": ring,
                        "color": [round(channel, 4) for channel in color],
                        "area": area,
                        "sourceObject": f"{kind_obj}[{index}]",
                    })
            rooms.extend(_raster_supplement_rooms(page, crop, crop_area))
            structure = None
            if not rooms and kind == "cad":
                # recover-cad-pdf-layers: hide reconstructed ruler runs before fill.
                rooms.extend(cad_linework_rooms(
                    page, crop, crop_area, pdf_path=pdf_path, page_index=page_index,
                ))
                strip_meta = dict(getattr(cad_linework_rooms, "last_strip_meta", None) or {})
                strip_n = int(getattr(cad_linework_rooms, "last_strip_removed", 0) or 0)
                structure = getattr(cad_linework_rooms, "last_structure", None)
                extract_page.cadStructure = structure
                if structure and structure.get("doors"):
                    extract_page.cadDoors = list(structure["doors"])
                if strip_n or strip_meta.get("mode") not in (None, "none") or structure:
                    extract_page.rulersHidden = {
                        "mode": strip_meta.get("mode") or "reconstructed-style-runs",
                        "kind": strip_meta.get("kind") or "reconstructed",
                        "grayStrokesRemoved": strip_n,
                        "inspection": strip_meta.get("inspection"),
                        "rulerCandidates": strip_meta.get("rulerCandidates"),
                        "structure": strip_meta.get("structure") or (
                            {k: v for k, v in (structure or {}).get("meta", {}).items() if k != "inspection"}
                            if structure else None
                        ),
                        "goal": "clean-map",
                    }
            rooms = _dedupe_rooms(rooms)
            if structure and structure.get("boundary") and len(structure["boundary"]) >= 4:
                boundary = structure["boundary"]
                envelopes = [{"polygonPdf": boundary, "area": structure.get("meta", {}).get("solidity") or 0, "sourceObject": "cad-footprint"}] + envelopes
            else:
                boundary = _choose_building_boundary(crop, envelopes, rooms)
            glyphs = []
            for char in page.chars:
                text = clean_label_text(char.get("text"))
                if not text:
                    continue
                x0, x1 = float(char["x0"]), float(char["x1"])
                top, bottom = float(char["top"]), float(char["bottom"])
                x, y = (x0 + x1) / 2, (top + bottom) / 2
                if not _in_padded_crop(x, y, x0, top, x1, bottom, crop, size):
                    continue
                glyphs.append({
                    "text": text,
                    "x": x,
                    "y": y,
                    "size": max(1.0, bottom - top),
                    "x0": x0,
                    "x1": x1,
                    "top": top,
                    "bottom": bottom,
                })
            clustered = cluster_glyphs(glyphs)
            words = []
            label_scale = max(1.0, VECTOR_RASTER_DPI / 72.0)
            for extracted in (
                page.extract_words(x_tolerance=3, y_tolerance=3),
                page.extract_words(x_tolerance=8, y_tolerance=5),
                page.extract_words(x_tolerance=int(12 * label_scale), y_tolerance=int(6 * label_scale)),
            ):
                for word in extracted:
                    label = _label_from_word(word)
                    if not label:
                        continue
                    if not _in_padded_crop(label["x"], label["y"], label["x0"], label["top"], label["x1"], label["bottom"], crop, size):
                        continue
                    words.append(label)
            labels = _merge_room_fragments(merge_label_sources(clustered, words), rooms)
            if not labels and rooms and kind == "cad":
                try:
                    ocr_labels, ocr_cal = cad_ocr_for_page(page, crop, rooms=rooms)
                except Exception:
                    ocr_labels, ocr_cal = [], None
                if ocr_labels:
                    labels = _merge_room_fragments(ocr_labels, rooms)
                    extract_page.calibration = ocr_cal
                    cad_only = all(
                        str(room.get("sourceObject") or "").startswith(("cad-fill-", "cad-stair-"))
                        for room in rooms
                    )
                    if cad_only:
                        rooms = clip_cad_rooms_to_labels(rooms, labels)
                        rooms, labels = name_cad_left_wing_rooms(rooms, labels)
                        if structure and structure.get("boundary") and len(structure["boundary"]) >= 4:
                            boundary = structure["boundary"]
                        else:
                            boundary = _choose_building_boundary(crop, envelopes, rooms)
            # Goal: clean map extent. Hide margin rulers after we have labels/calibration
            # when possible; order is flexible — correct rooms/corridors matter most.
            footprint_box = (structure or {}).get("footprintBox") if structure else None
            if kind == "cad" and (extract_page.calibration or labels or footprint_box):
                content_crop = cad_content_crop_hiding_rulers(
                    size, crop, labels, footprint_box=footprint_box,
                )
                if content_crop["width"] * content_crop["height"] < crop["width"] * crop["height"] * 0.98:
                    crop = content_crop
                    rooms = filter_rooms_to_crop(rooms, crop)
                    labels = filter_labels_to_crop(labels, crop)
                    if structure and structure.get("boundary") and len(structure["boundary"]) >= 4:
                        boundary = structure["boundary"]
                    else:
                        boundary = _choose_building_boundary(crop, envelopes, rooms)
                    previous = dict(extract_page.rulersHidden or {})
                    extract_page.rulersHidden = {
                        **previous,
                        "mode": (
                            f"content-crop+{previous['mode']}"
                            if previous.get("grayStrokesRemoved") or previous.get("mode")
                            else "content-crop"
                        ),
                        "goal": "clean-map",
                        "probe": probe_pdf_optional_content(pdf_path, page_index),
                        "footprintBox": footprint_box,
                    }
            labels.sort(key=lambda item: (-item["size"], item["y"], item["x"]))
            labels = labels[:MAX_LABELS]
    except PdfRejected:
        raise
    except Exception as error:
        raise PdfRejected("无法解析这份 PDF 的矢量内容。") from error
    if not rooms:
        if kind == "cad":
            raise PdfRejected("未找到闭合房间。请确认 CAD 墙线闭合，并可框选含墙线的有效区域后再试。")
        raise PdfRejected("未找到房间色块。请确认裁剪只包含平面图，且图纸带有填充区域。扫描件识别尚未接入。")
    if not boundary or len(boundary) < 3:
        if kind == "cad":
            raise PdfRejected("未找到建筑轮廓。CAD 将按房间核生成地图范围，请确认主体墙线可识别。")
        raise PdfRejected("未找到建筑轮廓。请确认裁剪范围内包含平面图矢量填充。")
    return size, crop, rooms, labels, boundary


def _cell_size(crop):
    longest = max(crop["width"], crop["height"])
    return max(2, int(math.ceil(longest / 500)))


def _grid_metrics(cell, mask_scale):
    """Pixel step and PDF-unit step of one occupancy-grid cell.

    Walkable canvases may be rasterized above 72 DPI. Downsample must use the
    pixel step; graph emission still talks in PDF units via ``grid_cell``.
    """
    cell_px = max(1, int(round(cell * mask_scale)))
    return cell_px, cell_px / float(mask_scale)


def _kind_from_labels(room, labels):
    for label in labels:
        if label.get("roomId") == room["id"] or contains((label["x"], label["y"]), room["polygonPdf"]):
            category = classify_label(label["text"])
            if category in {"elevator", "escalator", "stairs", "courtyard"}:
                return category
    return room["kind"]


def _downsample(mask, cell):
    """AND-reduce a boolean mask by ``cell`` pixels per occupancy-grid step."""
    height, width = mask.shape
    trimmed = mask[: height // cell * cell, : width // cell * cell]
    if trimmed.size == 0:
        return np.zeros((1, 1), dtype=bool)
    return trimmed.reshape(height // cell, cell, width // cell, cell).all(axis=(1, 3))


def _dilate(mask):
    padded = np.pad(mask.astype(np.uint8), 1)
    stacked = np.stack([
        padded[:-2, 1:-1], padded[2:, 1:-1], padded[1:-1, :-2], padded[1:-1, 2:],
        padded[1:-1, 1:-1], padded[:-2, :-2], padded[:-2, 2:], padded[2:, :-2], padded[2:, 2:],
    ])
    return stacked.max(axis=0).astype(bool)


def _erode(mask):
    padded = np.pad(mask.astype(np.uint8), 1)
    stacked = np.stack([
        padded[:-2, 1:-1], padded[2:, 1:-1], padded[1:-1, :-2], padded[1:-1, 2:],
        padded[1:-1, 1:-1], padded[:-2, :-2], padded[:-2, 2:], padded[2:, :-2], padded[2:, 2:],
    ])
    return stacked.min(axis=0).astype(bool)


def close_binary(mask, radius=1):
    out = mask
    for _ in range(max(0, radius)):
        out = _dilate(out)
    for _ in range(max(0, radius)):
        out = _erode(out)
    return out


def _bfs_path(allowed, src_mask, dst_mask, limit):
    height, width = allowed.shape
    queue = deque()
    parent = {}
    src_y, src_x = np.nonzero(src_mask)
    for x, y in zip(src_x.tolist(), src_y.tolist()):
        queue.append((x, y))
        parent[(x, y)] = None
    dist = {key: 0 for key in parent}
    while queue:
        x, y = queue.popleft()
        if dist[(x, y)] > limit:
            continue
        if dst_mask[y, x]:
            path = []
            node = (x, y)
            while node is not None:
                path.append(node)
                node = parent[node]
            return path[::-1]
        step = dist[(x, y)] + 1
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < width and 0 <= ny < height and (nx, ny) not in parent and allowed[ny, nx]:
                parent[(nx, ny)] = (x, y)
                dist[(nx, ny)] = step
                queue.append((nx, ny))
    return None


def _paint_path(mask, path, allowed=None, width=1):
    height, width_n = mask.shape
    for x, y in path:
        for dx in range(-width, width + 1):
            for dy in range(-width, width + 1):
                nx, ny = x + dx, y + dy
                if 0 <= nx < width_n and 0 <= ny < height:
                    if allowed is None or allowed[ny, nx]:
                        mask[ny, nx] = True


def repair_walkable_grid(safe, walkable, max_path=120):
    """Reconnect corridors pinched by clearance; fill only short leftover gaps."""
    notes = []
    labels, sizes = components(safe)
    if len(sizes) <= 1:
        return safe, notes
    repaired = safe.copy()
    order = sorted(range(1, len(sizes) + 1), key=lambda item: -sizes[item - 1])
    main = order[0]
    for lab in order[1:]:
        src = labels == lab
        dst = labels == main
        path = _bfs_path(walkable, src, dst, max_path)
        if path:
            _paint_path(repaired, path, allowed=walkable, width=1)
            notes.append(f"已接回被挤断的走廊片段（{sizes[lab - 1]} 格）")
            continue
        path = _bfs_path(np.ones_like(safe, dtype=bool), src, dst, MAX_BRIDGE_CELLS)
        if path and len(path) <= MAX_BRIDGE_CELLS:
            _paint_path(repaired, path, allowed=None, width=0)
            notes.append(f"已填补 {len(path)} 格窄缝")
            continue
        if sizes[lab - 1] < 12:
            repaired[src] = False
            notes.append(f"已忽略过小的孤立区域（{sizes[lab - 1]} 格）")
        else:
            notes.append(f"仍有独立可走区域（{sizes[lab - 1]} 格），未强行穿墙")
    return repaired, notes


def repair_skeleton(skeleton, grid, max_path=160):
    labels, sizes = components(skeleton)
    if len(sizes) <= 1:
        return skeleton, []
    notes = []
    repaired = skeleton.copy()
    order = sorted(range(1, len(sizes) + 1), key=lambda item: -sizes[item - 1])
    main = order[0]
    for lab in order[1:]:
        path = _bfs_path(grid, labels == lab, labels == main, max_path)
        if path:
            _paint_path(repaired, path, allowed=grid, width=0)
            notes.append(f"已接上走廊骨架片段（{sizes[lab - 1]} 格）")
    return repaired, notes


def nearest_walkable(point, all_x, all_y, cell):
    if all_x.size == 0:
        return None, math.inf
    distances = ((all_x + 0.5) * cell - point[0]) ** 2 + ((all_y + 0.5) * cell - point[1]) ** 2
    index = int(np.argmin(distances))
    snap = float(distances[index] ** 0.5)
    return (int(all_x[index]), int(all_y[index])), snap


def snap_anchor(point, rooms, all_x, all_y, cell):
    grid_point, snap = nearest_walkable(point, all_x, all_y, cell)
    if grid_point is not None and snap <= SNAP_LIMIT:
        return grid_point, snap, "label"
    room, _ = nearest_room(tuple(point), rooms, max_dist=48)
    if room:
        boundary = closest_boundary(point, room["polygonPdf"])
        cx, cy = _centroid(room["polygonPdf"])
        vx, vy = boundary[0] - cx, boundary[1] - cy
        length = math.hypot(vx, vy) or 1
        outside = [boundary[0] + 10 * vx / length, boundary[1] + 10 * vy / length]
        grid_point, snap = nearest_walkable(outside, all_x, all_y, cell)
        if grid_point is not None and snap <= SNAP_LIMIT_HARD:
            return grid_point, snap, "room-edge"
    grid_point, snap = nearest_walkable(point, all_x, all_y, cell)
    if grid_point is not None and snap <= SNAP_LIMIT_HARD:
        return grid_point, snap, "nearest"
    return None, snap, "failed"


def _attach_poi_node(nodes, edges, ids, position, poi, grid_point, chain, cell):
    node_id = f"poi:{poi['id']}"
    poi["nodeId"] = node_id
    nodes.append({"id": node_id, "position": position(grid_point), "kind": "poi", "poiId": poi["id"]})
    target = ids[chain[-1]] if chain else None
    if target:
        edges.append({
            "id": f"access:{poi['id']}",
            "source": node_id,
            "target": target,
            "lengthMapUnits": round(sum(math.dist(a, b) * cell for a, b in zip(chain, chain[1:])), 4),
            "polyline": [position(item) for item in simplify(chain)],
            "enabled": True,
            "mode": "walk",
            "accessibility": "unknown",
        })


def _nearest_junction(document, pos):
    size = (document.get("source") or {}).get("pdfSize") or [1, 1]
    best = None
    for node in document.get("graph", {}).get("nodes") or []:
        if node.get("kind") == "poi":
            continue
        delta = math.hypot((node["position"][0] - pos[0]) * size[0], (node["position"][1] - pos[1]) * size[1])
        if best is None or delta < best[0]:
            best = (delta, node)
    return best


def _attach_existing_poi(document, poi, pos):
    found = _nearest_junction(document, pos)
    poi["labelPosition"] = [round(pos[0], 7), round(pos[1], 7)]
    poi["requestedAnchor"] = poi["labelPosition"]
    if not found:
        poi["position"] = poi["labelPosition"]
        poi["nodeId"] = None
        return
    _, node = found
    poi["position"] = node["position"]
    node_id = f"poi:{poi['id']}"
    poi["nodeId"] = node_id
    nodes = document["graph"]["nodes"]
    edges = document["graph"]["edges"]
    nodes[:] = [item for item in nodes if item.get("id") != node_id]
    edges[:] = [item for item in edges if item.get("id") != f"access:{poi['id']}"]
    nodes.append({"id": node_id, "position": node["position"], "kind": "poi", "poiId": poi["id"]})
    edges.append({
        "id": f"access:{poi['id']}",
        "source": node_id,
        "target": node["id"],
        "lengthMapUnits": round(max(found[0], 0.01), 4),
        "polyline": [poi["position"], node["position"]] if poi["position"] != node["position"] else [node["position"]],
        "enabled": True,
        "mode": "walk",
        "accessibility": "unknown",
    })


ROOM_POI_CATEGORIES = {"room", "department", "office", "shop"}


def _is_room_place_poi(poi):
    if str(poi.get("id") or "").startswith("icon-"):
        return False
    category = poi.get("category")
    return (not category) or category in ROOM_POI_CATEGORIES


def _poi_for_room(document, room_id):
    wanted = f"room-{room_id}"
    linked = None
    for poi in document.get("pois") or []:
        if poi.get("id") == wanted:
            return poi
        if poi.get("roomId") == room_id and _is_room_place_poi(poi) and linked is None:
            linked = poi
    return linked


def _upsert_room_door(document, poi, obstacle):
    doors = document.setdefault("doors", [])
    poi_id = poi["id"]
    doors[:] = [item for item in doors if item.get("id") != f"door:{poi_id}" and item.get("poiId") != poi_id]
    polygon = obstacle.get("polygon") or []
    arrival = poi.get("position") or poi.get("labelPosition")
    if not arrival:
        return
    door_pos = closest_boundary(arrival, polygon) if len(polygon) >= 2 else arrival
    doors.append({
        "id": f"door:{poi_id}",
        "poiId": poi_id,
        "obstacleId": obstacle.get("id"),
        "position": [round(door_pos[0], 7), round(door_pos[1], 7)],
        "corridorAnchor": poi.get("position") or [round(door_pos[0], 7), round(door_pos[1], 7)],
        "provenance": "demo-placement",
        "opensRoomInterior": False,
    })


def _new_named_room_poi(document, obstacle, name, position):
    room_id = obstacle["id"]
    kind = obstacle.get("kind") or "room"
    category = kind if kind in FACILITY_CATEGORIES else "room"
    x, y = position
    return {
        "id": f"room-{room_id}",
        "name": name,
        "category": category,
        "sourceLabel": name,
        "labelPosition": [round(x, 7), round(y, 7)],
        "requestedAnchor": [round(x, 7), round(y, 7)],
        "position": [round(x, 7), round(y, 7)],
        "anchorStatus": "inferred",
        "confidence": 0.62,
        "confidenceText": 0.9,
        "confidenceGeometry": 0.55,
        "confidenceMeaning": "editor-named-room",
        "notes": "由编辑页命名后接入走廊。",
        "nodeId": None,
        "roomId": room_id,
        "floorId": document.get("floorId") or (document.get("floor") or {}).get("id"),
        "componentId": None,
        "snapMapUnits": 0,
    }


def _promote_named_rooms(document, renamed_rooms=None):
    """Turn named but unlinked rooms into graph-attached POIs (same path as facility icons)."""
    renamed_rooms = renamed_rooms or {}
    obstacles = document.get("geometry", {}).get("obstacles") or []
    if not document.get("graph"):
        return document
    for obstacle in obstacles:
        room_id = obstacle.get("id")
        if not room_id or obstacle.get("kind") in {"courtyard"}:
            continue
        name = str(renamed_rooms.get(room_id) or obstacle.get("name") or "").strip()[:40]
        if not name:
            continue
        polygon = obstacle.get("polygon") or []
        if len(polygon) < 3:
            continue
        pos = _centroid(polygon)
        poi = _poi_for_room(document, room_id)
        created = False
        if poi is None:
            poi = _new_named_room_poi(document, obstacle, name, pos)
            created = True
        else:
            poi["name"] = name
            poi["roomId"] = poi.get("roomId") or room_id
        if not poi.get("nodeId"):
            _attach_existing_poi(document, poi, pos)
        if created:
            document.setdefault("pois", []).append(poi)
        if poi.get("nodeId"):
            _upsert_room_door(document, poi, obstacle)
    return document


def apply_map_edits(document, edits):
    edits = edits or empty_edits()
    renamed_pois = edits.get("renamedPois") or {}
    renamed_rooms = edits.get("renamedRooms") or {}
    moved_pois = edits.get("movedPois") or {}
    room_colors = edits.get("roomColors") or {}
    icons = edits.get("facilityIcons") or []
    known_rooms = {item.get("id") for item in document.get("geometry", {}).get("obstacles", [])}
    for obstacle in document.get("geometry", {}).get("obstacles", []):
        if obstacle["id"] in renamed_rooms:
            obstacle["name"] = str(renamed_rooms[obstacle["id"]]).strip()[:40]
        # roomColors is the full override set: listed rooms get fillColor, others lose it.
        if obstacle["id"] in room_colors:
            color = normalize_room_color(room_colors[obstacle["id"]])
            if color:
                obstacle["fillColor"] = color
            else:
                obstacle.pop("fillColor", None)
        else:
            obstacle.pop("fillColor", None)
    for poi in document.get("pois", []):
        name = renamed_pois.get(poi["id"])
        if not name and poi.get("roomId") and _is_room_place_poi(poi):
            name = renamed_rooms.get(poi["roomId"])
        if not name:
            name = renamed_pois.get(poi.get("sourceLabel") or "")
        if name:
            text = str(name).strip()[:40]
            if text:
                poi["name"] = text
                poi["notes"] = "人工修订名称。"
        moved = moved_pois.get(poi["id"])
        if str(poi.get("id", "")).startswith("icon-"):
            continue
        if isinstance(moved, (list, tuple)) and len(moved) == 2:
            try:
                mx, my = float(moved[0]), float(moved[1])
            except (TypeError, ValueError):
                mx = my = None
            if mx is not None and 0 <= mx <= 1 and 0 <= my <= 1:
                poi["labelPosition"] = [round(mx, 7), round(my, 7)]
                poi["requestedAnchor"] = poi["labelPosition"]
    drop_ids = {poi["id"] for poi in document.get("pois", []) if str(poi["id"]).startswith("icon-")}
    document["pois"] = [poi for poi in document.get("pois", []) if poi["id"] not in drop_ids]
    document["graph"]["nodes"] = [node for node in document["graph"]["nodes"] if node.get("poiId") not in drop_ids]
    document["graph"]["edges"] = [edge for edge in document["graph"]["edges"] if not str(edge.get("id", "")).startswith("access:icon-")]
    document["doors"] = [door for door in document.get("doors", []) if door.get("poiId") not in drop_ids]
    existing = {poi["id"]: poi for poi in document["pois"]}
    for index, icon in enumerate(icons, start=1):
        pos = icon.get("position")
        if not isinstance(pos, (list, tuple)) or len(pos) != 2:
            continue
        try:
            x, y = float(pos[0]), float(pos[1])
        except (TypeError, ValueError):
            continue
        if not (0 <= x <= 1 and 0 <= y <= 1):
            continue
        category = icon.get("category") or "service"
        if category not in FACILITY_CATEGORIES:
            category = "service"
        poi_id = str(icon.get("id") or f"icon-{index}")
        if not poi_id.startswith("icon-"):
            poi_id = f"icon-{poi_id}"
        name = str(icon.get("name") or renamed_pois.get(poi_id) or FACILITY_NAMES.get(category) or "设施").strip()[:40]
        room_id = str(icon.get("roomId") or "").strip() or None
        if room_id not in known_rooms:
            room_id = None
        poi = {
            "id": poi_id,
            "name": name,
            "category": category,
            "sourceLabel": name,
            "labelPosition": [round(x, 7), round(y, 7)],
            "requestedAnchor": [round(x, 7), round(y, 7)],
            "position": [round(x, 7), round(y, 7)],
            "anchorStatus": "inferred",
            "confidence": 0.9,
            "confidenceText": 0.9,
            "confidenceGeometry": 0.5,
            "confidenceMeaning": "editor-placed-facility-icon",
            "notes": "在编辑页放置的设施图标。",
            "nodeId": None,
            "roomId": room_id,
            "floorId": document.get("floorId") or document.get("floor", {}).get("id"),
            "componentId": None,
            "snapMapUnits": 0,
        }
        _attach_existing_poi(document, poi, [x, y])
        if poi_id in existing:
            document["pois"] = [item for item in document["pois"] if item["id"] != poi_id]
        document["pois"].append(poi)
        existing[poi_id] = poi
    _promote_named_rooms(document, renamed_rooms)
    return document


def _edits_for(project, floor_id):
    by_floor = project.get("editsByFloor") or {}
    if floor_id and by_floor.get(floor_id):
        return by_floor[floor_id]
    return project.get("draft", {}).get("edits") or empty_edits()


def build_snapshot(pdf_path, project):
    draft = project["draft"]
    page = draft["page"]
    floor = normalize_floor(draft.get("floor"), page["index"])
    source_kind = normalize_source_kind(draft.get("sourceKind") or project.get("sourceKind"))
    size, crop, rooms, labels, boundary = extract_page(
        pdf_path, page["index"], page.get("crop"), source_kind=source_kind,
    )
    edits = _edits_for(project, floor["id"])
    renamed_rooms = edits.get("renamedRooms") or {}
    for room in rooms:
        room["kind"] = _kind_from_labels(room, labels)
        named = next((label["text"] for label in labels if label.get("roomId") == room["id"]), None)
        if named:
            room["name"] = named
        renamed = renamed_rooms.get(room["id"])
        if renamed:
            room["name"] = str(renamed).strip()[:40]
    closed, mask_scale = _build_walkable_canvas(size, crop, rooms, boundary=boundary)
    cell = _cell_size(crop)
    cell_px, grid_cell = _grid_metrics(cell, mask_scale)
    walkable_grid = _downsample(np.array(closed) > 0, cell_px)
    safe_full = closed.filter(ImageFilter.MinFilter(2 * min(cell, 3) + 1))
    safe_grid = _downsample(np.array(safe_full) > 0, cell_px)
    if int(safe_grid.sum()) < 20:
        safe_grid = walkable_grid
    connectivity = []
    if int(walkable_grid.sum()) >= 20:
        safe_grid, repaired = repair_walkable_grid(safe_grid, walkable_grid)
        connectivity.extend(repaired)
    if int(safe_grid.sum()) < 20:
        if source_kind == "cad":
            raise PdfRejected("走廊空白不足。CAD 已按房间核生成通道，请确认墙线未把走廊封死。")
        raise PdfRejected("裁剪范围内没有足够的走廊空白。请把图例排除在外，并保留房间之间的通道。")
    _, counts = components(safe_grid)
    skeleton = skeletonize(safe_grid)
    skeleton, skeleton_notes = repair_skeleton(skeleton, safe_grid)
    connectivity.extend(skeleton_notes)
    if int(skeleton.sum()) < 4:
        if source_kind == "cad":
            raise PdfRejected("无法从走廊生成路线网络。请确认 CAD 通道连续，不必框掉标尺。")
        raise PdfRejected("无法从走廊生成路线网络。请调整裁剪范围后再试。")
    all_y, all_x = np.nonzero(safe_grid)
    forced, attachments, warnings = set(), [], []

    def attach_source(source, kind, requested):
        grid_point, snap, method = snap_anchor(requested, rooms, all_x, all_y, grid_cell)
        if grid_point is None:
            warnings.append(f"{source.get('text') or source.get('id')}：离可走区域过远，未接入路线")
            attachments.append((source, None, None, snap, kind))
            return
        chain = path_to_skeleton(grid_point, skeleton, safe_grid)
        if chain is None:
            warnings.append(f"{source.get('text') or source.get('id')}：所在通道没有中心线")
            attachments.append((source, grid_point, None, snap, kind))
            return
        if method != "label" and snap > SNAP_LIMIT:
            warnings.append(f"{source.get('text') or source.get('id')}：已从房间边缘接到走廊")
        forced.add(chain[-1])
        attachments.append((source, grid_point, chain, snap, kind))

    for label in labels:
        attach_source(label, "label", [label["x"], label["y"]])
    labeled_rooms = {label.get("roomId") for label in labels if label.get("roomId")}
    for room in rooms:
        if room["id"] in labeled_rooms or room["kind"] in {"courtyard"}:
            continue
        if room["kind"] in {"room", "counter"} and not room.get("name"):
            continue
        attach_source(room, "room", _centroid(room["polygonPdf"]))

    nodes, edges, ids, position = build_graph(skeleton, safe_grid, forced, grid_cell, size)
    pois, doors, pending_labels = [], [], []
    used_names = {}
    used_rooms = set()
    for index, (source, grid_point, chain, snap, kind) in enumerate(attachments, start=1):
        if grid_point is None:
            continue
        if kind == "label":
            name = source["text"]
            used_names[name] = used_names.get(name, 0) + 1
            if used_names[name] > 1:
                name = f"{source['text']} {used_names[name]}"
            room_id = source.get("roomId")
            if room_id and room_id not in used_rooms:
                poi_id = f"room-{room_id}"
                used_rooms.add(room_id)
            else:
                poi_id = f"label-{index}"
            category = classify_label(source["text"])
            label_xy = [source["x"], source["y"]]
            rooms_here = [room for room in rooms if room["id"] == room_id] if room_id else [room for room in rooms if room["kind"] == "room" and contains((source["x"], source["y"]), room["polygonPdf"])]
            room_id = rooms_here[0]["id"] if rooms_here else room_id
        else:
            name = source.get("name") or "未命名房间"
            poi_id = f"room-{source['id']}"
            if poi_id in {poi["id"] for poi in pois}:
                continue
            category = "room"
            if source["kind"] in {"elevator", "escalator", "stairs"}:
                category = source["kind"]
                name = FACILITY_NAMES.get(category, name)
            label_xy = _centroid(source["polygonPdf"])
            rooms_here = [source]
            room_id = source["id"]
            used_rooms.add(room_id)
        poi = {
            "id": poi_id,
            "name": name,
            "category": category,
            "sourceLabel": source.get("text") or name,
            "labelPosition": _norm(label_xy, size),
            "requestedAnchor": _norm(label_xy, size),
            "position": position(grid_point),
            "anchorStatus": "inferred",
            "confidence": 0.62,
            "confidenceText": 0.78 if kind == "label" else 0.35,
            "confidenceGeometry": 0.55,
            "confidenceMeaning": "pdf-text-and-fill-extraction-not-surveyed",
            "notes": (
                "由 CAD Vision OCR 与房间色块自动生成，需人工核对。"
                if source.get("source") == "cad-vision-ocr"
                else "由 PDF 文字层与房间色块自动生成，需人工核对。"
            ),
            "nodeId": None,
            "roomId": room_id,
            "floorId": floor["id"],
            "componentId": None,
            "snapMapUnits": round(snap, 2),
        }
        pending_labels.append({
            "id": poi_id,
            "text": name,
            "source": (
                "cad-vision-ocr" if source.get("source") == "cad-vision-ocr"
                else "pdf-text-layer" if kind == "label"
                else "unnamed-room"
            ),
            "confidenceText": poi["confidenceText"],
        })
        if rooms_here:
            arrival = [(grid_point[0] + 0.5) * grid_cell, (grid_point[1] + 0.5) * grid_cell]
            door_pos = closest_boundary(arrival, rooms_here[0]["polygonPdf"])
            doors.append({
                "id": f"door:{poi_id}",
                "poiId": poi_id,
                "obstacleId": room_id,
                "position": _norm(door_pos, size),
                "corridorAnchor": position(grid_point),
                "provenance": "demo-placement",
                "opensRoomInterior": False,
            })
            rooms_here[0]["name"] = rooms_here[0].get("name") or name
        if chain:
            _attach_poi_node(nodes, edges, ids, position, poi, grid_point, chain, grid_cell)
        pois.append(poi)
    # Prefer CAD swing-arc door openings on the outer wall (and any unmatched arcs).
    cad_doors = getattr(extract_page, "cadDoors", None) or []
    if cad_doors:
        doors = _merge_cad_doors(doors, cad_doors, size, rooms)
    if not any(poi.get("nodeId") for poi in pois):
        if source_kind == "cad":
            raise PdfRejected("提取到了房间，但文字无法接到走廊。请确认通道未被墙线封死。")
        raise PdfRejected("提取到了房间，但文字无法接到走廊。请框选含通道的地图范围。")
    source_file = (project.get("draft") or {}).get("sourceFile") or project["sourceFile"]
    file_name = source_file.get("fileName") or "upload.pdf"
    asset = f"/api/projects/{project['id']}/maps/{floor['id']}"
    document = {
        "schemaVersion": "1.0.0",
        "id": f"maker-{project['id'][:8]}-{floor['id']}",
        "name": f"{floor['name']} · {file_name}",
        "status": "demo",
        "floorId": floor["id"],
        "floor": floor,
        "origin": "maker",
        "source": {
            "url": "",
            "pdfUrl": project.get("fileUrl") or f"/api/projects/{project['id']}/file",
            "pdfSha256": source_file["sha256"],
            "page": page["index"],
            "pdfSize": size,
            "imageSize": [int(round(crop["width"])), int(round(crop["height"]))],
            "imageUrl": "",
            "projectId": project["id"],
            "draftRevision": draft["revision"],
            "sourceKind": source_kind,
        },
        "calibration": None,
        "geometry": {
            "buildingBoundary": [_norm(point, size) for point in boundary],
            "obstacles": [
                {
                    "id": room["id"],
                    "kind": room["kind"],
                    "color": room["color"],
                    "sourceObject": room["sourceObject"],
                    "name": room.get("name"),
                    "polygon": [_norm(point, size) for point in room["polygonPdf"]],
                }
                for room in rooms
            ],
            "wallSegments": [],
            "walkableMaskUrl": f"{asset}/walkable-mask.png",
            "safeMaskUrl": f"{asset}/safe-mask.png",
            "walkableOverlayUrl": f"{asset}/walkable-overlay.png",
            "clearance": {"value": cell, "unit": "pdf-map-unit", "physicalRadiusVerified": False},
        },
        "pois": pois,
        "doors": doors,
        "graph": {
            "algorithm": "skeleton-topology-with-shortest-path",
            "coordinateSystem": "normalized-top-left",
            "nodes": nodes,
            "edges": edges,
        },
        "notes": [
            "由 CAD 图纸识别生成（可框选有效区域），不是施工图级模型。" if source_kind == "cad" else "由选页与裁剪自动提取，不是施工图级模型。",
            "生成前按 recover-cad-pdf-layers 恢复/隐藏标尺层（OCG 或 style-run 重建），再收紧楼层主体；地图不含标尺线。" if source_kind == "cad" else "白色或浅色间隙被当作走廊；深色图例应排除在裁剪外。",
            "2D/3D 外观与平面地图同一套材质。" if source_kind == "cad" else "生成时会尝试接上被挤断的走廊；门位按最近走廊到达点示意。",
        ],
    }
    document = apply_map_edits(document, _edits_for(project, floor["id"]))
    cad_cal = getattr(extract_page, "calibration", None)
    if isinstance(cad_cal, dict) and isinstance(cad_cal.get("metersPerMapUnit"), (int, float)) and cad_cal["metersPerMapUnit"] > 0:
        document["calibration"] = {
            "metersPerMapUnit": cad_cal["metersPerMapUnit"],
            "source": cad_cal.get("source") or "cad-ocr-ratio",
            "ratio": cad_cal.get("ratio"),
        }
    overlay = Image.new("RGBA", closed.size, (0, 0, 0, 0))
    rgba = np.array(overlay)
    walkable_pixels = np.zeros(closed.size[::-1], dtype=bool)
    height_px, width_px = walkable_pixels.shape
    for gy, gx in zip(*np.nonzero(safe_grid)):
        y0, y1 = gy * cell_px, min((gy + 1) * cell_px, height_px)
        x0, x1 = gx * cell_px, min((gx + 1) * cell_px, width_px)
        walkable_pixels[y0:y1, x0:x1] = True
    rgba[walkable_pixels] = [0, 162, 146, 75]
    images = {
        "walkable-mask.png": closed,
        "safe-mask.png": safe_full,
        "walkable-overlay.png": Image.fromarray(rgba),
    }
    connected = sum(1 for poi in document["pois"] if poi.get("nodeId"))
    report = {
        "sourceHash": source_file["sha256"],
        "page": page["index"],
        "floor": floor,
        "crop": crop,
        "sourceKind": source_kind,
        "poiCount": len(document["pois"]),
        "connectedPoiCount": connected,
        "roomAndObstacleCount": len(rooms),
        "textTokenCount": len(labels),
        "walkableComponents": counts,
        "graphNodes": len(document["graph"]["nodes"]),
        "graphEdges": len(document["graph"]["edges"]),
        "warnings": warnings,
        "connectivity": connectivity,
        "cadCalibration": getattr(extract_page, "calibration", None),
        "rulersHidden": getattr(extract_page, "rulersHidden", None),
        "unverified": [
            "自动识别结果需人工核对名称、房间边界和门位",
            "真实比例未标定" if not document.get("calibration") else "真实比例来自 CAD OCR 比例尺，需人工核对",
            "扫描件与无矢量填充的图纸尚未支持",
        ],
    }
    candidates = {
        "rooms": [
            {"id": room["id"], "kind": room["kind"], "source": "pdf-fill", "confidenceGeometry": 0.55}
            for room in rooms
        ],
        "corridors": [{"id": "crop-remainder", "source": "unfilled-space", "confidenceGeometry": 0.45}],
        "labels": pending_labels,
        "doors": [{"id": door["id"], "source": "inferred-corridor-anchor", "confidenceDoor": 0.3} for door in document["doors"]],
    }
    pending = [{
        "id": "review-extraction",
        "kind": "review",
        "message": (
            "三维已生成。CAD 地图不含标尺与面积；请核对房间名和可达路线。"
            if source_kind == "cad"
            else "三维已生成，请核对应科室名称、裁剪范围和可达路线。"
        ),
    }]
    pending.extend({"id": f"warn-{index}", "kind": "warning", "message": message} for index, message in enumerate((warnings + connectivity)[:12], start=1))
    return document, report, images, candidates, pending

"""North-arrow detection on CAD sheets (vector only, no text layer needed).

A north arrow is a circle (stroked, radius ~8–60 pt, drawn as Bézier arcs or a fine polyline)
holding a filled needle/triangle whose far tip points north. Axis bubbles are circles too, but
hold no filled shape spanning the circle. Returns the compass bearing of north on the plan
(0 = page up, 90 = right, 180 = down, 270 = left) or None.
"""
from __future__ import annotations

import math


def _points(path):
    pts = []
    for item in path.get("items") or []:
        for v in item[1:]:
            if hasattr(v, "x") and hasattr(v, "y"):
                pts.append((float(v.x), float(v.y)))
            elif hasattr(v, "x0"):  # rect
                pts += [(v.x0, v.y0), (v.x1, v.y1)]
    return pts


def _circle(path):
    pts = _points(path)
    if len(pts) < 8:
        return None
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    rs = [math.hypot(x - cx, y - cy) for x, y in pts]
    r = sum(rs) / len(rs)
    if not 8 <= r <= 60:
        return None
    if max(abs(v - r) for v in rs) > 0.12 * r:
        return None
    # Must go most of the way round.
    angles = sorted(math.atan2(y - cy, x - cx) for x, y in pts)
    gaps = [b - a for a, b in zip(angles, angles[1:])] + [angles[0] + 2 * math.pi - angles[-1]]
    if max(gaps) > math.pi / 2:
        return None
    return cx, cy, r


def bearing_on_page(page):
    drawings = page.get_drawings()
    circles = [c for c in (_circle(d) for d in drawings) if c]
    best = None
    for cx, cy, r in circles:
        for d in drawings:
            if d.get("fill") is None:
                continue
            pts = _points(d)
            if len(pts) < 3:
                continue
            if any(math.hypot(x - cx, y - cy) > 1.35 * r for x, y in pts):
                continue
            far = max(pts, key=lambda p: math.hypot(p[0] - cx, p[1] - cy))
            reach = math.hypot(far[0] - cx, far[1] - cy)
            xs, ys = [p[0] for p in pts], [p[1] for p in pts]
            span = math.hypot(max(xs) - min(xs), max(ys) - min(ys))
            # A needle: tip near the rim, long and narrow, not a solid disc / column dot.
            if reach < 0.6 * r or span < 0.9 * r:
                continue
            area = 0.0
            for i in range(len(pts)):
                x0, y0 = pts[i]
                x1, y1 = pts[(i + 1) % len(pts)]
                area += x0 * y1 - x1 * y0
            if abs(area) / 2 > 0.6 * math.pi * r * r:
                continue
            score = reach / r
            if best is None or score > best[0]:
                # The needle's apex is the vertex farthest (on average) from the others: the
                # base corners sit together at the tail end.
                uniq = []
                for q in pts:
                    if all(math.hypot(q[0] - u[0], q[1] - u[1]) > 0.5 for u in uniq):
                        uniq.append(q)
                apex = max(uniq, key=lambda q: sum(math.hypot(q[0] - u[0], q[1] - u[1]) for u in uniq))
                rest = [u for u in uniq if u is not apex] or [(cx, cy)]
                bx, by = sum(u[0] for u in rest) / len(rest), sum(u[1] for u in rest) / len(rest)
                dx, dy = apex[0] - bx, apex[1] - by
                best = (score, (math.degrees(math.atan2(dx, -dy)) + 360) % 360, (cx, cy, r))
    if not best:
        return None
    return {"bearing": round(best[1], 1), "at": [round(v, 1) for v in best[2]]}


def detect_north(pdf_path):
    """First north arrow found in the document (any page, margins included)."""
    import pymupdf
    doc = pymupdf.open(str(pdf_path))
    try:
        for index, page in enumerate(doc):
            found = bearing_on_page(page)
            if found:
                return {**found, "page": index + 1}
    finally:
        doc.close()
    return None

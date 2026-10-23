"""CAD line-art → recognition fills for maker extract_page.

Pre-pipeline only: invent pastel room polygons so the existing color-block
extractor can see rooms. Does not restyle 2D/3D materials.

Layer policy (recover-cad-pdf-layers skill):
1. Prefer native OCG / path layer names when present.
2. Otherwise reconstruct candidate layers from ordered style runs
   (consecutive paths sharing visual state — not proven CAD layers).
3. Hide reconstructed axis/ruler candidates before map generation so
   mid-gray grids never become walls or stay in the map.
"""
from __future__ import annotations

import ctypes
import json
import math
import re
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

# Pastels with luma > 0.35 and min(channel) < 0.93 so _is_room_fill_color accepts them
# and map-art.roomColor keeps the tint (same family as Gifu fills).
CAD_FILL_PALETTE = [
    [0.78, 0.86, 0.90],
    [0.86, 0.82, 0.90],
    [0.78, 0.88, 0.82],
    [0.90, 0.84, 0.74],
    [0.84, 0.80, 0.88],
    [0.88, 0.82, 0.72],
    [0.80, 0.84, 0.90],
    [0.86, 0.78, 0.84],
]
CAD_FILL_DPI = 48
CAD_CLOSE_RADIUS = 2
CAD_MIN_AREA = 3200
CAD_MAX_AREA_FRAC = 0.42
CAD_MIN_FILL_RATIO = 0.38
CAD_MAX_ASPECT = 3.8
CAD_MIN_SIDE = 28.0

# Ghostscript CAD sheets: walls ≈ black; background ruler grid ≈ gray 0.30 (≈77).
CAD_INK_MAX = 90
# Tight band around Ghostscript grid gray (~0.302 → 77); avoid eating wall AA.
CAD_GRID_GRAY_LO = 70
CAD_GRID_GRAY_HI = 85
CAD_GRID_CHANNEL_DELTA = 6

# Page-fraction body inset (same research clips as maker_ocr.BODY_INSET).
CAD_BODY_INSET = (0.145, 0.25, 0.71, 0.82)

RULER_OCG_RE = re.compile(
    r"ruler|dimension|dim\b|grid|axis|defpoint|标尺|尺寸|轴网|轴号|图框|viewport",
    re.I,
)


def _components_cv2(mask, connectivity):
    """OpenCV labelling (RapidOCR installs it); ``None`` when cv2 is missing."""
    try:
        import cv2
    except ImportError:
        return None
    _count, labels, stats, _centroids = cv2.connectedComponentsWithStats(
        np.ascontiguousarray(mask, dtype=np.uint8), connectivity=connectivity,
    )
    return labels.astype(np.int32), [int(v) for v in stats[1:, cv2.CC_STAT_AREA]]


def _components4(mask):
    fast = _components_cv2(mask, 4)
    if fast is not None:
        return fast
    labels = np.zeros(mask.shape, dtype=np.int32)
    sizes = []
    height, width = mask.shape
    for y, x in zip(*np.nonzero(mask)):
        if labels[y, x]:
            continue
        label = len(sizes) + 1
        queue = deque([(int(x), int(y))])
        labels[y, x] = label
        count = 0
        while queue:
            px, py = queue.popleft()
            count += 1
            for nx, ny in ((px + 1, py), (px - 1, py), (px, py + 1), (px, py - 1)):
                if 0 <= nx < width and 0 <= ny < height and mask[ny, nx] and not labels[ny, nx]:
                    labels[ny, nx] = label
                    queue.append((nx, ny))
        sizes.append(count)
    return labels, sizes


def _close_mask(mask, radius):
    if radius <= 0:
        return mask
    kernel = 2 * radius + 1
    try:
        import cv2
    except ImportError:
        cv2 = None
    if cv2 is not None:
        square = np.ones((kernel, kernel), np.uint8)
        return cv2.erode(cv2.dilate(mask.astype(np.uint8), square), square) > 0
    image = Image.fromarray(mask.astype(np.uint8) * 255)
    image = image.filter(ImageFilter.MaxFilter(kernel)).filter(ImageFilter.MinFilter(kernel))
    return np.array(image) > 127


def _maxpool2(mask):
    height, width = mask.shape
    height -= height % 2
    width -= width % 2
    if height < 2 or width < 2:
        return mask
    return mask[:height, :width].reshape(height // 2, 2, width // 2, 2).max(axis=(1, 3))


def _border_labels(labels):
    height, width = labels.shape
    border = set()
    for x in range(width):
        if labels[0, x]:
            border.add(int(labels[0, x]))
        if labels[height - 1, x]:
            border.add(int(labels[height - 1, x]))
    for y in range(height):
        if labels[y, 0]:
            border.add(int(labels[y, 0]))
        if labels[y, width - 1]:
            border.add(int(labels[y, width - 1]))
    return border


def _core_bounds(boxes, pad):
    if not boxes:
        return None
    cx = np.array([(b[0] + b[2]) / 2 for b in boxes])
    cy = np.array([(b[1] + b[3]) / 2 for b in boxes])
    x0, x1 = np.percentile(cx, [10, 90])
    y0, y1 = np.percentile(cy, [12, 88])
    core = [b for b in boxes if x0 <= (b[0] + b[2]) / 2 <= x1 and y0 <= (b[1] + b[3]) / 2 <= y1]
    if not core:
        core = boxes
    left = min(b[0] for b in core) - pad
    top = min(b[1] for b in core) - pad
    right = max(b[2] for b in core) + pad
    bottom = max(b[3] for b in core) + pad
    return left, top, right, bottom


def is_grid_gray_rgb(color):
    """True for mid-gray CAD background grid strokes (≈0.30 channel)."""
    if not color or len(color) < 3:
        return False
    r, g, b = float(color[0]), float(color[1]), float(color[2])
    if max(abs(r - g), abs(g - b), abs(r - b)) > 0.05:
        return False
    return 0.22 <= r <= 0.45


def cad_wall_ink_mask(rgb):
    """Boolean wall ink: dark strokes minus mid-gray ruler grid."""
    dark = rgb.min(axis=2)
    r = rgb[:, :, 0].astype(np.int16)
    g = rgb[:, :, 1].astype(np.int16)
    b = rgb[:, :, 2].astype(np.int16)
    grayish = (np.abs(r - g) <= CAD_GRID_CHANNEL_DELTA) & (np.abs(g - b) <= CAD_GRID_CHANNEL_DELTA)
    grid = grayish & (dark >= CAD_GRID_GRAY_LO) & (dark <= CAD_GRID_GRAY_HI)
    return (dark < CAD_INK_MAX) & ~grid


def probe_pdf_optional_content(pdf_path, page_index=1):
    """Inspect OCG / Optional Content. Empty ocgs ⇒ cannot hide by layer."""
    result = {
        "path": str(pdf_path),
        "pageIndex": page_index,
        "hasOcg": False,
        "ocgs": {},
        "rulerOcgs": [],
        "producer": None,
        "canHideByLayer": False,
        "strategy": "geometry-color",
    }
    path = Path(pdf_path)
    try:
        from pypdf import PdfReader
        reader = PdfReader(str(path), strict=False)
        info = reader.metadata or {}
        producer = getattr(info, "producer", None) or info.get("/Producer") if hasattr(info, "get") else None
        if producer:
            result["producer"] = str(producer)
        root = reader.trailer.get("/Root") if reader.trailer else None
        if root is not None:
            root_obj = root.get_object() if hasattr(root, "get_object") else root
            if hasattr(root_obj, "get") and root_obj.get("/OCProperties"):
                result["hasOcg"] = True
                result["strategy"] = "ocg-unnamed"
    except Exception as error:
        result["pypdfError"] = str(error)[:120]

    try:
        import fitz
    except ImportError:
        result["error"] = "pymupdf-missing"
        return result
    doc = fitz.open(str(path))
    try:
        meta_producer = (doc.metadata or {}).get("producer")
        if meta_producer:
            result["producer"] = meta_producer
        ocgs = doc.get_ocgs() or {}
        result["ocgs"] = {
            str(xref): {"name": info.get("name"), "on": info.get("on")}
            for xref, info in ocgs.items()
        }
        result["hasOcg"] = bool(ocgs) or result["hasOcg"]
        rulers = []
        for xref, info in ocgs.items():
            name = str(info.get("name") or "")
            if RULER_OCG_RE.search(name):
                rulers.append({"xref": xref, "name": name})
        result["rulerOcgs"] = rulers
        result["canHideByLayer"] = bool(rulers)
        if rulers:
            result["strategy"] = "ocg"
        elif ocgs:
            result["strategy"] = "ocg-unnamed"
        else:
            result["strategy"] = "reconstructed-style-runs"
        try:
            result["layerUiConfigs"] = doc.layer_ui_configs() or []
        except Exception:
            result["layerUiConfigs"] = []
    finally:
        doc.close()
    return result


def hide_ruler_ocgs(doc):
    """Turn off ruler-like OCGs on an open PyMuPDF document. Returns xrefs turned off."""
    ocgs = doc.get_ocgs() or {}
    off = []
    for xref, info in ocgs.items():
        name = str(info.get("name") or "")
        if RULER_OCG_RE.search(name):
            off.append(xref)
    if not off:
        return []
    try:
        doc.set_layer(-1, off=off)
    except Exception:
        # Older pymupdf: try per-config
        for xref in off:
            try:
                doc.set_oc(xref, on=False)
            except Exception:
                pass
    return off


def cad_content_crop_hiding_rulers(page_size, crop, labels=None, pad=96, footprint_box=None):
    """After calibration, shrink crop to floor-body so margin rulers leave the map.

    Prefers the recovered building footprint (includes left wing / annex). Falls
    back to research body inset. Room-name labels may expand the box slightly so
    named rooms are not clipped, but never re-open the title-block / axis bands
    beyond a modest pad.
    """
    width, height = float(page_size[0]), float(page_size[1])
    if footprint_box and len(footprint_box) == 4:
        fx0, fy0, fx1, fy1 = footprint_box
        pad_fp = max(24.0, pad * 0.35)
        x0, y0 = max(0.0, float(fx0) - pad_fp), max(0.0, float(fy0) - pad_fp)
        x1, y1 = min(width, float(fx1) + pad_fp), min(height, float(fy1) + pad_fp)
    else:
        fx0, fy0, fx1, fy1 = CAD_BODY_INSET
        x0, y0 = width * fx0, height * fy0
        x1, y1 = width * fx1, height * fy1
    content = [item for item in (labels or []) if item.get("source") == "cad-vision-ocr"] or (labels or [])
    if len(content) >= 3:
        xs = [item["x"] for item in content]
        ys = [item["y"] for item in content]
        # Keep body as the floor; only expand a little if labels sit near the edge.
        x0 = min(x0, max(0.0, min(xs) - pad))
        y0 = min(y0, max(0.0, min(ys) - pad))
        x1 = max(x1, min(width, max(xs) + pad))
        y1 = max(y1, min(height, max(ys) + pad))
        # Still drop the right title block / bottom title band.
        x1 = min(x1, width * 0.78)
        y1 = min(y1, height * 0.88)
        x0 = max(x0, width * 0.05)
        y0 = max(y0, height * 0.10)
    # Intersect with current crop
    cx0 = max(float(crop["x"]), x0)
    cy0 = max(float(crop["y"]), y0)
    cx1 = min(float(crop["x"]) + float(crop["width"]), x1)
    cy1 = min(float(crop["y"]) + float(crop["height"]), y1)
    if cx1 - cx0 < width * 0.25 or cy1 - cy0 < height * 0.25:
        return dict(crop)
    return {
        "x": round(cx0, 4),
        "y": round(cy0, 4),
        "width": round(cx1 - cx0, 4),
        "height": round(cy1 - cy0, 4),
    }


def item_center_in_crop(x, y, crop, pad=0):
    return (
        crop["x"] - pad <= x <= crop["x"] + crop["width"] + pad
        and crop["y"] - pad <= y <= crop["y"] + crop["height"] + pad
    )


def filter_rooms_to_crop(rooms, crop, pad=8):
    kept = []
    for room in rooms:
        source = str(room.get("sourceObject") or "")
        if room.get("kind") in {"stairs", "elevator", "escalator"} or source.startswith(("cad-stair-", "cad-elevator-")):
            kept.append(room)
            continue
        pts = room.get("polygonPdf") or []
        if not pts:
            continue
        cx = sum(p[0] for p in pts) / len(pts)
        cy = sum(p[1] for p in pts) / len(pts)
        if item_center_in_crop(cx, cy, crop, pad=pad):
            kept.append(room)
    return kept or rooms


def filter_labels_to_crop(labels, crop, pad=8):
    kept = [item for item in labels if item_center_in_crop(item["x"], item["y"], crop, pad=pad)]
    return kept or labels


def _normalized_color(value):
    if value is None:
        return None
    try:
        return tuple(round(float(v), 4) for v in value)
    except Exception:
        return None


def _style_signature(drawing):
    """Same signature used by recover-cad-pdf-layers inspect_cad_pdf.py."""
    return (
        drawing.get("type"),
        _normalized_color(drawing.get("color")),
        _normalized_color(drawing.get("fill")),
        round(float(drawing.get("width") or 0), 4),
        str(drawing.get("dashes") or ""),
        round(float(drawing.get("stroke_opacity") or 1), 4),
        round(float(drawing.get("fill_opacity") or 1), 4),
        json.dumps(drawing.get("lineCap"), sort_keys=True, default=str),
        json.dumps(drawing.get("lineJoin"), sort_keys=True, default=str),
        drawing.get("layer") or "",
        drawing.get("level", 0),
    )


def _union_rect(current, incoming):
    if incoming is None:
        return current
    if current is None:
        return list(incoming)
    return [
        min(current[0], incoming[0]),
        min(current[1], incoming[1]),
        max(current[2], incoming[2]),
        max(current[3], incoming[3]),
    ]


def make_style_runs(drawings):
    """Ordered style runs = reconstructed layer candidates (skill terminology)."""
    runs = []
    for index, drawing in enumerate(drawings):
        signature = _style_signature(drawing)
        rect = drawing.get("rect")
        try:
            bbox = [float(rect.x0), float(rect.y0), float(rect.x1), float(rect.y1)] if rect is not None else None
        except Exception:
            bbox = None
        if runs and runs[-1]["_signature"] == signature:
            run = runs[-1]
            run["end_index"] = index
            run["path_count"] += 1
            run["bbox"] = _union_rect(run["bbox"], bbox)
        else:
            runs.append({
                "_signature": signature,
                "start_index": index,
                "end_index": index,
                "path_count": 1,
                "bbox": bbox,
                "style": {
                    "type": drawing.get("type"),
                    "color": _normalized_color(drawing.get("color")),
                    "fill": _normalized_color(drawing.get("fill")),
                    "width": drawing.get("width"),
                    "dashes": drawing.get("dashes"),
                    "layer": drawing.get("layer") or "",
                    "level": drawing.get("level", 0),
                },
            })
    for run in runs:
        run.pop("_signature", None)
    return runs


def classify_reconstructed_ruler_runs(style_runs, page_width, page_height):
    """Pick reconstructed axis/ruler candidates from style runs.

    Evidence (skill CAD heuristics, labeled reconstructed — not native OCG):
    - stroke-only mid-gray color matching Ghostscript axis grids
    - large consecutive path counts (dash segments shattered by GS)
    - bbox spanning the central floor-plan envelope
    """
    page_area = max(1.0, float(page_width) * float(page_height))
    candidates = []
    for index, run in enumerate(style_runs):
        style = run.get("style") or {}
        if style.get("type") != "s":
            continue
        color = style.get("color")
        if not is_grid_gray_rgb(color):
            continue
        path_count = int(run.get("path_count") or 0)
        if path_count < 80:
            continue
        bbox = run.get("bbox")
        if not bbox:
            continue
        bw = max(0.0, bbox[2] - bbox[0])
        bh = max(0.0, bbox[3] - bbox[1])
        # Axis grids cross the floor body; tiny gray ornaments are not rulers.
        if bw < page_width * 0.25 or bh < page_height * 0.15:
            continue
        if bw * bh < page_area * 0.05:
            continue
        candidates.append({
            "runIndex": index,
            "pathCount": path_count,
            "bbox": [round(v, 4) for v in bbox],
            "color": list(color) if color else None,
            "width": style.get("width"),
            "kind": "reconstructed",
            "semantic": "axis-grid",
            "confidence": "high" if path_count >= 1000 else "medium",
        })
    candidates.sort(key=lambda item: -item["pathCount"])
    return candidates


def inspect_cad_page_layers(pdf_path, page_index=1):
    """Skill first-pass: native OCG vs reconstructed style-run candidates."""
    result = {
        "path": str(pdf_path),
        "pageIndex": page_index,
        "native": {"present": False, "ocgCount": 0, "pathLayerNames": [], "rulerOcgs": []},
        "reconstructed": {"styleRunCount": 0, "rulerCandidates": []},
        "drawingCount": 0,
        "strategy": "none",
    }
    try:
        import fitz
    except ImportError:
        result["error"] = "pymupdf-missing"
        return result
    doc = fitz.open(str(pdf_path))
    try:
        if page_index < 1 or page_index > doc.page_count:
            result["error"] = "bad-page"
            return result
        page = doc[page_index - 1]
        try:
            drawings = page.get_drawings(extended=True)
        except TypeError:
            drawings = page.get_drawings()
        result["drawingCount"] = len(drawings)
        ocgs = doc.get_ocgs() or {}
        path_layers = sorted({str(d.get("layer")) for d in drawings if d.get("layer")})
        rulers = []
        for xref, info in ocgs.items():
            name = str(info.get("name") or "")
            if RULER_OCG_RE.search(name):
                rulers.append({"xref": xref, "name": name})
        result["native"] = {
            "present": bool(ocgs or path_layers),
            "ocgCount": len(ocgs),
            "pathLayerNames": path_layers,
            "rulerOcgs": rulers,
        }
        runs = make_style_runs(drawings)
        rect = page.rect
        candidates = classify_reconstructed_ruler_runs(runs, rect.width, rect.height)
        result["reconstructed"] = {
            "styleRunCount": len(runs),
            "rulerCandidates": candidates,
        }
        if rulers:
            result["strategy"] = "native-ocg"
        elif candidates:
            result["strategy"] = "reconstructed-style-runs"
        elif ocgs or path_layers:
            result["strategy"] = "native-unnamed"
        else:
            result["strategy"] = "none"
        return result
    finally:
        doc.close()


def strip_reconstructed_ruler_strokes_pdfium(page, colors, lo=50, hi=120, delta=12):
    """Hide reconstructed ruler strokes at the pdfium object layer (in-memory)."""
    import pypdfium2.raw as pdfium_c

    # Prefer colors recovered from style runs; fall back to mid-gray band.
    targets = []
    for color in colors or []:
        if not color or len(color) < 3:
            continue
        targets.append(tuple(int(round(float(c) * 255)) for c in color[:3]))
    gone = []
    for obj in page.get_objects(max_depth=1):
        if obj.type != pdfium_c.FPDF_PAGEOBJ_PATH:
            continue
        fill = ctypes.c_int()
        stroke = ctypes.c_int()
        if not pdfium_c.FPDFPath_GetDrawMode(obj.raw, ctypes.byref(fill), ctypes.byref(stroke)):
            continue
        if not stroke.value or fill.value:
            continue
        r, g, b, a = (ctypes.c_uint() for _ in range(4))
        if not pdfium_c.FPDFPageObj_GetStrokeColor(
            obj.raw, ctypes.byref(r), ctypes.byref(g), ctypes.byref(b), ctypes.byref(a)
        ):
            continue
        if max(abs(r.value - g.value), abs(g.value - b.value), abs(r.value - b.value)) > delta:
            continue
        matched = False
        if targets:
            for tr, tg, tb in targets:
                if abs(r.value - tr) <= delta and abs(g.value - tg) <= delta and abs(b.value - tb) <= delta:
                    matched = True
                    break
        else:
            matched = lo <= r.value <= hi
        if matched:
            gone.append(obj)
    removed = len(gone)
    for obj in gone:
        page.remove_obj(obj)
    gone.clear()
    if removed:
        page.gen_content()
    return removed


def render_cad_content_hiding_rulers(pdf_path, page_index=1, dpi=CAD_FILL_DPI):
    """Recover layers (skill), hide ruler candidates, rasterize content layer.

    Returns (PIL RGB or None, meta dict).
    """
    inspection = inspect_cad_page_layers(pdf_path, page_index)
    meta = {
        "mode": inspection.get("strategy") or "none",
        "kind": "reconstructed",
        "inspection": {
            "nativePresent": bool((inspection.get("native") or {}).get("present")),
            "styleRunCount": (inspection.get("reconstructed") or {}).get("styleRunCount"),
            "rulerCandidateCount": len((inspection.get("reconstructed") or {}).get("rulerCandidates") or []),
            "drawingCount": inspection.get("drawingCount"),
        },
        "grayStrokesRemoved": 0,
        "ocgsHidden": [],
    }
    if inspection.get("error") == "pymupdf-missing":
        meta["error"] = "pymupdf-missing"
        return None, meta

    candidates = (inspection.get("reconstructed") or {}).get("rulerCandidates") or []
    colors = [c.get("color") for c in candidates if c.get("color")]

    # Native OCG hide when available.
    if inspection.get("strategy") == "native-ocg":
        try:
            import fitz
            src = fitz.open(str(pdf_path))
            try:
                hidden = hide_ruler_ocgs(src)
                meta["ocgsHidden"] = hidden
                meta["kind"] = "native"
                page = src[page_index - 1]
                mat = fitz.Matrix(dpi / 72.0, dpi / 72.0)
                pix = page.get_pixmap(matrix=mat, alpha=False)
                image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                return image, meta
            finally:
                src.close()
        except Exception as error:
            meta["ocgError"] = str(error)[:160]

    # Reconstructed style-run hide via pdfium object strip (fast, in-memory).
    if candidates or inspection.get("strategy") in {"reconstructed-style-runs", "none"}:
        try:
            import pypdfium2 as pdfium
            doc = pdfium.PdfDocument(str(pdf_path))
            try:
                if page_index < 1 or page_index > len(doc):
                    return None, meta
                page = doc[page_index - 1]
                removed = strip_reconstructed_ruler_strokes_pdfium(page, colors)
                meta["grayStrokesRemoved"] = removed
                if removed:
                    meta["mode"] = "reconstructed-style-runs"
                    meta["kind"] = "reconstructed"
                    meta["rulerCandidates"] = candidates[:5]
                image = page.render(scale=dpi / 72.0).to_pil().convert("RGB")
                # Drop page refs before doc.close to avoid pypdfium2 atexit storms.
                try:
                    page.close()
                except Exception:
                    pass
                page = None
                return image, meta
            finally:
                try:
                    doc.close()
                except Exception:
                    pass
        except Exception as error:
            meta["pdfiumError"] = str(error)[:160]

    # PyMuPDF redraw fallback (skips mid-gray strokes).
    try:
        image = render_page_without_grid_gray(pdf_path, page_index=page_index, dpi=dpi)
        meta["mode"] = "pymupdf-redraw"
        meta["kind"] = "reconstructed"
        return image, meta
    except Exception as error:
        meta["redrawError"] = str(error)[:160]
        return None, meta


def render_page_without_grid_gray(pdf_path, page_index=1, dpi=72, clip=None):
    """Rasterize page omitting mid-gray grid strokes (fallback when no OCG)."""
    import fitz

    src = fitz.open(str(pdf_path))
    try:
        page = src[page_index - 1]
        hide_ruler_ocgs(page.parent)
        rect = page.rect
        out = fitz.open()
        dst = out.new_page(width=rect.width, height=rect.height)
        shape = dst.new_shape()
        for drawing in page.get_drawings():
            color = drawing.get("color")
            fill = drawing.get("fill")
            if is_grid_gray_rgb(color) and not fill:
                continue
            if is_grid_gray_rgb(fill) and not color:
                continue
            for item in drawing.get("items") or []:
                op = item[0]
                if op == "l":
                    shape.draw_line(item[1], item[2])
                elif op == "c":
                    shape.draw_bezier(item[1], item[2], item[3], item[4])
                elif op == "re":
                    shape.draw_rect(item[1])
                elif op == "qu":
                    shape.draw_quad(item[1])
            stroke = None if color is None else color[:3]
            fill_c = None if fill is None else fill[:3]
            width = drawing.get("width") or 0.5
            if stroke or fill_c:
                shape.finish(color=stroke, fill=fill_c, width=width)
        shape.commit()
        mat = fitz.Matrix(dpi / 72.0, dpi / 72.0)
        clip_rect = fitz.Rect(clip) if clip else None
        pix = dst.get_pixmap(matrix=mat, clip=clip_rect, alpha=False)
        image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        out.close()
        return image
    finally:
        src.close()


# ---------------------------------------------------------------------------
# Vector structure layer (semantic inference on the content layer)
#
# Everything below works on the recovered *content* layer: PyMuPDF drawings
# minus the reconstructed ruler runs. Results are semantic inference (skill
# terminology), never reported as native CAD layers.
# ---------------------------------------------------------------------------

CAD_STRUCT_DPI = 72          # vector ink raster for footprint + rooms
CAD_STRUCT_POOL = 2          # 2 px → 1 cell (2 pt / cell at 72 dpi)
CAD_INK_MIN_PX = 2           # thin 0.48 pt strokes must survive rasterization
CAD_WALL_HALF = 3.4          # typical 240 mm wall at 1:100 → 6.8 pt; half = 3.4
CAD_OUTLINE_MIN_EDGE = 12.0  # drop rectilinear steps shorter than ~0.4 m
CAD_FRAME_FRAC = 0.85        # ink components spanning most of the page are frames
CAD_FOOTPRINT_MIN_SOLIDITY = 0.3
CAD_DOOR_MIN_R = 7.0
CAD_DOOR_MAX_R = 45.0
# Double-line wall thickness at 1:100 (~240mm ≈ 6.8pt) and walkable gap size.
CAD_WALL_THICKNESS = (4.5, 9.5)
CAD_WALL_GAP = (18.0, 55.0)      # opening along the wall (~0.6–1.9 m)
CAD_WALL_GAP_MERGE = 2.5         # cluster collinear wall strokes
CAD_STAIR_MIN_TREADS = 5
CAD_STAIR_SPACING = (5.0, 13.0)   # tread depth 0.18–0.45 m at 1:100
CAD_STAIR_TREAD_LEN = (15.0, 80.0)


def _label_components(mask, connectivity=4):
    """(labels, sizes) with scipy when present, else the pure-python BFS."""
    try:
        from scipy import ndimage

        structure = np.ones((3, 3), dtype=bool) if connectivity == 8 else None
        labels, count = ndimage.label(mask, structure=structure)
        if count == 0:
            return labels.astype(np.int32), []
        sizes = ndimage.sum(np.ones_like(mask, dtype=np.int32), labels, index=np.arange(1, count + 1))
        return labels.astype(np.int32), [int(v) for v in sizes]
    except ImportError:
        return _components4(mask)


def _fill_holes(mask):
    try:
        from scipy import ndimage

        return ndimage.binary_fill_holes(mask)
    except ImportError:
        labels, sizes = _components4(~mask)
        outside = _border_labels(labels)
        filled = mask.copy()
        for lab in range(1, len(sizes) + 1):
            if lab not in outside:
                filled |= labels == lab
        return filled


def _color_close(color, targets, tol=0.03):
    if not color or len(color) < 3:
        return False
    for target in targets:
        if all(abs(float(color[i]) - float(target[i])) <= tol for i in range(3)):
            return True
    return False


def _circle_fit(points):
    """Algebraic circle fit → (cx, cy, r, max_err) or None."""
    n = len(points)
    if n < 3:
        return None
    mx = sum(p[0] for p in points) / n
    my = sum(p[1] for p in points) / n
    u = [p[0] - mx for p in points]
    v = [p[1] - my for p in points]
    suu = sum(a * a for a in u)
    svv = sum(b * b for b in v)
    suv = sum(a * b for a, b in zip(u, v))
    suuu = sum(a ** 3 for a in u)
    svvv = sum(b ** 3 for b in v)
    suvv = sum(a * b * b for a, b in zip(u, v))
    svuu = sum(b * a * a for a, b in zip(u, v))
    det = suu * svv - suv * suv
    if abs(det) < 1e-9:
        return None
    uc = (0.5 * (suuu + suvv) * svv - 0.5 * (svvv + svuu) * suv) / det
    vc = (0.5 * (svvv + svuu) * suu - 0.5 * (suuu + suvv) * suv) / det
    cx, cy = uc + mx, vc + my
    r = math.sqrt(max(0.0, uc * uc + vc * vc + (suu + svv) / n))
    err = max(abs(math.hypot(p[0] - cx, p[1] - cy) - r) for p in points)
    return cx, cy, r, err


LEADER_MIN_PT = 100.0
DIM_TICK_PT = (1.5, 8.0)


def _is_leader_stroke(items):
    """A lone long oblique line: callout leader, never a plan wall (walls come in pairs / runs)."""
    if len(items) != 1 or items[0][0] != "l":
        return False
    p, q = items[0][1], items[0][2]
    dx, dy = float(q.x - p.x), float(q.y - p.y)
    length = math.hypot(dx, dy)
    if length < LEADER_MIN_PT:
        return False
    ang = math.degrees(math.atan2(abs(dy), abs(dx)))
    return 5.0 < ang < 85.0


def _tick_center(poly):
    """Centre of a small slanted dimension tick (stroked 45° slash or filled oblique sliver)."""
    xs, ys = [p[0] for p in poly], [p[1] for p in poly]
    w, h = max(xs) - min(xs), max(ys) - min(ys)
    if not (DIM_TICK_PT[0] <= math.hypot(w, h) <= DIM_TICK_PT[1] * 1.3) or min(w, h) < 0.5:
        return None
    if not (0.4 < w / max(h, 1e-6) < 2.5):
        return None
    return ((max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2)


def _drop_dimension_chains(segments, fills=()):
    """Remove dimension lines: axis-aligned lines carrying 45° tick marks, plus the ticks and
    the short extension lines that end on them. Style-agnostic, so it works for every sheet."""
    fills = list(fills)
    if not segments:
        return segments, fills
    arr = np.asarray(segments, dtype=float)
    dx, dy = arr[:, 2] - arr[:, 0], arr[:, 3] - arr[:, 1]
    length = np.hypot(dx, dy)
    ang = np.degrees(np.arctan2(np.abs(dy), np.abs(dx)))
    tick = (length >= DIM_TICK_PT[0]) & (length <= DIM_TICK_PT[1]) & (np.abs(ang - 45.0) < 30.0)
    fill_ticks = [(i, c) for i, c in ((i, _tick_center(p)) for i, p in enumerate(fills) if len(p) >= 2) if c]
    centers = [((a[0] + a[2]) / 2, (a[1] + a[3]) / 2) for a in arr[tick]] + [c for _, c in fill_ticks]
    if len(centers) < 3:
        return segments, fills
    tc = np.asarray(centers, dtype=float)
    n_seg_ticks = int(tick.sum())
    drop = np.zeros(len(arr), dtype=bool)
    used = np.zeros(len(tc), dtype=bool)
    horiz, vert = ang < 1.0, ang > 89.0
    for i in np.nonzero((horiz | vert) & (length > 20.0))[0]:
        x0, y0, x1, y1 = arr[i, :4]
        if horiz[i]:
            on = (np.abs(tc[:, 1] - y0) < 1.0) & (tc[:, 0] >= min(x0, x1) - 1) & (tc[:, 0] <= max(x0, x1) + 1)
        else:
            on = (np.abs(tc[:, 0] - x0) < 1.0) & (tc[:, 1] >= min(y0, y1) - 1) & (tc[:, 1] <= max(y0, y1) + 1)
        ends = [(np.hypot(tc[:, 0] - ex, tc[:, 1] - ey) < 1.5).any() for ex, ey in ((x0, y0), (x1, y1))]
        if on.sum() >= 2 and all(ends):
            drop[i] = True
            used |= on
    if not drop.any():
        drop[:] = False
    drop[np.nonzero(tick)[0][used[:n_seg_ticks]]] = True
    gone_fills = {fill_ticks[k][0] for k in np.nonzero(used[n_seg_ticks:])[0]}
    ut = tc[used]
    for i in np.nonzero((horiz | vert) & (length <= 40.0) & ~drop)[0]:
        for px, py in ((arr[i, 0], arr[i, 1]), (arr[i, 2], arr[i, 3])):
            if (np.hypot(ut[:, 0] - px, ut[:, 1] - py) < 1.5).any():
                drop[i] = True
                break
    # Callout leaders: long oblique single lines. Walls are drawn as parallel pairs, leaders are not.
    obl = np.nonzero((ang > 5.0) & (ang < 85.0) & (length > LEADER_MIN_PT))[0]
    for i in obl:
        ux, uy = dx[i] / length[i], dy[i] / length[i]
        mx, my = (arr[i, 0] + arr[i, 2]) / 2, (arr[i, 1] + arr[i, 3]) / 2
        twin = False
        for j in obl:
            if j == i or abs(abs(dx[j] / length[j] * ux + dy[j] / length[j] * uy) - 1) > 1e-3:
                continue
            ox, oy = (arr[j, 0] + arr[j, 2]) / 2 - mx, (arr[j, 1] + arr[j, 3]) / 2 - my
            if abs(-uy * ox + ux * oy) < 30.0 and abs(ux * ox + uy * oy) < length[i]:
                twin = True
                break
        if not twin:
            drop[i] = True
    return [seg for seg, d in zip(segments, drop) if not d], [p for i, p in enumerate(fills) if i not in gone_fills]


def load_cad_vector_content(pdf_path, page_index=1):
    """Content-layer vectors: segments/fills/arcs with reconstructed rulers removed.

    Returns dict with ``segments`` (N×5 float array x0,y0,x1,y1,width), ``arcs``
    (quarter-circle polylines), ``fills`` (point lists), ``pageSize``,
    ``rulerColors`` and the skill ``inspection``. ``None`` when PyMuPDF is missing.
    """
    try:
        import fitz
    except ImportError:
        return None
    inspection = inspect_cad_page_layers(pdf_path, page_index)
    if inspection.get("error"):
        return None
    ruler_colors = [
        c.get("color") for c in (inspection.get("reconstructed") or {}).get("rulerCandidates") or []
        if c.get("color")
    ]
    doc = fitz.open(str(pdf_path))
    try:
        page = doc[page_index - 1]
        try:
            drawings = page.get_drawings(extended=True)
        except TypeError:
            drawings = page.get_drawings()
        segments = []
        fills = []
        arcs = []
        for index, drawing in enumerate(drawings):
            kind = drawing.get("type")
            color = drawing.get("color")
            fill = drawing.get("fill")
            if kind == "s":
                if _color_close(color, ruler_colors) or (not ruler_colors and is_grid_gray_rgb(color)):
                    continue
                width = float(drawing.get("width") or 0.5)
                items = drawing.get("items") or []
                if _is_leader_stroke(items):
                    continue
                polyline = []
                all_lines = True
                for item in items:
                    op = item[0]
                    if op == "l":
                        p, q = item[1], item[2]
                        segments.append((float(p.x), float(p.y), float(q.x), float(q.y), width))
                        if not polyline:
                            polyline.append((float(p.x), float(p.y)))
                        polyline.append((float(q.x), float(q.y)))
                    elif op == "c":
                        all_lines = False
                        pts = [item[1], item[2], item[3], item[4]]
                        for a, b in zip(pts, pts[1:]):
                            segments.append((float(a.x), float(a.y), float(b.x), float(b.y), width))
                        polyline.extend((float(p.x), float(p.y)) for p in pts)
                    elif op in ("re", "qu"):
                        all_lines = False
                        rect = item[1]
                        try:
                            corners = [rect.ul, rect.ur, rect.lr, rect.ll]
                        except AttributeError:
                            corners = [rect.tl, rect.tr, rect.br, rect.bl]
                        for a, b in zip(corners, corners[1:] + corners[:1]):
                            segments.append((float(a.x), float(a.y), float(b.x), float(b.y), width))
                if len(polyline) >= 5 and (all_lines or len(polyline) >= 8):
                    fit = _circle_fit(polyline)
                    if fit:
                        cx, cy, r, err = fit
                        if CAD_DOOR_MIN_R <= r <= CAD_DOOR_MAX_R and err <= max(0.6, r * 0.03):
                            a0 = math.atan2(polyline[0][1] - cy, polyline[0][0] - cx)
                            a1 = math.atan2(polyline[-1][1] - cy, polyline[-1][0] - cx)
                            span = abs((a1 - a0 + math.pi) % (2 * math.pi) - math.pi)
                            arcs.append({
                                "index": index,
                                "center": (cx, cy),
                                "radius": r,
                                "spanDeg": math.degrees(span),
                                "start": polyline[0],
                                "end": polyline[-1],
                            })
            elif kind == "f" or (kind == "fs" and fill):
                if not fill or max(float(c) for c in fill[:3]) > 0.5:
                    continue
                if _color_close(fill, ruler_colors):
                    continue
                for item in drawing.get("items") or []:
                    op = item[0]
                    if op == "re" or op == "qu":
                        rect = item[1]
                        try:
                            corners = [rect.ul, rect.ur, rect.lr, rect.ll]
                        except AttributeError:
                            corners = [rect.tl, rect.tr, rect.br, rect.bl]
                        fills.append([(float(p.x), float(p.y)) for p in corners])
                    elif op == "l":
                        p, q = item[1], item[2]
                        if fills and fills[-1] and fills[-1][-1] == (float(p.x), float(p.y)):
                            fills[-1].append((float(q.x), float(q.y)))
                        else:
                            fills.append([(float(p.x), float(p.y)), (float(q.x), float(q.y))])
        rect = page.rect
        segments, fills = _drop_dimension_chains(segments, fills)
        return {
            "pageSize": (float(rect.width), float(rect.height)),
            "segments": np.array(segments, dtype=float).reshape(-1, 5),
            "fills": fills,
            "arcs": arcs,
            "rulerColors": ruler_colors,
            "inspection": inspection,
        }
    finally:
        doc.close()


def cad_ink_mask(content, crop, dpi=CAD_STRUCT_DPI, extra_segments=None):
    """Boolean ink raster of content-layer vectors inside ``crop`` (min width guaranteed)."""
    scale = dpi / 72.0
    width = max(1, int(math.ceil(crop["width"] * scale)))
    height = max(1, int(math.ceil(crop["height"] * scale)))
    image = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(image)
    ox, oy = crop["x"], crop["y"]

    def tx(x, y):
        return (x - ox) * scale, (y - oy) * scale

    for x0, y0, x1, y1, w in content["segments"]:
        draw.line([tx(x0, y0), tx(x1, y1)], fill=255, width=max(CAD_INK_MIN_PX, int(round(w * scale))))
    for x0, y0, x1, y1, w in extra_segments or []:
        draw.line([tx(x0, y0), tx(x1, y1)], fill=255, width=max(CAD_INK_MIN_PX, int(round(w * scale))))
    for polygon in content["fills"]:
        pts = [tx(x, y) for x, y in polygon]
        if len(pts) >= 3:
            draw.polygon(pts, fill=255, outline=255)
        elif len(pts) == 2:
            draw.line(pts, fill=255, width=CAD_INK_MIN_PX)
    return np.array(image) > 127


def _trace_rectilinear_rings(mask):
    """Axis-aligned boundary rings of a boolean cell mask (cell-corner coordinates)."""
    padded = np.pad(mask, 1)
    edges = {}
    filled = np.argwhere(padded)
    for r, c in filled:
        if not padded[r - 1, c]:
            edges.setdefault((c, r), []).append((c + 1, r))
        if not padded[r, c + 1]:
            edges.setdefault((c + 1, r), []).append((c + 1, r + 1))
        if not padded[r + 1, c]:
            edges.setdefault((c + 1, r + 1), []).append((c, r + 1))
        if not padded[r, c - 1]:
            edges.setdefault((c, r + 1), []).append((c, r))
    rings = []
    while edges:
        start = next(iter(edges))
        ring = [start]
        current = start
        while True:
            outs = edges.get(current)
            if not outs:
                break
            nxt = outs.pop()
            if not outs:
                del edges[current]
            if nxt == start:
                break
            ring.append(nxt)
            current = nxt
        if len(ring) >= 4:
            rings.append([(x - 1, y - 1) for x, y in ring])
    return rings


def _merge_collinear(points):
    out = []
    n = len(points)
    for i in range(n):
        prev = points[i - 1]
        cur = points[i]
        nxt = points[(i + 1) % n]
        if (prev[0] == cur[0] == nxt[0]) or (prev[1] == cur[1] == nxt[1]):
            continue
        out.append(cur)
    return out


def simplify_rectilinear(points, min_edge):
    """Remove steps shorter than ``min_edge`` while keeping every edge axis-aligned."""
    poly = [list(p) for p in _merge_collinear([tuple(p) for p in points])]
    while len(poly) > 4:
        n = len(poly)
        lengths = [abs(poly[i][0] - poly[(i + 1) % n][0]) + abs(poly[i][1] - poly[(i + 1) % n][1]) for i in range(n)]
        i = min(range(n), key=lambda k: lengths[k])
        if lengths[i] >= min_edge:
            break
        a, b = poly[i], poly[(i + 1) % n]
        p, c = poly[i - 1], poly[(i + 2) % n]
        if abs(a[1] - b[1]) < 1e-9:  # horizontal short edge → align the vertical neighbours
            mid = (a[0] + b[0]) / 2
            p[0] = c[0] = mid
        else:
            mid = (a[1] + b[1]) / 2
            p[1] = c[1] = mid
        for k in sorted({i, (i + 1) % n}, reverse=True):
            poly.pop(k)
        poly = [list(p) for p in _merge_collinear([tuple(p) for p in poly])]
    return [[round(x, 4), round(y, 4)] for x, y in poly]


def _ring_area(points):
    area = 0.0
    n = len(points)
    for i in range(n):
        x0, y0 = points[i]
        x1, y1 = points[(i + 1) % n]
        area += x0 * y1 - x1 * y0
    return abs(area) / 2


def cad_footprint(ink, page_cells=None):
    """Building footprint from wall ink: drop frames, pick the component with the
    largest enclosed area, absorb nearby wing components, close exterior door
    gaps, fill holes.

    Returns (footprint_mask, meta) or (None, meta).
    """
    height, width = ink.shape
    meta = {"closeRadiusCells": None, "solidity": None, "framesDropped": 0, "wingsMerged": 0}
    labels, sizes = _label_components(ink, connectivity=8)
    if not sizes:
        return None, meta
    order = np.argsort(sizes)[::-1]
    candidates = []
    for lab in order[:60]:
        lab_id = int(lab) + 1
        if sizes[lab] < 200:
            break
        ys, xs = np.nonzero(labels == lab_id)
        x0, x1 = int(xs.min()), int(xs.max()) + 1
        y0, y1 = int(ys.min()), int(ys.max()) + 1
        bw, bh = x1 - x0, y1 - y0
        if bw >= width * CAD_FRAME_FRAC or bh >= height * CAD_FRAME_FRAC:
            meta["framesDropped"] += 1
            continue
        candidates.append({
            "id": lab_id,
            "count": int(sizes[lab]),
            "bbox": (x0, y0, x1, y1),
            "area": bw * bh,
            "mask": labels == lab_id,
        })
    if not candidates:
        return None, meta
    # Seed = largest enclosed area after a light close.
    best = None
    for cand in candidates[:8]:
        for radius in (2, 4, 7, 11, 16):
            closed = _close_mask(cand["mask"], radius)
            filled = _fill_holes(closed)
            filled_area = int(filled.sum())
            solidity = filled_area / max(1, cand["area"])
            if solidity >= CAD_FOOTPRINT_MIN_SOLIDITY:
                if best is None or filled_area > best[0]:
                    best = (filled_area, filled, radius, solidity, cand)
                break
    if best is None:
        return None, meta
    _, footprint, radius, solidity, seed = best
    # Absorb wing / annex components that nearly touch the seed (e.g. 屋顶花园
    # left bay sits ~12 pt west of the main block as its own connected component).
    sx0, sy0, sx1, sy1 = seed["bbox"]
    pad = max(8, radius * 2 + 4)
    absorbed = [seed["id"]]
    for cand in candidates:
        if cand["id"] == seed["id"] or cand["count"] < 400:
            continue
        cx0, cy0, cx1, cy1 = cand["bbox"]
        # Must share the building's Y band and sit just outside the seed bbox.
        y_overlap = min(sy1, cy1) - max(sy0, cy0)
        if y_overlap < min(sy1 - sy0, cy1 - cy0) * 0.35:
            continue
        gap = max(0, max(sx0 - cx1, cx0 - sx1, sy0 - cy1, cy0 - sy1))
        if gap > pad:
            continue
        # Reject title-block / legend strips that are short in Y.
        if (cy1 - cy0) < (sy1 - sy0) * 0.45:
            continue
        footprint = footprint | _fill_holes(_close_mask(cand["mask"], max(radius, 4)))
        absorbed.append(cand["id"])
        meta["wingsMerged"] += 1
        sx0, sy0 = min(sx0, cx0), min(sy0, cy0)
        sx1, sy1 = max(sx1, cx1), max(sy1, cy1)
    # Final close so the absorbed wing shares one filled silhouette.
    # Gap between left bay and main block is ~12 pt ≈ 6 cells at 2 pt/cell.
    bridge = max(4, radius, int(math.ceil(pad / 2)))
    footprint = _fill_holes(_close_mask(footprint, bridge))
    meta.update({
        "closeRadiusCells": radius,
        "bridgeRadiusCells": bridge,
        "solidity": round(float(solidity), 3),
        "component": seed["id"],
        "components": absorbed,
    })
    return footprint, meta


def footprint_polygon(footprint, crop, cell_pt, min_edge=CAD_OUTLINE_MIN_EDGE):
    """Outer rectilinear outline (PDF coords) of a footprint mask."""
    rings = _trace_rectilinear_rings(footprint)
    if not rings:
        return None
    ring = max(rings, key=_ring_area)
    pdf = [[crop["x"] + x * cell_pt, crop["y"] + y * cell_pt] for x, y in ring]
    poly = simplify_rectilinear(pdf, min_edge)
    if len(poly) < 4:
        return None
    return poly


def _jamb_score(segments, center, direction, radius):
    """Evidence that ``direction`` (unit) runs along the wall the door sits in."""
    dx, dy = direction
    cx, cy = center
    sx0, sy0, sx1, sy1 = segments[:, 0], segments[:, 1], segments[:, 2], segments[:, 3]
    vx, vy = sx1 - sx0, sy1 - sy0
    length = np.hypot(vx, vy)
    ok = length >= 3.0
    with np.errstate(invalid="ignore", divide="ignore"):
        parallel = np.abs(vx * dy - vy * dx) / np.maximum(length, 1e-9) < 0.06
    lateral = np.abs((sx0 - cx) * dy - (sy0 - cy) * dx)
    ok &= parallel & (lateral <= max(9.0, radius * 0.45))
    t0 = (sx0 - cx) * dx + (sy0 - cy) * dy
    t1 = (sx1 - cx) * dx + (sy1 - cy) * dy
    tmin = np.minimum(t0, t1)
    tmax = np.maximum(t0, t1)
    near = ok & (np.abs(tmax) <= 4.0) & (tmin < -3.0)
    far = ok & (np.abs(tmin - radius) <= 4.0) & (tmax > radius + 3.0)
    beyond = ok & (tmin <= radius + 3.0) & (tmax >= radius + 12.0)
    return int(near.sum()) + 2 * int(far.sum()) + int(beyond.sum())


def detect_cad_doors(content, crop=None):
    """Semantic inference: quarter-circle swings → door openings on walls.

    Each door: center (hinge), radius (leaf = opening width), axis (unit along the
    wall), opening endpoints, mid point, score. Openings of double doors merge.
    """
    segments = content["segments"]
    doors = []
    for arc in content["arcs"]:
        if not (70.0 <= arc["spanDeg"] <= 110.0):
            continue
        cx, cy = arc["center"]
        r = arc["radius"]
        if crop is not None and not item_center_in_crop(cx, cy, crop, pad=20):
            continue
        best = None
        for endpoint in (arc["start"], arc["end"]):
            ex, ey = endpoint
            length = math.hypot(ex - cx, ey - cy) or 1.0
            direction = ((ex - cx) / length, (ey - cy) / length)
            # Snap to the axis (CAD walls are orthogonal; arc endpoints carry AA jitter).
            if abs(direction[0]) >= abs(direction[1]):
                direction = (1.0 if direction[0] > 0 else -1.0, 0.0)
            else:
                direction = (0.0, 1.0 if direction[1] > 0 else -1.0)
            score = _jamb_score(segments, (cx, cy), direction, r) if len(segments) else 0
            if best is None or score > best[0]:
                best = (score, direction)
        score, direction = best
        if score < 2:
            continue
        ex, ey = cx + direction[0] * r, cy + direction[1] * r
        doors.append({
            "id": f"cad-door-{arc['index']}",
            "kind": "door",
            "center": [round(cx, 3), round(cy, 3)],
            "radius": round(r, 3),
            "axis": [direction[0], direction[1]],
            "opening": [[round(cx, 3), round(cy, 3)], [round(ex, 3), round(ey, 3)]],
            "mid": [round((cx + ex) / 2, 3), round((cy + ey) / 2, 3)],
            "width": round(r, 3),
            "score": score,
            "source": "cad-swing-arc",
            "confidence": 0.75 if score >= 4 else 0.55,
        })
    # Merge double doors: collinear openings on the same axis that touch.
    merged = []
    used = set()
    for i, door in enumerate(doors):
        if i in used:
            continue
        current = dict(door)
        for j in range(i + 1, len(doors)):
            if j in used:
                continue
            other = doors[j]
            if abs(abs(current["axis"][0]) - abs(other["axis"][0])) > 1e-6:
                continue
            horizontal = abs(current["axis"][0]) > 0.5
            lat_i = current["mid"][1] if horizontal else current["mid"][0]
            lat_j = other["mid"][1] if horizontal else other["mid"][0]
            if abs(lat_i - lat_j) > 3.0:
                continue
            axis_index = 0 if horizontal else 1
            a0, a1 = sorted(p[axis_index] for p in current["opening"])
            b0, b1 = sorted(p[axis_index] for p in other["opening"])
            if b0 > a1 + 3.0 or a0 > b1 + 3.0:
                continue
            lo, hi = min(a0, b0), max(a1, b1)
            fixed = (lat_i + lat_j) / 2
            if horizontal:
                current["opening"] = [[lo, fixed], [hi, fixed]]
                current["mid"] = [(lo + hi) / 2, fixed]
            else:
                current["opening"] = [[fixed, lo], [fixed, hi]]
                current["mid"] = [fixed, (lo + hi) / 2]
            current["width"] = round(hi - lo, 3)
            current["score"] = max(current["score"], other["score"])
            current["double"] = True
            used.add(j)
        used.add(i)
        merged.append(current)
    return merged


def _wall_run_clusters(segments, vertical=True, merge=CAD_WALL_GAP_MERGE):
    """Cluster axis-aligned wall strokes by their fixed coordinate."""
    pieces = []
    for x0, y0, x1, y1, _w in segments:
        if vertical:
            if abs(x1 - x0) > 0.6:
                continue
            fixed = float((x0 + x1) / 2)
            a, b = sorted((float(y0), float(y1)))
        else:
            if abs(y1 - y0) > 0.6:
                continue
            fixed = float((y0 + y1) / 2)
            a, b = sorted((float(x0), float(x1)))
        if b - a < 2.0:
            continue
        pieces.append((fixed, a, b))
    pieces.sort()
    clusters = []
    for fixed, a, b in pieces:
        if clusters and abs(clusters[-1][0] - fixed) <= merge:
            clusters[-1][1].append((a, b, fixed))
            xs = [p[2] for p in clusters[-1][1]]
            clusters[-1][0] = sum(xs) / len(xs)
        else:
            clusters.append([fixed, [(a, b, fixed)]])
    return clusters


def _covered_intervals(pieces, join=2.0):
    intervals = []
    for a, b, _fixed in sorted(pieces):
        if intervals and a <= intervals[-1][1] + join:
            intervals[-1][1] = max(intervals[-1][1], b)
        else:
            intervals.append([a, b])
    return intervals


def _interval_gaps(intervals, lo, hi):
    """Gaps between covered runs clipped to [lo, hi]."""
    cover = [(max(a, lo), min(b, hi)) for a, b in intervals if min(b, hi) > max(a, lo) + 1]
    cover.sort()
    gaps = []
    for (a1, b1), (a2, b2) in zip(cover, cover[1:]):
        gap = a2 - b1
        if CAD_WALL_GAP[0] <= gap <= CAD_WALL_GAP[1]:
            gaps.append((b1, a2, gap))
    return gaps


def _interval_overlap_length(intervals_a, intervals_b):
    """Total length where two covered-interval sets overlap."""
    total = 0.0
    for a0, a1 in intervals_a:
        for b0, b1 in intervals_b:
            total += max(0.0, min(a1, b1) - max(a0, b0))
    return total


def detect_cad_wall_openings(content, crop=None, existing_doors=None):
    """Walkable breaks in double-line walls that have no swing arc.

    CAD partitions between 理疗室 are vertical double walls (~6.8pt) with a
    mid-height gap (~28pt) and no door leaf. Swing-arc detection misses them, so
    morphological room extraction merges the five rooms into one fill and the
    partition reads as a sealed wall. Emit gap openings so they can be sealed
    for room splits and rendered as doors.

    Pairing: examine every thickness-ok leaf pair that either is the greedy
    nearest forward neighbor (legacy) or shares enough wall-run overlap. Nearest
    alone mis-binds 理疗室 leaves to short stubs (~0 overlap) and drops 2/4
    vertical seals; overlap-qualified pairs recover those mates.
    """
    segments = content["segments"]
    if not len(segments):
        return []
    existing = list(existing_doors or [])
    openings = []
    lo_t, hi_t = CAD_WALL_THICKNESS
    min_overlap = CAD_WALL_GAP[0] * 2  # ~36pt shared run (~1.2 m at 1:100)
    for vertical in (True, False):
        clusters = _wall_run_clusters(segments, vertical=vertical)
        # Legacy exclusive nearest mates (preserve prior detections that have
        # little run overlap). High-overlap pairs are admitted separately so a
        # short stub cannot steal the real double-wall leaf.
        used_nearest = set()
        nearest_pairs = set()
        for i, (fi, _pieces_i) in enumerate(clusters):
            if i in used_nearest:
                continue
            for j in range(i + 1, len(clusters)):
                if j in used_nearest:
                    continue
                gap = abs(clusters[j][0] - fi)
                if lo_t <= gap <= hi_t:
                    nearest_pairs.add((i, j))
                    used_nearest.add(i)
                    used_nearest.add(j)
                    break
                if gap > hi_t:
                    break
        for i, (fi, pieces_i) in enumerate(clusters):
            intervals_i = _covered_intervals(pieces_i)
            if not intervals_i:
                continue
            for j in range(i + 1, len(clusters)):
                fj = clusters[j][0]
                thick = abs(fj - fi)
                if thick < lo_t:
                    continue
                if thick > hi_t:
                    break
                intervals_j = _covered_intervals(clusters[j][1])
                if not intervals_j:
                    continue
                overlap = _interval_overlap_length(intervals_i, intervals_j)
                if overlap < min_overlap and (i, j) not in nearest_pairs:
                    continue
                # Search band: union of both leaves' covered span.
                span0 = min(intervals_i[0][0], intervals_j[0][0])
                span1 = max(intervals_i[-1][1], intervals_j[-1][1])
                if span1 - span0 < CAD_WALL_GAP[0] * 2:
                    continue
                gaps_i = _interval_gaps(intervals_i, span0, span1)
                gaps_j = _interval_gaps(intervals_j, span0, span1)
                fixed = (fi + fj) / 2
                for a, b, _g in gaps_i:
                    for c, d, _h in gaps_j:
                        y0, y1 = max(a, c), min(b, d)
                        height = y1 - y0
                        if height < CAD_WALL_GAP[0]:
                            continue
                        mid_along = (y0 + y1) / 2
                        if crop is not None and not item_center_in_crop(
                            fixed if vertical else mid_along,
                            mid_along if vertical else fixed,
                            crop,
                            pad=20,
                        ):
                            continue
                        # Require wall continuing on both sides of the gap.
                        near_lo = any(abs(iv[1] - y0) <= 4.0 for iv in intervals_i + intervals_j)
                        near_hi = any(abs(iv[0] - y1) <= 4.0 for iv in intervals_i + intervals_j)
                        if not (near_lo and near_hi):
                            continue
                        if vertical:
                            mid = [fixed, mid_along]
                            opening = [[fixed, y0], [fixed, y1]]
                            axis = [0.0, 1.0]
                        else:
                            mid = [mid_along, fixed]
                            opening = [[y0, fixed], [y1, fixed]]
                            axis = [1.0, 0.0]
                        # Skip if a swing-arc door already covers this jamb.
                        duplicate = False
                        for door in existing:
                            dm = door.get("mid") or door.get("center")
                            if not dm:
                                continue
                            if math.hypot(dm[0] - mid[0], dm[1] - mid[1]) <= max(12.0, height * 0.35):
                                duplicate = True
                                break
                        if duplicate:
                            continue
                        openings.append({
                            "id": f"cad-wall-gap-{len(openings)}",
                            "kind": "door",
                            "center": [round(opening[0][0], 3), round(opening[0][1], 3)],
                            "radius": round(height / 2, 3),
                            "axis": axis,
                            "opening": [
                                [round(opening[0][0], 3), round(opening[0][1], 3)],
                                [round(opening[1][0], 3), round(opening[1][1], 3)],
                            ],
                            "mid": [round(mid[0], 3), round(mid[1], 3)],
                            "width": round(height, 3),
                            "score": 4,
                            "source": "cad-wall-gap",
                            "confidence": 0.62,
                        })
                        existing.append(openings[-1])
    return openings


def door_seal_segments(doors, width=0.96):
    """Segments closing each detected opening so rooms stay closed loops."""
    sealed = []
    for door in doors:
        w = width
        # Wall-gap seals must bridge the double-line thickness so the morph
        # close cannot reopen the niche and re-merge adjacent rooms.
        if door.get("source") == "cad-wall-gap":
            w = max(width, 3.2)
        sealed.append(
            (door["opening"][0][0], door["opening"][0][1], door["opening"][1][0], door["opening"][1][1], w)
        )
    return sealed


def detect_cad_stairs(content, crop=None):
    """Semantic inference: packs of evenly spaced parallel treads → stairs boxes."""
    segments = content["segments"]
    if not len(segments):
        return []
    lo_len, hi_len = CAD_STAIR_TREAD_LEN
    treads = {"h": [], "v": []}
    for x0, y0, x1, y1, _w in segments:
        length = math.hypot(x1 - x0, y1 - y0)
        if length < lo_len or length > hi_len:
            continue
        if abs(y1 - y0) < 0.35:
            treads["h"].append((y0, min(x0, x1), max(x0, x1)))
        elif abs(x1 - x0) < 0.35:
            treads["v"].append((x0, min(y0, y1), max(y0, y1)))
    stairs = []
    lo_gap, hi_gap = CAD_STAIR_SPACING
    for orientation, items in treads.items():
        if len(items) < CAD_STAIR_MIN_TREADS:
            continue
        items.sort(key=lambda t: (t[1], t[2], t[0]))
        groups = []
        for tread in items:
            placed = False
            for group in groups:
                ref = group[0]
                # Same both ends, or (first flight cut by the break line) one shared end and
                # mostly overlapping: ground-floor stairs draw only part of each tread.
                same = abs(ref[1] - tread[1]) <= 3.0 and abs(ref[2] - tread[2]) <= 3.0
                one_end = abs(ref[1] - tread[1]) <= 3.0 or abs(ref[2] - tread[2]) <= 3.0
                overlap = min(ref[2], tread[2]) - max(ref[1], tread[1])
                short = min(ref[2] - ref[1], tread[2] - tread[1])
                if same or (one_end and overlap >= 0.45 * short and abs(ref[0] - tread[0]) <= hi_gap * 12):
                    group.append(tread)
                    placed = True
                    break
            if not placed:
                groups.append([tread])
        for group in groups:
            if len(group) < CAD_STAIR_MIN_TREADS:
                continue
            keys = sorted({round(t[0], 1) for t in group})
            run = [keys[0]]

            def flush(run):
                if len(run) < CAD_STAIR_MIN_TREADS:
                    return
                gaps = [b - a for a, b in zip(run, run[1:])]
                med = sorted(gaps)[len(gaps) // 2]
                if not (lo_gap <= med <= hi_gap):
                    return
                if sum(1 for g in gaps if abs(g - med) <= med * 0.4) < len(gaps) * 0.7:
                    return
                span0 = min(t[1] for t in group)
                span1 = max(t[2] for t in group)
                if orientation == "h":
                    box = [span0, run[0] - med / 2, span1, run[-1] + med / 2]
                else:
                    box = [run[0] - med / 2, span0, run[-1] + med / 2, span1]
                if crop is not None and not item_center_in_crop((box[0] + box[2]) / 2, (box[1] + box[3]) / 2, crop, pad=20):
                    return
                stairs.append({"box": box, "treads": len(run), "spacing": round(med, 2)})

            for key in keys[1:]:
                if key - run[-1] <= hi_gap * 1.6:
                    run.append(key)
                else:
                    flush(run)
                    run = [key]
            flush(run)
    # Merge touching flights (scissor / landing) into one stair box.
    merged = []
    for stair in sorted(stairs, key=lambda s: -(s["box"][2] - s["box"][0]) * (s["box"][3] - s["box"][1])):
        box = stair["box"]
        hit = None
        for other in merged:
            ob = other["box"]
            if box[0] <= ob[2] + 6 and ob[0] <= box[2] + 6 and box[1] <= ob[3] + 6 and ob[1] <= box[3] + 6:
                hit = other
                break
        if hit:
            hit["box"] = [min(box[0], hit["box"][0]), min(box[1], hit["box"][1]), max(box[2], hit["box"][2]), max(box[3], hit["box"][3])]
            hit["treads"] += stair["treads"]
        else:
            merged.append(dict(stair))
    result = []
    for index, stair in enumerate(merged):
        x0, y0, x1, y1 = stair["box"]
        if (x1 - x0) < 12 or (y1 - y0) < 12:
            continue
        result.append({
            "id": f"cad-stair-{index}",
            "kind": "stairs",
            "name": "楼梯",
            "polygonPdf": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
            "color": [0.82, 0.84, 0.86],
            "area": (x1 - x0) * (y1 - y0),
            "sourceObject": f"cad-stair-{index}",
            "treads": stair["treads"],
            "source": "cad-tread-pattern",
            "confidence": 0.6,
        })
    return result


def cad_structure_rooms(content, crop, crop_area, dpi=CAD_STRUCT_DPI, pool=CAD_STRUCT_POOL):
    """Rooms, footprint outline, doors and stairs from the content layer.

    Returns dict(rooms, boundary, doors, stairs, footprintBox, meta) or None when
    no building footprint can be recovered.
    """
    doors = detect_cad_doors(content, crop)
    doors = list(doors) + detect_cad_wall_openings(content, crop, existing_doors=doors)
    stairs = detect_cad_stairs(content, crop)
    ink = cad_ink_mask(content, crop, dpi=dpi, extra_segments=door_seal_segments(doors))
    scale = dpi / 72.0
    cells = _maxpool2(ink) if pool == 2 else ink
    cell_pt = pool / scale
    footprint, fp_meta = cad_footprint(cells)
    if footprint is None:
        return None
    boundary = footprint_polygon(footprint, crop, cell_pt)
    if not boundary:
        return None
    ys, xs = np.nonzero(footprint)
    fp_box = [
        crop["x"] + xs.min() * cell_pt,
        crop["y"] + ys.min() * cell_pt,
        crop["x"] + (xs.max() + 1) * cell_pt,
        crop["y"] + (ys.max() + 1) * cell_pt,
    ]
    fp_area = (fp_box[2] - fp_box[0]) * (fp_box[3] - fp_box[1])
    closed = _close_mask(cells, 1)
    empty = ~closed & footprint
    labels, sizes = _label_components(empty)
    min_cells = max(6, int(CAD_MIN_AREA / (cell_pt * cell_pt)))
    max_cells = int(footprint.sum() * CAD_MAX_AREA_FRAC)
    rooms = []
    for lab, count in enumerate(sizes, start=1):
        if count < min_cells or count > max_cells:
            continue
        ys, xs = np.nonzero(labels == lab)
        px0, py0 = int(xs.min()), int(ys.min())
        px1, py1 = int(xs.max()) + 1, int(ys.max()) + 1
        bw, bh = px1 - px0, py1 - py0
        if count / max(1, bw * bh) < CAD_MIN_FILL_RATIO:
            continue
        if max(bw, bh) / max(1, min(bw, bh)) > CAD_MAX_ASPECT:
            continue
        x0 = crop["x"] + px0 * cell_pt - CAD_WALL_HALF
        y0 = crop["y"] + py0 * cell_pt - CAD_WALL_HALF
        x1 = crop["x"] + px1 * cell_pt + CAD_WALL_HALF
        y1 = crop["y"] + py1 * cell_pt + CAD_WALL_HALF
        width, height = x1 - x0, y1 - y0
        if width < CAD_MIN_SIDE or height < CAD_MIN_SIDE:
            continue
        area = width * height
        if area < CAD_MIN_AREA or area > min(crop_area * 0.22, fp_area * 0.35):
            continue
        rooms.append((x0, y0, x1, y1, area))
    out = []
    for index, (x0, y0, x1, y1, area) in enumerate(rooms):
        color = CAD_FILL_PALETTE[index % len(CAD_FILL_PALETTE)]
        out.append({
            "id": f"cad-fill-{index}",
            "kind": "room",
            "polygonPdf": [[round(x0, 3), round(y0, 3)], [round(x1, 3), round(y0, 3)], [round(x1, 3), round(y1, 3)], [round(x0, 3), round(y1, 3)]],
            "color": [round(channel, 4) for channel in color],
            "area": area,
            "sourceObject": f"cad-fill-{index}",
        })
    # Stairs inside the footprint become facility obstacles; drop room slivers under them.
    kept_stairs = []
    for stair in stairs:
        sx0, sy0, sx1, sy1 = stair["polygonPdf"][0][0], stair["polygonPdf"][0][1], stair["polygonPdf"][2][0], stair["polygonPdf"][2][1]
        cx, cy = (sx0 + sx1) / 2, (sy0 + sy1) / 2
        gx = int((cx - crop["x"]) / cell_pt)
        gy = int((cy - crop["y"]) / cell_pt)
        if not (0 <= gy < footprint.shape[0] and 0 <= gx < footprint.shape[1] and footprint[gy, gx]):
            continue
        out = [
            room for room in out
            if not (
                room["polygonPdf"][0][0] >= sx0 - 2 and room["polygonPdf"][0][1] >= sy0 - 2
                and room["polygonPdf"][2][0] <= sx1 + 2 and room["polygonPdf"][2][1] <= sy1 + 2
            )
        ]
        kept_stairs.append(stair)
    # Doors must sit on a wall inside the footprint.
    kept_doors = []
    for door in doors:
        mx, my = door["mid"]
        gx = int((mx - crop["x"]) / cell_pt)
        gy = int((my - crop["y"]) / cell_pt)
        if 0 <= gy < footprint.shape[0] and 0 <= gx < footprint.shape[1] and footprint[gy, gx]:
            kept_doors.append(door)
    return {
        "rooms": out,
        "boundary": boundary,
        "doors": kept_doors,
        "stairs": kept_stairs,
        "footprintBox": [round(v, 3) for v in fp_box],
        "meta": {
            **fp_meta,
            "dpi": dpi,
            "cellPt": cell_pt,
            "outlineVertices": len(boundary),
            "doorCount": len(kept_doors),
            "stairCount": len(kept_stairs),
            "inspection": {
                "nativePresent": bool((content["inspection"].get("native") or {}).get("present")),
                "styleRunCount": (content["inspection"].get("reconstructed") or {}).get("styleRunCount"),
                "rulerCandidateCount": len((content["inspection"].get("reconstructed") or {}).get("rulerCandidates") or []),
                "drawingCount": content["inspection"].get("drawingCount"),
            },
        },
    }


def cad_linework_rooms(page, crop, crop_area, dpi=CAD_FILL_DPI, raster=None, pdf_path=None, page_index=1):
    """Return pastel room dicts from closed CAD wall loops, or [].

    When ``pdf_path`` is set, recover/hide ruler layers (skill) before rasterize
    so reconstructed axis grids never become walls. Prefers the vector structure
    layer (footprint outline, doors, stairs); the pdfium raster path is the
    fallback. Structure results land on ``cad_linework_rooms.last_structure``.
    """
    strip_meta = {}
    strip_removed = 0
    cad_linework_rooms.last_structure = None
    if raster is None and pdf_path is not None:
        try:
            content = load_cad_vector_content(pdf_path, page_index)
        except Exception:
            content = None
        if content is not None and len(content["segments"]):
            try:
                structure = cad_structure_rooms(content, crop, crop_area)
            except Exception:
                structure = None
            if structure and structure["rooms"]:
                cad_linework_rooms.last_structure = structure
                candidates = (content["inspection"].get("reconstructed") or {}).get("rulerCandidates") or []
                cad_linework_rooms.last_strip_removed = sum(int(c.get("pathCount") or 0) for c in candidates)
                cad_linework_rooms.last_strip_meta = {
                    "mode": "reconstructed-style-runs" if candidates else content["inspection"].get("strategy") or "none",
                    "kind": "reconstructed",
                    "inspection": structure["meta"]["inspection"],
                    "rulerCandidates": candidates[:5],
                    "grayStrokesRemoved": cad_linework_rooms.last_strip_removed,
                    "structure": {k: v for k, v in structure["meta"].items() if k != "inspection"},
                }
                return structure["rooms"] + structure["stairs"]
        try:
            raster, strip_meta = render_cad_content_hiding_rulers(pdf_path, page_index, dpi)
            strip_removed = int((strip_meta or {}).get("grayStrokesRemoved") or 0)
        except Exception:
            raster, strip_meta, strip_removed = None, {}, 0
    if raster is None:
        try:
            raster = page.to_image(resolution=dpi).original.convert("RGB")
        except Exception:
            cad_linework_rooms.last_strip_meta = strip_meta
            cad_linework_rooms.last_strip_removed = 0
            return []
    arr = np.array(raster)
    if arr.size == 0:
        cad_linework_rooms.last_strip_meta = strip_meta
        cad_linework_rooms.last_strip_removed = 0
        return []
    scale = dpi / 72.0
    x0 = max(0, int(crop["x"] * scale))
    y0 = max(0, int(crop["y"] * scale))
    x1 = min(arr.shape[1], int((crop["x"] + crop["width"]) * scale))
    y1 = min(arr.shape[0], int((crop["y"] + crop["height"]) * scale))
    cropped = arr[y0:y1, x0:x1]
    if cropped.size == 0:
        cad_linework_rooms.last_strip_meta = strip_meta
        cad_linework_rooms.last_strip_removed = strip_removed
        return []
    # After reconstructed-layer hide, near-black ink is real walls. Keep a light
    # gray reject only when hide removed nothing (defense in depth).
    if strip_removed > 0:
        ink = cropped.min(axis=2) < CAD_INK_MAX
    else:
        ink = cad_wall_ink_mask(cropped)
    pooled = _maxpool2(ink)
    pool = 2 if pooled.shape[0] < ink.shape[0] else 1
    closed = _close_mask(pooled, CAD_CLOSE_RADIUS)
    empty = ~closed
    labels, sizes = _components4(empty)
    border = _border_labels(labels)
    min_px = max(6, int(CAD_MIN_AREA * (scale / pool) ** 2))
    max_px = int(empty.size * CAD_MAX_AREA_FRAC)
    raw = []
    for lab, count in enumerate(sizes, start=1):
        if lab in border or count < min_px or count > max_px:
            continue
        ys, xs = np.nonzero(labels == lab)
        px0, py0 = int(xs.min()), int(ys.min())
        px1, py1 = int(xs.max()) + 1, int(ys.max()) + 1
        bw, bh = px1 - px0, py1 - py0
        fill_ratio = count / max(1, bw * bh)
        if fill_ratio < CAD_MIN_FILL_RATIO:
            continue
        if max(bw, bh) / max(1, min(bw, bh)) > CAD_MAX_ASPECT:
            continue
        pdf_x0 = crop["x"] + (px0 * pool) / scale
        pdf_y0 = crop["y"] + (py0 * pool) / scale
        pdf_x1 = crop["x"] + (px1 * pool) / scale
        pdf_y1 = crop["y"] + (py1 * pool) / scale
        width, height = pdf_x1 - pdf_x0, pdf_y1 - pdf_y0
        if width < CAD_MIN_SIDE or height < CAD_MIN_SIDE:
            continue
        area = width * height
        if area < CAD_MIN_AREA or area > crop_area * 0.22:
            continue
        raw.append((pdf_x0, pdf_y0, pdf_x1, pdf_y1, area))
    core = _core_bounds(raw, pad=18)
    rooms = []
    for index, (px0, py0, px1, py1, area) in enumerate(raw):
        cx, cy = (px0 + px1) / 2, (py0 + py1) / 2
        if core and not (core[0] <= cx <= core[2] and core[1] <= cy <= core[3]):
            continue
        color = CAD_FILL_PALETTE[index % len(CAD_FILL_PALETTE)]
        rooms.append({
            "id": f"cad-fill-{index}",
            "kind": "counter" if area < 700 else "room",
            "polygonPdf": [[px0, py0], [px1, py0], [px1, py1], [px0, py1]],
            "color": [round(channel, 4) for channel in color],
            "area": area,
            "sourceObject": f"cad-fill-{index}",
        })
    cad_linework_rooms.last_strip_removed = strip_removed
    cad_linework_rooms.last_strip_meta = strip_meta
    return rooms


def render_cad_fill_preview(page, rooms, dpi=72):
    """RGB overlay for spike screenshots; not used at runtime."""
    raster = page.to_image(resolution=dpi).original.convert("RGBA")
    overlay = Image.new("RGBA", raster.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    scale = dpi / 72.0
    for room in rooms:
        color = tuple(int(channel * 255) for channel in room["color"])
        pts = room["polygonPdf"]
        xs = [p[0] * scale for p in pts]
        ys = [p[1] * scale for p in pts]
        box = [min(xs), min(ys), max(xs), max(ys)]
        draw.rectangle(box, fill=color + (150,), outline=color + (220,))
    return Image.alpha_composite(raster, overlay).convert("RGB")

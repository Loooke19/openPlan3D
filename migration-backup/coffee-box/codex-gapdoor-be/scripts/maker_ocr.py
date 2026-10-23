"""CAD outlined-text → content labels + calibration (not rendered).

Uses macOS Vision when the PDF has no text layer. Room names become Maker
labels/POIs. Scale, axis chains, and m² stay on the calibration layer.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import unicodedata
from pathlib import Path

CAD_OCR_DPI = 300
_METERS_PER_PDF_PT_AT_1_TO_100 = (25.4 / 72.0) * 0.1

# Research clips on the A1 CAD sheet, as fractions of page size
# (p1-floor-body / p1-title-bottom / p1-scale-axis @ 300 DPI).
BODY_INSET = (0.145, 0.25, 0.71, 0.82)
TITLE_BOX = (0.37, 0.835, 0.64, 0.945)
SCALE_AXIS_BOX = (0.145, 0.75, 0.71, 0.885)
LEFT_AXIS_BOX = (0.08, 0.18, 0.20, 0.82)

NAME_FIXES = {
    "管道牙": "管道井",
    "中医体员辨识室": "中医体质辨识室",
    "体检B超至": "体检B超室",
    "哥密度检测": "骨密度检测",
    "胃密度检测": "骨密度检测",
    "晋密度检测": "骨密度检测",
    "仪界室": "仪器室",
    "在放处": "存放处",
    "无蘭包室": "无菌包室",
    "公头卫生管理料": "公共卫生管理科",
    "公共卫生管理料": "公共卫生管理科",
    "体检奩口": "体检窗口",
    "手榨室": "手术室",
    "躚超一室": "B超一室",
    "登记医作更衣": "登记医生更衣",
    "氍记医牛更衣": "登记医生更衣",
    "慡复室": "恢复室",
    "计生咨询指挥": "计生咨询指挥室",
    "计生咨询指挥室": "计生咨询指挥室",
    # Ghostscript CAD sheet (Vision on outlined glyphs) — page-1 rehab wing
    "运动康复凶": "运动康复区",
    "运动康复区凶": "运动康复区",
    "野*茶水闸": "茶水间",
    "野茶水闸": "茶水间",
    "茶水闸": "茶水间",
    "清洁同": "清洁间",
    "配电同": "配电间",
    "空堝外机": "空调外机",
    "空请外": "空调外机",
    "公请タ": "空调外机",
    "空调外": "空调外机",
    "空调外右": "空调外机",
    "空调外杪": "空调外机",
    "空调外和": "空调外机",
    "空调外扒": "空调外机",
    "空调奶利": "空调外机",
    "空珊外7": "空调外机",
    "空珊外机": "空调外机",
    # Storage niches under 理疗室 — Vision confuses 藏 with 臧/减/锗/诸; also 繁體 儲
    "储臧": "储藏",
    "储减": "储藏",
    "锗藏": "储藏",
    "诸藏": "储藏",
    "儲藏": "储藏",
    "儲臧": "储藏",
    "储臧室": "储藏",
    "储藏室": "储藏",
    # Therapy rooms — Vision swaps 理/坦 on outlined glyphs
    "坦疗室": "理疗室",
    "埋疗室": "理疗室",
    "理疗至": "理疗室",
}

# Equipment / appliance callouts on the drawing — never auto room or dept names.
# Facilities and real rooms stay: 开水茶水间 / 茶水间 / 电脑室 / 空调外机.
# 空调外机 is intentionally NOT in this set (user: keep recognizing).
EQUIPMENT_DROP = {
    "冰箱", "冰柜", "冷柜", "冰稍", "水箱",
    "开水", "开水器", "开水炉", "空课水",
    "电脑", "计算机", "打印机", "复印机", "传真机", "扫描仪", "显示器",
    "热水器", "电热水器", "洗衣机", "消毒柜", "微波炉", "烤箱",
    "电视", "电视机", "饮水机", "净水器",
}

# Lone appliance stem → drop unless a room/facility suffix follows.
_EQUIPMENT_STEM_RE = re.compile(
    r"^(?:冰箱|冰柜|冷柜|冰稍|水箱|开水|开水器|电脑|计算机|打印机|复印机|传真机|"
    r"扫描仪|显示器|热水器|洗衣机|消毒柜|微波炉|电视|饮水机|净水器)"
)
_ROOM_FACILITY_SUFFIX_RE = re.compile(r"室|间|房|科|厅|处|区|台|包|井|窗|库")

DROP_RE = re.compile(r"中华人民共和|图层|指北针|会签|设计号|城心中图")

AREA_RE = re.compile(
    r"^(?:[本此]?层?建筑面积[:：]?)?\d+(?:\.\d+)?\s*m[²2'’]?\d*$",
    re.I,
)
AREA_TOKEN_RE = re.compile(r"\d+\.\d{2,4}\s*m[²2'’]?", re.I)
SCALE_RE = re.compile(r"^1\s*[:：\-]\s*(\d+)$")
AXIS_RE = re.compile(r"^\d{3,6}$")
BUBBLE_RE = re.compile(r"^[A-Z]?\d{1,2}$")
TITLE_RE = re.compile(
    r"平面|建筑面积|社区卫生|卫生服务|设计|图框|比例|教育版|出图|图章|注册建筑|"
    r"施工依据|项目经理|项目负责|专业负责|建设单位|项目名称|分项号|版本号|图档号|"
    r"图号|图名|签名|审定|审核|校对|绘制|修改说明|建施|结施|设施|Autodesk|日期"
)
ROOM_HINT_RE = re.compile(
    r"室|科|处|厅|井|窗|房|台|包|休息|手术|门诊|检验|药房|走廊|楼梯|电梯|仓库|值班|储藏|过道|理疗|空调|外机"
)
# Vision near-misses for the two-glyph 储藏 label on outlined CAD text.
_STORAGE_NEAR_RE = re.compile(r"^[储諸锗儲][藏臧减锗諸]$")
# 空调外机 niches beside 储藏 — last glyph often misread (右/杪/和/扒/…) or truncated.
_AC_NEAR_RE = re.compile(r"^空[调調請请埚珊]?外.{0,2}$")
CJK_RE = re.compile(r"[\u4e00-\u9fff]")

_VISOCR_BIN = Path.home() / ".cache" / "cad-visocr"


def normalize_ocr_text(text):
    text = unicodedata.normalize("NFKC", str(text or "")).replace(" ", "").strip()
    text = text.replace("ｍ", "m").replace("㎡", "m²")
    text = text.strip(" :：。;；,，、()*（）【】[]")
    # Vision often inserts * / · inside CAD-outlined room names.
    collapsed = text.replace("*", "").replace("·", "").replace("•", "")
    collapsed = collapsed.replace("儲", "储")
    if collapsed in NAME_FIXES:
        return NAME_FIXES[collapsed]
    if _STORAGE_NEAR_RE.match(collapsed):
        return "储藏"
    if _AC_NEAR_RE.match(collapsed):
        return "空调外机"
    return NAME_FIXES.get(text, text)


def is_equipment_label(text):
    """Appliance glyphs on CAD — not rooms. Keep 开水茶水间 / 电脑室 / 空调外机."""
    raw = normalize_ocr_text(text)
    if not raw:
        return False
    # Never demote outdoor AC niches (facility-like equipment rooms on plan).
    if raw == "空调外机" or raw.startswith("空调外机"):
        return False
    if raw in EQUIPMENT_DROP:
        return True
    if raw == "开水" or raw.startswith("开水器"):
        return True
    # Lone 开水* without 茶/间/室 → equipment callout, not a department.
    if raw.startswith("开水") and not any(tok in raw for tok in ("茶", "间", "室", "房")):
        return True
    # Stem match without room/facility suffix (电脑 → drop; 电脑室 → keep).
    if _EQUIPMENT_STEM_RE.match(raw) and not _ROOM_FACILITY_SUFFIX_RE.search(raw):
        if "茶" in raw:  # 开水茶水间 already covered; belt-and-suspenders
            return False
        return True
    return False


def classify_ocr_text(text):
    """Return content | calibration_* | drop. Calibration never becomes a POI."""
    raw = normalize_ocr_text(text)
    if not raw:
        return "drop", raw
    if is_equipment_label(raw):
        return "drop", raw
    # Physical therapy rooms are labelled "PT" in the hospital CAD sheet.
    # Keep only this observed abbreviation; arbitrary short Latin tokens are
    # usually axis or title-block noise.
    if raw.upper() == "PT":
        return "content", "PT"
    if SCALE_RE.match(raw) or raw in {"1:100", "1：100", "1-100"}:
        return "calibration_scale", raw
    if AREA_RE.match(raw) or (AREA_TOKEN_RE.search(raw) and not ROOM_HINT_RE.search(raw)):
        return "calibration_area", raw
    if re.search(r"\d", raw) and re.search(r"m[²2'’]?", raw, re.I) and not ROOM_HINT_RE.search(raw):
        return "calibration_area", raw
    if AXIS_RE.match(raw) or BUBBLE_RE.match(raw):
        return "calibration_axis", raw
    if TITLE_RE.search(raw) and not ROOM_HINT_RE.search(raw):
        return "calibration_title", raw
    if DROP_RE.search(raw):
        return "drop", raw
    if sum(ch.isdigit() for ch in raw) >= 3 and not ROOM_HINT_RE.search(raw):
        return "drop", raw
    if ROOM_HINT_RE.search(raw):
        return "content", raw
    if CJK_RE.search(raw) and 2 <= len(raw) <= 16:
        return "content", raw
    # Single-glyph room marks used on ward plans (卫 = toilet).
    if raw in {"卫", "厕"}:
        return "content", raw
    return "drop", raw


def room_name_for_plan(text):
    """Name to store on an openPlan room.

    RapidOCR may read dimensions and axis numbers. Those stay out of the
    project: only a content label with letters or CJK is a room name.
    """
    kind, raw = classify_ocr_text(text)
    if kind != "content" or not raw:
        return ""
    if re.fullmatch(r"[\d.]+", raw):
        return ""
    if not re.search(r"[A-Za-z\u4e00-\u9fff]", raw):
        return ""
    return _strip_label_noise(raw)


def _split_repeat(raw):
    m = re.fullmatch(r"(.{2,6}?)\1+", raw)
    return m.group(1) if m else raw


def _strip_label_noise(raw):
    """Generic OCR clean-up (no per-drawing tables): an area that OCR glued onto the
    name (病房21.994m), stray box/check glyphs (护士办公室☐) and a lone Latin letter
    picked up from a fixture symbol in front of the name (o卫)."""
    s = re.sub(r"(?:\d+\.\d+\s*(?:m²|m2|㎡|m)?|\d+\s*(?:m²|m2|㎡|m))$", "", raw)
    s = re.sub(r"[^\w\u4e00-\u9fff、/（）()]+$", "", s)
    s = re.sub(r"^[a-z](?=[\u4e00-\u9fff])", "", s)  # lowercase only: keep B超
    s = s.replace("(", "（").replace(")", "）")
    if s.count("（") > s.count("）"):
        s += "）"  # OCR dropped the closing bracket: 诊室(一 → 诊室（一）
    s = _split_repeat(s)
    return s if CJK_RE.search(s) or s.upper() == "PT" else raw


def _label_from_box(text, x0, y0, x1, y1, source="cad-vision-ocr"):
    return {
        "text": text,
        "x": (x0 + x1) / 2,
        "y": (y0 + y1) / 2,
        "size": max(1.0, y1 - y0),
        "x0": x0,
        "x1": x1,
        "top": y0,
        "bottom": y1,
        "source": source,
    }


def split_ocr_items(items):
    """Split Vision/fixture items into content labels and calibration records."""
    labels = []
    calibration_items = []
    for item in items:
        kind, text = classify_ocr_text(item.get("text") or item.get("name") or "")
        if item.get("bbox_pdf_pt") and len(item["bbox_pdf_pt"]) >= 4:
            x0, y0, width, height = item["bbox_pdf_pt"][:4]
            x1, y1 = x0 + width, y0 + height
        else:
            box = item.get("bbox_pdf")
            if not box or len(box) < 4:
                continue
            x0, y0, x1, y1 = box[0], box[1], box[2], box[3]
            if x1 < x0:
                x0, x1 = x1, x0
            if y1 < y0:
                y0, y1 = y1, y0
        record = {
            "text": text,
            "kind": kind,
            "confidence": float(item.get("confidence") or 0),
            "bbox_pdf": [x0, y0, x1, y1],
            "layer": "content" if kind == "content" else "calibration",
        }
        if kind == "content":
            labels.append(_label_from_box(text, x0, y0, x1, y1))
        elif kind.startswith("calibration"):
            calibration_items.append(record)
    return _dedupe_ocr_labels(labels), calibration_dict(calibration_items)


def _expand_repeated_storage_labels(labels):
    """Split Vision/merge glue like 储藏储藏 → N separate 储藏 along the bbox."""
    expanded = []
    for label in labels:
        text = label.get("text") or ""
        if re.fullmatch(r"(?:储藏){2,}", text):
            count = len(text) // 2
            x0 = float(label.get("x0", label["x"] - 8))
            x1 = float(label.get("x1", label["x"] + 8))
            span = max(x1 - x0, 12.0 * count)
            step = span / count
            for index in range(count):
                lx0 = x0 + index * step
                lx1 = lx0 + step
                expanded.append({
                    **label,
                    "text": "储藏",
                    "x": (lx0 + lx1) / 2,
                    "x0": lx0,
                    "x1": lx1,
                })
            continue
        expanded.append(label)
    return expanded


def _dedupe_ocr_labels(labels):
    """Keep the longer name when overlapping tiles see the same room."""
    kept = []
    for label in sorted(
        _expand_repeated_storage_labels(labels),
        key=lambda item: (-len(item["text"]), -item["size"]),
    ):
        rival = next(
            (
                item for item in kept
                if abs(item["x"] - label["x"]) < 22 and abs(item["y"] - label["y"]) < 16
            ),
            None,
        )
        if rival is None:
            kept.append(label)
            continue
        if len(label["text"]) > len(rival["text"]) + 1:
            kept[kept.index(rival)] = label
    return kept


def calibration_dict(records):
    if not records:
        return None
    ratio = None
    denom = None
    floor_area = None
    axis = []
    areas = []
    titles = []
    for item in records:
        text = item["text"]
        kind = item["kind"]
        if kind == "calibration_scale":
            match = re.search(r"1\s*[:：\-]\s*(\d+)", text)
            if match:
                denom = int(match.group(1))
                ratio = f"1:{denom}"
        elif kind == "calibration_axis" and AXIS_RE.match(text):
            axis.append(int(text))
        elif kind == "calibration_area":
            match = re.search(r"(\d+\.\d+)", text)
            if match:
                value = float(match.group(1))
                if "建筑面积" in text:
                    floor_area = value
                else:
                    areas.append(value)
        elif kind == "calibration_title":
            titles.append(text)
            match = re.search(r"1\s*[:：\-]\s*(\d+)", text)
            if match and denom is None:
                denom = int(match.group(1))
                ratio = f"1:{denom}"
            area_match = re.search(r"(\d+\.\d+)\s*m", text, re.I)
            if "建筑面积" in text and area_match:
                floor_area = float(area_match.group(1))
    meters = None
    if denom:
        meters = (25.4 / 72.0) * (denom / 1000.0)
    elif ratio == "1:100":
        meters = _METERS_PER_PDF_PT_AT_1_TO_100
    payload = {
        "source": "cad-ocr-ratio" if meters else "cad-ocr",
        "layer": "calibration",
        "ratio": ratio,
        "floorAreaM2": floor_area,
        "axisDimsMm": axis,
        "roomAreasM2": areas[:80],
        "titles": titles[:8],
    }
    if meters:
        payload["metersPerMapUnit"] = meters
    return payload


def _visocr_binary():
    source = Path(__file__).with_name("cad_visocr.swift")
    if not source.is_file():
        return None
    binary = _VISOCR_BIN
    if binary.is_file() and binary.stat().st_mtime >= source.stat().st_mtime:
        return binary
    binary.parent.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.run(
            ["swiftc", "-O", "-o", str(binary), str(source)],
            check=True,
            capture_output=True,
            timeout=120,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return binary if binary.is_file() else None


_rapidocr_engine = None


def _rapidocr_importable():
    try:
        import rapidocr  # noqa: F401
        return True
    except ImportError:
        pass
    try:
        import rapidocr_onnxruntime  # noqa: F401
        return True
    except ImportError:
        return False


def resolve_ocr_backend():
    """Pick vision | rapidocr from CAD_OCR_BACKEND (default auto)."""
    choice = (os.environ.get("CAD_OCR_BACKEND") or "auto").strip().lower()
    if choice in {"off", "none", "0", "skip"}:
        return "off"
    if choice in {"vision", "visocr", "macos", "apple"}:
        return "vision"
    if choice in {"rapidocr", "rapid", "onnx", "paddle"}:
        return "rapidocr"
    if sys.platform == "darwin" and _visocr_binary() is not None:
        return "vision"
    if _rapidocr_importable():
        return "rapidocr"
    if _visocr_binary() is not None:
        return "vision"
    return "off"


def _get_rapidocr_engine():
    """Lazy singleton. Supports rapidocr (v3+) and legacy rapidocr_onnxruntime."""
    global _rapidocr_engine
    if _rapidocr_engine is not None:
        return _rapidocr_engine
    try:
        from rapidocr import RapidOCR
        _rapidocr_engine = RapidOCR()
        return _rapidocr_engine
    except Exception:
        pass
    try:
        from rapidocr_onnxruntime import RapidOCR
        _rapidocr_engine = RapidOCR()
        return _rapidocr_engine
    except Exception:
        return None


def _quad_to_xywh(box):
    xs = [float(point[0]) for point in box]
    ys = [float(point[1]) for point in box]
    x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
    return [x0, y0, max(1.0, x1 - x0), max(1.0, y1 - y0)]


def recognize_image_rapidocr(image_path):
    """Run RapidOCR (ONNX) on a PNG. Returns [{text, confidence, bbox_pixel_xywh}]."""
    engine = _get_rapidocr_engine()
    if engine is None:
        return []
    try:
        result = engine(str(image_path))
    except Exception:
        return []
    items = []
    boxes = getattr(result, "boxes", None)
    txts = getattr(result, "txts", None)
    scores = getattr(result, "scores", None)
    if boxes is not None and txts is not None:
        score_list = scores or (0.0,) * len(txts)
        for box, text, score in zip(boxes, txts, score_list):
            if box is None:
                continue
            items.append({
                "text": text or "",
                "confidence": float(score or 0),
                "bbox_pixel_xywh": _quad_to_xywh(box),
            })
        return items
    rows = result[0] if isinstance(result, tuple) else result
    if not rows:
        return []
    for row in rows:
        if not row or len(row) < 2:
            continue
        box, text = row[0], row[1]
        score = float(row[2]) if len(row) > 2 else 0.0
        if box is None:
            continue
        items.append({
            "text": text or "",
            "confidence": score,
            "bbox_pixel_xywh": _quad_to_xywh(box),
        })
    return items


def recognize_image(image_path, backend=None):
    """Dispatch to Vision or RapidOCR. Same tile contract for both backends."""
    backend = backend or resolve_ocr_backend()
    if backend == "vision":
        return recognize_image_vision(image_path)
    if backend == "off":
        return []
    return recognize_image_rapidocr(image_path)


def recognize_image_vision(image_path):
    """Run macOS Vision on a PNG. Returns [{text, confidence, bbox_pixel_xywh}]."""
    binary = _visocr_binary()
    if binary is None:
        return []
    with tempfile.TemporaryDirectory(prefix="cad-visocr-") as folder:
        out = Path(folder) / "ocr.json"
        try:
            subprocess.run(
                [str(binary), str(image_path), str(out)],
                check=True,
                capture_output=True,
                timeout=120,
            )
        except (OSError, subprocess.SubprocessError):
            return []
        if not out.is_file():
            return []
        payload = json.loads(out.read_text(encoding="utf-8"))
    items = []
    for row in payload.get("items") or []:
        box = row.get("bboxPixelXYWH") or []
        if len(box) != 4:
            continue
        items.append({
            "text": row.get("text") or "",
            "confidence": float(row.get("confidence") or 0),
            "bbox_pixel_xywh": [float(v) for v in box],
        })
    return items


OCR_TILE_PX = int(os.environ.get("CAD_OCR_TILE_PX", "1400"))
OCR_TILE_DPI = int(os.environ.get("CAD_OCR_TILE_DPI", "300"))
OCR_TRUST_CONF = float(os.environ.get("CAD_OCR_TRUST_CONF", "0.97"))


def _ocr_cache_dir():
    path = Path(os.environ.get("CAD_OCR_CACHE", str(Path.home() / ".cache" / "cad-ocr-tiles")))
    path.mkdir(parents=True, exist_ok=True)
    return path


def ocr_page_lines(pdf_path, page_index, box=None, dpi=None, tile_px=None):
    """Every OCR text line of a page region in PDF points: [{text, x0, y0, x1, y1, conf}].

    A1/A0 sheets are tiled so each raster stays under the detector's input size (half-page
    tiles at 200 dpi were being downscaled ~3x and small room names vanished). Tiles overlap
    by 20 % and lines seen twice are de-duplicated. Results are cached per file+page+params.
    """
    import hashlib
    import fitz
    dpi = dpi or OCR_TILE_DPI
    tile_px = tile_px or OCR_TILE_PX
    digest = hashlib.sha1(Path(pdf_path).read_bytes()).hexdigest()[:16]
    doc = fitz.open(str(pdf_path))
    try:
        page = doc[page_index - 1]
        rect = page.rect
        bx0, by0, bx1, by1 = box or (0, 0, rect.width, rect.height)
        bx0, by0 = max(0.0, bx0), max(0.0, by0)
        bx1, by1 = min(rect.width, bx1), min(rect.height, by1)
        key = f"{digest}-p{page_index}-{dpi}-{tile_px}-{bx0:.0f}-{by0:.0f}-{bx1:.0f}-{by1:.0f}.json"
        cached = _ocr_cache_dir() / key
        if cached.is_file():
            return json.loads(cached.read_text(encoding="utf-8"))
        scale = dpi / 72.0
        step_pt = tile_px / scale
        overlap = step_pt * 0.2
        lines = []
        y = by0
        while y < by1:
            x = bx0
            while x < bx1:
                tx1, ty1 = min(bx1, x + step_pt + overlap), min(by1, y + step_pt + overlap)
                pix = page.get_pixmap(dpi=dpi, clip=fitz.Rect(x, y, tx1, ty1), alpha=False)
                with tempfile.TemporaryDirectory(prefix="cad-ocr-tile-") as folder:
                    png = Path(folder) / "tile.png"
                    png.write_bytes(pix.tobytes("png"))
                    raw = recognize_image(png)
                for item in raw:
                    px, py, pw, ph = item["bbox_pixel_xywh"]
                    lines.append({
                        "text": item.get("text") or "",
                        "conf": float(item.get("confidence") or 0),
                        "x0": x + px / scale, "y0": y + py / scale,
                        "x1": x + (px + pw) / scale, "y1": y + (py + ph) / scale,
                    })
                x += step_pt
            y += step_pt
        lines = _dedupe_lines(lines)
        cached.write_text(json.dumps(lines, ensure_ascii=False), encoding="utf-8")
        return lines
    finally:
        doc.close()


def _dedupe_lines(lines):
    """Drop a line mostly covered by a longer line (tile overlap sees text twice)."""
    def area(a):
        return max(0.0, a["x1"] - a["x0"]) * max(0.0, a["y1"] - a["y0"])
    kept = []
    for line in sorted(lines, key=lambda l: (-len(l["text"]), -l["conf"])):
        dup = False
        for k in kept:
            ix = max(0.0, min(k["x1"], line["x1"]) - max(k["x0"], line["x0"]))
            iy = max(0.0, min(k["y1"], line["y1"]) - max(k["y0"], line["y0"]))
            if ix * iy > 0.6 * max(1e-6, area(line)):
                dup = True
                break
        if not dup:
            kept.append(line)
    return kept


def group_label_lines(lines, words=None):
    """Join OCR lines that belong to one label (a long name printed on two or three lines).

    Lines join when the next one sits right below (gap < 0.9 line height), overlaps
    horizontally or shares a centre, and has a similar glyph height; text is read top→bottom.
    Joining is skipped when the upper line already reads as a complete name and the lower
    one does too (two stacked labels such as 输液室大厅 / 夜间输液室 stay apart unless the
    joined string is a known word).
    """
    from hospital_lexicon import known, looks_complete
    items = sorted((dict(l) for l in lines), key=lambda l: (l["y0"], l["x0"]))
    used = [False] * len(items)
    blocks = []
    for i, line in enumerate(items):
        if used[i]:
            continue
        used[i] = True
        block = [line]
        while True:
            last = block[-1]
            h = max(1.0, last["y1"] - last["y0"])
            nxt = None
            for j in range(len(items)):
                if used[j]:
                    continue
                o = items[j]
                oh = max(1.0, o["y1"] - o["y0"])
                gap = o["y0"] - last["y1"]
                if not (-0.3 * h <= gap <= 0.9 * h) or not (0.7 <= oh / h <= 1.4):
                    continue
                overlap = min(o["x1"], last["x1"]) - max(o["x0"], last["x0"])
                centre = abs((o["x0"] + o["x1"]) - (last["x0"] + last["x1"])) / 2
                if overlap <= 0 and centre > 1.2 * h:
                    continue
                nxt = j
                break
            if nxt is None:
                break
            a = "/".join(x["text"] for x in block).split("/")[-1]
            b = items[nxt]["text"]
            used[nxt] = True
            # Two stand-alone names stacked in one label (登记 / 医生更衣, 输液室大厅 / 夜间输液室)
            # join with 「/」; a fragment (卫生健康监督 + 协管办公室, 药剂 + 存放处) joins plainly.
            standalone = lambda t: looks_complete(t) or (known(t, words) and len(t) <= 4)
            if known(a + b, words) or not (standalone(a) and standalone(b)):
                items[nxt] = {**items[nxt], "join": ""}
            else:
                items[nxt] = {**items[nxt], "join": "/"}
            block.append(items[nxt])
        blocks.append({
            "text": block[0]["text"] + "".join(b.get("join", "") + b["text"] for b in block[1:]),
            "x0": min(b["x0"] for b in block), "y0": min(b["y0"] for b in block),
            "x1": max(b["x1"] for b in block), "y1": max(b["y1"] for b in block),
            "lines": len(block),
            "conf": min(float(b.get("conf", 1.0)) for b in block),
        })
    return blocks


def room_labels_from_lines(lines, extra_names=None):
    """Clean, join and lexicon-correct OCR lines into labels {text, x, y, raw}."""
    from hospital_lexicon import correct, lexicon
    words = lexicon(extra_names)
    cleaned = []
    for line in lines:
        text = room_name_for_plan(line.get("text") or "")
        if text:
            cleaned.append({**line, "text": text})
    labels = []
    for block in group_label_lines(cleaned, words):
        raw = clean_joined = room_name_for_plan(block["text"]) or block["text"]
        # Trust confident reads (keeps printed oddities such as 计生咨询指挥室); only shaky
        # glyphs are snapped to the lexicon / supplied room list.
        if extra_names:
            # A room list supplied at import is authoritative: snap even confident reads to it.
            fixed = correct(clean_joined, extra_names, strict_extra=True)
            if fixed == clean_joined and block.get("conf", 1.0) < OCR_TRUST_CONF:
                fixed = correct(clean_joined)
        else:
            fixed = correct(clean_joined) if block.get("conf", 1.0) < OCR_TRUST_CONF else clean_joined
        labels.append({
            "text": fixed,
            "raw": raw,
            "x": (block["x0"] + block["x1"]) / 2,
            "y": (block["y0"] + block["y1"]) / 2,
            "box": [block["x0"], block["y0"], block["x1"], block["y1"]],
        })
    return labels


def openplan_room_labels(pdf_path, page_index=1, dpi=200, box=None, extra_names=None):
    """Room-name labels in PDF points, from tiled high-resolution OCR (see ocr_page_lines)."""
    backend = resolve_ocr_backend()
    if backend == "off":
        return []
    if backend == "rapidocr" and _get_rapidocr_engine() is None:
        raise RuntimeError("RapidOCR 运行引擎不可用；请安装 requirements.txt 中的 OCR 依赖")
    if os.environ.get("CAD_OCR_LEGACY") != "1":
        return room_labels_from_lines(ocr_page_lines(pdf_path, page_index, box=box), extra_names)
    return _openplan_room_labels_legacy(pdf_path, page_index, dpi)


def _openplan_room_labels_legacy(pdf_path, page_index=1, dpi=200):
    """Room-name labels in PDF points (y down, same space as the CAD vectors).

    Used when a PDF becomes an openPlan project. Dimension and id numbers are
    recognized by the engine and then dropped here.
    """
    backend = resolve_ocr_backend()
    if backend == "off":
        return []
    if backend == "rapidocr" and _get_rapidocr_engine() is None:
        raise RuntimeError("RapidOCR 运行引擎不可用；请安装 requirements.txt 中的 OCR 依赖")
    if backend == "vision" and _visocr_binary() is None:
        raise RuntimeError("macOS Vision OCR 不可用")
    try:
        import fitz
    except ImportError:
        return []
    doc = fitz.open(str(pdf_path))
    try:
        page = doc[page_index - 1]
        rect = page.rect
        labels = []
        overlap = 0.12
        for row in range(2):
            for col in range(2):
                x0 = rect.width * max(0.0, col / 2 - (overlap if col else 0))
                y0 = rect.height * max(0.0, row / 2 - (overlap if row else 0))
                x1 = rect.width * min(1.0, (col + 1) / 2 + (overlap if col < 1 else 0))
                y1 = rect.height * min(1.0, (row + 1) / 2 + (overlap if row < 1 else 0))
                if x1 - x0 < 40 or y1 - y0 < 24:
                    continue
                pix = page.get_pixmap(dpi=dpi, clip=fitz.Rect(x0, y0, x1, y1), alpha=False)
                with tempfile.TemporaryDirectory(prefix="openplan-ocr-") as folder:
                    png = Path(folder) / "tile.png"
                    png.write_bytes(pix.tobytes("png"))
                    raw = recognize_image(png, backend=backend)
                scale = dpi / 72.0
                for item in raw:
                    name = room_name_for_plan(item.get("text") or "")
                    if not name:
                        continue
                    px, py, pw, ph = item["bbox_pixel_xywh"]
                    labels.append({
                        "text": name,
                        "x": x0 + (px + pw / 2) / scale,
                        "y": y0 + (py + ph / 2) / scale,
                    })
        kept = []
        for label in sorted(labels, key=lambda item: -len(item["text"])):
            if any(abs(item["x"] - label["x"]) < 18 and abs(item["y"] - label["y"]) < 14 for item in kept):
                continue
            kept.append(label)
        return kept
    finally:
        doc.close()


def _frac_box(crop, box):
    left, top = crop["x"], crop["y"]
    width, height = crop["width"], crop["height"]
    x0, y0, x1, y1 = box
    return (
        left + width * x0,
        top + height * y0,
        left + width * x1,
        top + height * y1,
    )


def _intersect(a, b):
    x0 = max(a[0], b[0])
    y0 = max(a[1], b[1])
    x1 = min(a[2], b[2])
    y1 = min(a[3], b[3])
    if x1 - x0 < 40 or y1 - y0 < 24:
        return None
    return (x0, y0, x1, y1)


def _content_window(crop, rooms):
    """Floor-body clip: prefer room-fill envelope (keeps left wing), else inset."""
    inset = _frac_box(crop, BODY_INSET)
    if not rooms:
        return inset
    boxes = []
    for room in rooms:
        pts = room["polygonPdf"]
        x0 = min(p[0] for p in pts)
        y0 = min(p[1] for p in pts)
        x1 = max(p[0] for p in pts)
        y1 = max(p[1] for p in pts)
        boxes.append((x0, y0, x1, y1))
    if len(boxes) < 3:
        return inset
    pad = 48
    core = (
        min(b[0] for b in boxes) - pad,
        min(b[1] for b in boxes) - pad,
        max(b[2] for b in boxes) + pad,
        max(b[3] for b in boxes) + pad,
    )
    # Expand the research inset so left-wing rooms (屋顶花园) stay inside OCR.
    union = (
        min(inset[0], core[0]),
        min(inset[1], core[1]),
        max(inset[2], core[2]),
        max(inset[3], core[3]),
    )
    # Still clip away the title block on the right / bottom of the sheet.
    page_right = crop["x"] + crop["width"]
    page_bottom = crop["y"] + crop["height"]
    union = (
        max(crop["x"], union[0]),
        max(crop["y"], union[1]),
        min(page_right * 0.78 + crop["x"] * 0.22, union[2], page_right),
        min(page_bottom * 0.88 + crop["y"] * 0.12, union[3], page_bottom),
    )
    if union[2] - union[0] < 40 or union[3] - union[1] < 24:
        return inset
    return union


def _tiles(box, nx=2, ny=2, overlap=0.2):
    x0, y0, x1, y1 = box
    width, height = x1 - x0, y1 - y0
    tile_w, tile_h = width / nx, height / ny
    ox, oy = tile_w * overlap, tile_h * overlap
    tiles = []
    for row in range(ny):
        for col in range(nx):
            tx0 = x0 + col * tile_w - (ox if col else 0)
            ty0 = y0 + row * tile_h - (oy if row else 0)
            tx1 = x0 + (col + 1) * tile_w + (ox if col < nx - 1 else 0)
            ty1 = y0 + (row + 1) * tile_h + (oy if row < ny - 1 else 0)
            tiles.append((
                max(x0, tx0),
                max(y0, ty0),
                min(x1, tx1),
                min(y1, ty1),
            ))
    return tiles


def _ocr_windows(crop, rooms):
    """Research-aligned clips. Page stays full; only OCR rasters are windowed.

    Body uses a denser 4×3 tile grid: 2×2 routinely missed 2/5 of the small
    「储藏」niches under 理疗室 (glyphs hug the wall next to 空调外机).
    An extra mid-height strip covers the niche row so the rightmost 储藏
    is not lost on a vertical tile seam.
    """
    body = _content_window(crop, rooms)
    windows = list(_tiles(body, nx=4, ny=3, overlap=0.28))
    x0, y0, x1, y1 = body
    strip_h = max(48.0, (y1 - y0) * 0.2)
    strip_y0 = y0 + (y1 - y0) * 0.52
    windows.append((x0, strip_y0, x1, min(y1, strip_y0 + strip_h)))
    windows.append(_frac_box(crop, TITLE_BOX))
    windows.append(_frac_box(crop, SCALE_AXIS_BOX))
    windows.append(_frac_box(crop, LEFT_AXIS_BOX))
    return windows


def _raster_ocr_items(page, crop, dpi=CAD_OCR_DPI, rooms=None):
    items = []
    scale = dpi / 72.0
    for x0, y0, x1, y1 in _ocr_windows(crop, rooms):
        if x1 - x0 < 40 or y1 - y0 < 24:
            continue
        try:
            clipped_page = page.crop((x0, y0, x1, y1))
            raster = clipped_page.to_image(resolution=dpi).original.convert("RGB")
        except Exception:
            continue
        with tempfile.TemporaryDirectory(prefix="cad-ocr-win-") as folder:
            png = Path(folder) / "win.png"
            raster.save(png)
            raw = recognize_image(png)
        for row in raw:
            px, py, pw, ph = row["bbox_pixel_xywh"]
            items.append({
                "text": row["text"],
                "confidence": row["confidence"],
                "bbox_pdf": [
                    x0 + px / scale,
                    y0 + py / scale,
                    x0 + (px + pw) / scale,
                    y0 + (py + ph) / scale,
                ],
            })
    return items


def cad_ocr_for_page(page, crop, items=None, rooms=None):
    """Return (content labels, calibration dict or None). Never emits ruler POIs."""
    if items is None:
        fixture = os.environ.get("CAD_OCR_FIXTURE_JSON")
        if fixture and Path(fixture).is_file():
            payload = json.loads(Path(fixture).read_text(encoding="utf-8"))
            items = payload.get("content_layer_room_names") or []
            items = list(items) + list(payload.get("calibration_layer_axis_dims") or [])
            items = items + list(payload.get("calibration_layer_room_areas") or [])
            items = items + list(payload.get("calibration_layer_title_scale") or [])
            normalized = []
            for row in items:
                box = row.get("bbox_pdf_pt") or row.get("bbox_pdf")
                text = row.get("name") or row.get("text_norm") or row.get("text_raw") or row.get("text") or ""
                if row.get("kind") == "axis_dim" and row.get("value") is not None:
                    text = str(row.get("value"))
                if not box or not text:
                    continue
                normalized.append({"text": text, "bbox_pdf_pt": box, "confidence": row.get("confidence") or 0})
            items = normalized
        elif float(crop.get("width") or 0) < 800:
            return [], None
        else:
            items = _raster_ocr_items(page, crop, rooms=rooms)
    return split_ocr_items(items)


def clip_cad_rooms_to_labels(rooms, labels, pad=96):
    """Drop CAD fills far from room-name labels (axis-band false rooms).

    Keep large wing rooms (屋顶花园 / 运动康复区) and stair facilities even when
    OCR missed their names — they sit outside the dense label cluster.
    """
    content = [item for item in labels if item.get("source") == "cad-vision-ocr"] or labels
    if len(content) < 3 or not rooms:
        return rooms
    xs = [item["x"] for item in content]
    ys = [item["y"] for item in content]
    x0, x1 = min(xs) - pad, max(xs) + pad
    y0, y1 = min(ys) - pad, max(ys) + pad
    kept = []
    for room in rooms:
        source = str(room.get("sourceObject") or "")
        pts = room["polygonPdf"]
        cx = sum(p[0] for p in pts) / len(pts)
        cy = sum(p[1] for p in pts) / len(pts)
        if source.startswith("cad-stair-") or room.get("kind") == "stairs":
            kept.append(room)
            continue
        if source.startswith("cad-fill-") and not (x0 <= cx <= x1 and y0 <= cy <= y1):
            # Large annex / wing rooms must survive even if OCR skipped their name.
            if float(room.get("area") or 0) >= 35000:
                kept.append(room)
                continue
            continue
        kept.append(room)
    return kept or rooms


def name_cad_left_wing_rooms(rooms, labels):
    """If Vision read 运动康复区 but missed 屋顶花园, name the western large wing.

    Also inject synthetic labels at wing centroids so room→label attachment
    prefers the wing names over nearby 办公 glyphs.
    """
    rehab = next((item for item in labels if "运动康复" in (item.get("text") or "")), None)
    if not rehab or not rooms:
        return rooms, labels
    wings = sorted(
        [room for room in rooms if room.get("kind") == "room" and float(room.get("area") or 0) >= 35000],
        key=lambda room: sum(p[0] for p in room["polygonPdf"]) / len(room["polygonPdf"]),
    )
    if len(wings) < 2:
        return rooms, labels
    west, east = wings[0], wings[1]
    rehab_x = rehab["x"]
    east_cx = sum(p[0] for p in east["polygonPdf"]) / len(east["polygonPdf"])
    west_cx = sum(p[0] for p in west["polygonPdf"]) / len(west["polygonPdf"])
    if abs(east_cx - rehab_x) > abs(west_cx - rehab_x):
        west, east = east, west
        west_cx, east_cx = east_cx, west_cx
    east["name"] = "运动康复区"
    west["name"] = "屋顶花园"
    injected = []
    for room, text in ((west, "屋顶花园"), (east, "运动康复区")):
        cx = sum(p[0] for p in room["polygonPdf"]) / len(room["polygonPdf"])
        cy = sum(p[1] for p in room["polygonPdf"]) / len(room["polygonPdf"])
        injected.append({
            "text": text,
            "x": cx,
            "y": cy,
            "size": 14.0,
            "x0": cx - 20,
            "x1": cx + 20,
            "top": cy - 8,
            "bottom": cy + 8,
            "source": "cad-vision-ocr",
            "roomId": room["id"],
        })
    # Drop OCR '办公' that land inside the wing boxes — they steal the room name.
    cleaned = []
    for label in labels:
        if label.get("text") == "办公":
            for room in (west, east):
                xs = [p[0] for p in room["polygonPdf"]]
                ys = [p[1] for p in room["polygonPdf"]]
                if min(xs) <= label["x"] <= max(xs) and min(ys) <= label["y"] <= max(ys):
                    break
            else:
                cleaned.append(label)
            continue
        cleaned.append(label)
    return rooms, injected + cleaned

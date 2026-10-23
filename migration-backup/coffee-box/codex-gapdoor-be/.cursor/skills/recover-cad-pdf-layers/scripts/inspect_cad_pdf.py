#!/usr/bin/env python3
"""Inspect native and reconstructable structure in a vector CAD PDF page."""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

try:
    import fitz  # PyMuPDF
except ImportError:
    print("PyMuPDF is required. Install it with: python3 -m pip install pymupdf", file=sys.stderr)
    raise SystemExit(2)


def rect_list(value: Any) -> list[float] | None:
    if value is None:
        return None
    try:
        rect = fitz.Rect(value)
        return [round(rect.x0, 4), round(rect.y0, 4), round(rect.x1, 4), round(rect.y1, 4)]
    except Exception:
        return None


def serializable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, bytes):
        return value.decode("latin1", errors="replace")
    if isinstance(value, dict):
        return {str(k): serializable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [serializable(v) for v in value]
    if hasattr(value, "x0") and hasattr(value, "y0") and hasattr(value, "x1") and hasattr(value, "y1"):
        return rect_list(value)
    if hasattr(value, "x") and hasattr(value, "y"):
        return [round(float(value.x), 4), round(float(value.y), 4)]
    try:
        return [serializable(v) for v in value]
    except Exception:
        return str(value)


def normalized_color(value: Any) -> tuple[float, ...] | None:
    if value is None:
        return None
    try:
        return tuple(round(float(v), 4) for v in value)
    except Exception:
        return None


def style_signature(drawing: dict[str, Any]) -> tuple[Any, ...]:
    return (
        drawing.get("type"),
        normalized_color(drawing.get("color")),
        normalized_color(drawing.get("fill")),
        round(float(drawing.get("width") or 0), 4),
        str(drawing.get("dashes") or ""),
        round(float(drawing.get("stroke_opacity") or 1), 4),
        round(float(drawing.get("fill_opacity") or 1), 4),
        json.dumps(serializable(drawing.get("lineCap")), sort_keys=True),
        json.dumps(serializable(drawing.get("lineJoin")), sort_keys=True),
        drawing.get("layer") or "",
        drawing.get("level", 0),
    )


def union_rect(current: list[float] | None, incoming: list[float] | None) -> list[float] | None:
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


def drawing_metadata(drawing: dict[str, Any], include_items: bool) -> dict[str, Any]:
    keys = (
        "type",
        "seqno",
        "layer",
        "level",
        "rect",
        "color",
        "fill",
        "width",
        "dashes",
        "stroke_opacity",
        "fill_opacity",
        "lineCap",
        "lineJoin",
        "closePath",
        "even_odd",
        "isolated",
        "knockout",
        "blendmode",
        "opacity",
        "scissor",
    )
    result = {key: serializable(drawing.get(key)) for key in keys if key in drawing}
    items = drawing.get("items") or []
    result["item_count"] = len(items)
    if include_items:
        result["items"] = serializable(items)
    return result


def make_style_runs(drawings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    runs: list[dict[str, Any]] = []
    for index, drawing in enumerate(drawings):
        signature = style_signature(drawing)
        bbox = rect_list(drawing.get("rect"))
        seqno = drawing.get("seqno", index)
        if runs and runs[-1]["_signature"] == signature:
            run = runs[-1]
            run["end_index"] = index
            run["end_seqno"] = seqno
            run["path_count"] += 1
            run["item_count"] += len(drawing.get("items") or [])
            run["bbox"] = union_rect(run["bbox"], bbox)
        else:
            runs.append(
                {
                    "_signature": signature,
                    "start_index": index,
                    "end_index": index,
                    "start_seqno": seqno,
                    "end_seqno": seqno,
                    "path_count": 1,
                    "item_count": len(drawing.get("items") or []),
                    "bbox": bbox,
                    "style": {
                        "type": drawing.get("type"),
                        "color": serializable(drawing.get("color")),
                        "fill": serializable(drawing.get("fill")),
                        "width": drawing.get("width"),
                        "dashes": drawing.get("dashes"),
                        "stroke_opacity": drawing.get("stroke_opacity"),
                        "fill_opacity": drawing.get("fill_opacity"),
                        "layer": drawing.get("layer") or "",
                        "level": drawing.get("level", 0),
                    },
                }
            )
    for run in runs:
        run.pop("_signature", None)
    return runs


def count_stream_operators(doc: fitz.Document, page: fitz.Page) -> dict[str, int]:
    operators = ("BDC", "BMC", "EMC", "Do", "q", "Q", "W", "W*")
    totals = {operator: 0 for operator in operators}
    for xref in page.get_contents() or []:
        try:
            stream = doc.xref_stream(xref)
        except Exception:
            continue
        for operator in operators:
            pattern = rb"(?<![A-Za-z0-9_/])" + re.escape(operator.encode("ascii")) + rb"(?![A-Za-z0-9_])"
            totals[operator] += len(re.findall(pattern, stream))
    return totals


def write_report(path: Path, report: dict[str, Any]) -> None:
    native = report["native_layers"]
    structure = report["structure"]
    vectors = report["vectors"]
    if native["present"]:
        conclusion = "Native PDF layers were detected."
    elif structure["hierarchy_present"]:
        conclusion = "No native PDF layers were detected, but structural hierarchy is present and may help reconstruction."
    else:
        conclusion = "No native PDF layers or recoverable PDF hierarchy were detected; editor groups must be treated as reconstructed."

    lines = [
        "# CAD PDF layer inspection",
        "",
        f"- Source: `{report['source']}`",
        f"- Page: {report['page']} of {report['page_count']}",
        f"- Page size: {report['page_size'][0]:.2f} x {report['page_size'][1]:.2f} pt",
        f"- Conclusion: **{conclusion}**",
        "",
        "## Native layers",
        "",
        f"- OCG count: {native['ocg_count']}",
        f"- Path layer names: {', '.join(native['path_layer_names']) if native['path_layer_names'] else 'none'}",
        "",
        "## PDF structure",
        "",
        f"- Content streams: {structure['content_streams']}",
        f"- Drawing hierarchy levels: {structure['levels']}",
        f"- Group records: {structure['group_records']}",
        f"- Clip records: {structure['clip_records']}",
        f"- Form XObjects: {structure['form_xobjects']}",
        f"- Marked-content operators: BDC={structure['operators']['BDC']}, BMC={structure['operators']['BMC']}, EMC={structure['operators']['EMC']}",
        "",
        "## Vector content",
        "",
        f"- Drawing records: {vectors['drawing_count']}",
        f"- Types: {vectors['types']}",
        f"- Ordered style runs: {vectors['style_run_count']}",
        f"- Fonts: {report['resources']['font_count']}",
        f"- Images: {report['resources']['image_count']}",
        "",
        "## Interpretation",
        "",
        "`style_runs` are consecutive vector paths with the same visual state. They are useful reconstruction evidence, but they are not proof of original CAD layers. Compare candidate runs spatially and visually, and calibrate against importer screenshots or an imported editor document when an exact editor hierarchy is required.",
        "",
    ]
    path.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path, help="Input PDF path")
    parser.add_argument("--page", type=int, default=1, help="One-based page number (default: 1)")
    parser.add_argument("--output-dir", type=Path, required=True, help="Directory for reports and previews")
    parser.add_argument("--include-items", action="store_true", help="Include exact drawing commands in drawings.json")
    parser.add_argument("--scale", type=float, default=1.5, help="PNG render scale (default: 1.5)")
    args = parser.parse_args()

    source = args.pdf.expanduser().resolve()
    if not source.is_file():
        parser.error(f"PDF not found: {source}")

    output_dir = args.output_dir.expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    doc = fitz.open(source)
    if args.page < 1 or args.page > doc.page_count:
        parser.error(f"--page must be between 1 and {doc.page_count}")
    page = doc[args.page - 1]

    try:
        drawings = page.get_drawings(extended=True)
    except TypeError:
        drawings = page.get_drawings()

    ocgs_raw = doc.get_ocgs() or {}
    ocgs = {str(xref): serializable(value) for xref, value in ocgs_raw.items()}
    path_layers = sorted({str(d.get("layer")) for d in drawings if d.get("layer")})
    levels = Counter(int(d.get("level") or 0) for d in drawings)
    types = Counter(str(d.get("type") or "unknown") for d in drawings)
    style_runs = make_style_runs(drawings)
    operators = count_stream_operators(doc, page)
    xobjects = page.get_xobjects() or []
    # Page.get_xobjects() enumerates Form XObjects.
    form_xobjects = len(xobjects)
    group_records = types.get("group", 0)
    clip_records = types.get("clip", 0)
    hierarchy_present = bool(group_records or clip_records or any(level != 0 for level in levels))

    report = {
        "source": str(source),
        "page": args.page,
        "page_count": doc.page_count,
        "page_size": [page.rect.width, page.rect.height],
        "pymupdf_version": getattr(fitz, "VersionBind", "unknown"),
        "native_layers": {
            "present": bool(ocgs or path_layers),
            "ocg_count": len(ocgs),
            "ocgs": ocgs,
            "path_layer_names": path_layers,
        },
        "structure": {
            "hierarchy_present": hierarchy_present,
            "content_streams": len(page.get_contents() or []),
            "levels": dict(sorted(levels.items())),
            "group_records": group_records,
            "clip_records": clip_records,
            "xobject_count": len(xobjects),
            "form_xobjects": form_xobjects,
            "operators": operators,
        },
        "vectors": {
            "drawing_count": len(drawings),
            "types": dict(types),
            "style_run_count": len(style_runs),
            "style_runs": style_runs,
        },
        "resources": {
            "font_count": len(page.get_fonts(full=True) or []),
            "image_count": len(page.get_images(full=True) or []),
        },
    }

    drawing_output = [drawing_metadata(drawing, args.include_items) for drawing in drawings]
    (output_dir / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    (output_dir / "drawings.json").write_text(json.dumps(drawing_output, ensure_ascii=False, indent=2), encoding="utf-8")
    write_report(output_dir / "report.md", report)
    (output_dir / "page.svg").write_text(page.get_svg_image(text_as_path=True), encoding="utf-8")
    pixmap = page.get_pixmap(matrix=fitz.Matrix(args.scale, args.scale), alpha=False)
    pixmap.save(output_dir / "page.png")

    print(json.dumps({
        "output_dir": str(output_dir),
        "native_layers": report["native_layers"]["present"],
        "drawing_count": len(drawings),
        "hierarchy_present": hierarchy_present,
        "style_runs": len(style_runs),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

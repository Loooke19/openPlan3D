---
name: recover-cad-pdf-layers
description: Inspect CAD-exported PDFs, distinguish true PDF optional-content layers from importer-created groups, extract vector drawing order and geometry, and reconstruct evidence-backed candidate layers. Use when a PDF opens as multiple editable groups in Affinity, Illustrator, Inkscape, or another vector editor, or when the user wants to recover walls, dimensions, axes, text, title blocks, or room-plan regions from a vector PDF. Do not use for ordinary PDF text extraction.
---

# Recover CAD PDF Layers

Analyze a CAD-exported PDF without assuming that editor-visible groups are native PDF layers. Preserve the source file and label every result as either **native**, **reconstructed**, or **semantic inference**.

## Core distinction

- **Native PDF layer:** an Optional Content Group (OCG), normally exposed through `/OCProperties`, or a drawing path with a non-empty layer name.
- **PDF structural hierarchy:** clipping groups, transparency groups, marked content, Form XObjects, nested graphics-state scopes, or multiple content streams. This can guide reconstruction but is not necessarily a CAD layer.
- **Importer-created group:** a hierarchy created by Affinity, Illustrator, Inkscape, or another importer from drawing order, path boundaries, styles, clipping, or its own heuristics.
- **Semantic layer:** a classification such as walls, room outlines, axes, dimensions, text, furniture, or title block. This requires inference unless explicitly named in the PDF.

Never report importer-created or inferred groups as original CAD layers without direct evidence.

## First pass

Run the bundled inspector on the relevant page:

```bash
python3 scripts/inspect_cad_pdf.py "/absolute/path/input.pdf" --page 1 --output-dir "/absolute/path/output"
```

If PyMuPDF is unavailable, install only that dependency:

```bash
python3 -m pip install pymupdf
```

The inspector writes:

- `report.md`: human-readable findings and interpretation.
- `report.json`: machine-readable page, OCG, stream, and vector statistics.
- `drawings.json`: ordered vector-path metadata; add `--include-items` when exact path coordinates are required.
- `page.svg`: vector representation for DOM and object-tree inspection.
- `page.png`: visual reference for checking candidate groups.

Treat `style_runs` in `report.json` as candidate boundaries only. They are consecutive paths sharing the same visual state, not proven layers.

## Decision workflow

1. If native OCGs or non-empty path layer names exist, report their names, initial visibility, hierarchy, and coverage. These are genuine PDF layers.
2. If hierarchy levels, clip/group records, Form XObjects, or marked-content blocks exist, map them before using spatial heuristics. Describe them as PDF structure unless they explicitly reference an OCG.
3. If all paths have empty layer names and level zero, state that the PDF contains no recoverable native hierarchy. Continue only as reconstruction.
4. Examine ordered style runs, path bounding boxes, line width, stroke/fill color, opacity, dash pattern, and spatial connectivity.
5. Build candidate groups using multiple signals:
   - consecutive drawing order;
   - common style signature;
   - intersecting or near-touching geometry;
   - shared bounding region;
   - repeated symbols or dimensions;
   - placement inside or outside the principal floor-plan envelope.
6. Render or export each candidate independently and compare it with the full page. A candidate is credible when hiding it removes a coherent visual system without damaging unrelated content.
7. When Affinity screenshots or an imported `.afdesign` document are available, use them as calibration evidence. Toggle one group at a time and record what disappears. Do not assume the same grouping can be derived uniquely from the original PDF.

## Useful open-source helpers

- **PyMuPDF:** primary extractor for paths, sequence numbers, layer names, hierarchy levels, images, fonts, SVG, and rendering.
- **pikepdf or qpdf:** low-level inspection of OCG dictionaries, content streams, marked content, and Form XObjects when PyMuPDF summaries are ambiguous.
- **Inkscape or MuPDF SVG output:** a second importer for comparing reconstructed object trees. Its groups may differ from Affinity's.
- **Shapely + NetworkX:** optional spatial graph clustering for large path collections. Use grid or R-tree indexing; avoid quadratic all-pairs comparisons.
- **RoomFormer or CubiCasa5K:** optional semantic floor-plan recognition when the task is to identify rooms, walls, doors, or furniture rather than reproduce PDF/importer structure.

## CAD drawing heuristics

Use these as evidence, not fixed rules:

- Long orthogonal lines extending beyond the building envelope, repeated grid bubbles, and dimension strings often form axis/dimension candidates.
- Dense connected orthogonal paths near the central drawing region often form the floor-plan candidate.
- A large rectangular frame plus a dense table at an edge often forms the title-block candidate.
- Many small filled contours with similar height often indicate text converted to outlines.
- Repeated furniture symbols may remain contiguous in drawing order because CAD blocks were emitted together.
- A Ghostscript-produced or merged PDF may lose OCG metadata while preserving object order inherited from CAD layers or blocks.

## Exact Affinity hierarchy

The original PDF cannot reveal an exact Affinity-created hierarchy when no equivalent boundaries exist in the PDF. To recover it exactly, use one of:

- the Affinity document after import (`.afdesign`, `.afphoto`, or `.afpub`);
- an SVG exported from Affinity with groups preserved;
- UI inspection that expands the layer tree and toggles group visibility.

Report this limitation clearly instead of reverse-engineering a single answer from ambiguous path order.

## Deliverable expectations

Return:

- whether native layers exist;
- the evidence used;
- counts of vectors, streams, groups/clips, images, and fonts;
- candidate or semantic groups with confidence labels;
- a warning wherever a grouping is inferred;
- the generated report and SVG paths when files were requested.

Do not modify or overwrite the source PDF unless the user explicitly asks for a reconstructed output.

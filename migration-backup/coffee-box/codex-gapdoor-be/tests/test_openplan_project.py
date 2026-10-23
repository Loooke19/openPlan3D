"""Ruler scale and double-line walls → openPlan centimetres."""
import unittest
import sys
from pathlib import Path
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from openplan_project import (
    _attach_doors,
    _merge_axis,
    attach_missing_pdf_doors,
    _apply_pdf_room_names,
    centerlines_from_segments,
    cm_per_point,
    detect_closed_rooms,
    merge_overlapping_walls,
    recognize_pdf,
    repair_wall_lines,
    room_floor_texture,
)


def _box_segments():
    """100×80 pt rectangle, 6 pt double walls."""
    rows = []

    def add(x0, y0, x1, y1):
        rows.append((x0, y0, x1, y1, 0.6))

    for x in (0.0, 6.0, 94.0, 100.0):
        add(x, 0, x, 80)
    for y in (0.0, 6.0, 74.0, 80.0):
        add(0, y, 100, y)
    return np.array(rows, dtype=float)


class OpenPlanProjectTests(unittest.TestCase):
    def test_pdf_door_attaches_after_a_wall_is_added(self):
        wall = {"id": "late", "start": {"x": 0, "y": 0}, "end": {"x": 300, "y": 0},
                "thickness": 12, "height": 280}
        floor = {"walls": [wall], "doors": [], "footprint": [
            {"x": -50, "y": -100}, {"x": 350, "y": -100},
            {"x": 350, "y": 100}, {"x": -50, "y": 100}]}
        candidate = {"mid": [140, 8], "axis": [1, 0], "width": 90, "source": "cad-swing-arc"}
        attach_missing_pdf_doors(floor, [candidate, candidate])
        self.assertEqual(len(floor["doors"]), 1)
        self.assertEqual(floor["doors"][0]["wallId"], "late")
        floor["doors"][0]["id"] = "door-9"
        attach_missing_pdf_doors(floor, [{**candidate, "mid": [250, 8]}])
        self.assertEqual([door["id"] for door in floor["doors"]], ["door-9", "door-10"])
        floor["doors"] = []
        floor["footprint"][0]["y"] = floor["footprint"][1]["y"] = 0
        attach_missing_pdf_doors(floor, [candidate])
        self.assertEqual(floor["doors"], [])

    def test_capped_gap_becomes_opening_but_covered_gap_stays_wall(self):
        left = {"a": 0, "b": 0, "c": 100, "d": 0, "thick": 12, "h": True}
        right = {"a": 190, "b": 0, "c": 300, "d": 0, "thick": 12, "h": True}
        caps = [{"a": x, "b": -30, "c": x, "d": 30, "thick": 12, "h": False} for x in (100, 190)]
        boundary = [(-100, -100), (400, -100), (400, 100), (-100, 100)]
        gaps = []
        joined = _merge_axis([left, right], True, caps, gaps, 1, boundary)
        self.assertEqual(len(joined), 1)
        self.assertEqual([(round(g["mid"][0]), round(g["width"])) for g in gaps], [(145, 90)])
        gaps = []
        backing = {**left, "a": 95, "b": 25, "c": 195, "d": 25}
        _merge_axis([left, right, backing], True, caps, gaps, 1, boundary)
        self.assertEqual(gaps, [])
        gaps = []
        _merge_axis([left, right], True, [], gaps, 1, boundary,
                    doors=[{"mid": [145, 0], "axis": [1, 0]}])
        self.assertEqual(len(gaps), 1)
        gaps = []
        _merge_axis([left, right], True, [], gaps, 1, boundary)
        self.assertEqual(len(gaps), 1)
        gaps = []
        short_head = {**left, "a": 50}
        _merge_axis([short_head, right], True, [], gaps, 1, boundary)
        self.assertEqual(gaps, [])

    def test_door_arc_uses_nearest_parallel_wall_and_wall_head(self):
        lines = [(0, 0, 200, 0, 2), (0, 25, 100, 25, 2), (130, 25, 200, 25, 2)]
        door = {"mid": [115, 23], "axis": [1, 0], "width": 32}
        attached = _attach_doors([door], lines, 3.5)
        self.assertEqual(attached[0]["wallIndex"], 1)
        self.assertEqual(_attach_doors([{**door, "mid": [115, 80]}], lines, 3.5), [])

    def test_overlapping_walls_merge_before_door_attachment(self):
        walls = [
            {"id": "a", "start": {"x": 0, "y": 0}, "end": {"x": 100, "y": 0}, "thickness": 12},
            {"id": "b", "start": {"x": 50, "y": 0}, "end": {"x": 150, "y": 0}, "thickness": 15},
            {"id": "c", "start": {"x": 160, "y": 0}, "end": {"x": 200, "y": 0}, "thickness": 12},
        ]
        doors = [{"wallId": "b", "position": 0.25, "width": 60}]
        rooms = [{"walls": ["a", "b", "c"]}]
        merged = merge_overlapping_walls(walls, doors, rooms)
        self.assertEqual(len(merged), 2)
        self.assertEqual((merged[0]["start"]["x"], merged[0]["end"]["x"], merged[0]["thickness"]), (0, 150, 15))
        self.assertEqual((doors[0]["wallId"], doors[0]["position"]), ("a", 0.5))
        self.assertEqual(rooms[0]["walls"], ["a", "c"])

    def test_door_across_collinear_join_opens_both_spans(self):
        walls = [
            {"id": "a", "start": {"x": 0, "y": 0}, "end": {"x": 100, "y": 0}, "thickness": 12},
            {"id": "b", "start": {"x": 100, "y": 0}, "end": {"x": 200, "y": 0}, "thickness": 12},
        ]
        doors = [{"wallId": "a", "position": 0.8, "width": 80}]
        merged = merge_overlapping_walls(walls, doors)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["end"]["x"], 200)
        self.assertEqual((doors[0]["wallId"], doors[0]["position"]), ("a", 0.4))

    def test_pdf_room_names_report_missing_backend(self):
        rooms = [{"polygon": [{"x": 0, "y": 0}, {"x": 100, "y": 0}, {"x": 100, "y": 100}, {"x": 0, "y": 100}]}]
        with patch("maker_ocr.resolve_ocr_backend", return_value="off"):
            report = _apply_pdf_room_names(rooms, "unused.pdf", 1, 1)
        self.assertEqual(report["ocrStatus"], "unavailable")
        self.assertEqual(report["namedRooms"], 0)

    def test_pdf_room_names_are_written_inside_face(self):
        rooms = [{"polygon": [{"x": 0, "y": 0}, {"x": 100, "y": 0}, {"x": 100, "y": 100}, {"x": 0, "y": 100}]}]
        labels = [{"text": "康复室", "x": 50, "y": 50}, {"text": "标题栏", "x": 150, "y": 50}]
        with patch("maker_ocr.resolve_ocr_backend", return_value="rapidocr"), patch("maker_ocr.openplan_room_labels", return_value=labels):
            report = _apply_pdf_room_names(rooms, "unused.pdf", 1, 1)
        self.assertEqual(rooms[0]["name"], "康复室")
        self.assertEqual(report["ocrStatus"], "complete")
        self.assertEqual(report["namedRooms"], 1)
        self.assertEqual(report["ocrLabels"], 2)

    def test_ruler_scale_mm_to_cm(self):
        self.assertAlmostEqual(cm_per_point(100, 7200), 7.2)

    def test_one_face_can_pair_with_two_walls(self):
        # The long mate must not consume the shared stroke and drop the short room.
        rows = [
            (0, 0, 0, 100, 0.5),
            (-7, 0, -7, 100, 0.5),
            (0, 200, 0, 280, 0.5),
            (6, 200, 6, 280, 0.5),
        ]
        lines = centerlines_from_segments(np.array(rows, dtype=float))
        spans = sorted(
            (round(min(line[1], line[3]), 1), round(max(line[1], line[3]), 1))
            for line in lines
            if abs(line[0] - line[2]) < 0.5
        )
        self.assertTrue(any(start <= 5 and end >= 95 for start, end in spans), spans)
        self.assertTrue(any(start <= 205 and end >= 275 for start, end in spans), spans)

    def test_double_line_box_becomes_four_walls(self):
        lines = centerlines_from_segments(_box_segments())
        self.assertGreaterEqual(len(lines), 4)
        horizontals = [line for line in lines if abs(line[1] - line[3]) < 0.5]
        verticals = [line for line in lines if abs(line[0] - line[2]) < 0.5]
        self.assertGreaterEqual(len(horizontals), 2)
        self.assertGreaterEqual(len(verticals), 2)

    def test_sample_pdf_emits_project(self):
        pdf = Path(__file__).resolve().parents[1] / "source" / "gifu-hospital-map.pdf"
        if not pdf.exists():
            self.skipTest("sample pdf missing")
        # 200 pt on paper → 7200 mm. Enough to scale; not a surveyed wall.
        result = recognize_pdf(pdf, (100, 400, 300, 400), 7200, mode="generate", floor_name="1F")
        project = result["project"]
        floor = project["floors"][0]
        self.assertEqual(floor["name"], "1F")
        self.assertEqual(floor["furniture"], [])
        self.assertGreater(result["stats"]["walls"], 0)
        self.assertEqual(result["display"]["graph"]["edges"], [])
        self.assertEqual(result["display"]["schemaVersion"], "1.0.0")
        for wall in floor["walls"]:
            self.assertGreater(wall["thickness"], 0)
            self.assertEqual(wall["color"], "#e2e6e3")
            self.assertGreater(wall["height"], 0)
        for door in floor["doors"]:
            self.assertIn(door["wallId"], {wall["id"] for wall in floor["walls"]})
            self.assertGreater(door["position"], 0)
            self.assertLess(door["position"], 1)

    def test_gapped_box_closes_and_drops_stray_wall(self):
        # 15pt corner gaps → 108cm at 7.2 cm/pt, inside the corner-extend limit.
        # A segment far to the right is not part of the building.
        lines = [
            (3, 3, 82, 3, 6),
            (97, 3, 97, 62, 6),
            (18, 77, 97, 77, 6),
            (3, 18, 3, 77, 6),
            (400, 400, 460, 400, 6),
        ]
        repaired = repair_wall_lines(lines, 7.2, boundary=None)
        self.assertLess(len(repaired), 5)
        walls = []
        for index, (x0, y0, x1, y1, thick) in enumerate(repaired):
            walls.append({
                "id": f"wall-{index + 1}",
                "start": {"x": round(x0 * 7.2, 2), "y": round(y0 * 7.2, 2)},
                "end": {"x": round(x1 * 7.2, 2), "y": round(y1 * 7.2, 2)},
                "thickness": thick * 7.2,
            })
        xs = [point for wall in walls for point in (wall["start"]["x"], wall["end"]["x"])]
        self.assertLess(max(xs), 1200)
        rooms = detect_closed_rooms(walls)
        self.assertEqual(len(rooms), 1)
        self.assertGreaterEqual(len(rooms[0]["walls"]), 4)
        self.assertGreater(rooms[0]["polygon"].__len__(), 3)

    def test_crossing_divider_becomes_two_rooms(self):
        walls = [
            {"id": "bottom", "start": {"x": 0, "y": 0}, "end": {"x": 400, "y": 0}},
            {"id": "top", "start": {"x": 0, "y": 200}, "end": {"x": 400, "y": 200}},
            {"id": "left", "start": {"x": 0, "y": 0}, "end": {"x": 0, "y": 200}},
            {"id": "right", "start": {"x": 400, "y": 0}, "end": {"x": 400, "y": 200}},
            {"id": "mid", "start": {"x": 200, "y": -30}, "end": {"x": 200, "y": 230}},
        ]
        rooms = detect_closed_rooms(walls)
        self.assertEqual(len(rooms), 2)
        self.assertTrue(all("mid" in room["walls"] for room in rooms))

    def test_hospital_floor_texture_for_rooms_and_corridors(self):
        corridor = [{"x": 0, "y": 0}, {"x": 900, "y": 0}, {"x": 900, "y": 180}, {"x": 0, "y": 180}]
        room = [{"x": 0, "y": 0}, {"x": 300, "y": 0}, {"x": 300, "y": 280}, {"x": 0, "y": 280}]
        self.assertEqual(room_floor_texture(corridor, ""), "hospital-floor")
        self.assertEqual(room_floor_texture(room, ""), "hospital-floor")
        self.assertEqual(room_floor_texture(room, "走廊"), "hospital-floor")


if __name__ == "__main__":
    unittest.main()

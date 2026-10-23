"""End to end: the synthetic two-storey CAD PDF imports with real room names and a usable lift.

Fixture: tests/fixtures/synthetic-hospital-2f.pdf (from make_synthetic_hospital_pdf.py).
Guards the handoff's known issue "房间名多为「房间 N」": names must come from the PDF
labels through the real OCR/text path, not the 房间 N fallback.
"""
import importlib.util
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

PDF = Path(__file__).resolve().parent / "fixtures" / "synthetic-hospital-2f.pdf"
EXPECTED = {
    "floor-0": {"挂号收费", "药房", "候诊区", "检验科", "放射科", "输液室", "采血处", "门诊大厅", "卫生间", "超声科"},
    "floor-1": {"内科诊室", "外科诊室", "儿科", "眼科", "康复室", "口腔科", "皮肤科", "心电图室", "卫生间", "耳鼻喉科"},
}


@unittest.skipUnless(importlib.util.find_spec("rapidocr") and importlib.util.find_spec("fitz"), "OCR stack not installed")
class SyntheticPdfImportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import floor_nav
        import pdf_building

        cls.built = pdf_building.import_building(PDF)
        cls.project = cls.built["project"]
        cls.places = floor_nav.all_places(cls.project)

    def test_rooms_carry_their_drawn_names(self):
        for floor in self.project["floors"]:
            names = {str(room.get("name") or "") for room in floor["rooms"]}
            missing = EXPECTED[floor["id"]] - names
            self.assertFalse(missing, f"{floor['id']} missing {missing}")

    def test_nav_lists_named_destinations_not_placeholder_numbers(self):
        for floor_id, expected in EXPECTED.items():
            names = {p["name"] for p in self.places if p["floorId"] == floor_id}
            self.assertTrue(expected <= names, expected - names)
            placeholders = [n for n in names if re.fullmatch(r"房间 \d+", n)]
            # Only unlabelled leftovers (shaft boxes, slivers) may stay numbered.
            self.assertLessEqual(len(placeholders), 2, placeholders)

    def test_lift_stops_line_up_outside_the_x_ray_room(self):
        lift = next(link for link in self.project["verticalLinks"] if link["kind"] == "elevator")
        xs = {round(stop["x"]) for stop in lift["stops"]}
        self.assertEqual(len(xs), 1)
        self.assertGreater(min(xs), 900)  # 放射科 ends at x≈898 cm


if __name__ == "__main__":
    unittest.main()

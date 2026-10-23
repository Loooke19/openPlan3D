"""CAD ruler hide: skill layer recovery + gray-grid ink + content crop."""
import unittest
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from maker_cad import (
    cad_content_crop_hiding_rulers,
    cad_wall_ink_mask,
    filter_rooms_to_crop,
    inspect_cad_page_layers,
    is_grid_gray_rgb,
    probe_pdf_optional_content,
    render_cad_content_hiding_rulers,
)


class CadRulerHideTests(unittest.TestCase):
    def test_grid_gray_color(self):
        self.assertTrue(is_grid_gray_rgb((0.302, 0.302, 0.302)))
        self.assertFalse(is_grid_gray_rgb((0.0, 0.0, 0.0)))
        self.assertFalse(is_grid_gray_rgb((0.0, 0.5, 0.8)))

    def test_wall_ink_ignores_mid_gray_grid(self):
        rgb = np.zeros((4, 4, 3), dtype=np.uint8)
        rgb[0, 0] = [0, 0, 0]
        rgb[1, 1] = [77, 77, 77]
        rgb[2, 2] = [200, 200, 200]
        rgb[3, 0] = [60, 60, 60]  # wall AA — keep
        ink = cad_wall_ink_mask(rgb)
        self.assertTrue(ink[0, 0])
        self.assertFalse(ink[1, 1])
        self.assertFalse(ink[2, 2])
        self.assertTrue(ink[3, 0])

    def test_content_crop_shrinks_full_page(self):
        size = [2386.77, 1686.61]
        crop = {"x": 0, "y": 0, "width": size[0], "height": size[1]}
        labels = [
            {"x": 700, "y": 700, "source": "cad-vision-ocr"},
            {"x": 900, "y": 720, "source": "cad-vision-ocr"},
            {"x": 800, "y": 900, "source": "cad-vision-ocr"},
        ]
        hidden = cad_content_crop_hiding_rulers(size, crop, labels, pad=50)
        self.assertLess(hidden["width"] * hidden["height"], crop["width"] * crop["height"] * 0.9)
        self.assertGreater(hidden["x"], 50)
        self.assertGreater(hidden["y"], 50)

    def test_filter_rooms_to_crop(self):
        crop = {"x": 100, "y": 100, "width": 200, "height": 200}
        rooms = [
            {"sourceObject": "cad-fill-0", "polygonPdf": [[120, 120], [160, 120], [160, 160], [120, 160]]},
            {"sourceObject": "cad-fill-1", "polygonPdf": [[800, 800], [840, 800], [840, 840], [800, 840]]},
        ]
        kept = filter_rooms_to_crop(rooms, crop)
        self.assertEqual([r["sourceObject"] for r in kept], ["cad-fill-0"])

    def test_probe_user_pdf_has_no_ocg(self):
        pdf = Path("/Users/luke/Downloads/2#带名称_合并(5页).pdf")
        if not pdf.is_file():
            self.skipTest("user CAD PDF not present")
        probe = probe_pdf_optional_content(pdf, page_index=1)
        self.assertFalse(probe["hasOcg"])
        self.assertFalse(probe["canHideByLayer"])
        self.assertEqual(probe["strategy"], "reconstructed-style-runs")
        self.assertIn("Ghostscript", probe.get("producer") or "")

    def test_skill_recovers_reconstructed_ruler_layer_on_page1(self):
        pdf = Path("/Users/luke/Downloads/2#带名称_合并(5页).pdf")
        if not pdf.is_file():
            self.skipTest("user CAD PDF not present")
        inspection = inspect_cad_page_layers(pdf, page_index=1)
        self.assertFalse(inspection["native"]["present"])
        self.assertEqual(inspection["strategy"], "reconstructed-style-runs")
        candidates = inspection["reconstructed"]["rulerCandidates"]
        self.assertGreaterEqual(len(candidates), 1)
        self.assertGreaterEqual(candidates[0]["pathCount"], 1000)
        self.assertEqual(candidates[0]["semantic"], "axis-grid")
        self.assertEqual(candidates[0]["kind"], "reconstructed")

    def test_hide_reconstructed_rulers_strips_gray_axis_strokes(self):
        pdf = Path("/Users/luke/Downloads/2#带名称_合并(5页).pdf")
        if not pdf.is_file():
            self.skipTest("user CAD PDF not present")
        image, meta = render_cad_content_hiding_rulers(pdf, page_index=1, dpi=48)
        self.assertIsNotNone(image)
        self.assertEqual(meta["mode"], "reconstructed-style-runs")
        self.assertGreaterEqual(meta["grayStrokesRemoved"], 10000)
        # Mid-gray should be nearly gone from the cleaned raster.
        arr = np.array(image)
        grayish = (
            (np.abs(arr[:, :, 0].astype(np.int16) - arr[:, :, 1].astype(np.int16)) <= 6)
            & (np.abs(arr[:, :, 1].astype(np.int16) - arr[:, :, 2].astype(np.int16)) <= 6)
            & (arr.min(axis=2) >= 70)
            & (arr.min(axis=2) <= 85)
        )
        self.assertLess(float(grayish.mean()), 0.01)


    def test_structure_recovers_doors_stairs_and_left_wing(self):
        pdf = Path("/Users/luke/Downloads/2#带名称_合并(5页).pdf")
        if not pdf.is_file():
            self.skipTest("user CAD PDF not present")
        from maker_cad import load_cad_vector_content, cad_structure_rooms

        content = load_cad_vector_content(pdf, page_index=1)
        self.assertIsNotNone(content)
        self.assertGreater(len(content["segments"]), 1000)
        width, height = content["pageSize"]
        crop = {"x": 0, "y": 0, "width": width, "height": height}
        structure = cad_structure_rooms(content, crop, width * height)
        self.assertIsNotNone(structure)
        self.assertGreaterEqual(structure["meta"].get("wingsMerged", 0), 1)
        self.assertLess(structure["footprintBox"][0], 220)
        xs = [p[0] for p in structure["boundary"]]
        self.assertLess(min(xs), 220)
        self.assertTrue(all(
            abs(a[0] - b[0]) < 1.5 or abs(a[1] - b[1]) < 1.5
            for a, b in zip(structure["boundary"], structure["boundary"][1:] + structure["boundary"][:1])
        ), "boundary must stay rectilinear")
        self.assertGreaterEqual(len(structure["doors"]), 10)
        self.assertGreaterEqual(len(structure["stairs"]), 2)
        self.assertTrue(any(r["polygonPdf"][0][0] < 400 for r in structure["rooms"]))


if __name__ == "__main__":
    unittest.main()

"""CAD OCR split: room names vs scale/area/axis."""
import unittest
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from maker_ocr import (
    openplan_room_labels,
    classify_ocr_text,
    is_equipment_label,
    room_name_for_plan,
    split_ocr_items,
    clip_cad_rooms_to_labels,
    _ocr_windows,
)


class CadOcrSplitTests(unittest.TestCase):
    def test_room_ocr_reports_unusable_engine(self):
        with patch("maker_ocr.resolve_ocr_backend", return_value="rapidocr"), patch("maker_ocr._get_rapidocr_engine", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "RapidOCR"):
                openplan_room_labels("unused.pdf")

    def test_room_names_are_content(self):
        for text in ("手术室", "细菌室", "中医体质辨识室", "体检窗口", "管道牙", "休息"):
            kind, _ = classify_ocr_text(text)
            self.assertEqual(kind, "content", text)

    def test_name_typos_are_corrected(self):
        kind, text = classify_ocr_text("管道牙")
        self.assertEqual(kind, "content")
        self.assertEqual(text, "管道井")
        _, text = classify_ocr_text("仪界室")
        self.assertEqual(text, "仪器室")
        _, text = classify_ocr_text("手榨室")
        self.assertEqual(text, "手术室")
        _, text = classify_ocr_text("体检奩口")
        self.assertEqual(text, "体检窗口")
        self.assertEqual(classify_ocr_text("中华人民共和民")[0], "drop")
        for typo in ("储臧", "储减", "锗藏", "诸藏", "儲藏"):
            kind, text = classify_ocr_text(typo)
            self.assertEqual(kind, "content", typo)
            self.assertEqual(text, "储藏", typo)
        for typo in ("空调外", "空调外右", "空调外杪", "空请外", "空堝外机"):
            kind, text = classify_ocr_text(typo)
            self.assertEqual(kind, "content", typo)
            self.assertEqual(text, "空调外机", typo)
        self.assertEqual(classify_ocr_text("坦疗室")[1], "理疗室")
        self.assertEqual(classify_ocr_text("冰箱")[0], "drop")
        self.assertEqual(classify_ocr_text("开水")[0], "drop")
        self.assertEqual(classify_ocr_text("开水器")[0], "drop")
        self.assertEqual(classify_ocr_text("电脑")[0], "drop")
        self.assertEqual(classify_ocr_text("打印机")[0], "drop")
        self.assertEqual(classify_ocr_text("饮水机")[0], "drop")
        self.assertTrue(is_equipment_label("电脑"))
        self.assertFalse(is_equipment_label("空调外机"))
        self.assertFalse(is_equipment_label("储藏"))
        # Real pantry / computer room must survive; outdoor AC stays a name.
        kind, text = classify_ocr_text("开水茶水间")
        self.assertEqual(kind, "content")
        self.assertIn("茶", text)
        self.assertEqual(classify_ocr_text("电脑室")[0], "content")
        self.assertEqual(classify_ocr_text("空调外机")[0], "content")
        self.assertEqual(classify_ocr_text("储藏")[0], "content")

    def test_storage_labels_survive_dedupe(self):
        # Five niches under 理疗室 sit ~50–140pt apart — must not collapse.
        xs = [960.6, 1095.1, 1148.8, 1286.7, 1345.7]
        items = [
            {"text": "储藏", "bbox_pdf": [x - 8, 1047.0, x + 8, 1060.0]}
            for x in xs
        ]
        labels, _ = split_ocr_items(items)
        self.assertEqual(len(labels), 5)
        self.assertEqual([item["text"] for item in labels], ["储藏"] * 5)

    def test_plan_names_drop_pure_numbers(self):
        self.assertEqual(room_name_for_plan("PT"), "PT")
        self.assertEqual(room_name_for_plan("手术室"), "手术室")
        self.assertEqual(room_name_for_plan("走廊"), "走廊")
        self.assertEqual(room_name_for_plan("3400"), "")
        self.assertEqual(room_name_for_plan("17.204m2"), "")
        self.assertEqual(room_name_for_plan("12"), "")
        self.assertEqual(room_name_for_plan("1:100"), "")
        self.assertEqual(room_name_for_plan("办公室"), "办公室")
        self.assertEqual(room_name_for_plan("项目经理"), "")
        self.assertEqual(room_name_for_plan("由Autodesk教育版产品制作"), "")
        self.assertEqual(room_name_for_plan("原屋顶平面"), "")
        self.assertEqual(room_name_for_plan("建施-04"), "")

    def test_scale_area_axis_are_calibration(self):
        self.assertEqual(classify_ocr_text("1:100")[0], "calibration_scale")
        self.assertEqual(classify_ocr_text("17.204m2")[0], "calibration_area")
        self.assertEqual(classify_ocr_text("43940")[0], "calibration_axis")
        self.assertEqual(classify_ocr_text("3400")[0], "calibration_axis")
        self.assertEqual(classify_ocr_text("三层现状平面图")[0], "calibration_title")
        self.assertEqual(classify_ocr_text("本层建筑面积：964.326m2")[0], "calibration_area")
        self.assertEqual(classify_ocr_text("19發04m")[0], "calibration_area")
        self.assertEqual(classify_ocr_text("信裝6m?")[0], "calibration_area")
        labels, calibration = split_ocr_items([
            {"text": "三层现状平面图1:100", "bbox_pdf": [1100, 1420, 1240, 1440]},
        ])
        self.assertEqual(labels, [])
        self.assertEqual(calibration["ratio"], "1:100")

    def test_split_keeps_names_out_of_calibration_pois(self):
        items = [
            {"text": "细菌室", "bbox_pdf": [640, 590, 680, 610]},
            {"text": "14.420m2", "bbox_pdf": [640, 610, 700, 625]},
            {"text": "1:100", "bbox_pdf": [1100, 1420, 1160, 1440]},
            {"text": "43940", "bbox_pdf": [800, 1300, 860, 1320]},
        ]
        labels, calibration = split_ocr_items(items)
        self.assertEqual([item["text"] for item in labels], ["细菌室"])
        self.assertEqual(labels[0]["source"], "cad-vision-ocr")
        self.assertEqual(calibration["ratio"], "1:100")
        self.assertTrue(calibration["metersPerMapUnit"] > 0)
        self.assertIn(43940, calibration["axisDimsMm"])

    def test_clip_drops_axis_band_cad_fills(self):
        labels = [{
            "text": name, "x": 100 + index, "y": 100, "size": 10,
            "x0": 90, "x1": 110, "top": 95, "bottom": 105, "source": "cad-vision-ocr",
        } for index, name in enumerate(("细菌室", "仪器室", "手术室"))]
        rooms = [
            {"sourceObject": "cad-fill-0", "polygonPdf": [[80, 80], [120, 80], [120, 120], [80, 120]]},
            {"sourceObject": "cad-fill-1", "polygonPdf": [[80, 800], [140, 800], [140, 860], [80, 860]]},
        ]
        kept = clip_cad_rooms_to_labels(rooms, labels, pad=50)
        self.assertEqual([room["sourceObject"] for room in kept], ["cad-fill-0"])

    def test_ocr_windows_match_research_clips(self):
        crop = {"x": 0, "y": 0, "width": 2386.77, "height": 1686.61}
        rooms = [
            {"polygonPdf": [[600, 600], [800, 600], [800, 800], [600, 800]]},
            {"polygonPdf": [[900, 600], [1100, 600], [1100, 800], [900, 800]]},
            {"polygonPdf": [[600, 900], [800, 900], [800, 1100], [600, 1100]]},
            {"polygonPdf": [[900, 900], [1100, 900], [1100, 1100], [900, 1100]]},
        ]
        windows = _ocr_windows(crop, rooms)
        self.assertGreaterEqual(len(windows), 6)
        title = (1100, 1430)
        self.assertTrue(
            any(w[0] <= title[0] <= w[2] and w[1] <= title[1] <= w[3] for w in windows),
            windows,
        )
        body = (700, 700)
        body_hits = sum(1 for w in windows if w[0] <= body[0] <= w[2] and w[1] <= body[1] <= w[3])
        self.assertGreaterEqual(body_hits, 1)

    def test_overlapping_tiles_keep_longer_name(self):
        labels, _ = split_ocr_items([
            {"text": "体", "bbox_pdf": [100, 100, 120, 114]},
            {"text": "体检窗口", "bbox_pdf": [98, 98, 140, 116]},
        ])
        self.assertEqual([item["text"] for item in labels], ["体检窗口"])


if __name__ == "__main__":
    unittest.main()

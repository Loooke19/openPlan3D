import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from hospital_lexicon import correct  # noqa: E402
from maker_ocr import group_label_lines, room_labels_from_lines  # noqa: E402


def line(text, x0, y0, w=40, h=8, conf=1.0):
    return {"text": text, "x0": x0, "y0": y0, "x1": x0 + w, "y1": y0 + h, "conf": conf}


class LexiconTest(unittest.TestCase):
    def test_single_glyph_fixes(self):
        self.assertEqual(correct("谈证室"), "谈话室")
        self.assertEqual(correct("计划性育手术室"), "计划生育手术室")
        self.assertEqual(correct("度弃物"), "废弃物")

    def test_never_touches_numerals_or_valid_words(self):
        self.assertEqual(correct("计免留观一室"), "计免留观一室")
        self.assertEqual(correct("内科诊室1"), "内科诊室1")
        self.assertEqual(correct("诊室"), "诊室")

    def test_supplied_list_is_used(self):
        self.assertEqual(correct("西药户", ["西药房"], strict_extra=True), "西药房")


class GroupingTest(unittest.TestCase):
    def test_two_line_name_joins(self):
        blocks = group_label_lines([line("卫生健康监督", 0, 0, 60), line("协管办公室", 5, 10, 50)])
        self.assertEqual([b["text"] for b in blocks], ["卫生健康监督协管办公室"])

    def test_stacked_complete_names_stay_apart(self):
        blocks = group_label_lines([line("输液大厅", 0, 0), line("夜间输液室", 0, 10)])
        self.assertEqual([b["text"] for b in blocks], ["输液大厅/夜间输液室"])
        blocks = group_label_lines([line("眼科普诊", 0, 0), line("眼科专家诊室", 0, 10)])
        self.assertEqual([b["text"] for b in blocks], ["眼科普诊/眼科专家诊室"])

    def test_far_lines_stay_apart(self):
        blocks = group_label_lines([line("药剂", 0, 0), line("存放处", 200, 10)])
        self.assertEqual(len(blocks), 2)

    def test_confident_reads_kept_as_printed(self):
        labels = room_labels_from_lines([line("计生咨询指挥室", 0, 0, 80, conf=1.0)])
        self.assertEqual(labels[0]["text"], "计生咨询指挥室")
        shaky = room_labels_from_lines([line("谈证室", 0, 0, conf=0.8)])
        self.assertEqual((shaky[0]["text"], shaky[0]["raw"]), ("谈话室", "谈证室"))


class NorthArrowTest(unittest.TestCase):
    def _pdf(self, apex):
        import math
        import pymupdf
        doc = pymupdf.open()
        page = doc.new_page(width=400, height=400)
        page.draw_circle((200, 200), 30, color=(0, 0, 0))
        ax, ay = apex
        # needle: apex at the rim, two base corners near the opposite rim
        bx, by = 200 - (ax - 200), 200 - (ay - 200)
        nx, ny = -(ay - 200) / 30 * 4, (ax - 200) / 30 * 4
        page.draw_polyline([(ax, ay), (bx + nx, by + ny), (bx - nx, by - ny), (ax, ay)], color=None, fill=(0, 0, 0), closePath=True)
        page.draw_circle((60, 60), 10, color=(0, 0, 0))  # axis bubble: ignored
        path = Path(tempfile.mkdtemp()) / "n.pdf"
        doc.save(str(path))
        return path

    def test_detects_bearing(self):
        from north_arrow import detect_north
        self.assertAlmostEqual(detect_north(self._pdf((200, 172)))["bearing"] % 360, 0, delta=3)
        self.assertAlmostEqual(detect_north(self._pdf((172, 200)))["bearing"], 270, delta=3)

    def test_none_without_arrow(self):
        import pymupdf
        from north_arrow import detect_north
        doc = pymupdf.open()
        doc.new_page().draw_circle((100, 100), 20, color=(0, 0, 0))
        path = Path(tempfile.mkdtemp()) / "x.pdf"
        doc.save(str(path))
        self.assertIsNone(detect_north(path))


class RoomListParseTest(unittest.TestCase):
    def test_text_and_json(self):
        import kujiale_import_server as k
        self.assertEqual(k._parse_room_names("[1F]\n门厅、西药房\n[2F]\n推拿"), {"1F": ["门厅", "西药房"], "2F": ["推拿"]})
        self.assertEqual(k._parse_room_names('["诊室"]'), {"*": ["诊室"]})
        self.assertIsNone(k._parse_room_names(""))


if __name__ == "__main__":
    unittest.main()


class EntranceTest(unittest.TestCase):
    def test_exterior_door_becomes_entrance_poi(self):
        from pdf_building import add_entrances
        sq = [{"x": 0, "y": 0}, {"x": 1000, "y": 0}, {"x": 1000, "y": 1000}, {"x": 0, "y": 1000}]
        floor = {
            "footprint": sq,
            "walls": [{"id": "w1", "start": {"x": 0, "y": 1000}, "end": {"x": 1000, "y": 1000}, "thickness": 20},
                      {"id": "w2", "start": {"x": 500, "y": 0}, "end": {"x": 500, "y": 1000}, "thickness": 12}],
            "doors": [{"id": "d1", "wallId": "w1", "position": 0.5, "width": 150},
                      {"id": "d2", "wallId": "w2", "position": 0.3, "width": 90}],
        }
        pois = add_entrances(floor)
        self.assertEqual(len(pois), 1)
        self.assertEqual(pois[0]["text"], "大门（出入口 A）")
        self.assertIn("大门", pois[0]["aliases"])
        self.assertLess(pois[0]["y"], 1000)  # inside the building


class StairChainTest(unittest.TestCase):
    def test_split_stairwell_chains_into_one_link(self):
        from pdf_building import link_shafts
        floors = [{"id": f"f{i}", "level": i} for i in (1, 2, 3, 4)]
        v = {"f1": [{"kind": "stairs", "x": 693, "y": -535}, {"kind": "stairs", "x": -927, "y": 85}],
             "f2": [{"kind": "stairs", "x": 904, "y": -517}, {"kind": "stairs", "x": 970, "y": 236}, {"kind": "stairs", "x": -936, "y": 83}],
             "f3": [{"kind": "stairs", "x": 876, "y": 121}, {"kind": "stairs", "x": -944, "y": 101}],
             "f4": [{"kind": "stairs", "x": -864, "y": 258}]}
        links = link_shafts(floors, v)
        spans = sorted(sorted(s["floorId"] for s in l["stops"]) for l in links)
        self.assertEqual(spans, [["f1", "f2", "f3"], ["f1", "f2", "f3", "f4"]])

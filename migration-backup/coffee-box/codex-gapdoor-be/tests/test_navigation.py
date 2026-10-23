"""Geometry and routing regressions against the independently inspected 1F PDF.

Run with: python3 -m unittest discover -s tests -v
Coordinates below are PDF map units (800 x 1210), never measured metres.
"""
from collections import defaultdict
import copy
import importlib.util
import json
import math
from pathlib import Path
import unittest

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("build_map", ROOT / "scripts/build_map.py")
build_map = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build_map)


def sampled_points(polyline, pdf_size, spacing=0.2):
    """Sample every segment, including a single-position POI attachment."""
    points = [np.array(p, dtype=float) * pdf_size for p in polyline]
    if points:
        yield points[0]
    for a, b in zip(points, points[1:]):
        count = max(1, math.ceil(float(np.linalg.norm(b - a)) / spacing))
        for i in range(1, count + 1):
            yield a + (b - a) * (i / count)


def pixel_index(value):
    # Seven-decimal normalized coordinates can move an integer by <0.0001 px.
    # Correct only that serialization error, never dilate the mask or allow an
    # adjacent walkable pixel to excuse a point that is genuinely in a wall.
    rounded = round(float(value))
    return rounded if abs(float(value) - rounded) <= 0.0001 else math.floor(value)


class HospitalNavigationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.document = json.loads((ROOT / "data/map.json").read_text())
        cls.graph = cls.document["graph"]
        cls.pois = {p["id"]: p for p in cls.document["pois"]}
        cls.pdf_size = np.array(cls.document["source"]["pdfSize"], dtype=float)
        cls.safe = np.array(Image.open(ROOT / "data/safe-mask.png").convert("L")) > 0
        cls.walkable = np.array(Image.open(ROOT / "data/walkable-mask.png").convert("L")) > 0

    def route(self, destination, graph=None, origin="entrance-main"):
        return build_map.shortest_path(
            self.graph if graph is None else graph,
            self.pois[origin]["nodeId"],
            self.pois[destination]["nodeId"],
        )

    def test_courtyards_rooms_shafts_and_label_whitespace_are_not_floor(self):
        # These rectangles are safely INSIDE independently inspected obstacles.
        blocked_areas = {
            "west courtyard": (280, 240, 325, 377),
            "east courtyard": (560, 492, 628, 526),
            "cafe": (425, 340, 448, 435),
            "pharmacy": (350, 610, 510, 785),
            "central elevator shaft": (429, 494, 443, 523),
            "general medicine": (340, 280, 390, 375),
            "grey administration": (180, 650, 275, 785),
            # A white reception-label background overlaps the cafe on the PDF.
            "white label covering cafe": (425, 402, 440, 412),
        }
        for name, (x0, y0, x1, y1) in blocked_areas.items():
            with self.subTest(area=name):
                self.assertFalse(self.walkable[y0:y1, x0:x1].any(), name)
                self.assertFalse(self.safe[y0:y1, x0:x1].any(), name)
        for x, y in [(30, 350), (400, 80), (780, 500), (600, 900)]:
            with self.subTest(outside=(x, y)):
                self.assertFalse(self.walkable[y, x])

    def test_blue_main_lobby_and_north_connection_are_walkable(self):
        for name, point in [
            ("blue main entrance", (92, 345)),
            ("main lobby", (180, 345)),
            ("north connection", (224, 130)),
            ("north reception west side", (233, 115)),
        ]:
            with self.subTest(location=name):
                x, y = point
                self.assertTrue(self.walkable[y, x], name)
                self.assertTrue(self.safe[y, x], name)

    def test_every_graph_edge_stays_inside_safe_floor(self):
        self.assertEqual(tuple(self.safe.shape[::-1]), tuple(self.pdf_size.astype(int)))
        nodes = {n["id"]: n for n in self.graph["nodes"]}
        self.assertGreater(len(self.graph["edges"]), 0)
        for edge in self.graph["edges"]:
            with self.subTest(edge=edge["id"]):
                self.assertIn(edge["source"], nodes)
                self.assertIn(edge["target"], nodes)
                self.assertTrue(edge["polyline"])
                np.testing.assert_allclose(edge["polyline"][0], nodes[edge["source"]]["position"], atol=1e-7)
                np.testing.assert_allclose(edge["polyline"][-1], nodes[edge["target"]]["position"], atol=1e-7)
                for point in sampled_points(edge["polyline"], self.pdf_size):
                    x, y = (pixel_index(value) for value in point)
                    self.assertTrue(
                        0 <= x < self.safe.shape[1] and 0 <= y < self.safe.shape[0]
                        and self.safe[y, x],
                        f"{edge['id']} leaves safe floor at PDF {point.tolist()}",
                    )

    def test_main_entrance_reaches_major_destinations(self):
        destinations = [
            "department-endoscopy", "department-general-medicine", "department-emergency",
            "department-radiology", "department-mri", "pharmacy-day-counter",
            "pharmacy-after-hours", "shop-cafe", "elevator-floor-1-2", "elevator-wards",
            "entrance-emergency", "entrance-after-hours", "entrance-south",
        ]
        for destination in destinations:
            with self.subTest(destination=destination):
                self.assertIsNotNone(self.pois[destination]["nodeId"])
                route = self.route(destination)
                self.assertIsNotNone(route)
                self.assertGreater(route["lengthMapUnits"], 0)
                self.assertTrue(route["steps"])

    def test_closing_north_connection_isolates_north_but_not_main_hospital(self):
        graph = copy.deepcopy(self.graph)
        disabled = []
        for edge in graph["edges"]:
            # A horizontal closure spans the full known connecting neck. Test
            # polyline segments, not just their endpoints: long edges may cross.
            for a, b in zip(edge["polyline"], edge["polyline"][1:]):
                a, b = np.array(a) * self.pdf_size, np.array(b) * self.pdf_size
                if a[1] == b[1] or not min(a[1], b[1]) <= 132 <= max(a[1], b[1]):
                    continue
                crossing_x = a[0] + (132 - a[1]) * (b[0] - a[0]) / (b[1] - a[1])
                if 214 <= crossing_x <= 236:
                    edge["enabled"] = False
                    disabled.append(edge["id"])
                    break
        self.assertTrue(disabled, "No graph edge crossed the known north connection")
        self.assertIsNotNone(self.route("department-endoscopy"))
        self.assertIsNone(self.route("department-endoscopy", graph))
        self.assertIsNone(self.route("reception-endoscopy", graph))
        for destination in ["pharmacy-day-counter", "department-radiology", "department-emergency"]:
            with self.subTest(main_building_destination=destination):
                self.assertIsNotNone(self.route(destination, graph))

    def test_same_origin_and_destination_has_zero_distance(self):
        for destination in ["entrance-main", "department-endoscopy", "pharmacy-day-counter"]:
            with self.subTest(destination=destination):
                result = self.route(destination, origin=destination)
                self.assertEqual(result["lengthMapUnits"], 0)
                self.assertEqual(result["steps"], [])

    def test_repeated_map_labels_keep_distinct_poi_and_graph_ids(self):
        pois = self.document["pois"]
        self.assertEqual(len(pois), len({p["id"] for p in pois}))
        grouped = defaultdict(list)
        for poi in pois:
            grouped[poi["sourceLabel"]].append(poi)
        # Actual repeated names on this floor must not be collapsed by OCR or
        # identification: two consultation rooms and multiple reception desks.
        self.assertEqual(len(grouped["5 咨询室"]), 2)
        self.assertGreaterEqual(len(grouped["接待处"]), 3)
        for source_label, entries in grouped.items():
            if len(entries) < 2:
                continue
            with self.subTest(source_label=source_label):
                node_ids = [p["nodeId"] for p in entries]
                self.assertNotIn(None, node_ids)
                self.assertEqual(len(node_ids), len(set(node_ids)))
        nodes = self.graph["nodes"]
        edges = self.graph["edges"]
        self.assertEqual(len(nodes), len({n["id"] for n in nodes}))
        self.assertEqual(len(edges), len({e["id"] for e in edges}))

    def test_uncalibrated_routes_do_not_claim_physical_metres(self):
        self.assertIsNone(self.document["calibration"])
        self.assertFalse(self.document["geometry"]["clearance"]["physicalRadiusVerified"])
        route = self.route("pharmacy-day-counter")
        self.assertGreater(route["lengthMapUnits"], 0)
        samples = json.loads((ROOT / "data/sample-routes.json").read_text())

        def check(value, path):
            if isinstance(value, dict):
                for key, child in value.items():
                    if key.lower() in {"lengthmeters", "distancemeters", "lengthmetres", "distancemetres", "metersperpixel", "metresperpixel"}:
                        self.assertIsNone(child, f"Uncalibrated physical measurement at {path}.{key}")
                    check(child, f"{path}.{key}")
            elif isinstance(value, list):
                for index, child in enumerate(value):
                    check(child, f"{path}[{index}]")

        check(self.document, "map")
        check(samples, "sample-routes")
        check(route, "computed-route")

    def test_diagonal_navigation_cannot_cut_between_touching_obstacles(self):
        mask = np.array([[True, False], [False, True]])
        self.assertEqual(list(build_map.neighbors((0, 0), mask)), [])


if __name__ == "__main__":
    unittest.main()

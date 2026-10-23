"""Stage 3 maker build: extract a cropped page into a MapDocument snapshot."""
from io import BytesIO
from pathlib import Path
import json
import sys
import tempfile
import unittest

from pypdf import PdfWriter

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))


def blank_pdf(pages):
    writer = PdfWriter()
    for width, height in pages:
        writer.add_blank_page(width=width, height=height)
    buffer = BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def pdf_with_content(width, height, instructions: bytes):
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
        (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width} {height}] "
            "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"
        ).encode("ascii"),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length %d >>\nstream\n" % len(instructions) + instructions + b"\nendstream",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for index, payload in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{index} 0 obj\n".encode("ascii") + payload + b"\nendobj\n"
    startxref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode("ascii")
    out += b"0000000000 65535 f \n"
    for offset in offsets[1:]:
        out += f"{offset:010d} 00000 n \n".encode("ascii")
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{startxref}\n%%EOF\n"
    ).encode("ascii")
    return bytes(out)


def valid_point(point):
    return (
        isinstance(point, list)
        and len(point) == 2
        and all(isinstance(value, (int, float)) and value == value and 0 <= value <= 1 for value in point)
    )


def assert_activate_coords(test, data):
    """Mirror preview/viewer.js activate() coordinate and graph-link checks."""
    ids = {node["id"] for node in data["graph"]["nodes"]}
    for node in data["graph"]["nodes"]:
        test.assertTrue(valid_point(node["position"]), node)
    for poi in data["pois"]:
        test.assertTrue(valid_point(poi["position"]), poi)
        test.assertTrue(valid_point(poi["labelPosition"]), poi)
        if poi.get("nodeId"):
            test.assertIn(poi["nodeId"], ids, poi)
    for edge in data["graph"]["edges"]:
        test.assertIn(edge["source"], ids, edge)
        test.assertIn(edge["target"], ids, edge)
        test.assertTrue(isinstance(edge["lengthMapUnits"], (int, float)) and edge["lengthMapUnits"] >= 0, edge)
        test.assertTrue(edge.get("polyline") and all(valid_point(point) for point in edge["polyline"]), edge)
    test.assertTrue(data["geometry"]["buildingBoundary"] and all(valid_point(point) for point in data["geometry"]["buildingBoundary"]))
    for obstacle in data["geometry"]["obstacles"]:
        test.assertTrue(obstacle.get("polygon") and all(valid_point(point) for point in obstacle["polygon"]), obstacle)


def floorplan_pdf():
    instructions = b"\n".join([
        b"1 1 1 rg 0 0 400 300 re f",
        b"0.82 0.90 0.80 rg 20 90 120 150 re f",
        b"0.99 0.87 0.72 rg 240 90 120 150 re f",
        b"BT /F1 14 Tf 40 160 Td (Clinic) Tj ET",
        b"BT /F1 14 Tf 260 160 Td (Office) Tj ET",
        b"BT /F1 14 Tf 150 30 Td (Entrance) Tj ET",
    ])
    return pdf_with_content(400, 300, instructions)


def cad_linework_pdf():
    """Closed black wall loops, no room fills — CAD line-art stand-in."""
    instructions = b"\n".join([
        b"1 1 1 rg 0 0 400 300 re f",
        b"0 0 0 RG 3 w",
        b"40 50 m 180 50 l 180 200 l 40 200 l s",
        b"200 50 m 360 50 l 360 200 l 200 200 l s",
        b"40 210 m 360 210 l 360 270 l 40 270 l s",
    ])
    return pdf_with_content(400, 300, instructions)


class MakerBuildTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        import os
        os.environ["HOSPITAL_PROJECTS_DIR"] = self.tmpdir.name
        import importlib
        import maker_app
        import maker_store
        import maker_build
        importlib.reload(maker_store)
        importlib.reload(maker_build)
        importlib.reload(maker_app)
        maker_app.store.root = Path(self.tmpdir.name)
        maker_app.store.root.mkdir(parents=True, exist_ok=True)
        from fastapi.testclient import TestClient
        self.app = maker_app
        self.client = TestClient(maker_app.app)

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_blank_page_cannot_build(self):
        created = self.client.post("/api/projects", files={"file": ("blank.pdf", blank_pdf([(200, 200)]), "application/pdf")}).json()
        response = self.client.post(f"/api/projects/{created['id']}/build", json={"revision": created["draft"]["revision"]})
        self.assertEqual(response.status_code, 400)
        self.assertIn("房间", response.json()["detail"])
        self.assertFalse((ROOT / "data" / created["id"]).exists())

    def test_floorplan_builds_without_touching_demo_data(self):
        created = self.client.post("/api/projects", files={"file": ("clinic.pdf", floorplan_pdf(), "application/pdf")}).json()
        saved = self.client.put(f"/api/projects/{created['id']}/draft", json={
            "revision": created["draft"]["revision"],
            "pageIndex": 1,
            "rotation": 0,
            "floor": {"id": "2F", "name": "二楼", "description": "日间手术"},
        }).json()
        response = self.client.post(f"/api/projects/{saved['id']}/build", json={"revision": saved["draft"]["revision"]})
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        document = body["map"]
        self.assertEqual(document["schemaVersion"], "1.0.0")
        self.assertEqual(document["floor"]["id"], "2F")
        self.assertEqual(document["floor"]["name"], "二楼")
        self.assertGreaterEqual(len(document["geometry"]["obstacles"]), 1)
        self.assertGreaterEqual(len(document["pois"]), 1)
        self.assertTrue(any(poi.get("nodeId") for poi in document["pois"]))
        self.assertTrue(document["graph"]["nodes"])
        assert_activate_coords(self, document)
        self.assertEqual(body["project"]["status"], "ready")
        self.assertEqual(body["project"]["floors"]["1"]["status"], "ready")
        fetched = self.client.get(f"/api/projects/{saved['id']}/map", params={"floor": "2F"})
        self.assertEqual(fetched.status_code, 200)
        self.assertEqual(fetched.json()["floor"]["id"], "2F")
        self.assertFalse((ROOT / "data" / saved["id"]).exists())
        overlay = self.client.get(f"/api/projects/{saved['id']}/maps/2F/walkable-overlay.png")
        self.assertEqual(overlay.status_code, 200)

    def test_gifu_page_two_can_build(self):
        pdf = ROOT / "source" / "gifu-hospital-map.pdf"
        if not pdf.is_file():
            self.skipTest("source PDF missing")
        created = self.client.post("/api/projects", files={"file": ("chn.pdf", pdf.read_bytes(), "application/pdf")}).json()
        saved = self.client.put(f"/api/projects/{created['id']}/draft", json={
            "revision": created["draft"]["revision"],
            "pageIndex": 2,
            "rotation": 0,
            "crop": {"x": 4.678, "y": 0, "width": 781.652, "height": 819.182},
            "floor": {"id": "2F", "name": "二楼", "description": "北门诊楼"},
        }).json()
        response = self.client.post(f"/api/projects/{saved['id']}/build", json={"revision": saved["draft"]["revision"]})
        self.assertEqual(response.status_code, 200, response.text)
        document = response.json()["map"]
        self.assertEqual(document["floor"]["id"], "2F")
        self.assertGreaterEqual(len(document["geometry"]["obstacles"]), 10)
        self.assertGreaterEqual(len(document["pois"]), 5)
        self.assertGreaterEqual(len(document["graph"]["nodes"]), 10)
        assert_activate_coords(self, document)
        demo = json.loads((ROOT / "data" / "map.json").read_text(encoding="utf-8"))
        self.assertEqual(demo["id"], "gifu-1f")

    def test_cluster_vertical_cjk_name(self):
        from maker_build import cluster_glyphs
        glyphs = []
        y = 20
        for char in "主入口出口":
            glyphs.append({"text": char, "x": 10, "y": y, "size": 20, "x0": 5, "x1": 15, "top": y - 10, "bottom": y + 10})
            y += 20
        texts = [item["text"] for item in cluster_glyphs(glyphs)]
        joined = "".join(texts)
        self.assertTrue(any("主入口" in text for text in texts) or "主入口" in joined, texts)

    def test_repair_walkable_reconnects_pinched_corridor(self):
        import numpy as np
        from build_map import components
        from maker_build import repair_walkable_grid
        walkable = np.zeros((16, 40), dtype=bool)
        walkable[6:10, 2:18] = True
        walkable[6:10, 18:22] = True
        walkable[6:10, 22:38] = True
        safe = walkable.copy()
        safe[6:10, 18:22] = False
        repaired, notes = repair_walkable_grid(safe, walkable)
        _, sizes = components(repaired)
        self.assertEqual(len(sizes), 1, notes)
        self.assertTrue(notes)

    def test_gifu_page_one_recovers_stacked_and_nearby_names(self):
        from maker_build import extract_page
        pdf = ROOT / "source" / "gifu-hospital-map.pdf"
        if not pdf.is_file():
            self.skipTest("source PDF missing")
        _, _, rooms, labels, _ = extract_page(pdf, 1, {"x": 78, "y": 42, "width": 696, "height": 772})
        texts = {item["text"] for item in labels}
        blob = " ".join(texts)
        self.assertGreaterEqual(len(labels), 40)
        self.assertIn("北门诊楼", blob)
        self.assertTrue("入口大厅" in blob or any("大厅" in text for text in texts))
        self.assertTrue(any("主入口" in text for text in texts))
        self.assertGreaterEqual(len(rooms), 20)

    def test_rename_and_icon_persist_without_rewriting_pdf(self):
        import hashlib
        created = self.client.post("/api/projects", files={"file": ("clinic.pdf", floorplan_pdf(), "application/pdf")}).json()
        pdf_path = Path(self.tmpdir.name) / created["id"] / "source.pdf"
        digest = hashlib.sha256(pdf_path.read_bytes()).hexdigest()
        saved = self.client.put(f"/api/projects/{created['id']}/draft", json={
            "revision": created["draft"]["revision"],
            "pageIndex": 1,
            "rotation": 0,
            "floor": {"id": "1F", "name": "一楼"},
        }).json()
        built = self.client.post(f"/api/projects/{saved['id']}/build", json={"revision": saved["draft"]["revision"]})
        self.assertEqual(built.status_code, 200, built.text)
        document = built.json()["map"]
        poi = document["pois"][0]
        patched = self.client.patch(f"/api/projects/{saved['id']}/edits", json={
            "revision": built.json()["project"]["draft"]["revision"],
            "floorId": "1F",
            "renamedPois": {poi["id"]: "急诊大厅"},
            "renamedRooms": {poi["roomId"]: "急诊大厅"} if poi.get("roomId") else {},
            "facilityIcons": [{"id": "icon-wc1", "category": "restroom", "name": "卫生间", "position": [0.5, 0.5]}],
        })
        self.assertEqual(patched.status_code, 200, patched.text)
        names = [item["name"] for item in patched.json()["map"]["pois"]]
        self.assertIn("急诊大厅", names)
        self.assertTrue(any(item["id"].startswith("icon-") for item in patched.json()["map"]["pois"]))
        rebuilt = self.client.post(f"/api/projects/{saved['id']}/build", json={"revision": patched.json()["draft"]["revision"]})
        self.assertEqual(rebuilt.status_code, 200, rebuilt.text)
        rebuilt_names = [item["name"] for item in rebuilt.json()["map"]["pois"]]
        self.assertIn("急诊大厅", rebuilt_names)
        self.assertTrue(any(item["id"].startswith("icon-") and item["category"] == "restroom" for item in rebuilt.json()["map"]["pois"]))
        self.assertEqual(hashlib.sha256(pdf_path.read_bytes()).hexdigest(), digest)
        self.assertFalse((ROOT / "data" / saved["id"]).exists())

    def test_dark_structural_fills_are_not_rooms(self):
        from maker_build import DARK_FILL_MAX, _is_dark_structural, extract_page
        self.assertTrue(_is_dark_structural([0.137, 0.122, 0.126]))
        self.assertTrue(_is_dark_structural([0.0, 0.0, 0.0]))
        self.assertFalse(_is_dark_structural([0.82, 0.90, 0.80]))
        pdf = ROOT / "source" / "gifu-hospital-map.pdf"
        if not pdf.is_file():
            self.skipTest("source PDF missing")
        crop3 = {"x": 8.406, "y": 0.861, "width": 791.265, "height": 538.134}
        _, _, rooms, _, _ = extract_page(pdf, 3, crop3)
        dark = [room for room in rooms if max(room["color"]) <= DARK_FILL_MAX]
        self.assertEqual(dark, [], dark)

    def test_hires_walkable_grid_stays_in_normalized_page(self):
        import numpy as np
        from maker_build import (
            WALKABLE_RASTER_DPI,
            _build_walkable_canvas,
            _cell_size,
            _downsample,
            _grid_metrics,
        )
        size = (800.0, 734.0)
        crop = {"x": 22.643, "y": 19.007, "width": 746.042, "height": 515.0}
        rooms = [{"polygonPdf": [[100, 80], [300, 80], [300, 250], [100, 250]]}]
        closed, mask_scale = _build_walkable_canvas(size, crop, rooms)
        self.assertAlmostEqual(mask_scale, WALKABLE_RASTER_DPI / 72.0)
        cell = _cell_size(crop)
        cell_px, grid_cell = _grid_metrics(cell, mask_scale)
        self.assertGreater(cell_px, cell)
        grid = _downsample(np.array(closed) > 0, cell_px)
        max_x = (grid.shape[1] - 0.5) * grid_cell / size[0]
        max_y = (grid.shape[0] - 0.5) * grid_cell / size[1]
        self.assertLessEqual(max_x, 1.0)
        self.assertLessEqual(max_y, 1.0)
        buggy = _downsample(np.array(closed) > 0, cell)
        buggy_x = (buggy.shape[1] - 0.5) * cell / size[0]
        self.assertGreater(buggy_x, 1.0)

    def test_hires_extract_supplements_rooms_and_labels(self):
        from maker_build import VECTOR_RASTER_DPI, extract_page
        pdf = ROOT / "source" / "gifu-hospital-map.pdf"
        if not pdf.is_file():
            self.skipTest("source PDF missing")
        crop1 = {"x": 78, "y": 42, "width": 696, "height": 772}
        _, _, rooms, labels, _ = extract_page(pdf, 1, crop1)
        self.assertGreaterEqual(VECTOR_RASTER_DPI, 144)
        self.assertGreaterEqual(len(rooms), 20)
        self.assertGreaterEqual(len(labels), 40)
        raster_sources = [room for room in rooms if str(room.get("sourceObject", "")).startswith("raster-")]
        self.assertGreaterEqual(len(raster_sources), 1, rooms)

    def test_gifu_page_three_pois_share_a_route_network(self):
        from collections import defaultdict
        pdf = ROOT / "source" / "gifu-hospital-map.pdf"
        if not pdf.is_file():
            self.skipTest("source PDF missing")
        created = self.client.post("/api/projects", files={"file": ("chn.pdf", pdf.read_bytes(), "application/pdf")}).json()
        saved = self.client.put(f"/api/projects/{created['id']}/draft", json={
            "revision": created["draft"]["revision"],
            "pageIndex": 3,
            "rotation": 0,
            "crop": {"x": 8.406, "y": 0.861, "width": 791.265, "height": 538.134},
            "floor": {"id": "3F", "name": "三楼"},
        }).json()
        response = self.client.post(f"/api/projects/{saved['id']}/build", json={"revision": saved["draft"]["revision"]})
        self.assertEqual(response.status_code, 200, response.text)
        document = response.json()["map"]
        parent = {}
        def find(node):
            parent.setdefault(node, node)
            while parent[node] != node:
                parent[node] = parent[parent[node]]
                node = parent[node]
            return node
        def union(a, b):
            parent[find(a)] = find(b)
        for edge in document["graph"]["edges"]:
            if edge.get("enabled", True):
                union(edge["source"], edge["target"])
        pois = [poi for poi in document["pois"] if poi.get("nodeId")]
        self.assertGreaterEqual(len(pois), 8)
        groups = defaultdict(int)
        for poi in pois:
            groups[find(poi["nodeId"])] += 1
        largest = max(groups.values())
        self.assertGreaterEqual(largest / len(pois), 0.85)
        assert_activate_coords(self, document)
        deleted = self.client.delete(f"/api/projects/{saved['id']}/floors/3F")
        self.assertEqual(deleted.status_code, 400, deleted.text)
        self.assertIn("最后一层", deleted.json()["detail"])
        self.assertTrue((Path(self.tmpdir.name) / saved["id"] / "source.pdf").is_file())
        still = self.client.get(f"/api/projects/{saved['id']}")
        self.assertEqual(still.status_code, 200)
        self.assertEqual(still.json().get("status"), "ready")
        self.assertEqual(still.json().get("activeFloor"), "3F")

    def test_apply_map_edits_keeps_icon_room_and_moved_pois(self):
        from maker_build import apply_map_edits
        document = {
            "floorId": "1F",
            "floor": {"id": "1F"},
            "source": {"pdfSize": [100, 100]},
            "geometry": {"obstacles": [{"id": "room-a", "name": "A", "polygon": [[0, 0], [1, 0], [1, 1], [0, 1]]}]},
            "pois": [{
                "id": "elevator-1",
                "name": "电梯",
                "category": "elevator",
                "labelPosition": [0.2, 0.2],
                "requestedAnchor": [0.2, 0.2],
                "position": [0.2, 0.2],
                "roomId": "room-a",
            }],
            "graph": {"nodes": [{"id": "j1", "position": [0.25, 0.25], "kind": "junction"}], "edges": []},
            "doors": [],
        }
        edited = apply_map_edits(document, {
            "movedPois": {"elevator-1": [0.41, 0.37]},
            "facilityIcons": [{
                "id": "icon-wc1",
                "category": "restroom",
                "name": "卫生间",
                "position": [0.3, 0.3],
                "roomId": "room-a",
            }],
        })
        moved = next(item for item in edited["pois"] if item["id"] == "elevator-1")
        self.assertEqual(moved["labelPosition"], [0.41, 0.37])
        icon = next(item for item in edited["pois"] if item["id"] == "icon-wc1")
        self.assertEqual(icon["roomId"], "room-a")
        self.assertEqual(icon["labelPosition"], [0.3, 0.3])

    def test_apply_map_edits_sets_room_fill_color(self):
        from maker_build import apply_map_edits
        document = {
            "floorId": "1F",
            "floor": {"id": "1F"},
            "source": {"pdfSize": [100, 100]},
            "geometry": {"obstacles": [
                {"id": "room-a", "name": "A", "polygon": [[0, 0], [1, 0], [1, 1], [0, 1]], "fillColor": "#abcdef"},
                {"id": "room-b", "name": "B", "polygon": [[0, 0], [.5, 0], [.5, .5], [0, .5]]},
            ]},
            "pois": [],
            "graph": {"nodes": [], "edges": []},
            "doors": [],
        }
        edited = apply_map_edits(document, {"roomColors": {"room-b": "#DCE8DF"}})
        by_id = {item["id"]: item for item in edited["geometry"]["obstacles"]}
        self.assertNotIn("fillColor", by_id["room-a"])
        self.assertEqual(by_id["room-b"]["fillColor"], "#dce8df")
        cleared = apply_map_edits(edited, {"roomColors": {}})
        self.assertNotIn("fillColor", cleared["geometry"]["obstacles"][1])

    def test_hollow_raster_envelope_does_not_swallow_rooms(self):
        from maker_build import _dedupe_rooms, RASTER_MIN_FILL_RATIO
        self.assertGreaterEqual(RASTER_MIN_FILL_RATIO, 0.15)
        rooms = [
            {
                "id": "raster-150-0",
                "sourceObject": "raster-150-0",
                "area": 160000,
                "polygonPdf": [[20, 20], [700, 20], [700, 380], [20, 380]],
            },
            {
                "id": "curve-91",
                "sourceObject": "curve[91]",
                "area": 2500,
                "polygonPdf": [[80, 80], [130, 80], [130, 130], [80, 130]],
            },
            {
                "id": "curve-69",
                "sourceObject": "curve[69]",
                "area": 2500,
                "polygonPdf": [[200, 80], [250, 80], [250, 130], [200, 130]],
            },
            {
                "id": "curve-53",
                "sourceObject": "curve[53]",
                "area": 2500,
                "polygonPdf": [[80, 200], [130, 200], [130, 250], [80, 250]],
            },
        ]
        kept = _dedupe_rooms(rooms)
        ids = {item["id"] for item in kept}
        self.assertNotIn("raster-150-0", ids)
        self.assertGreaterEqual(len(ids), 3)

    def test_crop_rectangle_is_not_building_boundary(self):
        from maker_build import _choose_building_boundary, _is_crop_rectangle
        crop = {"x": 18.0, "y": 10.0, "width": 770.0, "height": 386.0}
        crop_rect = [
            [crop["x"], crop["y"]],
            [crop["x"] + crop["width"], crop["y"]],
            [crop["x"] + crop["width"], crop["y"] + crop["height"]],
            [crop["x"], crop["y"] + crop["height"]],
        ]
        wing = [[30, 130], [190, 130], [190, 270], [30, 270]]
        diamond = [[245, 133], [349, 30], [413, 30], [510, 126], [567, 272], [296, 374]]
        rooms = [
            {"polygonPdf": wing, "area": 1000},
            {"polygonPdf": diamond, "area": 2000},
        ]
        envelope = {"polygonPdf": diamond + wing[:1], "area": 250000}
        boundary = _choose_building_boundary(crop, [envelope], rooms)
        self.assertFalse(_is_crop_rectangle(boundary, crop), boundary)
        self.assertGreaterEqual(len(boundary), 5)
        ignored = _choose_building_boundary(crop, [{"polygonPdf": crop_rect, "area": 297000}], rooms)
        self.assertFalse(_is_crop_rectangle(ignored, crop), ignored)

    def test_page_five_keeps_ward_wings_and_vector_outline(self):
        from maker_build import extract_page, _is_crop_rectangle
        pdf = ROOT / "source" / "gifu-hospital-map.pdf"
        if not pdf.is_file():
            self.skipTest("source PDF missing")
        crop = {"x": 18.242, "y": 10.164, "width": 772.934, "height": 385.898}
        _, crop, rooms, labels, boundary = extract_page(pdf, 5, crop)
        self.assertGreaterEqual(len(rooms), 20)
        self.assertLess(max(room["area"] for room in rooms), crop["width"] * crop["height"] * 0.4)
        self.assertGreaterEqual(len(boundary), 8)
        self.assertFalse(_is_crop_rectangle(boundary, crop), boundary)
        texts = {item["text"] for item in labels}
        blob = " ".join(texts)
        self.assertTrue(any("西区病房" in text or "区病房" in text for text in texts), texts)
        self.assertTrue(any("东区病房" in text for text in texts), texts)
        self.assertIn("屋顶", blob)
        self.assertFalse(any("病房餐厅" in text for text in texts), texts)
        xs = [p[0] for p in boundary]
        ys = [p[1] for p in boundary]
        self.assertLess(max(xs) - min(xs), crop["width"] + 8)
        self.assertLess(max(ys) - min(ys), crop["height"] + 8)
        self.assertTrue(
            any(abs(p[0] - min(xs)) > 20 and abs(p[0] - max(xs)) > 20 for p in boundary)
            or any(abs(p[1] - min(ys)) > 20 and abs(p[1] - max(ys)) > 20 for p in boundary),
            boundary,
        )

    def test_apply_map_edits_promotes_named_room_to_navigable_poi(self):
        from maker_build import apply_map_edits
        document = {
            "floorId": "1F",
            "floor": {"id": "1F"},
            "source": {"pdfSize": [100, 100]},
            "geometry": {
                "obstacles": [{
                    "id": "curve-99",
                    "kind": "room",
                    "polygon": [[0.2, 0.2], [0.4, 0.2], [0.4, 0.4], [0.2, 0.4]],
                }]
            },
            "pois": [{
                "id": "entrance-1",
                "name": "入口",
                "category": "entrance",
                "labelPosition": [0.1, 0.5],
                "requestedAnchor": [0.1, 0.5],
                "position": [0.1, 0.5],
                "nodeId": "poi:entrance-1",
                "roomId": None,
            }],
            "graph": {
                "nodes": [
                    {"id": "j1", "position": [0.48, 0.31], "kind": "junction"},
                    {"id": "poi:entrance-1", "position": [0.1, 0.5], "kind": "poi", "poiId": "entrance-1"},
                ],
                "edges": [{
                    "id": "e1",
                    "source": "j1",
                    "target": "poi:entrance-1",
                    "lengthMapUnits": 40,
                    "polyline": [[0.48, 0.31], [0.1, 0.5]],
                    "enabled": True,
                }],
            },
            "doors": [],
        }
        edited = apply_map_edits(document, {"renamedRooms": {"curve-99": "处置室"}})
        room = next(item for item in edited["geometry"]["obstacles"] if item["id"] == "curve-99")
        self.assertEqual(room["name"], "处置室")
        poi = next(item for item in edited["pois"] if item["id"] == "room-curve-99")
        self.assertEqual(poi["name"], "处置室")
        self.assertEqual(poi["roomId"], "curve-99")
        self.assertEqual(poi["category"], "room")
        self.assertEqual(poi["nodeId"], "poi:room-curve-99")
        self.assertTrue(any(node["id"] == "poi:room-curve-99" for node in edited["graph"]["nodes"]))
        access = next(edge for edge in edited["graph"]["edges"] if edge["id"] == "access:room-curve-99")
        self.assertEqual(access["source"], "poi:room-curve-99")
        self.assertEqual(access["target"], "j1")
        self.assertTrue(any(door["poiId"] == "room-curve-99" for door in edited["doors"]))
        again = apply_map_edits(edited, {"renamedRooms": {"curve-99": "处置室"}})
        self.assertEqual(sum(1 for item in again["pois"] if item["id"] == "room-curve-99"), 1)
        self.assertEqual(sum(1 for edge in again["graph"]["edges"] if edge["id"] == "access:room-curve-99"), 1)

    def test_apply_map_edits_does_not_hijack_facility_inside_named_room(self):
        from maker_build import apply_map_edits
        document = {
            "floorId": "1F",
            "source": {"pdfSize": [100, 100]},
            "geometry": {"obstacles": [{
                "id": "room-a",
                "kind": "room",
                "name": "A",
                "polygon": [[0, 0], [1, 0], [1, 1], [0, 1]],
            }]},
            "pois": [{
                "id": "elevator-1",
                "name": "电梯",
                "category": "elevator",
                "labelPosition": [0.2, 0.2],
                "requestedAnchor": [0.2, 0.2],
                "position": [0.2, 0.2],
                "roomId": "room-a",
            }],
            "graph": {"nodes": [{"id": "j1", "position": [0.25, 0.25], "kind": "junction"}], "edges": []},
            "doors": [],
        }
        edited = apply_map_edits(document, {"renamedRooms": {"room-a": "处置室"}})
        elevator = next(item for item in edited["pois"] if item["id"] == "elevator-1")
        self.assertEqual(elevator["name"], "电梯")
        room_poi = next(item for item in edited["pois"] if item["id"] == "room-room-a")
        self.assertEqual(room_poi["name"], "处置室")
        self.assertTrue(room_poi.get("nodeId"))

    def test_save_edits_promotes_unnamed_room_for_preview(self):
        created = self.client.post("/api/projects", files={"file": ("clinic.pdf", floorplan_pdf(), "application/pdf")}).json()
        saved = self.client.put(f"/api/projects/{created['id']}/draft", json={
            "revision": created["draft"]["revision"],
            "pageIndex": 1,
            "rotation": 0,
            "floor": {"id": "1F", "name": "一楼"},
        }).json()
        folder = Path(self.tmpdir.name) / saved["id"]
        record = json.loads((folder / "project.json").read_text(encoding="utf-8"))
        document = {
            "schemaVersion": "1.0.0",
            "floorId": "1F",
            "floor": {"id": "1F", "name": "一楼"},
            "source": {"pdfSize": [800, 600], "projectId": saved["id"]},
            "geometry": {
                "buildingBoundary": [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]],
                "obstacles": [{
                    "id": "curve-7",
                    "kind": "room",
                    "polygon": [[0.3, 0.3], [0.5, 0.3], [0.5, 0.5], [0.3, 0.5]],
                }],
            },
            "pois": [{
                "id": "entrance-1",
                "name": "入口",
                "category": "entrance",
                "labelPosition": [0.2, 0.6],
                "requestedAnchor": [0.2, 0.6],
                "position": [0.2, 0.6],
                "nodeId": "poi:entrance-1",
                "roomId": None,
            }],
            "graph": {
                "nodes": [
                    {"id": "j1", "position": [0.42, 0.4], "kind": "junction"},
                    {"id": "poi:entrance-1", "position": [0.2, 0.6], "kind": "poi", "poiId": "entrance-1"},
                ],
                "edges": [],
            },
            "doors": [],
        }
        snap = folder / "maps" / "1F"
        snap.mkdir(parents=True, exist_ok=True)
        (snap / "map.json").write_text(json.dumps(document), encoding="utf-8")
        record["status"] = "ready"
        record["activeFloor"] = "1F"
        record["floors"] = {"1": {"id": "1F", "status": "ready", "pageIndex": 1}}
        (folder / "project.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        patched = self.client.patch(f"/api/projects/{saved['id']}/edits", json={
            "revision": record["draft"]["revision"],
            "floorId": "1F",
            "renamedRooms": {"curve-7": "处置室"},
        })
        self.assertEqual(patched.status_code, 200, patched.text)
        mapped = patched.json()["map"]
        poi = next(item for item in mapped["pois"] if item["id"] == "room-curve-7")
        self.assertEqual(poi["name"], "处置室")
        self.assertTrue(poi.get("nodeId"))
        self.assertIn(poi["nodeId"], {node["id"] for node in mapped["graph"]["nodes"]})
        fetched = self.client.get(f"/api/projects/{saved['id']}/map", params={"floor": "1F"})
        self.assertEqual(fetched.status_code, 200)
        preview = fetched.json()
        self.assertTrue(any(item["id"] == "room-curve-7" and item.get("nodeId") for item in preview["pois"]))

    def test_rebuild_attaches_user_named_unnamed_rooms(self):
        pdf = ROOT / "source" / "gifu-hospital-map.pdf"
        if not pdf.is_file():
            self.skipTest("source PDF missing")
        created = self.client.post("/api/projects", files={"file": ("chn.pdf", pdf.read_bytes(), "application/pdf")}).json()
        saved = self.client.put(f"/api/projects/{created['id']}/draft", json={
            "revision": created["draft"]["revision"],
            "pageIndex": 1,
            "rotation": 0,
            "crop": {"x": 78, "y": 42, "width": 696, "height": 772},
            "floor": {"id": "1F", "name": "一楼"},
        }).json()
        built = self.client.post(f"/api/projects/{saved['id']}/build", json={"revision": saved["draft"]["revision"]})
        self.assertEqual(built.status_code, 200, built.text)
        document = built.json()["map"]
        linked = {poi.get("roomId") for poi in document["pois"] if poi.get("roomId")}
        unnamed = [
            obstacle for obstacle in document["geometry"]["obstacles"]
            if obstacle["id"] not in linked
            and obstacle.get("kind") in {"room", "counter"}
            and not obstacle.get("name")
        ]
        self.assertTrue(unnamed, "page 1 should still have unnamed rooms before naming")
        room = unnamed[0]
        patched = self.client.patch(f"/api/projects/{saved['id']}/edits", json={
            "revision": built.json()["project"]["draft"]["revision"],
            "floorId": "1F",
            "renamedRooms": {room["id"]: "处置室"},
        })
        self.assertEqual(patched.status_code, 200, patched.text)
        live = next(
            poi for poi in patched.json()["map"]["pois"]
            if poi.get("roomId") == room["id"] or poi["id"] == f"room-{room['id']}"
        )
        self.assertEqual(live["name"], "处置室")
        self.assertTrue(live.get("nodeId"), live)
        rebuilt = self.client.post(
            f"/api/projects/{saved['id']}/build",
            json={"revision": patched.json()["draft"]["revision"]},
        )
        self.assertEqual(rebuilt.status_code, 200, rebuilt.text)
        again = next(
            poi for poi in rebuilt.json()["map"]["pois"]
            if poi.get("roomId") == room["id"] or poi["id"] == f"room-{room['id']}"
        )
        self.assertEqual(again["name"], "处置室")
        self.assertTrue(again.get("nodeId"), again)
        self.assertIn(again["nodeId"], {node["id"] for node in rebuilt.json()["map"]["graph"]["nodes"]})

    def test_cad_linework_pdf_yields_room_fills(self):
        from maker_build import extract_page
        from maker_pdf import PdfRejected
        path = Path(self.tmpdir.name) / "cad-linework.pdf"
        path.write_bytes(cad_linework_pdf())
        crop = {"x": 0, "y": 0, "width": 400, "height": 300}
        try:
            _, _, rooms, _, boundary = extract_page(path, 1, crop, source_kind="cad")
        except PdfRejected as error:
            self.fail(f"CAD linework should not hit 未找到房间色块: {error}")
        cad_rooms = [room for room in rooms if str(room.get("sourceObject", "")).startswith("cad-fill-")]
        self.assertGreaterEqual(len(cad_rooms), 2, rooms)
        self.assertTrue(boundary and len(boundary) >= 3)
        self.assertTrue(all(max(room["color"]) > 0.25 for room in cad_rooms))

    def test_floorplan_kind_does_not_fill_cad_linework(self):
        from maker_build import extract_page
        from maker_pdf import PdfRejected
        path = Path(self.tmpdir.name) / "cad-linework.pdf"
        path.write_bytes(cad_linework_pdf())
        crop = {"x": 0, "y": 0, "width": 400, "height": 300}
        with self.assertRaises(PdfRejected) as raised:
            extract_page(path, 1, crop, source_kind="floorplan")
        self.assertIn("房间色块", str(raised.exception))

    def test_cad_ocr_labels_when_pdf_has_no_text_layer(self):
        from unittest.mock import patch
        import maker_build
        path = Path(self.tmpdir.name) / "cad-linework.pdf"
        path.write_bytes(cad_linework_pdf())
        fake = [{
            "text": "诊室",
            "x": 110, "y": 175, "size": 12,
            "x0": 90, "x1": 130, "top": 165, "bottom": 185,
            "source": "cad-vision-ocr",
        }]
        cal = {"metersPerMapUnit": 0.035277, "source": "cad-ocr-ratio", "ratio": "1:100", "layer": "calibration"}
        with patch.object(maker_build, "cad_ocr_for_page", return_value=(fake, cal)):
            _, _, rooms, labels, _ = maker_build.extract_page(
                path, 1, {"x": 0, "y": 0, "width": 400, "height": 300}, source_kind="cad",
            )
        self.assertTrue(any(item["text"] == "诊室" for item in labels), labels)
        self.assertTrue(any(item.get("roomId") for item in labels), labels)
        self.assertEqual(maker_build.extract_page.calibration["ratio"], "1:100")
        self.assertGreaterEqual(len(rooms), 2)

    def test_colored_floorplan_does_not_call_cad_ocr(self):
        from unittest.mock import patch
        import maker_build
        path = Path(self.tmpdir.name) / "colored.pdf"
        path.write_bytes(floorplan_pdf())
        with patch.object(maker_build, "cad_ocr_for_page", side_effect=AssertionError("CAD OCR should not run on text-layer floorplans")):
            _, _, rooms, labels, _ = maker_build.extract_page(path, 1, {"x": 0, "y": 0, "width": 400, "height": 300})
        self.assertFalse(any(str(room.get("sourceObject", "")).startswith("cad-fill-") for room in rooms), rooms)
        self.assertTrue(any("Clinic" in item["text"] or "Office" in item["text"] for item in labels), labels)

    def test_colored_floorplan_does_not_use_cad_fill(self):
        from maker_build import extract_page
        path = Path(self.tmpdir.name) / "colored.pdf"
        path.write_bytes(floorplan_pdf())
        _, _, rooms, _, _ = extract_page(path, 1, {"x": 0, "y": 0, "width": 400, "height": 300})
        self.assertFalse(any(str(room.get("sourceObject", "")).startswith("cad-fill-") for room in rooms), rooms)
        self.assertGreaterEqual(len(rooms), 2)

    def test_cad_build_keeps_source_kind_on_map(self):
        from unittest.mock import patch
        import maker_build
        created = self.client.post(
            "/api/projects",
            files={"file": ("cad.pdf", cad_linework_pdf(), "application/pdf")},
            data={"sourceKind": "cad"},
        ).json()
        saved = self.client.put(f"/api/projects/{created['id']}/draft", json={
            "revision": created["draft"]["revision"],
            "pageIndex": 1,
            "rotation": 0,
            "sourceKind": "cad",
            "floor": {"id": "1F", "name": "一楼"},
        }).json()
        fake = [{
            "text": "诊室",
            "x": 110, "y": 175, "size": 12,
            "x0": 90, "x1": 130, "top": 165, "bottom": 185,
            "source": "cad-vision-ocr",
        }]
        cal = {"metersPerMapUnit": 0.035277, "source": "cad-ocr-ratio", "ratio": "1:100"}
        with patch.object(maker_build, "cad_ocr_for_page", return_value=(fake, cal)):
            built = self.client.post(
                f"/api/projects/{saved['id']}/build",
                json={"revision": saved["draft"]["revision"]},
            )
        self.assertEqual(built.status_code, 200, built.text)
        document = built.json()["map"]
        self.assertEqual(document["source"]["sourceKind"], "cad")
        self.assertEqual(built.json()["report"]["sourceKind"], "cad")
        self.assertTrue(any("同一套材质" in note for note in document["notes"]), document["notes"])
        self.assertEqual(document["calibration"]["ratio"], "1:100")
        self.assertTrue(any(poi.get("nodeId") for poi in document["pois"]), document["pois"])


if __name__ == "__main__":
    unittest.main()

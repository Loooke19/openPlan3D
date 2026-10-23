"""Stage 2 maker API: upload, page selection, crop persistence.

Does not import build_map or pdfplumber. Run:
  .venv/bin/python -m unittest tests.test_maker -v
"""
from io import BytesIO
from pathlib import Path
import json
import shutil
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


def encrypted_pdf():
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    writer.encrypt("secret")
    buffer = BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


class MakerApiTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        import os
        os.environ["HOSPITAL_PROJECTS_DIR"] = self.tmpdir.name
        import importlib
        import maker_app
        import maker_store
        importlib.reload(maker_store)
        importlib.reload(maker_app)
        maker_app.store.root = Path(self.tmpdir.name)
        maker_app.store.root.mkdir(parents=True, exist_ok=True)
        from fastapi.testclient import TestClient
        self.app = maker_app
        self.client = TestClient(maker_app.app)

    def tearDown(self):
        self.tmpdir.cleanup()

    def _mark_floor_ready(self, project_id, floor_id="1F", page_index=1):
        folder = Path(self.tmpdir.name) / project_id
        record = json.loads((folder / "project.json").read_text(encoding="utf-8"))
        floor = record["draft"]["floor"]
        record["status"] = "ready"
        record["activeFloor"] = floor_id
        record["mapUrl"] = f"/api/projects/{project_id}/map?floor={floor_id}"
        record["floors"][str(page_index)] = {
            **floor,
            "id": floor_id,
            "status": "ready",
            "pageIndex": page_index,
            "mapUrl": record["mapUrl"],
        }
        (folder / "project.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")

    def test_health(self):
        response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["ok"])
        self.assertGreaterEqual(response.json()["stage"], 4)

    def test_floor_info_round_trip(self):
        payload = blank_pdf([(800, 1210), (800, 1070)])
        created = self.client.post("/api/projects", files={"file": ("ward.pdf", payload, "application/pdf")}).json()
        self.assertEqual(created["draft"]["floor"]["id"], "1F")
        self.assertEqual(created["draft"]["floor"]["name"], "一楼")
        saved = self.client.put(f"/api/projects/{created['id']}/draft", json={
            "revision": created["draft"]["revision"],
            "pageIndex": 2,
            "rotation": 0,
            "floor": {"id": "2F", "name": "二楼", "description": "外科病房"},
        })
        self.assertEqual(saved.status_code, 200)
        body = saved.json()
        self.assertEqual(body["draft"]["floor"]["id"], "2F")
        self.assertEqual(body["draft"]["floor"]["name"], "二楼")
        self.assertEqual(body["draft"]["floor"]["description"], "外科病房")
        self.assertEqual(body["floors"]["2"]["id"], "2F")
        self.assertEqual(body["floors"]["1"]["id"], "1F")

    def test_duplicate_floor_id_is_rejected(self):
        payload = blank_pdf([(200, 200), (200, 200)])
        created = self.client.post("/api/projects", files={"file": ("two.pdf", payload, "application/pdf")}).json()
        first = self.client.put(f"/api/projects/{created['id']}/draft", json={
            "revision": 1,
            "pageIndex": 1,
            "rotation": 0,
            "floor": {"id": "2F", "name": "二楼"},
        })
        self.assertEqual(first.status_code, 200)
        second = self.client.put(f"/api/projects/{created['id']}/draft", json={
            "revision": 2,
            "pageIndex": 2,
            "rotation": 0,
            "floor": {"id": "2F", "name": "另一层"},
        })
        self.assertEqual(second.status_code, 400)
        self.assertIn("已用于", second.json()["detail"])

    def test_invalid_floor_id_is_rejected(self):
        payload = blank_pdf([(200, 200)])
        created = self.client.post("/api/projects", files={"file": ("a.pdf", payload, "application/pdf")}).json()
        response = self.client.put(f"/api/projects/{created['id']}/draft", json={
            "revision": 1,
            "pageIndex": 1,
            "rotation": 0,
            "floor": {"id": "二楼", "name": "二楼"},
        })
        self.assertEqual(response.status_code, 400)

    def test_upload_rejects_non_pdf(self):
        response = self.client.post("/api/projects", files={"file": ("notes.txt", b"hello", "text/plain")})
        self.assertEqual(response.status_code, 400)
        self.assertIn("PDF", response.json()["detail"])

    def test_upload_rejects_encrypted_pdf(self):
        response = self.client.post("/api/projects", files={"file": ("locked.pdf", encrypted_pdf(), "application/pdf")})
        self.assertEqual(response.status_code, 400)
        self.assertIn("加密", response.json()["detail"])

    def test_upload_rejects_oversized_file(self):
        self.app.store.max_upload_bytes = 32
        response = self.client.post("/api/projects", files={"file": ("big.pdf", b"%PDF-1.4" + b"x" * 80, "application/pdf")})
        self.assertEqual(response.status_code, 400)
        self.assertIn("过大", response.json()["detail"])

    def test_upload_rejects_too_many_pages(self):
        self.app.store.max_pages = 2
        payload = blank_pdf([(100, 100), (100, 100), (100, 100)])
        response = self.client.post("/api/projects", files={"file": ("many.pdf", payload, "application/pdf")})
        self.assertEqual(response.status_code, 400)
        self.assertIn("页数", response.json()["detail"])

    def test_upload_keeps_source_out_of_demo_data(self):
        payload = blank_pdf([(800, 1210), (600, 400)])
        response = self.client.post("/api/projects", files={"file": ("floor.pdf", payload, "application/pdf")})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "uploaded")
        self.assertEqual(len(body["pages"]), 2)
        self.assertEqual(body["draft"]["page"]["originalSize"], [800.0, 1210.0])
        self.assertIsNone(body["draft"]["page"]["crop"])
        self.assertFalse((ROOT / "data" / body["id"]).exists())
        self.assertFalse((ROOT / "source" / (body["id"] + ".pdf")).exists())
        stored = Path(self.tmpdir.name) / body["id"] / "source.pdf"
        self.assertTrue(stored.is_file())

    def test_select_second_page_and_crop_round_trip(self):
        payload = blank_pdf([(800, 1210), (1024, 768)])
        created = self.client.post("/api/projects", files={"file": ("ward.pdf", payload, "application/pdf")}).json()
        project_id = created["id"]
        crop = {"x": 40, "y": 30, "width": 400, "height": 300}
        saved = self.client.put(f"/api/projects/{project_id}/draft", json={
            "revision": created["draft"]["revision"],
            "pageIndex": 2,
            "rotation": 90,
            "crop": crop,
        })
        self.assertEqual(saved.status_code, 200)
        draft = saved.json()["draft"]
        self.assertEqual(draft["revision"], 2)
        self.assertEqual(draft["page"]["index"], 2)
        self.assertEqual(draft["page"]["originalSize"], [1024.0, 768.0])
        self.assertEqual(draft["page"]["rotation"], 90)
        self.assertEqual(draft["page"]["crop"]["width"], 400)
        restored = self.client.get(f"/api/projects/{project_id}").json()
        self.assertEqual(restored["draft"]["page"]["index"], 2)
        self.assertEqual(restored["draft"]["page"]["originalSize"], [1024.0, 768.0])
        self.assertEqual(restored["draft"]["page"]["crop"]["x"], 40)
        pdf = self.client.get(f"/api/projects/{project_id}/file")
        self.assertEqual(pdf.status_code, 200)
        self.assertIn("pdf", pdf.headers.get("content-type", "").lower())
        pdf_path = Path(self.tmpdir.name) / project_id / "source.pdf"
        digest = pdf_path.read_bytes()
        again = self.client.put(f"/api/projects/{project_id}/draft", json={
            "revision": restored["draft"]["revision"],
            "pageIndex": 2,
            "rotation": 90,
            "crop": crop,
        })
        self.assertEqual(again.status_code, 200)
        self.assertEqual((Path(self.tmpdir.name) / project_id / "source.pdf").read_bytes(), digest)

    def test_edits_and_delete_floor_keep_source_pdf(self):
        payload = blank_pdf([(200, 200), (200, 200)])
        created = self.client.post("/api/projects", files={"file": ("two.pdf", payload, "application/pdf")}).json()
        pdf_path = Path(self.tmpdir.name) / created["id"] / "source.pdf"
        digest = pdf_path.read_bytes()
        first = self.client.put(f"/api/projects/{created['id']}/draft", json={
            "revision": created["draft"]["revision"],
            "pageIndex": 1,
            "rotation": 0,
            "floor": {"id": "1F", "name": "一楼"},
        }).json()
        patched = self.client.patch(f"/api/projects/{created['id']}/edits", json={
            "revision": first["draft"]["revision"],
            "floorId": "1F",
            "renamedPois": {"room-x": "问询处"},
            "movedPois": {"elevator-1": [0.42, 0.31]},
            "facilityIcons": [{
                "id": "icon-wc1",
                "category": "restroom",
                "name": "卫生间",
                "position": [0.5, 0.5],
                "roomId": "room-a",
            }],
        })
        self.assertEqual(patched.status_code, 200, patched.text)
        stored = patched.json()["editsByFloor"]["1F"]
        self.assertEqual(stored["renamedPois"]["room-x"], "问询处")
        self.assertEqual(stored["movedPois"]["elevator-1"], [0.42, 0.31])
        self.assertEqual(stored["facilityIcons"][0]["roomId"], "room-a")
        colored = self.client.patch(f"/api/projects/{created['id']}/edits", json={
            "revision": patched.json()["draft"]["revision"],
            "floorId": "1F",
            "roomColors": {"room-a": "#CBDEDC", "room-b": "eee5d5"},
        })
        self.assertEqual(colored.status_code, 200, colored.text)
        colors = colored.json()["editsByFloor"]["1F"]["roomColors"]
        self.assertEqual(colors["room-a"], "#cbdedc")
        self.assertEqual(colors["room-b"], "#eee5d5")
        deleted = self.client.delete(f"/api/projects/{created['id']}/floors/1F")
        self.assertEqual(deleted.status_code, 400, deleted.text)
        self.assertIn("最后一层", deleted.json()["detail"])
        self.assertTrue(pdf_path.is_file())
        self.assertEqual(pdf_path.read_bytes(), digest)

    def _write_ready_map(self, project_id, floor_id, page_index, name):
        folder = Path(self.tmpdir.name) / project_id
        record = json.loads((folder / "project.json").read_text(encoding="utf-8"))
        document = {
            "floorId": floor_id,
            "floor": {"id": floor_id, "code": floor_id, "name": name, "description": ""},
            "source": {"pdfSize": [800, 1210], "projectId": project_id, "page": page_index},
            "geometry": {
                "buildingBoundary": [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]],
                "obstacles": [{"id": "room-a", "name": name, "polygon": [[0.2, 0.2], [0.4, 0.2], [0.4, 0.4], [0.2, 0.4]]}],
            },
            "pois": [{
                "id": "room-a",
                "name": name,
                "category": "department",
                "position": [0.3, 0.3],
                "labelPosition": [0.3, 0.3],
            }],
            "graph": {"nodes": [], "edges": []},
            "doors": [],
        }
        snap = folder / "maps" / floor_id
        snap.mkdir(parents=True, exist_ok=True)
        (snap / "map.json").write_text(json.dumps(document), encoding="utf-8")
        record["status"] = "ready"
        record["activeFloor"] = floor_id
        record["mapUrl"] = f"/api/projects/{project_id}/map?floor={floor_id}"
        record.setdefault("floors", {})[str(page_index)] = {
            "id": floor_id,
            "code": floor_id,
            "name": name,
            "description": "",
            "status": "ready",
            "pageIndex": page_index,
            "mapUrl": record["mapUrl"],
        }
        (folder / "project.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        latest = folder / "maps" / "latest"
        if latest.exists():
            shutil.rmtree(latest)
        shutil.copytree(snap, latest)
        return document

    def test_delete_one_ready_floor_keeps_the_other_map(self):
        payload = blank_pdf([(200, 200), (200, 200)])
        created = self.client.post("/api/projects", files={"file": ("two.pdf", payload, "application/pdf")}).json()
        project_id = created["id"]
        self.client.put(f"/api/projects/{project_id}/draft", json={
            "revision": created["draft"]["revision"],
            "pageIndex": 1,
            "rotation": 0,
            "floor": {"id": "1F", "name": "一楼"},
        })
        self._write_ready_map(project_id, "1F", 1, "一楼")
        self.client.put(f"/api/projects/{project_id}/draft", json={
            "revision": self.client.get(f"/api/projects/{project_id}").json()["draft"]["revision"],
            "pageIndex": 2,
            "rotation": 0,
            "floor": {"id": "2F", "name": "二楼"},
        })
        self._write_ready_map(project_id, "2F", 2, "二楼")
        last = self.client.delete(f"/api/projects/{project_id}/floors/1F")
        self.assertEqual(last.status_code, 200, last.text)
        blocked = self.client.delete(f"/api/projects/{project_id}/floors/2F")
        self.assertEqual(blocked.status_code, 400, blocked.text)
        self.assertIn("最后一层", blocked.json()["detail"])
        leftover = self.client.get(f"/api/projects/{project_id}/map?floor=2F")
        self.assertEqual(leftover.status_code, 200, leftover.text)
        self.assertEqual(leftover.json()["floor"]["id"], "2F")
        missing = self.client.get(f"/api/projects/{project_id}/map?floor=1F")
        self.assertEqual(missing.status_code, 404)
        body = last.json()
        ready_ids = {
            item["id"]
            for item in body["floors"].values()
            if item.get("status") == "ready" and item.get("id")
        }
        self.assertEqual(ready_ids, {"2F"})
        self.assertEqual(body["activeFloor"], "2F")

    def test_crop_cannot_escape_original_page(self):
        payload = blank_pdf([(200, 100)])
        created = self.client.post("/api/projects", files={"file": ("tiny.pdf", payload, "application/pdf")}).json()
        response = self.client.put(f"/api/projects/{created['id']}/draft", json={
            "revision": 1,
            "pageIndex": 1,
            "rotation": 0,
            "crop": {"x": 0, "y": 0, "width": 400, "height": 50},
        })
        self.assertEqual(response.status_code, 400)
        self.assertIn("原始页面", response.json()["detail"])

    def test_stale_revision_is_rejected(self):
        payload = blank_pdf([(200, 200)])
        created = self.client.post("/api/projects", files={"file": ("a.pdf", payload, "application/pdf")}).json()
        first = self.client.put(f"/api/projects/{created['id']}/draft", json={"revision": 1, "pageIndex": 1, "rotation": 0})
        self.assertEqual(first.status_code, 200)
        second = self.client.put(f"/api/projects/{created['id']}/draft", json={"revision": 1, "pageIndex": 1, "rotation": 180})
        self.assertEqual(second.status_code, 409)

    def test_attach_floor_pdf_keeps_original_source(self):
        payload = blank_pdf([(800, 1210)])
        created = self.client.post("/api/projects", files={"file": ("one.pdf", payload, "application/pdf")}).json()
        project_id = created["id"]
        primary_path = Path(self.tmpdir.name) / project_id / "source.pdf"
        primary_digest = primary_path.read_bytes()
        ready = self.client.put(f"/api/projects/{project_id}/draft", json={
            "revision": created["draft"]["revision"],
            "pageIndex": 1,
            "rotation": 0,
            "floor": {"id": "1F", "name": "一楼"},
        }).json()
        self._mark_floor_ready(project_id, "1F", 1)
        second_pdf = blank_pdf([(640, 480), (640, 480)])
        response = self.client.post(
            f"/api/projects/{project_id}/floor-pdf",
            files={"file": ("two.pdf", second_pdf, "application/pdf")},
        )
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["draft"]["page"]["index"], 1)
        self.assertEqual(body["draft"]["page"]["originalSize"], [640.0, 480.0])
        self.assertEqual(body["draft"]["floor"]["id"], "2F")
        self.assertEqual(len(body["pages"]), 2)
        self.assertNotEqual(body["draft"]["sourceFile"]["sha256"], body["sourceFile"]["sha256"])
        self.assertTrue(primary_path.is_file())
        self.assertEqual(primary_path.read_bytes(), primary_digest)
        alt = Path(self.tmpdir.name) / project_id / "sources" / f"{body['draft']['sourceFile']['sha256'][:16]}.pdf"
        self.assertTrue(alt.is_file())
        ready_ids = {
            item["id"]
            for item in body["floors"].values()
            if item.get("status") == "ready" and item.get("id")
        }
        self.assertIn("1F", ready_ids)
        self.assertNotEqual(body["floors"].get("1", {}).get("status"), "ready")

    def test_same_pdf_add_floor_keeps_new_floor_as_generate(self):
        """Same file for 新增楼层 must not inherit page-1 ready →『重新生成』."""
        payload = blank_pdf([(800, 1210), (800, 1070), (800, 900)])
        created = self.client.post("/api/projects", files={"file": ("chn.pdf", payload, "application/pdf")}).json()
        project_id = created["id"]
        saved = self.client.put(f"/api/projects/{project_id}/draft", json={
            "revision": created["draft"]["revision"],
            "pageIndex": 1,
            "rotation": 0,
            "floor": {"id": "1F", "name": "一楼"},
        }).json()
        self._mark_floor_ready(project_id, "1F", 1)
        attached = self.client.post(
            f"/api/projects/{project_id}/floor-pdf",
            files={"file": ("chn.pdf", payload, "application/pdf")},
        )
        self.assertEqual(attached.status_code, 200, attached.text)
        body = attached.json()
        self.assertEqual(body["draft"]["page"]["index"], 1)
        self.assertEqual(body["draft"]["floor"]["id"], "2F")
        ready_ids = {
            item["id"]
            for item in body["floors"].values()
            if item.get("status") == "ready" and item.get("id")
        }
        self.assertIn("1F", ready_ids)
        self.assertNotIn(body["draft"]["floor"]["id"], ready_ids)
        saved_new = self.client.put(f"/api/projects/{project_id}/draft", json={
            "revision": body["draft"]["revision"],
            "pageIndex": 3,
            "rotation": 0,
            "floor": {"id": "12F", "name": "12楼"},
        })
        self.assertEqual(saved_new.status_code, 200, saved_new.text)
        after = saved_new.json()
        self.assertEqual(after["floors"]["3"]["id"], "12F")
        self.assertEqual(after["floors"]["3"]["status"], "draft")
        self.assertIn("1F", {
            item["id"] for item in after["floors"].values()
            if item.get("status") == "ready"
        })

    def test_attach_floor_pdf_requires_ready_floor(self):
        payload = blank_pdf([(200, 200)])
        created = self.client.post("/api/projects", files={"file": ("one.pdf", payload, "application/pdf")}).json()
        response = self.client.post(
            f"/api/projects/{created['id']}/floor-pdf",
            files={"file": ("two.pdf", payload, "application/pdf")},
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("首层", response.json()["detail"])

    def test_resolve_pdf_serves_draft_source(self):
        payload = blank_pdf([(800, 1210)])
        created = self.client.post("/api/projects", files={"file": ("one.pdf", payload, "application/pdf")}).json()
        project_id = created["id"]
        self.client.put(f"/api/projects/{project_id}/draft", json={
            "revision": created["draft"]["revision"],
            "pageIndex": 1,
            "rotation": 0,
            "floor": {"id": "1F", "name": "一楼"},
        })
        self._mark_floor_ready(project_id, "1F", 1)
        second_pdf = blank_pdf([(640, 480)])
        attached = self.client.post(
            f"/api/projects/{project_id}/floor-pdf",
            files={"file": ("two.pdf", second_pdf, "application/pdf")},
        ).json()
        draft_sha = attached["draft"]["sourceFile"]["sha256"]
        draft_file = self.client.get(f"/api/projects/{project_id}/file?sha256={draft_sha}")
        self.assertEqual(draft_file.status_code, 200)
        self.assertEqual(draft_file.content, second_pdf)
        primary_file = self.client.get(f"/api/projects/{project_id}/file?sha256={attached['sourceFile']['sha256']}")
        self.assertEqual(primary_file.status_code, 200)
        self.assertEqual(primary_file.content, payload)

    def test_path_tokens_are_not_directories(self):
        response = self.client.get("/api/projects/not-a-uuid")
        self.assertEqual(response.status_code, 404)

    def test_institution_list_rename_delete_and_isolation(self):
        first = self.client.post("/api/projects", files={"file": ("alpha-hospital.pdf", blank_pdf([(200, 200)]), "application/pdf")}, data={"sourceKind": "floorplan"}).json()
        second = self.client.post("/api/projects", files={"file": ("beta-clinic.pdf", blank_pdf([(220, 220)]), "application/pdf")}, data={"sourceKind": "floorplan"}).json()
        self.assertEqual(first["name"], "alpha-hospital")
        self.assertEqual(second["name"], "beta-clinic")

        listed = self.client.get("/api/projects").json()["projects"]
        ids = {item["id"] for item in listed}
        self.assertIn(first["id"], ids)
        self.assertIn(second["id"], ids)

        renamed = self.client.patch(f"/api/projects/{first['id']}", json={"name": "岐阜第一医院"}).json()
        self.assertEqual(renamed["name"], "岐阜第一医院")
        self.assertEqual(self.client.get(f"/api/projects/{first['id']}").json()["name"], "岐阜第一医院")
        self.assertEqual(self.client.get(f"/api/projects/{second['id']}").json()["name"], "beta-clinic")

        # Edits stay inside the institution folder.
        self.client.put(f"/api/projects/{first['id']}/draft", json={
            "revision": first["draft"]["revision"],
            "pageIndex": 1,
            "rotation": 0,
            "sourceKind": "floorplan",
            "floor": {"id": "1F", "name": "一楼"},
        })
        self._mark_floor_ready(first["id"], "1F", 1)
        folder_a = Path(self.tmpdir.name) / first["id"]
        folder_b = Path(self.tmpdir.name) / second["id"]
        self.assertTrue((folder_a / "project.json").is_file())
        self.assertTrue((folder_b / "project.json").is_file())
        self.assertNotEqual(folder_a.resolve(), folder_b.resolve())

        deleted = self.client.delete(f"/api/projects/{first['id']}")
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(deleted.json()["name"], "岐阜第一医院")
        self.assertFalse(folder_a.exists())
        self.assertTrue(folder_b.exists())
        self.assertEqual(self.client.get(f"/api/projects/{first['id']}").status_code, 404)
        self.assertEqual(self.client.get(f"/api/projects/{second['id']}").status_code, 200)

        empty = self.client.patch(f"/api/projects/{second['id']}", json={"name": "   "})
        self.assertEqual(empty.status_code, 400)
        too_long = self.client.patch(f"/api/projects/{second['id']}", json={"name": "x" * 41})
        self.assertIn(too_long.status_code, (400, 422))

    def test_upload_cad_kind_accepts_crop(self):
        payload = blank_pdf([(800, 1210)])
        created = self.client.post(
            "/api/projects",
            files={"file": ("cad.pdf", payload, "application/pdf")},
            data={"sourceKind": "cad"},
        )
        self.assertEqual(created.status_code, 200, created.text)
        body = created.json()
        self.assertEqual(body["draft"]["sourceKind"], "cad")
        self.assertEqual(body["sourceKind"], "cad")
        self.assertIsNone(body["draft"]["page"]["crop"])
        self.assertEqual(body["draft"]["pending"][0]["id"], "cad-crop")
        saved = self.client.put(f"/api/projects/{body['id']}/draft", json={
            "revision": body["draft"]["revision"],
            "pageIndex": 1,
            "rotation": 0,
            "sourceKind": "cad",
            "crop": {"x": 40, "y": 30, "width": 400, "height": 300},
        })
        self.assertEqual(saved.status_code, 200, saved.text)
        crop = saved.json()["draft"]["page"]["crop"]
        self.assertEqual(crop["x"], 40)
        self.assertEqual(crop["y"], 30)
        self.assertEqual(crop["width"], 400)
        self.assertEqual(crop["height"], 300)
        self.assertEqual(saved.json()["draft"]["sourceKind"], "cad")

    def test_switch_floorplan_crop_to_cad_keeps_crop(self):
        payload = blank_pdf([(800, 600)])
        created = self.client.post(
            "/api/projects",
            files={"file": ("plan.pdf", payload, "application/pdf")},
            data={"sourceKind": "floorplan"},
        ).json()
        cropped = self.client.put(f"/api/projects/{created['id']}/draft", json={
            "revision": created["draft"]["revision"],
            "pageIndex": 1,
            "rotation": 0,
            "sourceKind": "floorplan",
            "crop": {"x": 10, "y": 10, "width": 400, "height": 300},
        }).json()
        self.assertEqual(cropped["draft"]["page"]["crop"]["width"], 400)
        switched = self.client.put(f"/api/projects/{created['id']}/draft", json={
            "revision": cropped["draft"]["revision"],
            "pageIndex": 1,
            "rotation": 0,
            "sourceKind": "cad",
            "crop": {"x": 10, "y": 10, "width": 400, "height": 300},
        })
        self.assertEqual(switched.status_code, 200, switched.text)
        body = switched.json()
        self.assertEqual(body["draft"]["sourceKind"], "cad")
        self.assertEqual(body["draft"]["page"]["crop"]["width"], 400)
        self.assertEqual(body["draft"]["pending"][0]["id"], "cad-crop")

    def test_invalid_source_kind_is_rejected(self):
        payload = blank_pdf([(200, 200)])
        created = self.client.post(
            "/api/projects",
            files={"file": ("a.pdf", payload, "application/pdf")},
            data={"sourceKind": "blueprint"},
        )
        self.assertEqual(created.status_code, 400)
        self.assertIn("图纸类型", created.json()["detail"])


if __name__ == "__main__":
    unittest.main()

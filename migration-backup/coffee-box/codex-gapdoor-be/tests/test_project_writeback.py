"""Editor write-back: revisions, optimistic concurrency, backups, server-owned keys."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from fastapi.testclient import TestClient  # noqa: E402

import kujiale_import_server as server  # noqa: E402


class WriteBackTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = server.PROJECTS
        server.PROJECTS = Path(self.tmp.name) / "projects"
        server.PROJECTS.mkdir()
        self.client = TestClient(server.app)
        self.pid = server.create_project("门诊")["id"]

    def tearDown(self):
        server.PROJECTS = self.old
        self.tmp.cleanup()

    def get(self):
        return self.client.get(f"/api/projects/{self.pid}.json").json()

    def put(self, project, base, force=False):
        return self.client.put(f"/api/projects/{self.pid}.json", json={"project": project, "baseRevision": base, "force": force})

    def test_save_bumps_revision_and_keeps_backup(self):
        project = self.get()
        base = project.get("revision", 0)
        project["name"] = "门诊 · 已编辑"
        response = self.put(project, base)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["revision"], base + 1)
        saved = self.get()
        self.assertEqual(saved["name"], "门诊 · 已编辑")
        self.assertEqual(saved["revision"], base + 1)
        history = list((server.PROJECTS / self.pid / "history").glob("project-r*.json"))
        self.assertTrue(any(json.loads(f.read_text())["name"] == "门诊" for f in history))
        self.assertFalse(list((server.PROJECTS / self.pid).glob(".*.tmp")))

    def test_stale_base_gets_409_with_server_copy_and_no_overwrite(self):
        project = self.get()
        base = project.get("revision", 0)
        server.add_empty_floor(self.pid, "2F")  # someone else changed it
        project["name"] = "stale"
        response = self.put(project, base)
        self.assertEqual(response.status_code, 409)
        body = response.json()
        self.assertEqual(len(body["project"]["floors"]), 2)
        self.assertGreater(body["revision"], base)
        self.assertNotEqual(self.get()["name"], "stale")
        # Explicit "keep mine" after the user chose it.
        self.assertEqual(self.put(project, base, force=True).status_code, 200)
        self.assertEqual(self.get()["name"], "stale")

    def test_server_owned_vertical_links_survive_editor_save(self):
        _path, current = server._read_project(self.pid)
        current["verticalLinks"] = [{"id": "lift-1", "kind": "elevator"}]
        server._write_project(_path, current)
        project = self.get()
        project["verticalLinks"] = []
        self.assertEqual(self.put(project, project["revision"]).status_code, 200)
        self.assertEqual(self.get()["verticalLinks"], [{"id": "lift-1", "kind": "elevator"}])

    def test_rejects_mismatched_id_and_empty_floors(self):
        project = self.get()
        self.assertEqual(self.put({**project, "id": "0" * 32}, project.get("revision", 0)).status_code, 400)
        self.assertEqual(self.put({**project, "floors": []}, project.get("revision", 0)).status_code, 400)


if __name__ == "__main__":
    unittest.main()

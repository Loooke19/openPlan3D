"""Saved plan files: list, create, and add a floor."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import kujiale_import_server as server


class PlanFileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = server.PROJECTS
        server.PROJECTS = Path(self.tmp.name) / "projects"
        server.PROJECTS.mkdir()

    def tearDown(self):
        server.PROJECTS = self.old
        self.tmp.cleanup()

    def test_new_file_can_gain_another_floor(self):
        created = server.create_project("门诊")
        self.assertEqual(created["name"], "门诊")
        self.assertEqual([floor["name"] for floor in created["floors"]], ["1F"])
        added = server.add_empty_floor(created["id"], "2F")
        self.assertEqual([floor["name"] for floor in added["floors"]], ["1F", "2F"])
        self.assertEqual(added["floors"][1]["level"], 1)
        self.assertEqual(added["activeFloorId"], added["floors"][1]["id"])
        listed = server.list_projects()
        self.assertEqual(listed[0]["id"], created["id"])
        path, project = server._read_project(created["id"])
        floor = {
            "id": "floor-0",
            "name": "3F",
            "level": 0,
            "elevation": 0,
            "walls": [{"id": "wall-1"}],
            "rooms": [],
            "doors": [],
        }
        server.attach_floor(project, floor)
        server._write_project(path, project)
        again = server.list_projects()[0]
        self.assertEqual([item["name"] for item in again["floors"]], ["1F", "2F", "3F"])
        self.assertEqual(again["floors"][2]["walls"], 1)
        server.project_delete(created["id"])
        self.assertEqual(server.list_projects(), [])


if __name__ == "__main__":
    unittest.main()

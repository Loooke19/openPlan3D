"""Manual names (editor/MCP) survive a re-import of the same PDF."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import name_overrides as no


def project(shift=0.0, ids=("r1", "r2", "r3")):
    def room(rid, x, name):
        return {"id": rid, "name": name, "polygon": [
            {"x": x + shift, "y": shift}, {"x": x + 400 + shift, "y": shift},
            {"x": x + 400 + shift, "y": 300 + shift}, {"x": x + shift, "y": 300 + shift}]}
    return {"id": "p", "sourceSha": "abc", "floors": [{"id": "f3", "level": 3, "name": "3F", "rooms": [
        room(ids[0], 0, "心里咨询室"), room(ids[1], 1000, "妇科门诊一"), room(ids[2], 3000, "妇科门诊一")]}]}


class OverrideTest(unittest.TestCase):
    def test_drawn_ids_and_door_survive_reimport(self):
        import draw_rooms
        with tempfile.TemporaryDirectory() as root:
            first = {"sourceSha": "drawn", "floors": [{"level": 0, "rooms": [], "walls": [], "doors": []}]}
            polygon = [{"x": 0, "y": 0}, {"x": 300, "y": 0}, {"x": 300, "y": 300}, {"x": 0, "y": 300}]
            room = draw_rooms.add_drawn_room(first["floors"][0], polygon, "手画房间", key="custom-id")
            no.record_drawn(root, first)
            again = {"sourceSha": "drawn", "floors": [{"level": 0, "rooms": [], "walls": [], "doors": []}]}
            self.assertEqual(no.apply_drawn(root, again), 1)
            self.assertEqual(again["floors"][0]["rooms"][0]["id"], room["id"])
            self.assertEqual({d["id"] for d in again["floors"][0]["doors"]},
                             {d["id"] for d in first["floors"][0]["doors"]})

    def test_reimport_keeps_manual_names(self):
        with tempfile.TemporaryDirectory() as root:
            first = project()
            rooms = first["floors"][0]["rooms"]
            rooms[0]["displayName"] = "心理咨询室"
            rooms[1]["displayName"] = "妇科门诊一（北）"
            rooms[2]["displayName"] = "妇科门诊一（南）"
            self.assertEqual(no.record(root, first), 3)
            # Re-import: new ids, geometry nudged 30 cm, automatic names only.
            again = project(shift=30, ids=("x9", "x7", "x8"))
            self.assertEqual(no.apply(root, again), 3)
            names = [r.get("displayName") for r in again["floors"][0]["rooms"]]
            self.assertEqual(names, ["心理咨询室", "妇科门诊一（北）", "妇科门诊一（南）"])
            self.assertEqual(again["floors"][0]["rooms"][0]["name"], "心里咨询室")  # printed name kept

    def test_other_pdf_untouched(self):
        with tempfile.TemporaryDirectory() as root:
            first = project(); first["floors"][0]["rooms"][0]["displayName"] = "心理咨询室"
            no.record(root, first)
            other = project(); other["sourceSha"] = "zzz"
            self.assertEqual(no.apply(root, other), 0)


if __name__ == "__main__":
    unittest.main()

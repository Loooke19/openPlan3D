import sys, tempfile, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import draw_rooms, name_overrides, floor_nav


def W(i, x0, y0, x1, y1):
    return {"id": i, "start": {"x": x0, "y": y0}, "end": {"x": x1, "y": y1}, "thickness": 20}


def floor():
    # 1000×600 box, a corridor wall at y=300 with nothing splitting the south half
    return {"id": "floor-0", "name": "1F", "level": 0, "doors": [], "rooms": [],
            "walls": [W("a", 0, 0, 1000, 0), W("b", 1000, 0, 1000, 600), W("c", 1000, 600, 0, 600),
                      W("d", 0, 600, 0, 0), W("e", 0, 300, 600, 300)]}


class DrawnRoomTests(unittest.TestCase):
    def test_drawn_room_becomes_named_face_and_survives_reimport(self):
        f = floor()
        room = draw_rooms.add_drawn_room(f, [{"x": 6, "y": 296}, {"x": 404, "y": 596}], "治疗室")
        self.assertTrue(any(w["id"].startswith("drawn-") for w in f["walls"]))
        names = [r["name"] for r in floor_nav._nav_rooms(f)]
        self.assertIn("治疗室", names)
        self.assertTrue(f["doors"], "a door is added so the room is reachable")
        project = {"sourceSha": "x", "floors": [f]}
        with tempfile.TemporaryDirectory() as root:
            name_overrides.record_drawn(root, project)
            fresh = {"sourceSha": "x", "floors": [floor()]}
            self.assertEqual(name_overrides.apply_drawn(root, fresh), 1)
            self.assertIn("治疗室", [r["name"] for r in floor_nav._nav_rooms(fresh["floors"][0])])
        self.assertEqual(room["floorPolygon"][0], {"x": 0.0, "y": 300.0})


if __name__ == "__main__":
    unittest.main()

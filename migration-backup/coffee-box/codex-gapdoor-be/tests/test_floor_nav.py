"""Single-floor routes through doors, and the nav page stays free of the editor."""
import math
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import floor_nav
import kujiale_import_server as server

ROOT = Path(__file__).resolve().parents[1]


def wall(wall_id, x0, y0, x1, y1, thickness=20):
    return {
        "id": wall_id,
        "start": {"x": x0, "y": y0},
        "end": {"x": x1, "y": y1},
        "thickness": thickness,
    }


def two_rooms(door=True):
    walls = [
        wall("bottom-a", 0, 0, 400, 0),
        wall("bottom-b", 400, 0, 800, 0),
        wall("top-a", 0, 300, 400, 300),
        wall("top-b", 400, 300, 800, 300),
        wall("left", 0, 0, 0, 300),
        wall("right", 800, 0, 800, 300),
        wall("mid", 400, 0, 400, 300),
    ]
    doors = []
    if door:
        doors.append({"id": "door-1", "wallId": "mid", "position": 0.5, "width": 90})
    return {
        "id": "floor-0",
        "name": "1F",
        "walls": walls,
        "doors": doors,
        "rooms": [
            {"id": "room-a", "name": "甲", "walls": ["bottom-a", "left", "top-a", "mid"], "color": "#dce8df"},
            {"id": "room-b", "name": "卫生间", "walls": ["bottom-b", "right", "top-b", "mid"], "color": "#dce7ee"},
        ],
    }


def rooms_off_corridor():
    """甲 / 乙 open onto a named corridor; 丙 also opens onto it (shortcut bait)."""
    walls = [
        # corridor band y=300..500
        wall("c-bottom", 0, 500, 900, 500),
        wall("c-top", 0, 300, 900, 300),
        wall("c-left", 0, 300, 0, 500),
        wall("c-right", 900, 300, 900, 500),
        # room 甲 above left
        wall("a-top", 0, 0, 300, 0),
        wall("a-left", 0, 0, 0, 300),
        wall("a-right", 300, 0, 300, 300),
        # room 乙 above right
        wall("b-top", 600, 0, 900, 0),
        wall("b-left", 600, 0, 600, 300),
        wall("b-right", 900, 0, 900, 300),
        # room 丙 below (shortcut if interiors were fully walkable)
        wall("p-bottom", 200, 800, 700, 800),
        wall("p-left", 200, 500, 200, 800),
        wall("p-right", 700, 500, 700, 800),
        # divider stubs so faces close against corridor top/bottom
        wall("a-bot", 0, 300, 300, 300),
        wall("b-bot", 600, 300, 900, 300),
        wall("p-top", 200, 500, 700, 500),
    ]
    doors = [
        {"id": "door-a", "wallId": "a-bot", "position": 0.5, "width": 90},
        {"id": "door-b", "wallId": "b-bot", "position": 0.5, "width": 90},
        {"id": "door-p", "wallId": "p-top", "position": 0.5, "width": 90},
    ]
    return {
        "id": "floor-0",
        "name": "1F",
        "walls": walls,
        "doors": doors,
        "rooms": [
            {"id": "room-a", "name": "甲", "walls": ["a-top", "a-left", "a-right", "a-bot"], "color": "#dce8df"},
            {"id": "room-b", "name": "乙", "walls": ["b-top", "b-left", "b-right", "b-bot"], "color": "#dce7ee"},
            {"id": "room-c", "name": "走廊", "walls": ["c-top", "c-bottom", "c-left", "c-right"], "color": "#eee5d5"},
            {"id": "room-p", "name": "丙", "walls": ["p-top", "p-bottom", "p-left", "p-right"], "color": "#f0e4d3"},
        ],
    }


def room_with_two_corridor_doors():
    """A room with two doors onto a corridor must not become a through-shortcut."""
    walls = [
        wall("c-bottom", 0, 400, 800, 400),
        wall("c-top", 0, 200, 800, 200),
        wall("c-left", 0, 200, 0, 400),
        wall("c-right", 800, 200, 800, 400),
        wall("r-top", 200, 0, 600, 0),
        wall("r-left", 200, 0, 200, 200),
        wall("r-right", 600, 0, 600, 200),
        wall("r-bot", 200, 200, 600, 200),
    ]
    doors = [
        {"id": "door-l", "wallId": "r-bot", "position": 0.25, "width": 80},
        {"id": "door-r", "wallId": "r-bot", "position": 0.75, "width": 80},
    ]
    return {
        "id": "floor-0",
        "name": "1F",
        "walls": walls,
        "doors": doors,
        "rooms": [
            {"id": "room-r", "name": "甲", "walls": ["r-top", "r-left", "r-right", "r-bot"], "color": "#dce8df"},
            {"id": "room-c", "name": "走廊", "walls": ["c-top", "c-bottom", "c-left", "c-right"], "color": "#eee5d5"},
        ],
    }


def _segment_crosses(polyline, x, y):
    for left, right in zip(polyline, polyline[1:]):
        span = right["x"] - left["x"]
        if span == 0 or (left["x"] - x) * (right["x"] - x) > 0:
            continue
        crossed = left["y"] + (x - left["x"]) / span * (right["y"] - left["y"])
        if abs(crossed - y) < 50:
            return True
    return False


def project_with(floor, extra=None, active=None):
    floors = [floor] + ([extra] if extra else [])
    return {
        "id": "p",
        "name": "测试",
        "activeFloorId": active or floor["id"],
        "updatedAt": "t",
        "floors": floors,
    }


class FloorNavTests(unittest.TestCase):
    def test_room_spur_preserves_thin_wall_seal_outside_door(self):
        floor = two_rooms(True)
        for item in floor["walls"]:
            item["thickness"] = 10
        grid = floor_nav.build_grid(floor)
        for x in (390, 410):
            self.assertFalse(grid.walkable(*grid.cell_at(x, 90)))
        self.assertTrue(grid.walkable(*grid.cell_at(400, 150)))
        route = floor_nav.route_view(
            project_with(floor), "floor-0", {"x": 200, "y": 150}, {"x": 600, "y": 150}
        )
        self.assertTrue(route["ok"])
        self.assertTrue(_segment_crosses(route["polyline"], 400, 150))
        for left, right in zip(route["polyline"], route["polyline"][1:]):
            self.assertFalse(floor_nav._segment_hits_wall(
                (left["x"], left["y"]), (right["x"], right["y"]),
                floor["walls"], floor_nav._openings(floor),
            ))


    def test_void_is_neither_walkable_nor_a_destination(self):
        f = two_rooms()
        f["rooms"][1].update(name="上空", floorOpening=True, floorTexture="none")
        p = project_with(f)
        g = floor_nav.grid_for(p, f["id"])
        for x, y in [(450, 150), (600, 150), (750, 150)]:
            col, row = g.cell_at(x, y)
            self.assertFalse(g.walkable(col, row))
        self.assertNotIn("room-b", [r["id"] for r in floor_nav.nav_view(p, f["id"])["rooms"]])
        self.assertNotIn("上空", [r["name"] for r in g.destinations])

    def test_placeholder_and_empty_names_are_not_searchable(self):
        for name in ["", "房间 3", "房间3", "Room 14", "room14", "房间54（door-33）"]:
            self.assertFalse(floor_nav.is_destination(name))
        self.assertTrue(floor_nav.is_destination("内窥镜室"))

    def test_grid_cache_rebuilds_when_door_moves_without_count_change(self):
        project = project_with(two_rooms(True))
        first = floor_nav.grid_for(project, "floor-0")
        project["floors"][0]["doors"][0]["position"] = 0.75
        second = floor_nav.grid_for(project, "floor-0")
        self.assertIsNot(first, second)
        route = floor_nav.route_view(
            project, "floor-0", {"x": 200, "y": 150}, {"x": 600, "y": 150}
        )
        self.assertTrue(route["ok"])
        self.assertTrue(any(abs(point["y"] - 225) < 2 for point in route["polyline"]))

    def test_detected_faces_get_unique_destination_ids(self):
        floor = two_rooms(True)
        floor["rooms"] = [{"id": "shared-room", "name": "Shared", "walls": ["mid"]}]
        grid = floor_nav.build_grid(floor)
        ids = [place["id"] for place in grid.destinations]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(ids.count("shared-room"), 1)
        view_ids = [room["id"] for room in floor_nav._nav_rooms(floor)]
        self.assertEqual(len(view_ids), len(set(view_ids)))

    def test_nav_links_use_the_listening_port(self):
        previous = server._PUBLIC_ORIGIN
        try:
            server.set_public_origin("")
            request = SimpleNamespace(scope={"server": ("127.0.0.1", 8882), "scheme": "http"})
            self.assertEqual(server.public_origin(request), "http://127.0.0.1:8882")
            self.assertIn("8882", server.nav_url("a" * 32, "floor-0", request))
            summary = server.summarize_project(project_with(two_rooms(True)), request)
            self.assertIn("8882", summary["navUrl"])
            self.assertIn("8882", summary["editorUrl"])
        finally:
            server.set_public_origin(previous)

    def setUp(self):
        floor_nav._CACHE.clear()

    def test_route_crosses_the_door(self):
        grid = floor_nav.build_grid(two_rooms(True))
        self.assertTrue(grid.walkable(*grid.cell_at(400, 150)))
        self.assertFalse(grid.walkable(*grid.cell_at(400, 30)))
        route = floor_nav.route_view(project_with(two_rooms(True)), "floor-0", {"x": 200, "y": 150}, {"x": 600, "y": 150})
        self.assertTrue(route["ok"])
        self.assertGreater(route["lengthCm"], 300)
        self.assertLess(route["lengthCm"], 500)
        self.assertTrue(_segment_crosses(route["polyline"], 400, 150))
        self.assertEqual(route["usedDoorIds"], ["door-1"])
        view = floor_nav.nav_view(project_with(two_rooms(True)), "floor-0")
        self.assertEqual(len(view["openings"]), 1)
        self.assertGreaterEqual(len(view["rooms"]), 2)
        for room in view["rooms"]:
            self.assertGreaterEqual(len(room["polygon"]), 3)
            self.assertTrue(str(room["fillColor"]).startswith("#"))
        names = {item["name"] for item in grid.destinations}
        self.assertEqual(names, {"甲", "卫生间"})

    def test_shared_wall_without_a_door_blocks(self):
        ROUTE = floor_nav.route_view(project_with(two_rooms(False)), None, {"x": 200, "y": 150}, {"x": 600, "y": 150})
        # No door: never walks through the mid wall; the sealed target falls back to the
        # closest reachable spot on the start side (import-missed door policy).
        self.assertTrue(all(pt["x"] < 400 for pt in ROUTE["polyline"]) if ROUTE.get("ok") else ROUTE == {"ok": False, "reason": "blocked"})

    def test_requested_floor_ignores_the_other_floor(self):
        closed = {
            "id": "floor-1",
            "name": "2F",
            "walls": [
                wall("a", 0, 0, 300, 0),
                wall("b", 300, 0, 300, 300),
                wall("c", 300, 300, 0, 300),
                wall("d", 0, 300, 0, 0),
            ],
            "doors": [],
            "rooms": [],
        }
        project = project_with(two_rooms(True), closed, active="floor-0")
        opened = floor_nav.nav_view(project, "floor-0")
        other = floor_nav.nav_view(project, "floor-1")
        self.assertEqual(opened["floorName"], "1F")
        self.assertEqual({item["name"] for item in opened["destinations"]}, {"甲", "卫生间"})
        self.assertEqual(other["floorId"], "floor-1")
        self.assertEqual(len(other["walls"]), 4)
        self.assertEqual(other["destinations"], [])
        blocked = floor_nav.route_view(project, "floor-1", {"x": 150, "y": 150}, {"x": 600, "y": 150})
        self.assertFalse(blocked["ok"])
        self.assertEqual(floor_nav.nav_view(project, None)["floorId"], "floor-0")

    def test_empty_floor(self):
        project = project_with({"id": "floor-0", "name": "1F", "walls": [], "doors": [], "rooms": []})
        view = floor_nav.nav_view(project, None)
        self.assertTrue(view["empty"])
        self.assertEqual(view["destinations"], [])
        self.assertEqual(floor_nav.route_view(project, None, {"x": 0, "y": 0}, {"x": 10, "y": 10})["reason"], "empty")

    def test_route_does_not_cross_walls(self):
        project = project_with(two_rooms(True))
        route = floor_nav.route_view(
            project, "floor-0", {"x": 200, "y": 150}, {"x": 600, "y": 150}
        )
        self.assertTrue(route["ok"])
        floor = project["floors"][0]
        walls = floor_nav._walls(floor)
        openings = floor_nav._openings(floor)
        for left, right in zip(route["polyline"], route["polyline"][1:]):
            self.assertFalse(
                floor_nav._segment_hits_wall(
                    (left["x"], left["y"]), (right["x"], right["y"]), walls, openings
                ),
                f"segment {left} → {right} punched a wall",
            )
        # No door: still blocked (cannot walk through the mid wall).
        ROUTE = floor_nav.route_view(
            project_with(two_rooms(False)), None, {"x": 200, "y": 150}, {"x": 600, "y": 150}
        )
        # No door: never walks through the mid wall; the sealed target falls back to the
        # closest reachable spot on the start side (import-missed door policy).
        self.assertTrue(all(pt["x"] < 400 for pt in ROUTE["polyline"]) if ROUTE.get("ok") else ROUTE == {"ok": False, "reason": "blocked"})

    def test_route_string_pull_and_door_centers(self):
        project = project_with(rooms_off_corridor())
        route = floor_nav.route_view(
            project, "floor-0", {"x": 150, "y": 150}, {"x": 750, "y": 150}
        )
        self.assertTrue(route["ok"])
        # String-pull should keep the corridor run compact (not a cell-stair polyline).
        self.assertLessEqual(len(route["polyline"]), 24)
        floor = project["floors"][0]
        openings = floor_nav._openings(floor)
        walls = floor_nav._walls(floor)
        for left, right in zip(route["polyline"], route["polyline"][1:]):
            self.assertFalse(
                floor_nav._segment_hits_wall(
                    (left["x"], left["y"]), (right["x"], right["y"]), walls, openings
                )
            )
        # Path should pass a door center when entering/leaving a room door.
        door_hit = False
        for opening in openings:
            for point in route["polyline"]:
                if math.hypot(point["x"] - opening["x"], point["y"] - opening["y"]) < 20:
                    door_hit = True
                    break
            if door_hit:
                break
        self.assertTrue(door_hit)
        # Same door center must not be revisited (avoids jamb zig-zag).
        centers = [
            (round(opening["x"], 1), round(opening["y"], 1))
            for opening in openings
        ]
        seen = set()
        for point in route["polyline"]:
            key = (round(point["x"], 1), round(point["y"], 1))
            if key in centers:
                self.assertNotIn(key, seen, f"door center {key} visited twice")
                seen.add(key)

    def test_door_approach_alignment_does_not_create_wall_crossing(self):
        opening = {"x": 0, "y": 0, "ux": 1, "uy": 0, "width": 80, "across": 20}
        obstacle = wall("side-wall", -10, 25, 10, 25, thickness=10)
        points = [(-50, -50), (0, 0), (50, 50)]
        aligned = floor_nav._align_door_approaches(points, [opening], [obstacle])
        self.assertEqual(aligned[-1], (50, 50))
        self.assertFalse(floor_nav._segment_hits_wall(aligned[1], aligned[2], [obstacle], [opening]))

    def test_via_points_chain(self):
        project = project_with(two_rooms(True))
        route = floor_nav.route_view(
            project,
            "floor-0",
            {"x": 200, "y": 150},
            {"x": 600, "y": 150},
            [{"x": 200, "y": 200}],
        )
        self.assertTrue(route["ok"])
        self.assertGreater(route["lengthCm"], 300)

    def test_route_stays_in_corridor_not_side_room(self):
        project = project_with(rooms_off_corridor())
        grid = floor_nav.build_grid(rooms_off_corridor())
        # Corridor interior is walkable; side-room center is only on a spur, not a through grid.
        self.assertTrue(grid.walkable(*grid.cell_at(450, 400)))
        route = floor_nav.route_view(
            project,
            "floor-0",
            {"x": 150, "y": 150},
            {"x": 750, "y": 150},
        )
        self.assertTrue(route["ok"])
        # Must not dip into 丙 (y > 520); stay on the corridor band.
        self.assertTrue(all(point["y"] < 520 for point in route["polyline"]))
        self.assertTrue(any(300 <= point["y"] <= 500 for point in route["polyline"]))

    def test_room_is_not_a_door_to_door_shortcut(self):
        project = project_with(room_with_two_corridor_doors())
        # Walk along the corridor past the two doors — must not duck into 甲.
        route = floor_nav.route_view(
            project,
            "floor-0",
            {"x": 80, "y": 300},
            {"x": 720, "y": 300},
        )
        self.assertTrue(route["ok"])
        self.assertTrue(all(point["y"] > 180 for point in route["polyline"]))
        self.assertEqual(route["usedDoorIds"], [])
        # Entering 甲 is allowed when it is the destination.
        into = floor_nav.route_view(
            project,
            "floor-0",
            {"x": 80, "y": 300},
            {"x": 400, "y": 100},
        )
        self.assertTrue(into["ok"])
        self.assertTrue(any(point["y"] < 180 for point in into["polyline"]))
        self.assertEqual(into["usedDoorIds"], ["door-l"])

    def test_map_document_for_scene(self):
        project = project_with(two_rooms(True))
        doc = floor_nav.map_document(project, "floor-0")
        self.assertEqual(doc["schemaVersion"], "1.0.0")
        self.assertFalse(doc["empty"])
        self.assertEqual(len(doc["geometry"]["obstacles"]), 2)
        self.assertEqual(len(doc["doors"]), 1)
        self.assertEqual(len(doc["pois"]), 2)
        categories = {poi["name"]: poi["category"] for poi in doc["pois"]}
        self.assertEqual(categories["卫生间"], "restroom")
        self.assertEqual(categories["甲"], "room")
        for poi in doc["pois"]:
            self.assertTrue(all(0 <= v <= 1 for v in poi["position"]))
        self.assertEqual(doc["source"]["sourceKind"], "openplan")
        self.assertAlmostEqual(doc["calibration"]["metersPerMapUnit"], 0.05)

    def test_nav_page_is_not_the_editor(self):
        files = (ROOT / "preview" / "files.js").read_text(encoding="utf-8")
        css = (ROOT / "preview" / "files.css").read_text(encoding="utf-8")
        server_src = (ROOT / "scripts" / "kujiale_import_server.py").read_text(encoding="utf-8")
        self.assertIn("导航浏览", files)
        self.assertIn("navUrl", files)
        self.assertIn("nav-entry", css)
        self.assertIn("nav_url", server_src)
        self.assertIn("/nav?", server_src)
        self.assertIn("RedirectResponse", server_src)
        self.assertIn("OPENPLAN_ORIGIN", server_src)
        self.assertNotIn("scene3d", server_src)
        for word in ("绘制", "导入楼层"):
            self.assertNotIn(word, server_src[server_src.find("def nav_url"): server_src.find("def nav_url") + 800])
        paths = {getattr(route, "path", None) for route in server.app.routes}
        self.assertIn("/nav", paths)
        self.assertIn("/api/projects/{project_id}/map.json", paths)

    def test_hospital_material_defaults(self):
        src = (ROOT / "scripts" / "openplan_project.py").read_text(encoding="utf-8")
        self.assertIn('WALL_TEXTURE = "hospital-wall"', src)
        self.assertIn('CORRIDOR_TEXTURE = "hospital-floor"', src)
        self.assertIn('return "hospital-floor"', src)


if __name__ == "__main__":
    unittest.main()


class SealedPocketTest(unittest.TestCase):
    """Entrances / POIs in a pocket the grid can't reach still route (snap to the main region)."""

    def test_every_poi_routable_from_every_entrance(self):
        floor = two_rooms(door=False)
        floor["textAnnotations"] = [
            {"id": "entrance-1", "text": "大门（出入口 A）", "x": 600, "y": 150, "poi": True, "aliases": ["大门"]},
            {"id": "poi-x", "text": "导医台", "x": 200, "y": 150, "poi": True},
        ]
        project = {"id": "p-sealed", "floors": [floor]}
        view = floor_nav.nav_view(project, "floor-0")
        places = view.get("places") or view.get("destinations")
        entrances = [p for p in places if "出入口" in p["name"]]
        self.assertTrue(entrances)
        for e in entrances:
            for d in places:
                if d is e:
                    continue
                r = floor_nav.route_view(project, "floor-0", e, d, [])
                self.assertTrue(r.get("ok"), (e["name"], d["name"], r.get("reason")))

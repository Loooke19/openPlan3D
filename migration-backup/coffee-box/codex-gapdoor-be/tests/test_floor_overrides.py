import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import draw_rooms
import floor_nav as nav
import floor_overrides as overrides
from pdf_building import _room_faces
from test_floor_nav import two_rooms, rooms_off_corridor, wall


class FloorOverrideTests(unittest.TestCase):
    def test_uncovered_footprint_is_not_floor_or_walkable(self):
        from shapely.geometry import Point, Polygon
        floor = two_rooms()
        floor["footprint"] = [{"x": 0, "y": -600}, {"x": 800, "y": -600},
                              {"x": 800, "y": 300}, {"x": 0, "y": 300}]
        floor["walls"].extend([wall("isolated", 100, -400, 100, -200),
                               {**wall("manual", 700, -400, 700, -200), "drawn": True}])
        nav.prepare_floor(floor)
        self.assertNotIn("isolated", {w["id"] for w in floor["walls"]})
        self.assertIn("manual", {w["id"] for w in floor["walls"]})
        surface = nav.floor_surface(floor)
        self.assertFalse(surface.covers(Point(400, -300)))
        self.assertEqual(surface.intersection(Polygon([(0, -600), (800, -600), (800, -20), (0, -20)])).area, 0)
        grid = nav.build_grid(floor)
        self.assertFalse(any(grid.walkable(c, r) for r in range(grid.rows) for c in range(grid.cols)
                             if grid.center(c, r)[1] < -20))
        self.assertTrue(grid.walkable(*grid.cell_at(400, 150)))

    def test_surface_keeps_explicit_regions_thresholds_and_cuts_voids(self):
        from shapely.geometry import Point
        floor = two_rooms()
        floor["walkableRegions"] = [[{"x": 0, "y": -150}, {"x": 300, "y": -150},
                                      {"x": 300, "y": 0}, {"x": 0, "y": 0}]]
        floor["doors"].append({"id": "entry", "wallId": "top-a", "position": .5, "width": 90})
        floor["footprintExclusions"] = [{"x0": 50, "y0": 50, "x1": 100, "y1": 100}]
        nav.prepare_floor(floor)
        surface = nav.floor_surface(floor)
        for point in [(150, -100), (200, 0), (400, 150), (600, 150)]:
            self.assertTrue(surface.covers(Point(*point)))
        self.assertFalse(surface.covers(Point(75, 75)))
        self.assertFalse(surface.covers(Point(600, -100)))
        self.assertTrue(floor["floorRegions"][0]["holes"])

    def test_isolated_wall_rule_keeps_connections_room_edges_and_door_hosts(self):
        floor = two_rooms()
        floor["rooms"].append({"id": "explicit", "floorPolygon": [
            {"x": 1000, "y": 0}, {"x": 1200, "y": 0}, {"x": 1200, "y": 200}]})
        floor["walls"].extend([wall("stub", 900, 500, 900, 700),
                               wall("touch", 200, 0, 200, -200),
                               wall("edge", 1000, 0, 1000, -200),
                               wall("door-host", 1500, 0, 1500, 200),
                               {**wall("manual", 1600, 0, 1600, 200), "drawn": True}])
        floor["doors"].append({"id": "door", "wallId": "door-host", "position": .5, "width": 90})
        ids = {w["id"] for w in overrides.connected_walls(floor)}
        self.assertNotIn("stub", ids)
        self.assertTrue({"touch", "edge", "door-host", "manual"} <= ids)

    def test_smoothing_cannot_shortcut_uncovered_space(self):
        floor = two_rooms()
        floor["rooms"][1]["floorOpening"] = True
        grid = nav.build_grid(floor)
        walls, openings = nav._grid_geometry(grid)
        self.assertTrue(nav._segment_hits_wall((100, 100), (700, 100), walls, openings))

    def test_open_corridor_between_rooms_is_kept_without_extending_into_bare_slab(self):
        from shapely.geometry import Point
        floor = two_rooms()
        for w in floor["walls"]:
            w["id"] = "lower-" + w["id"]
            for p in (w["start"], w["end"]):
                p["y"] += 500
        upper = two_rooms()
        floor["walls"].extend(upper["walls"])
        floor["doors"] = []
        floor["rooms"] = []
        surface = nav.floor_surface(floor)
        self.assertTrue(surface.covers(Point(400, 400)))
        self.assertFalse(surface.covers(Point(400, -300)))

    def test_open_public_area_is_floor_without_filling_outer_footprint(self):
        from shapely.geometry import Point
        rect = lambda x0, y0, x1, y1: [
            {"x": x0, "y": y0}, {"x": x1, "y": y0},
            {"x": x1, "y": y1}, {"x": x0, "y": y1}]
        floor = {"walls": [], "rooms": [
            {"floorPolygon": rect(0, 0, 1000, 250)},
            {"floorPolygon": rect(0, 1050, 1000, 1300)}],
            "footprint": rect(-500, -500, 1500, 1800)}
        self.assertFalse(nav.floor_surface(floor).covers(Point(500, 650)))
        for name in ("门厅", "大厅", "候诊区"):
            floor["textAnnotations"] = [{"x": 500, "y": 650, "text": name}]
            surface = nav.floor_surface(floor)
            self.assertTrue(surface.covers(Point(500, 650)), name)
            self.assertFalse(surface.covers(Point(1250, 650)), name)
            self.assertFalse(surface.covers(Point(500, -250)), name)
        floor["footprintExclusions"] = [{"x0": 450, "y0": 600, "x1": 550, "y1": 700}]
        self.assertFalse(nav.floor_surface(floor).covers(Point(500, 650)))

    def test_detected_room_boundary_with_gapped_endpoints_survives(self):
        floor = two_rooms()
        floor["walls"].append(wall("crossing", 600, -50, 600, 350))
        self.assertIn("crossing", {w["id"] for w in overrides.connected_walls(floor)})

    def test_route_smoothing_cannot_cross_excluded_boxes(self):
        from shapely.geometry import LineString, box
        floor = {"id": "floor-7", "name": "8F", "rooms": [], "doors": [],
                 "walls": [wall("a", 0, 0, 1000, 0), wall("b", 1000, 0, 1000, 1000),
                           wall("c", 1000, 1000, 0, 1000), wall("d", 0, 1000, 0, 0)],
                 "footprint": [{"x": 0, "y": 0}, {"x": 1000, "y": 0},
                               {"x": 1000, "y": 1000}, {"x": 0, "y": 1000}]}
        boxes = [{"x0": 400, "y0": 400, "x1": 600, "y1": 600},
                 {"x0": 500, "y0": 500, "x1": 700, "y1": 700}]
        overrides.apply(floor, [], {"walls_remove_box": [{**b, "roomType": "void"} for b in boxes]})
        grid = nav.build_grid(floor)
        for a, b in [((200, 500), (800, 500)), ((800, 500), (200, 500)),
                     ((200, 200), (800, 800))]:
            points, error = nav._leg(grid, a, b)
            self.assertIsNone(error)
            self.assertTrue(points)
            self.assertTrue(all(not LineString(points).intersects(box(b["x0"], b["y0"], b["x1"], b["y1"])) for b in boxes))
        walls, openings = nav._grid_geometry(grid)
        opening = {"x": 400, "y": 500, "ux": 0, "uy": 1, "width": 200, "across": 30}
        self.assertTrue(nav._segment_hits_wall((200, 500), (800, 500), walls, [opening]))

    def test_non_room_boxes_block_footprint_and_doors_on_any_floor(self):
        for name in ("1F", "7F"):
            floor = two_rooms()
            floor["name"] = name
            floor["footprint"] = [{"x": 0, "y": 0}, {"x": 800, "y": 0},
                                  {"x": 800, "y": 300}, {"x": 0, "y": 300}]
            boxes = [{"x0": 350, "y0": 100, "x1": 450, "y1": 200},
                     {"x0": 100, "y0": 100, "x1": 200, "y1": 200}]
            overrides.apply(floor, [], {"walls_remove_box": [{**b, "roomType": "void"} for b in boxes]})
            self.assertEqual(floor["footprintExclusions"], boxes)
            grid = nav.build_grid(floor)
            for b in boxes:
                cells = [grid.walkable(c, r) for r in range(grid.rows) for c in range(grid.cols)
                         if b["x0"] <= grid.center(c, r)[0] <= b["x1"]
                         and b["y0"] <= grid.center(c, r)[1] <= b["y1"]]
                self.assertTrue(cells)
                self.assertFalse(any(cells))
            self.assertTrue(grid.walkable(*grid.cell_at(600, 150)))

    def test_box_cleanup_drops_short_stubs_but_keeps_long_and_manual_walls(self):
        floor = two_rooms()
        box = {"x0": 1000, "y0": 0, "x1": 1200, "y1": 300}
        cases = [("short", (1100, 150), (1300, 150), False),
                 ("reversed", (900, 150), (1100, 150), False),
                 ("diagonal", (1100, 150), (1300, 350), False),
                 ("threshold", (1100, 150), (1400, 150), False),
                 ("over-threshold", (1100, 150), (1401, 150), False),
                 ("tangent", (1200, 150), (1300, 150), False),
                 ("long", (1100, 150), (1500, 150), False),
                 ("outside", (1300, 150), (1350, 150), False),
                 ("through", (900, 150), (1300, 150), False),
                 ("drawn", (1100, 150), (1300, 150), True),
                 ("manual-door", (1100, 150), (1300, 150), False)]
        for key, a, b, drawn in cases:
            floor["walls"].append({"id": key, "start": dict(zip(("x", "y"), a)),
                                   "end": dict(zip(("x", "y"), b)), "thickness": 15, "drawn": drawn})
        floor["doors"].append({"id": "manual", "wallId": "manual-door", "position": .5,
                               "width": 90, "drawn": True})
        floor["doors"].append({"id": "removed", "wallId": "short", "position": .5, "width": 90})
        overrides.apply(floor, [], {"walls_remove_box": [box]})
        ids = {w["id"] for w in floor["walls"]}
        self.assertFalse(ids & {"short", "reversed", "diagonal", "threshold"})
        self.assertTrue({"long", "outside", "through", "over-threshold", "tangent", "drawn", "manual-door"} <= ids)
        self.assertNotIn("footprintExclusions", floor)
        self.assertNotIn("removed", {d["id"] for d in floor["doors"]})
        self.assertIn("manual", {d["id"] for d in floor["doors"]})

    def test_exclusions_invalidate_cached_navigation(self):
        floor = two_rooms()
        project = {"id": "cache-exclusions", "floors": [floor], "activeFloorId": floor["id"]}
        before = nav.grid_for(project)
        floor["footprintExclusions"] = [{"x0": 100, "y0": 100, "x1": 200, "y1": 200}]
        after = nav.grid_for(project)
        self.assertIsNot(before, after)
        self.assertTrue(before.walkable(*before.cell_at(150, 150)))
        self.assertFalse(after.walkable(*after.cell_at(150, 150)))

    def test_merge_retains_named_id_and_untouched_room(self):
        floor = rooms_off_corridor()
        old = copy.deepcopy(floor["rooms"])
        overrides.apply(floor, [], {"walls_remove": [{"x": 150, "y": 300, "tol": 1}]})
        room_b = next(r for r in floor["rooms"] if r["id"] == "room-b")
        self.assertEqual(room_b["name"], old[1]["name"])
        self.assertEqual(set(room_b["walls"]), set(old[1]["walls"]))
        self.assertEqual(len({r["id"] for r in floor["rooms"]}), len(floor["rooms"]))

    def test_split_keeps_one_manual_name_and_unique_ids(self):
        floor = two_rooms()
        floor["rooms"][0].update(name="手工诊室", nameSource="manual", displayName="改过的名称")
        overrides.apply(floor, [], {"walls_add": [{"start": {"x": 200, "y": 0},
                                                  "end": {"x": 200, "y": 300}}]})
        named = [r for r in floor["rooms"] if r.get("name") == "手工诊室"]
        self.assertEqual(len(named), 1)
        self.assertEqual(named[0]["id"], "room-a")
        self.assertEqual(named[0]["displayName"], "改过的名称")
        self.assertEqual(len(floor["rooms"]), 3)

    def test_void_stays_blocked_even_with_a_door_and_footprint(self):
        floor = two_rooms()
        floor["footprint"] = [{"x": 0, "y": 0}, {"x": 800, "y": 0},
                              {"x": 800, "y": 300}, {"x": 0, "y": 300}]
        overrides.apply(floor, [], {"rooms": [{"x": 150, "y": 150, "name": "门厅上空",
                                               "floorOpening": True, "floorTexture": "none"}]})
        grid = nav.build_grid(floor)
        poly = _room_faces(floor)["room-a"]
        inside = [grid.walkable(c, r) for r in range(grid.rows) for c in range(grid.cols)
                  if nav._point_in_polygon(*grid.center(c, r), poly)]
        self.assertTrue(inside)
        self.assertFalse(any(inside))
        self.assertNotIn("room-a", {d["id"] for d in grid.destinations})

    def test_drawn_geometry_and_manual_door_survive(self):
        floor = two_rooms()
        rect = [{"x": 1000, "y": 0}, {"x": 1300, "y": 0},
                {"x": 1300, "y": 300}, {"x": 1000, "y": 300}]
        room = draw_rooms.add_drawn_room(floor, rect, "手工房间", key="stable")
        drawn = copy.deepcopy(room)
        walls = [copy.deepcopy(w) for w in floor["walls"] if w.get("drawn")]
        doors = copy.deepcopy(floor["doors"])
        overrides.apply(floor, [], {"walls_remove_box": [{"x0": 999, "y0": -1, "x1": 1301, "y1": 301}],
                                    "walls_add": [{"start": {"x": 200, "y": 0}, "end": {"x": 200, "y": 300}}]})
        self.assertIn(drawn, floor["rooms"])
        self.assertTrue(all(w in floor["walls"] for w in walls))
        self.assertEqual(floor["doors"], doors)
        self.assertEqual(len([r for r in floor["rooms"] if r.get("drawn")]), 1)

    def test_placeholders_are_never_searchable(self):
        for name in ["", None, "房间 54", "房间54", "Room 9", "room9"]:
            self.assertFalse(nav.is_destination(name))
        self.assertTrue(nav.is_destination("办公室"))

    def test_reimport_uses_previous_ids(self):
        edit = {"walls_add": [{"start": {"x": 200, "y": 0}, "end": {"x": 200, "y": 300}}]}
        first = two_rooms()
        overrides.apply(first, [], edit)
        again = two_rooms()
        overrides.apply(again, [], edit, previous_floor=first)
        self.assertEqual({r["id"]: set(r["walls"]) for r in first["rooms"]},
                         {r["id"]: set(r["walls"]) for r in again["rooms"]})

    def test_manual_door_host_is_kept(self):
        floor = two_rooms()
        floor["doors"][0]["drawn"] = True
        before = copy.deepcopy(floor)
        overrides.apply(floor, [], {"walls_remove": [{"x": 400, "y": 150, "tol": 1}]})
        self.assertEqual(floor, before)

    def test_small_manual_fragment_wins_a_merge(self):
        floor = two_rooms()
        for wall in floor["walls"]:
            for point in [wall["start"], wall["end"]]:
                if point["x"] == 800:
                    point["x"] = 1600
        floor["rooms"][0].update(name="人工名字", nameSource="manual")
        overrides.apply(floor, [], {"walls_remove": [{"x": 400, "y": 150, "tol": 1}]})
        self.assertEqual(len(floor["rooms"]), 1)
        self.assertEqual(floor["rooms"][0]["id"], "room-a")
        self.assertEqual(floor["rooms"][0]["name"], "人工名字")

    def test_stairs_recalculate_from_geometry_without_changing_rooms(self):
        floor = two_rooms()
        floor.update(name="1F", level=0, elevation=0)
        floor["rooms"][0]["name"] = "楼梯"
        above = {"id": "floor-1", "name": "2F", "level": 1, "elevation": 340,
                 "height": 390, "walls": [], "rooms": []}
        before = copy.deepcopy(floor)
        with mock.patch.object(overrides, "load", return_value=None):
            overrides.generate_stairs([above, floor])
            first = copy.deepcopy(floor["stairs"])
            self.assertEqual(first[0]["riserCount"], 20)
            self.assertEqual({k: v for k, v in floor.items() if k != "stairs"}, before)
            for wall in floor["walls"]:
                for point in (wall["start"], wall["end"]):
                    point["y"] *= 2
            overrides.generate_stairs([floor, above])
            self.assertGreater(floor["stairs"][0]["depth"], first[0]["depth"])
            self.assertEqual(floor["stairs"][0]["id"], first[0]["id"])

    def test_missing_room_outline_and_single_floor_steps(self):
        floor = two_rooms()
        floor.update(name="1F", level=0, elevation=0)
        floor["rooms"][0]["name"] = "楼梯"
        above = {"id": "floor-1", "name": "2F", "level": 1, "elevation": 300,
                 "walls": [], "rooms": []}
        linked = {"kind": "stairs", "link": "west", "x": 1100, "y": 200,
                  "polygon": [{"x": 1000, "y": 0}, {"x": 1200, "y": 0},
                              {"x": 1200, "y": 400}, {"x": 1000, "y": 400}],
                  "thickness": 20, "rotation": 180, "stairType": "straight"}
        steps = {"kind": "stairs", "link": "outdoor", "x": 200, "y": 150}
        data = {"1F": {"vertical_tag": [steps, linked]}, "2F": {"vertical_tag": [linked]}}
        with mock.patch.object(overrides, "load", side_effect=lambda b, f: data[f]):
            overrides.generate_stairs([floor, above], "test")
        self.assertEqual([s["id"] for s in floor["stairs"]], ["stair-west"])
        stair = floor["stairs"][0]
        self.assertEqual(stair["position"], {"x": 1100, "y": 200})
        self.assertEqual((stair["width"], stair["depth"], stair["rotation"]), (170, 370, 180))
        self.assertEqual(stair, above["stairs"][0])

    def test_writing_stairs_preserves_other_override_bytes(self):
        source = '{\n "rooms" : [ { "name": "卫生间", "floorOpening": false } ],\n "stairs" : []\n}\n'
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(overrides, "overrides_dir", return_value=Path(temp)):
            path = Path(temp) / "test-1F.json"
            path.write_text(source, encoding="utf-8")
            floors = [{"name": "1F", "stairs": [{"id": "stairs"}]}]
            overrides.write_stair_overrides(floors, "test")
            written = path.read_text(encoding="utf-8")
            self.assertEqual(written, source.replace('[]\n}', json.dumps(floors[0]["stairs"], indent=1) + '\n}'))
            overrides.write_stair_overrides(floors, "test")
            self.assertEqual(path.read_text(encoding="utf-8"), written)


if __name__ == "__main__":
    unittest.main()

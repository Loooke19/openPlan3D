"""Multi-page PDF → one building: storeys from sheet titles, linked shafts, direct rides."""
import copy
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import floor_nav
import floor_overrides
import kujiale_import_server as server
import pdf_building
from openplan_project import _elevator_crosses
from test_floor_nav import rooms_off_corridor, two_rooms, wall


def storey_floor(level, name=None):
    floor = copy.deepcopy(rooms_off_corridor())
    floor["id"] = pdf_building.floor_id_for(level)
    floor["name"] = name or pdf_building.storey_label(level + 1)
    floor["level"] = level
    floor["elevation"] = level * 300
    floor["rooms"][1]["name"] = "电梯"
    return floor


def building(levels=4):
    floors = [storey_floor(level) for level in range(levels)]
    vertical = {floor["id"]: [{"kind": "elevator", "roomId": "room-b", "x": 750, "y": 150}] for floor in floors}
    return {
        "id": "b" * 32,
        "name": "楼",
        "activeFloorId": "floor-0",
        "updatedAt": "t",
        "floors": floors,
        "verticalLinks": pdf_building.link_shafts(floors, vertical),
    }


def place(project, floor_id, name):
    return next(
        item for item in floor_nav.all_places(project)
        if item["floorId"] == floor_id and item["name"] == name
    )


def stop(item):
    return {"x": item["x"], "y": item["y"], "floor": item["floorId"]}


class SheetTitleTests(unittest.TestCase):
    def test_plan_caption_names_the_storey_and_scale(self):
        parsed = pdf_building.parse_sheet_title(
            ["图名：", "Sheet Name:", "五层现状平面图", "1:100", "五层平面图", "本层建筑面积：593.217m²"],
        )
        self.assertEqual(parsed["storey"], 5)
        self.assertEqual(parsed["scale"], 100)
        self.assertEqual(parsed["title"], "五层现状平面图")

    def test_tens_basements_and_latin_storeys(self):
        self.assertEqual(pdf_building.parse_sheet_title(["十二层平面图 1：200"])["storey"], 12)
        self.assertEqual(pdf_building.parse_sheet_title(["十二层平面图 1：200"])["scale"], 200)
        self.assertEqual(pdf_building.parse_sheet_title(["地下一层平面图"])["storey"], -1)
        self.assertEqual(pdf_building.parse_sheet_title(["3F 平面图"])["storey"], 3)
        self.assertIsNone(pdf_building.parse_sheet_title(["本层建筑面积", "图号"])["storey"])

    def test_top_first_page_order_still_stacks_one_f_at_the_bottom(self):
        titles = [{"page": page, "storey": 6 - page, "title": "", "scale": 100} for page in range(1, 6)]
        floors = pdf_building.assign_floors(titles)
        self.assertEqual([row["name"] for row in floors], ["1F", "2F", "3F", "4F", "5F"])
        self.assertEqual([row["page"] for row in floors], [5, 4, 3, 2, 1])
        self.assertEqual([row["level"] for row in floors], [0, 1, 2, 3, 4])
        self.assertAlmostEqual(pdf_building.sheet_scale(titles), 100 * 2.54 / 72)

    def test_unreadable_or_repeated_titles_go_above_the_known_floors(self):
        titles = [
            {"page": 1, "storey": 2},
            {"page": 2, "storey": None},
            {"page": 3, "storey": 1},
            {"page": 4, "storey": 2},
        ]
        floors = pdf_building.assign_floors(titles)
        self.assertEqual([(row["page"], row["name"], row["level"]) for row in floors],
                         [(3, "1F", 0), (1, "2F", 1), (2, "第2页", 2), (4, "第4页", 3)])
        self.assertEqual(pdf_building.floor_id_for(-1), "floor-b1")


class ShaftTests(unittest.TestCase):
    def test_link_labels_use_the_lowest_plan_instead_of_averaging_different_origins(self):
        floors = [storey_floor(0), storey_floor(1)]
        for wall in floors[1]["walls"]:
            for point in (wall["start"], wall["end"]):
                point["x"] += 5000
                point["y"] += 1500
        links = [{"id": side, "kind": "stairs", "stops": [
            {"floorId": "floor-1", "x": x + 5000, "y": 1800},
            {"floorId": "floor-0", "x": x, "y": 300},
        ]} for side, x in (("west", 100), ("east", 1100))]
        pdf_building.name_links(links, list(reversed(floors)), 270.1)
        self.assertEqual([link["name"] for link in links], ["楼梯（西）", "楼梯（东）"])
        pdf_building.name_links(links, floors, None)
        self.assertEqual([link["name"] for link in links], ["楼梯 A", "楼梯 B"])


    def setUp(self):
        floor_nav._CACHE.clear()

    def test_elevator_x_is_found_by_its_two_crossing_diagonals(self):
        segments = [
            (851, 687, 924, 738, 0.5),
            (851, 738, 924, 687, 0.5),
            (100, 100, 400, 100, 0.5),
            (500, 500, 540, 560, 0.5),
        ]
        centres = _elevator_crosses(segments)
        self.assertEqual(len(centres), 1)
        self.assertAlmostEqual(centres[0][0], 887.5)
        self.assertAlmostEqual(centres[0][1], 712.5)

    def test_sealed_shaft_room_gets_a_door_onto_the_corridor(self):
        floor = storey_floor(0)
        floor["doors"] = [door for door in floor["doors"] if door["id"] != "door-b"]
        vertical = [{"kind": "elevator", "roomId": "room-b", "x": 750, "y": 150}]
        report = pdf_building.connect_shafts(floor, vertical)
        self.assertEqual(len(report["doors"]), 1)
        door = next(door for door in floor["doors"] if door["id"] == report["doors"][0])
        self.assertEqual(door["wallId"], "b-bot")
        self.assertEqual(vertical[0]["roomId"], "room-b")

    def test_boxed_shaft_stands_in_its_lift_lobby_not_across_a_wall(self):
        # Regression: CAD draws the shaft as its own sealed box (with the X) inside the
        # lift lobby. The fallback landing was the nearest walkable cell as the crow
        # flies, which sat in the neighbouring room across the shared wall.
        floor = storey_floor(0)
        walls = floor["walls"]
        walls += [
            {**walls[0], "id": "d-top", "start": {"x": 300, "y": 0}, "end": {"x": 600, "y": 0}},
            {**walls[0], "id": "d-bot", "start": {"x": 300, "y": 300}, "end": {"x": 600, "y": 300}},
        ]
        for wid, x0, y0, x1, y1 in (("s-n", 605, 40, 740, 40), ("s-s", 605, 260, 740, 260),
                                    ("s-w", 605, 40, 605, 260), ("s-e", 740, 40, 740, 260)):
            walls.append({**walls[0], "id": wid, "start": {"x": x0, "y": y0}, "end": {"x": x1, "y": y1}})
        floor["rooms"].append({"id": "room-d", "name": "放射科", "walls": ["d-top", "d-bot", "a-right", "b-left"], "color": "#eee"})
        floor["doors"].append({"id": "door-d", "wallId": "d-bot", "position": 0.5, "width": 90})
        vertical = [{"kind": "elevator", "roomId": "room-b", "x": 630, "y": 150}]
        pdf_building.connect_shafts(floor, vertical)
        self.assertEqual(len(vertical), 1)
        self.assertGreater(vertical[0]["x"], 600, vertical[0])  # inside 电梯 lobby, not 放射科
        self.assertLess(vertical[0]["y"], 300)
        self.assertEqual(vertical[0]["roomId"], "room-b")

    def test_sealed_shaft_lands_in_front_of_it_not_in_the_room_across_the_wall(self):
        # Regression (synthetic CAD PDF): the elevator room stayed sealed, and the landing
        # fallback took the nearest walkable cell as the crow flies -- inside 放射科 on the
        # far side of the shared wall -- so the lift stop sat in the X-ray room.
        floor = storey_floor(0)
        floor["doors"] = [door for door in floor["doors"] if door["id"] != "door-b"]
        walls = floor["walls"]
        walls += [
            {**walls[0], "id": "d-top", "start": {"x": 300, "y": 0}, "end": {"x": 600, "y": 0}},
            {**walls[0], "id": "d-bot", "start": {"x": 300, "y": 300}, "end": {"x": 600, "y": 300}},
        ]
        floor["rooms"].append({"id": "room-d", "name": "放射科", "walls": ["d-top", "d-bot", "a-right", "b-left"], "color": "#eee"})
        floor["doors"].append({"id": "door-d", "wallId": "d-bot", "position": 0.5, "width": 90})
        vertical = [{"kind": "elevator", "roomId": "room-b", "x": 640, "y": 220}]
        # As in the PDF, no door onto the shaft makes it reachable.
        with mock.patch.object(pdf_building, "_doors_toward_main", return_value=[], create=True), \
                mock.patch.object(pdf_building, "_door_toward_main", return_value=None):
            report = pdf_building.connect_shafts(floor, vertical)
        self.assertEqual(report["landings"], 1)
        self.assertGreater(vertical[0]["x"], 600, vertical[0])  # not in 放射科 (x 300..600)
        self.assertTrue(300 < vertical[0]["y"] < 500, vertical[0])  # corridor right outside
        self.assertEqual(vertical[0]["at"], (640, 220))

    def test_shaft_outside_any_room_moves_to_its_landing(self):
        floor = storey_floor(0)
        vertical = [{"kind": "stairs", "roomId": "", "x": 450, "y": 150}]
        report = pdf_building.connect_shafts(floor, vertical)
        self.assertEqual(report["landings"], 1)
        self.assertTrue(300 < vertical[0]["y"] < 500)
        self.assertEqual(vertical[0]["at"], (450, 150))

    def test_sealed_named_room_gets_a_door_but_plant_decks_stay_closed(self):
        floor = storey_floor(0)
        floor["doors"] = [door for door in floor["doors"] if door["id"] not in ("door-a", "door-p")]
        floor["rooms"][3]["name"] = "空调外机"
        added = pdf_building.infer_room_doors(floor)
        self.assertEqual([door["wallId"] for door in floor["doors"] if door["id"] in added], ["a-bot"])

    def test_one_link_stops_on_every_floor_at_the_same_spot(self):
        floors = [storey_floor(level) for level in (2, 0, 1)]
        vertical = {
            "floor-0": [{"kind": "elevator", "roomId": "room-b", "x": 750, "y": 150}],
            "floor-1": [{"kind": "elevator", "roomId": "", "x": 760, "y": 360, "at": (752, 148)}],
            "floor-2": [
                {"kind": "elevator", "roomId": "room-b", "x": 748, "y": 152},
                {"kind": "elevator", "roomId": "", "x": 100, "y": 150},
            ],
        }
        links = pdf_building.link_shafts(floors, vertical)
        self.assertEqual(len(links), 1)
        self.assertEqual([item["floorId"] for item in links[0]["stops"]], ["floor-0", "floor-1", "floor-2"])
        self.assertEqual(links[0]["stops"][1], {"floorId": "floor-1", "x": 760.0, "y": 360.0})


class DirectRideTests(unittest.TestCase):
    def setUp(self):
        floor_nav._CACHE.clear()

    def test_top_to_ground_trip_only_shows_the_two_end_floors(self):
        project = building(4)
        start = place(project, "floor-3", "甲")
        end = place(project, "floor-0", "丙")
        result = floor_nav.route_view(project, "floor-3", stop(start), stop(end))
        self.assertTrue(result["ok"], result)
        self.assertEqual([leg["floorId"] for leg in result["legs"]], ["floor-3", "floor-0"])
        self.assertEqual(len(result["transfers"]), 1)
        transfer = result["transfers"][0]
        self.assertEqual((transfer["fromFloorId"], transfer["toFloorId"]), ("floor-3", "floor-0"))
        self.assertEqual(transfer["storeys"], 3)
        self.assertEqual(transfer["direction"], "down")

    def test_changing_shafts_mid_building_loses_to_one_direct_ride(self):
        project = building(4)
        # Floor-by-floor escalators inside 甲 undercut walking to the elevator in 乙
        # unless changing between them on 2F / 3F costs extra.
        for level in range(3):
            project["verticalLinks"].append({
                "id": f"escalator-{level}",
                "kind": "escalator",
                "stops": [
                    {"floorId": f"floor-{level}", "roomId": "room-a"},
                    {"floorId": f"floor-{level + 1}", "roomId": "room-a"},
                ],
            })
        start = place(project, "floor-0", "甲")
        end = place(project, "floor-3", "甲")
        result = floor_nav.route_view(project, "floor-0", stop(start), stop(end))
        self.assertTrue(result["ok"], result)
        self.assertEqual([leg["floorId"] for leg in result["legs"]], ["floor-0", "floor-3"])
        self.assertEqual(result["transfers"][0]["direction"], "up")


class BuildingImportServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = server.PROJECTS, server.SHEETS
        server.PROJECTS = Path(self.tmp.name) / "projects"
        server.SHEETS = Path(self.tmp.name) / "sheets"
        server.PROJECTS.mkdir()
        (server.SHEETS / "s1").mkdir(parents=True)
        (server.SHEETS / "s1" / "page.pdf").write_bytes(b"%PDF-1.4")
        (server.SHEETS / "s1" / "meta.json").write_text('{"dpi": 96, "pages": 4}')

    def tearDown(self):
        server.PROJECTS, server.SHEETS = self.old
        self.tmp.cleanup()

    def test_job_writes_one_project_with_every_floor_and_links(self):
        from fastapi.testclient import TestClient
        built = building(4)

        def fake_import(pdf, scale=None, name="", progress=None, **_kw):
            progress(1, 5, "识别第 1 页 · 4F")
            return {"project": built, "floors": [{"name": "1F", "level": 0}], "links": built["verticalLinks"], "scale": scale}

        with mock.patch.object(server, "import_building", side_effect=fake_import), \
                mock.patch.object(server, "_sheet_floors", return_value={"cmPerPoint": 3.52778}):
            client = TestClient(server.app)
            started = client.post("/api/import-building", data={"sheetId": "s1", "name": "楼"})
            self.assertEqual(started.status_code, 200, started.text)
            job_id = started.json()["jobId"]
            for _ in range(50):
                job = client.get(f"/api/jobs/{job_id}").json()
                if job["state"] != "running":
                    break
                time.sleep(0.05)
        self.assertEqual(job["state"], "done", job)
        self.assertIn("/nav?", job["result"]["navUrl"])
        self.assertEqual(job["result"]["links"][0]["floors"], ["floor-0", "floor-1", "floor-2", "floor-3"])
        _path, saved = server._read_project(job["result"]["projectId"])
        self.assertEqual(len(saved["floors"]), 4)
        self.assertEqual(len(saved["verticalLinks"]), 1)

    def test_without_ruler_or_titled_scale_the_import_asks_for_a_ruler(self):
        from fastapi.testclient import TestClient
        with mock.patch.object(server, "_sheet_floors", return_value={"cmPerPoint": None}):
            response = TestClient(server.app).post("/api/import-building", data={"sheetId": "s1"})
        self.assertEqual(response.status_code, 400)


class FloorOverrideTests(unittest.TestCase):
    def test_named_split_keeps_the_original_id_on_the_correct_small_piece(self):
        f = two_rooms(False)
        f["walls"] = [w for w in f["walls"] if w["id"] != "mid"]
        f["rooms"] = [{"id": "room-20", "name": "细菌室", "walls": [w["id"] for w in f["walls"]]}]
        floor_overrides.apply(f, [], {
            "walls_add": [{"start": {"x": 200, "y": 0}, "end": {"x": 200, "y": 300}}],
            "rooms": [{"x": 100, "y": 150, "name": "细菌室"}, {"x": 600, "y": 150, "name": "生化室"}],
        })
        r = next(r for r in f["rooms"] if r["id"] == "room-20")
        self.assertEqual((r["name"], r["area"]), ("细菌室", 6))

    def test_previous_manual_geometry_and_cleared_name_survive_a_fresh_import(self):
        previous = two_rooms()
        previous["walls"][-1]["drawn"] = True
        previous["doors"][0]["drawn"] = True
        previous["rooms"][0].update(name="", nameSource="manual")
        fresh = two_rooms()
        fresh["rooms"][0]["id"] = "room-new"
        floor_overrides.apply(fresh, [], {"rooms": [{"x": 200, "y": 150, "name": "错误恢复"}]}, previous)
        self.assertIn(previous["walls"][-1], fresh["walls"])
        self.assertIn(previous["doors"][0], fresh["doors"])
        room = next(r for r in fresh["rooms"] if r["id"] == "room-a")
        self.assertEqual((room["name"], room["nameSource"]), ("", "manual"))
        self.assertEqual(set(room["walls"]), set(previous["rooms"][0]["walls"]))

    def test_merge_keeps_the_named_room_id_and_manual_name(self):
        f = two_rooms()
        f["rooms"][0].update(displayName="人工名称", nameSource="manual")
        f["rooms"][1]["name"] = ""
        floor_overrides.apply(f, [], {"walls_remove": [{"x": 400, "y": 150, "tol": 1}],
                                      "rooms": [{"x": 200, "y": 150, "name": "自动名称"}]})
        self.assertEqual(len(f["rooms"]), 1)
        r = f["rooms"][0]
        self.assertEqual(r["id"], "room-a")
        self.assertEqual(r["name"], "甲")
        self.assertEqual(r["displayName"], "人工名称")
        self.assertEqual(r["area"], 24)

    def test_split_never_duplicates_ids_names_or_opening_metadata(self):
        f = two_rooms(False)
        f["walls"] = [w for w in f["walls"] if w["id"] != "mid"]
        f["rooms"] = [{"id": "room-20", "name": "上空", "floorOpening": True,
                       "floorTexture": "none", "walls": [w["id"] for w in f["walls"]]}]
        floor_overrides.apply(f, [], {"walls_add": [{"start": {"x": 200, "y": 0}, "end": {"x": 200, "y": 300}}]})
        self.assertEqual({r["id"] for r in f["rooms"]}, {"room-20", "room-21"})
        old = next(r for r in f["rooms"] if r["id"] == "room-20")
        self.assertTrue(old["floorOpening"])
        self.assertEqual(old["floorTexture"], "none")
        self.assertEqual(sum(r.get("name") == "上空" for r in f["rooms"]), 1)

    def test_trim_keeps_stair_side_and_repositions_a_door_on_a_reversed_wall(self):
        w = wall("long", 1000, 0, 0, 0)
        f = {"walls": [w], "rooms": [], "doors": [{"id": "d", "wallId": "long", "position": .9}]}
        with mock.patch.object(floor_overrides, "_rebuild_rooms"):
            floor_overrides.apply(f, [], {"walls_remove": [{"start": {"x": 400, "y": 0}, "end": {"x": 1000, "y": 0}, "tol": 1}]})
        self.assertEqual(len(f["walls"]), 1)
        self.assertEqual(f["walls"][0]["start"], {"x": 0, "y": 0})
        self.assertEqual(f["walls"][0]["end"], {"x": 400, "y": 0})
        self.assertEqual(f["doors"][0]["position"], .25)
        self.assertEqual(f["doors"][0]["wallId"], f["walls"][0]["id"])

    def test_drawn_room_walls_and_doors_are_unchanged(self):
        f = two_rooms()
        f["walls"][-1]["drawn"] = True
        f["doors"][0]["drawn"] = True
        f["rooms"][1].update(drawn=True, floorPolygon=[{"x": 400, "y": 0}, {"x": 800, "y": 0},
                                                     {"x": 800, "y": 300}, {"x": 400, "y": 300}])
        old = copy.deepcopy(f)
        floor_overrides.apply(f, [], {"walls_remove": [{"x": 400, "y": 150, "tol": 1}],
                                      "walls_add": [{"start": {"x": 100, "y": 0}, "end": {"x": 100, "y": 300}}],
                                      "rooms": [{"x": 600, "y": 150, "name": "错误覆盖", "roomType": "corridor"}]})
        self.assertIn(old["walls"][-1], f["walls"])
        self.assertIn(old["doors"][0], f["doors"])
        self.assertIn(old["rooms"][1], f["rooms"])


if __name__ == "__main__":
    unittest.main()

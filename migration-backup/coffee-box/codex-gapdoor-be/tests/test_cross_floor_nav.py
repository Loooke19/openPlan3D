"""Cross-floor trips: walk to a vertical link, ride, walk on from the same shaft."""
import copy
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import floor_nav
import kujiale_import_server as server
from test_floor_nav import rooms_off_corridor


def floor_with(floor_id, name, level, renames):
    floor = copy.deepcopy(rooms_off_corridor())
    floor["id"] = floor_id
    floor["name"] = name
    floor["level"] = level
    for room in floor["rooms"]:
        room["name"] = renames.get(room["id"], room["name"])
    return floor


def two_floor_project(elevator="电梯", upper_elevator=None):
    lower = floor_with("floor-0", "1F", 0, {"room-b": elevator})
    upper = floor_with("floor-1", "2F", 1, {"room-b": upper_elevator or elevator, "room-a": "病房"})
    return {
        "id": "p",
        "name": "两层",
        "activeFloorId": "floor-0",
        "updatedAt": "t",
        "floors": [lower, upper],
    }


def place(project, floor_id, name):
    return next(
        item for item in floor_nav.all_places(project)
        if item["floorId"] == floor_id and item["name"] == name
    )


def stop(item):
    return {"x": item["x"], "y": item["y"], "floor": item["floorId"]}


class CrossFloorTests(unittest.TestCase):
    def setUp(self):
        floor_nav._CACHE.clear()

    def test_same_named_elevators_pair_and_the_trip_has_two_legs(self):
        project = two_floor_project()
        links = floor_nav.vertical_links(project)
        self.assertEqual(len(links), 1)
        self.assertEqual(links[0]["kind"], "elevator")
        self.assertEqual(links[0]["source"], "auto")
        self.assertEqual([item["floorId"] for item in links[0]["stops"]], ["floor-0", "floor-1"])

        route = floor_nav.route_view(
            project, "floor-0",
            stop(place(project, "floor-0", "甲")),
            stop(place(project, "floor-1", "丙")),
        )
        self.assertTrue(route["ok"])
        self.assertTrue(route["crossFloor"])
        self.assertEqual([leg["floorId"] for leg in route["legs"]], ["floor-0", "floor-1"])
        self.assertEqual(route["polyline"], route["legs"][0]["polyline"])
        transfer = route["transfers"][0]
        self.assertEqual(transfer["afterLeg"], 0)
        self.assertEqual((transfer["fromFloorId"], transfer["toFloorId"]), ("floor-0", "floor-1"))
        lower_stop, upper_stop = links[0]["stops"]
        self.assertEqual(route["legs"][0]["polyline"][-1], {"x": lower_stop["x"], "y": lower_stop["y"]})
        self.assertEqual(route["legs"][1]["polyline"][0], {"x": upper_stop["x"], "y": upper_stop["y"]})
        self.assertIn("door-b", route["legs"][0]["usedDoorIds"])
        self.assertEqual(set(route["legs"][1]["usedDoorIds"]), {"door-b", "door-p"})
        self.assertEqual(
            route["lengthCm"],
            sum(leg["lengthCm"] for leg in route["legs"]),
        )

    def test_floor_tags_do_not_split_a_shaft(self):
        project = two_floor_project("1F电梯", "2F 电梯")
        self.assertEqual(len(floor_nav.vertical_links(project)), 1)

    def test_single_floor_route_is_one_leg(self):
        project = two_floor_project()
        route = floor_nav.route_view(
            project, "floor-0",
            stop(place(project, "floor-0", "甲")),
            stop(place(project, "floor-0", "丙")),
        )
        self.assertTrue(route["ok"])
        self.assertFalse(route["crossFloor"])
        self.assertEqual(len(route["legs"]), 1)
        self.assertEqual(route["transfers"], [])

    def test_no_link_between_floors(self):
        project = two_floor_project("储藏")
        route = floor_nav.route_view(
            project, "floor-0",
            stop(place(project, "floor-0", "甲")),
            stop(place(project, "floor-1", "丙")),
        )
        self.assertEqual(route, {"ok": False, "reason": "no-link"})

    def test_manual_link_joins_differently_named_rooms(self):
        project = two_floor_project("储藏")
        link = floor_nav.add_vertical_link(project, {
            "kind": "stairs",
            "name": "东侧楼梯",
            "stops": [
                {"floorId": "floor-0", "roomId": "room-b"},
                {"floorId": "floor-1", "roomId": "room-b"},
            ],
        })
        self.assertTrue(link["id"].startswith("link-"))
        links = floor_nav.vertical_links(project)
        self.assertEqual([(item["source"], item["name"]) for item in links], [("manual", "东侧楼梯")])
        route = floor_nav.route_view(
            project, "floor-0",
            stop(place(project, "floor-0", "甲")),
            stop(place(project, "floor-1", "丙")),
        )
        self.assertTrue(route["ok"])
        self.assertEqual(route["transfers"][0]["kind"], "stairs")
        accessible = floor_nav.route_view(
            project, "floor-0",
            stop(place(project, "floor-0", "甲")),
            stop(place(project, "floor-1", "丙")),
            accessible=True,
        )
        self.assertEqual(accessible["reason"], "no-link")
        self.assertTrue(floor_nav.remove_vertical_link(project, link["id"]))
        self.assertEqual(floor_nav.vertical_links(project), [])

    def test_manual_link_claims_rooms_from_auto_pairing(self):
        project = two_floor_project()
        floor_nav.add_vertical_link(project, {
            "kind": "elevator",
            "name": "病床梯",
            "stops": [
                {"floorId": "floor-0", "roomId": "room-b"},
                {"floorId": "floor-1", "roomId": "room-b"},
            ],
        })
        links = floor_nav.vertical_links(project)
        self.assertEqual([item["source"] for item in links], ["manual"])

    def test_bad_manual_links_are_rejected(self):
        project = two_floor_project()
        with self.assertRaises(ValueError):
            floor_nav.add_vertical_link(project, {"kind": "slide", "stops": []})
        with self.assertRaises(ValueError):
            floor_nav.add_vertical_link(project, {"stops": [
                {"floorId": "floor-0", "roomId": "room-b"},
                {"floorId": "floor-0", "roomId": "room-a"},
            ]})
        with self.assertRaises(ValueError):
            floor_nav.add_vertical_link(project, {"stops": [{"floorId": "floor-0", "roomId": "room-b"}]})

    def test_via_on_the_upper_floor_extends_the_upper_leg(self):
        project = two_floor_project()
        route = floor_nav.route_view(
            project, "floor-0",
            stop(place(project, "floor-0", "甲")),
            stop(place(project, "floor-1", "丙")),
            [stop(place(project, "floor-1", "病房"))],
        )
        self.assertTrue(route["ok"])
        self.assertEqual([leg["floorId"] for leg in route["legs"]], ["floor-0", "floor-1"])

    def test_nav_view_lists_every_floor(self):
        project = two_floor_project()
        view = floor_nav.nav_view(project, "floor-0")
        self.assertEqual({item["floorId"] for item in view["places"]}, {"floor-0", "floor-1"})
        self.assertEqual(len(view["verticalLinks"]), 1)
        elevator = next(item for item in view["destinations"] if item["name"] == "电梯")
        self.assertEqual(elevator["category"], "elevator")


class VerticalLinkApiTests(unittest.TestCase):
    def setUp(self):
        floor_nav._CACHE.clear()
        self.tmp = tempfile.TemporaryDirectory()
        self.old = server.PROJECTS
        server.PROJECTS = Path(self.tmp.name) / "projects"
        server.PROJECTS.mkdir()

    def tearDown(self):
        server.PROJECTS = self.old
        self.tmp.cleanup()

    def test_links_persist_in_project_json(self):
        from fastapi.testclient import TestClient

        project = two_floor_project("储藏")
        project["id"] = "c" * 32
        folder = server.PROJECTS / project["id"]
        folder.mkdir()
        server._write_project(folder / "project.json", project)
        client = TestClient(server.app)
        base = f"/api/projects/{project['id']}"
        self.assertEqual(client.get(f"{base}/vertical-links.json").json(), {"links": []})
        bad = client.post(f"{base}/vertical-links", json={"stops": []})
        self.assertEqual(bad.status_code, 400)
        added = client.post(f"{base}/vertical-links", json={
            "kind": "elevator",
            "stops": [
                {"floorId": "floor-0", "roomId": "room-b"},
                {"floorId": "floor-1", "roomId": "room-b"},
            ],
        }).json()
        link_id = added["link"]["id"]
        _path, saved = server._read_project(project["id"])
        self.assertEqual(saved["verticalLinks"][0]["id"], link_id)
        start = place(saved, "floor-0", "甲")
        end = place(saved, "floor-1", "丙")
        route = client.post(f"{base}/route", json={
            "floor": "floor-0",
            "from": stop(start),
            "to": stop(end),
            "accessible": True,
        }).json()
        self.assertTrue(route["ok"])
        self.assertEqual(route["transfers"][0]["linkId"], link_id)
        self.assertEqual(client.delete(f"{base}/vertical-links/{link_id}").json(), {"links": []})
        self.assertEqual(client.delete(f"{base}/vertical-links/{link_id}").status_code, 404)

    def test_editor_bind_replaces_one_to_one_and_keeps_multistop_shaft(self):
        project = two_floor_project()
        project["floors"].append(floor_with("floor-2", "3F", 2, {"room-b": "电梯", "room-a": "病房"}))
        project["verticalLinks"] = [{
            "id": "link-elevator-1",
            "kind": "elevator",
            "name": "电梯",
            "source": "pdf-import",
            "stops": [
                {"floorId": "floor-0", "roomId": "room-b", "x": 100, "y": 100},
                {"floorId": "floor-1", "roomId": "room-b", "x": 100, "y": 100},
                {"floorId": "floor-2", "roomId": "room-b", "x": 100, "y": 100},
            ],
        }]
        # Rebind 2F → a different 3F room (room-a).
        result = floor_nav.bind_adjacent_vertical_link(project, {
            "kind": "elevator",
            "from": {"floorId": "floor-1", "roomId": "room-b"},
            "to": {"floorId": "floor-2", "roomId": "room-a"},
        })
        self.assertTrue(result["replaced"])
        stops = {stop["floorId"]: stop for stop in result["link"]["stops"]}
        self.assertEqual(stops["floor-0"]["roomId"], "room-b")
        self.assertEqual(stops["floor-1"]["roomId"], "room-b")
        self.assertEqual(stops["floor-2"]["roomId"], "room-a")
        self.assertEqual(len(project["verticalLinks"]), 1)
        # Cross-floor 1F→3F still one direct ride (no mid-floor flash).
        route = floor_nav.route_view(
            project, "floor-0",
            stop(place(project, "floor-0", "甲")),
            stop(place(project, "floor-2", "丙")),
        )
        self.assertTrue(route["ok"])
        self.assertEqual([leg["floorId"] for leg in route["legs"]], ["floor-0", "floor-2"])
        self.assertEqual(len(route["transfers"]), 1)

    def test_bind_api_endpoint(self):
        from fastapi.testclient import TestClient

        project = two_floor_project("储藏", "储藏")
        project["id"] = "d" * 32
        for room in project["floors"][0]["rooms"]:
            if room["id"] == "room-b":
                room["name"] = "电梯"
        for room in project["floors"][1]["rooms"]:
            if room["id"] == "room-b":
                room["name"] = "电梯"
        client = TestClient(server.app)
        base = f"/api/projects/{project['id']}"
        folder = server.PROJECTS / project["id"]
        folder.mkdir()
        server._write_project(folder / "project.json", project)
        bound = client.post(f"{base}/vertical-links/bind", json={
            "from": {"floorId": "floor-0", "roomId": "room-b"},
            "to": {"floorId": "floor-1", "roomId": "room-b"},
        }).json()
        self.assertIn("link", bound)
        self.assertFalse(bound["replaced"])
        again = client.post(f"{base}/vertical-links/bind", json={
            "from": {"floorId": "floor-0", "roomId": "room-b"},
            "to": {"floorId": "floor-1", "roomId": "room-a"},
        }).json()
        self.assertTrue(again["replaced"])
        stops = {stop["floorId"]: stop for stop in again["link"]["stops"]}
        self.assertEqual(stops["floor-1"]["roomId"], "room-a")


if __name__ == "__main__":
    unittest.main()

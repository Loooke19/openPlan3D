"""限制通行区: suggested from infection-control clusters; routes avoid them unless needed."""
import glob
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import floor_nav as fn  # noqa: E402
import pdf_building as pb  # noqa: E402


class P1ZoneTest(unittest.TestCase):
    def setUp(self):
        hits = sorted(glob.glob(str(ROOT / "data/kujiale-import/projects/*/project.json")))
        self.p1 = None
        for h in hits:
            d = json.loads(Path(h).read_text(encoding="utf-8"))
            names = {r.get("name") for f in d.get("floors") or [] for r in f.get("rooms") or []}
            if {"一脱间", "二脱间", "外科专家门诊"} <= names and any(l.get("source") == "pdf-import" for l in d.get("verticalLinks") or []):
                self.p1 = d
        if not self.p1:
            self.skipTest("P1 import not on this box")

    def test_sw_cluster_suggested_with_south_stair(self):
        zones = pb.suggest_restricted_zones(self.p1["floors"])
        self.assertEqual(len(zones), 1)
        z = zones[0]
        self.assertTrue(z["provisional"])
        self.assertIn("采样室", z["rooms"])
        self.p1["restrictedZones"] = zones
        links = fn.nav_view(self.p1, None)["verticalLinks"]
        self.assertEqual([l["name"] for l in links if l.get("restricted")], ["楼梯"])  # south stair

    def test_main_lobby_to_2f_surgery_uses_north_stair(self):
        self.p1["restrictedZones"] = pb.suggest_restricted_zones(self.p1["floors"])
        places = fn.all_places(self.p1)
        ground = places[0]["floorId"]
        starts = [p for p in places if p["floorId"] == ground and "门厅" in p["name"] and not p.get("restricted")]
        self.assertTrue(starts)
        b = next(p for p in places if p["name"] == "外科专家门诊")
        for a in starts:
            r = fn.route_view(self.p1, ground, {"x": a["x"], "y": a["y"], "floor": ground},
                              {"x": b["x"], "y": b["y"], "floor": b["floorId"]})
            self.assertTrue(r["ok"], r)
            north = [t for t in r["transfers"] if t["from"]["x"] < 0]  # north = drawing-left
            self.assertEqual(len(north), len(r["transfers"]), r["transfers"])

    def test_inside_destination_may_enter(self):
        self.p1 = json.loads((ROOT / "data/kujiale-import/projects/17404623f6034dad83a9f201036b98b4/project.json").read_text(encoding="utf-8"))
        self.p1["restrictedZones"] = pb.suggest_restricted_zones(self.p1["floors"])
        places = fn.all_places(self.p1)
        a = next(p for p in places if "门厅" in p["name"] and not p.get("restricted"))
        b = next(p for p in places if p["name"] == "采样室")
        self.assertTrue(b.get("restricted"))
        r = fn.route_view(self.p1, a["floorId"], {"x": a["x"], "y": a["y"], "floor": a["floorId"]},
                          {"x": b["x"], "y": b["y"], "floor": b["floorId"]})
        self.assertTrue(r["ok"])


class ImportedLinksNoAutoPairTest(unittest.TestCase):
    def test_no_name_only_pairs_when_imported(self):
        # Two rooms named 楼梯 far apart on different floors: imported projects must not pair them.
        floor = lambda fid, lvl: {"id": fid, "level": lvl, "name": f"{lvl+1}F", "walls": [], "rooms": [], "doors": []}
        project = {"floors": [floor("a", 0), floor("b", 1)], "verticalLinks": [
            {"id": "l1", "kind": "stairs", "name": "楼梯", "source": "pdf-import",
             "stops": [{"floorId": "a", "x": 0, "y": 0}, {"floorId": "b", "x": 0, "y": 0}]}]}
        self.assertTrue(all(l.get("source") != "auto" for l in fn.vertical_links(project)))


if __name__ == "__main__":
    unittest.main()


class StopNearZoneTest(unittest.TestCase):
    def test_landing_just_outside_zone_box_is_restricted(self):
        import floor_nav as fn
        z = {"_poly": [(0, 0), (1000, 0), (1000, 1000), (0, 1000)]}
        self.assertTrue(fn.stop_in_zone({"x": 1120, "y": 500}, z))
        self.assertFalse(fn.stop_in_zone({"x": 1600, "y": 500}, z))

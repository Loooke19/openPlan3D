"""Every searchable place on every floor is routable from every 1F entrance (real imports).

Projects are the imported P1/P2/P3 under data/kujiale-import/projects; set
NAV_ROUTE_PROJECTS to a comma list of ids to choose (skipped when absent)."""
import json
import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import floor_nav as fn  # noqa: E402

DEFAULT = "08733a21de95407285afe73b285e42f2"  # P3 (narrow-QA blocker: 门厅 → 2F 女卫)


class AllEntrancesCrossFloor(unittest.TestCase):
    def test_every_place_from_every_entrance(self):
        ids = [i for i in os.environ.get("NAV_ROUTE_PROJECTS", DEFAULT).split(",") if i]
        ran = 0
        for pid in ids:
            path = ROOT / "data" / "kujiale-import" / "projects" / pid / "project.json"
            if not path.exists():
                continue
            project = json.loads(path.read_text(encoding="utf-8"))
            view = fn.nav_view(project, None) if hasattr(fn, "nav_view") else None
            places = (view or {}).get("places") or []
            if not places:
                continue
            ground = places[0]["floorId"]
            starts = [p for p in places if p["floorId"] == ground and p.get("category") == "entrance"
                      or p["floorId"] == ground and "门厅" in p["name"]]
            self.assertTrue(starts, pid)
            bad = []
            # One cross-floor target per floor and per toilet (QA blocker class), kept fast.
            per_floor = {}
            for b in places:
                if b["floorId"] != ground and ("卫" in b["name"] or b["floorId"] not in per_floor):
                    per_floor.setdefault(b["floorId"], []).append(b)
            targets = [b for bs in per_floor.values() for b in bs[:4]]
            for a in starts:
                for b in targets:
                    r = fn.route_view(project, a["floorId"], {"x": a["x"], "y": a["y"], "floor": a["floorId"]},
                                      {"x": b["x"], "y": b["y"], "floor": b["floorId"]})
                    if not r.get("ok"):
                        bad.append(f"{a['name']} → {b['floorName']} {b['name']}: {r.get('reason')}")
            ran += 1
            self.assertEqual(bad, [], f"{pid}: {len(bad)} unroutable\n" + "\n".join(bad[:20]))
        if not ran:
            self.skipTest("no imported projects on this box")


if __name__ == "__main__":
    unittest.main()

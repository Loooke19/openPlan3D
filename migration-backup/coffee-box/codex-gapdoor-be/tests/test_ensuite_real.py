"""P2 2F: ward en-suite toilets (door only into a ward) are children, not searchable."""
import glob
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import floor_nav as fn  # noqa: E402


class P2EnsuiteTest(unittest.TestCase):
    def test_p2_2f_public_toilets(self):
        p2 = None
        for h in sorted(glob.glob(str(ROOT / "data/kujiale-import/projects/*/project.json"))):
            d = json.loads(Path(h).read_text(encoding="utf-8"))
            if len(d.get("floors") or []) == 5 and any(
                    r.get("name") == "心理行为与智力测查室" for f in d["floors"] for r in f.get("rooms") or []):
                p2 = d
                break
        if not p2:
            self.skipTest("P2 import not on this box")
        places = [p for p in fn.all_places(p2) if p["floorName"] == "2F" and p["name"] in ("卫", "卫生间")
                  and not p.get("ensuite")]
        self.assertEqual((len([p for p in places if p["x"] > 0]), len([p for p in places if p["x"] < 0])), (2, 1), places)


if __name__ == "__main__":
    unittest.main()

"""One-click gate for an import (+ overrides).  Exit 0 only when every check passes.

    python scripts/verify_import.py <new import dir> <HEAD import dir> [--truth data/overrides/pdf_truth.json]

Each dir holds P1.json / P2.json / P3.json as written by import_building.  Checks:
  1. per floor: indoor stairs / elevators >= PDF truth, linked stops >= PDF, stairs/elevators >= HEAD
  2. vertical links: every PDF link exists with all its floors; link count/stops >= HEAD
  3. independent named rooms (or explicitly standalone unnamed rooms) >= HEAD,
     applying the same attachment/type corrections to HEAD; fragment faces do not count
  4. every pair of stair/elevator stops on different floors routes (cross-floor all-pairs)
  5. 3x10 seeded route sample: 30/30, no diagonal / wall-crossing segment
"""
from __future__ import annotations

import argparse
import json
import math
import random
import re
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import floor_nav as fn  # noqa: E402
from pdf_building import _room_faces, _CIRCULATION_RE  # noqa: E402


def area(p):
    return abs(sum(p[i][0] * p[i - 1][1] - p[i - 1][0] * p[i][1] for i in range(len(p)))) / 2


def real_rooms(floor, semantics=None):
    faces = _room_faces(floor)
    semantics = {r["id"]: r for r in (semantics or floor).get("rooms") or []}
    count = 0
    for room in floor.get("rooms") or []:
        corrected = semantics.get(room["id"], room)
        name = room.get("displayName") or room.get("name") or ""
        if room["id"] not in faces or area(faces[room["id"]]) < 1.5e4:
            continue
        if corrected.get("floorOpening") or corrected.get("attachedTo") or corrected.get("roomType") in ("void", "corridor", "shaft"):
            continue
        if _CIRCULATION_RE.search(name) or not (corrected.get("standalone") or fn.is_destination(name)):
            continue
        count += 1
    return count


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("new")
    ap.add_argument("head")
    ap.add_argument("--truth", default=str(Path(__file__).resolve().parent.parent / "data/overrides/pdf_truth.json"))
    ap.add_argument("--buildings", default="P1,P2,P3")
    ap.add_argument("--no-pairs", action="store_true", help="skip the all-pairs cross-floor check (quick loop)")
    a = ap.parse_args()
    truth = json.loads(Path(a.truth).read_text(encoding="utf-8"))
    fails, table, pair_rows = [], [], []
    sample = {"ok": 0, "n": 0, "diag": 0, "hits": 0, "ms": []}
    for b in a.buildings.split(","):
        new = json.loads((Path(a.new) / f"{b}.json").read_text(encoding="utf-8"))
        head = json.loads((Path(a.head) / f"{b}.json").read_text(encoding="utf-8"))
        project = new["project"]
        fname = {f["id"]: f["name"] for f in project["floors"]}
        hfloors = {f["name"]: f for f in head["project"]["floors"]}
        hrep = {r["name"]: r for r in head["floors"]}
        links = project.get("verticalLinks") or []
        for rep, floor in zip(sorted(new["floors"], key=lambda r: r["level"]), sorted(project["floors"], key=lambda f: f["level"])):
            n = floor["name"]
            t = truth[b]["floors"].get(n, {})
            linked = {k: sum(1 for l in links if l["kind"] == k and len(l["stops"]) >= 2
                             for s in l["stops"] if s["floorId"] == floor["id"]) for k in ("stairs", "elevator")}
            rooms_new, rooms_head = real_rooms(floor), real_rooms(hfloors[n], floor) if n in hfloors else 0
            row = {"b": b, "f": n, "pdf_st": t.get("stairs", 0), "pdf_el": t.get("elevator", 0),
                   "mdl_st": rep["stairs"], "mdl_el": rep["elevators"], "lnk_st": linked["stairs"], "lnk_el": linked["elevator"],
                   "head_st": hrep.get(n, {}).get("stairs", 0), "head_el": hrep.get(n, {}).get("elevators", 0),
                   "rooms": rooms_new, "rooms_head": rooms_head}
            table.append(row)
            for k, pk, mk, hk in (("stairs", "pdf_st", "lnk_st", "head_st"), ("elevator", "pdf_el", "lnk_el", "head_el")):
                if row[mk] < row[pk]:
                    fails.append(f"{b} {n} 跨层连通的{k} {row[mk]} < PDF {row[pk]}")
            if rep["stairs"] < row["head_st"] or rep["elevators"] < row["head_el"]:
                fails.append(f"{b} {n} 楼梯/电梯数少于 HEAD")
            if rooms_new < rooms_head:
                fails.append(f"{b} {n} 房间 {rooms_new} < HEAD {rooms_head}")
        have = [(l["kind"], sorted(fname[s["floorId"]] for s in l["stops"])) for l in links]
        for kind, fls in truth[b]["links"]:
            hit = next((h for h in have if h[0] == kind and set(fls) <= set(h[1])), None)
            if hit:
                have.remove(hit)
            else:
                fails.append(f"{b} 缺跨层连接 {kind} {fls}")
        hl = head["project"].get("verticalLinks") or []
        if len([l for l in links if len(l["stops"]) >= 2]) < len(hl) or sum(len(l["stops"]) for l in links) < sum(len(l["stops"]) for l in hl):
            fails.append(f"{b} 跨层连接/站数少于 HEAD")
        # 4. all pairs of vertical stops on different floors
        stops = [(l["name"], s) for l in links for s in l["stops"]]
        ok = n_pairs = 0
        for i, (na, sa) in enumerate(stops if not a.no_pairs else []):
            for nb, sb in stops[i + 1:]:
                if sa["floorId"] == sb["floorId"]:
                    continue
                n_pairs += 1
                r = fn.route_view(project, sa["floorId"], {"x": sa["x"], "y": sa["y"], "floor": sa["floorId"]},
                                  {"x": sb["x"], "y": sb["y"], "floor": sb["floorId"]})
                if r.get("ok"):
                    ok += 1
                else:
                    fails.append(f"{b} 跨层 {fname[sa['floorId']]}{na} -> {fname[sb['floorId']]}{nb} {r.get('reason')}")
        pair_rows.append((b, ok, n_pairs))
        # 5. seeded sample (same seed as the earlier bench)
        places = [p for p in fn.all_places(project) if fn.is_destination(p.get("name")) and not p.get("restricted")]
        rnd = random.Random(7 + ord(b[1]))
        floors = {f["id"]: f for f in project["floors"]}
        for _ in range(10):
            pa, pc = rnd.sample(places, 2)
            t0 = time.perf_counter()
            r = fn.route_view(project, pa["floorId"], {"x": pa["x"], "y": pa["y"], "floor": pa["floorId"]},
                              {"x": pc["x"], "y": pc["y"], "floor": pc["floorId"]})
            sample["ms"].append((time.perf_counter() - t0) * 1000)
            sample["n"] += 1
            if not r.get("ok"):
                fails.append(f"{b} 抽样 {pa.get('floorName')}{pa.get('name')} -> {pc.get('floorName')}{pc.get('name')} {r.get('reason')}")
                continue
            sample["ok"] += 1
            for leg in r.get("legs") or []:
                f = floors[leg["floorId"]]
                W, O = fn._walls(f), fn._openings(f)
                pts = [(p["x"], p["y"]) for p in leg["polyline"]]
                for p, q in zip(pts, pts[1:]):
                    if math.dist(p, q) > 30 and min(abs(p[0] - q[0]), abs(p[1] - q[1])) > 5:
                        sample["diag"] += 1
                        print("  斜段", b, f["name"], pa.get("name"), "->", pc.get("name"), [round(v) for v in (*p, *q)])
                    if fn._segment_hits_wall(p, q, W, O):
                        sample["hits"] += 1
                        print("  碰墙", b, f["name"], pa.get("name"), "->", pc.get("name"), [round(v) for v in (*p, *q)])
    if sample["diag"] or sample["hits"]:
        fails.append(f"抽样斜段 {sample['diag']} 碰墙 {sample['hits']}")
    print("楼栋 楼层 | PDF楼梯/电梯 | 模型楼梯/电梯(识别+补画) | 跨层连通楼梯/电梯 | HEAD楼梯/电梯 | 独立房间(≥1.5㎡，排除附属/碎面) 新/HEAD")
    for r in table:
        print(f"{r['b']} {r['f']} | {r['pdf_st']}/{r['pdf_el']} | {r['mdl_st']}/{r['mdl_el']} | {r['lnk_st']}/{r['lnk_el']} | {r['head_st']}/{r['head_el']} | {r['rooms']}/{r['rooms_head']}")
    for b, ok, n in pair_rows:
        print(f"{b} 楼梯电梯两两跨层 {ok}/{n}")
    ms = sample["ms"]
    print(f"抽样 {sample['ok']}/{sample['n']} 斜段 {sample['diag']} 碰墙 {sample['hits']} 耗时中位 {statistics.median(ms):.0f}ms 最大 {max(ms):.0f}ms")
    for f in fails:
        print("FAIL", f)
    print("PASS" if not fails else f"NOT PASS ({len(fails)})")
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())

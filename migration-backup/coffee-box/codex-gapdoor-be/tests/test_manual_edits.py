"""Manual wall/door edits and the name sync survive a re-import (name_overrides.record_edits/apply_edits)."""
import copy
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import name_overrides as no  # noqa: E402


def W(i, x0, y0, x1, y1, **kw):
    return {"id": i, "start": {"x": x0, "y": y0}, "end": {"x": x1, "y": y1}, "thickness": 12, **kw}


def fresh():
    return {"sourceSha": "abc", "floors": [{"id": "f1", "level": 0,
        "walls": [W("wall-1", 0, 0, 400, 0), W("wall-2", 400, 0, 400, 300), W("wall-3", 400, 300, 0, 300),
                  W("wall-4", 0, 300, 0, 0)],
        "doors": [{"id": "door-1", "wallId": "wall-1", "position": 0.25, "width": 90, "type": "single"},
                  {"id": "door-2", "wallId": "wall-3", "position": 0.5, "width": 90, "type": "single"}],
        "rooms": [{"id": "room-1", "name": "残卫", "walls": ["wall-1", "wall-2", "wall-3", "wall-4"]}]}]}


def edited():
    p = fresh()
    f = p["floors"][0]
    f["walls"].append(W("r9-x", 0, 150, 400, 150, drawn=True))
    f["doors"] = [d for d in f["doors"] if d["id"] != "door-1"]
    f["removedDoors"] = [{"x": 100.0, "y": 0.0}]
    f["doors"].append({"id": "r9-door", "wallId": "r9-x", "position": 0.5, "width": 97, "type": "single", "drawn": True})
    f["doors"].append({"id": "r9-open", "wallId": "wall-2", "position": 0.25, "width": 144, "type": "opening", "drawn": True})
    r = f["rooms"][0]
    r.update(name="无障碍卫生间", displayName="无障碍卫生间", aliases=["残卫"], walls=["r9-x", "wall-2", "wall-3", "wall-4"])
    return p


def test_edits_replay_on_fresh_import(tmp_path):
    src = edited()
    assert no.record(tmp_path, src) == 1
    assert no.record_edits(tmp_path, src) == 5
    p = fresh()
    no.apply_edits(tmp_path, p)
    no.apply(tmp_path, p)
    f = p["floors"][0]
    assert any(w["id"] == "r9-x" for w in f["walls"])
    ids = {d["id"] for d in f["doors"]}
    assert "door-1" not in ids and "door-2" in ids
    door = next(d for d in f["doors"] if d["id"] == "r9-door")
    assert door["wallId"] == "r9-x" and abs(door["position"] - 0.5) < 1e-3
    op = next(d for d in f["doors"] if d["id"] == "r9-open")
    assert op["wallId"] == "wall-2" and op["type"] == "opening"
    r = f["rooms"][0]
    assert r["walls"] == ["r9-x", "wall-2", "wall-3", "wall-4"]
    assert r["name"] == "无障碍卫生间" and r["displayName"] == "无障碍卫生间" and "残卫" in r["aliases"]
    # idempotent: a second apply changes nothing
    snap = copy.deepcopy(p)
    no.apply_edits(tmp_path, p)
    assert p == snap


def test_door_reattaches_when_wall_ids_change(tmp_path):
    src = edited()
    no.record_edits(tmp_path, src)
    p = fresh()
    for w in p["floors"][0]["walls"]:
        w["id"] = "n" + w["id"]
    for d in p["floors"][0]["doors"]:
        d["wallId"] = "n" + d["wallId"]
    no.apply_edits(tmp_path, p)
    op = next(d for d in p["floors"][0]["doors"] if d["id"] == "r9-open")
    assert op["wallId"] == "nwall-2"
    assert "door-1" not in {d["id"] for d in p["floors"][0]["doors"]}


def test_removed_wall_stays_removed(tmp_path):
    src = fresh()
    f = src["floors"][0]
    f["walls"].append(W("wall-9", 0, 100, 400, 100))
    p = copy.deepcopy(src)
    f["walls"] = [w for w in f["walls"] if w["id"] != "wall-9"]
    f["removedWalls"] = [{"start": {"x": 0, "y": 100}, "end": {"x": 400, "y": 100}}]
    no.record_edits(tmp_path, src)
    p["floors"][0]["rooms"][0]["walls"].append("wall-9")
    no.apply_edits(tmp_path, p)
    assert "wall-9" not in {w["id"] for w in p["floors"][0]["walls"]}
    assert "wall-9" not in p["floors"][0]["rooms"][0]["walls"]


def test_cleared_name_stays_cleared(tmp_path):
    src = fresh()
    r = src["floors"][0]["rooms"][0]
    r.update(name="", attachedTo="打包")
    no.record(tmp_path, src)
    p = fresh()
    no.apply(tmp_path, p)
    assert p["floors"][0]["rooms"][0]["name"] == "" and p["floors"][0]["rooms"][0]["attachedTo"] == "打包"


def test_equal_neighbour_keeps_its_own_name(tmp_path):
    src = fresh()
    f = src["floors"][0]
    f["rooms"].append({"id": "room-2", "name": "无菌包室", "walls": ["wall-1", "wall-2", "wall-3", "wall-4"],
                       "polygon": [{"x": 100, "y": 0}, {"x": 500, "y": 0}, {"x": 500, "y": 300}, {"x": 100, "y": 300}]})
    f["rooms"][0].update(name="洗手1", displayName="洗手1", nameSource="manual")
    no.record(tmp_path, src)
    p = copy.deepcopy(src)
    p["floors"][0]["rooms"][0].update(name="洗手", displayName=None)
    p["floors"][0]["rooms"][0].pop("displayName")
    no.apply(tmp_path, p)
    assert p["floors"][0]["rooms"][1]["name"] == "无菌包室" and not p["floors"][0]["rooms"][1].get("displayName")


def test_corrected_ocr_note_persists(tmp_path):
    src = fresh()
    src["floors"][0]["textAnnotations"] = [{"id": "poi-1", "x": 10, "y": 10, "text": "柜子", "poi": False, "manual": True}]
    no.record_edits(tmp_path, src)
    p = fresh()
    p["floors"][0]["textAnnotations"] = [{"id": "poi-9", "x": 14, "y": 8, "text": "相子", "poi": True}]
    no.apply_edits(tmp_path, p)
    assert p["floors"][0]["textAnnotations"][0]["text"] == "柜子" and not p["floors"][0]["textAnnotations"][0]["poi"]

import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "scripts"))
from maker_ocr import room_name_for_plan

def test_glued_area_box_and_symbol_letters_are_stripped():
    assert room_name_for_plan("病房21.994m") == "病房"
    assert room_name_for_plan("护士办公室☐") == "护士办公室"
    assert room_name_for_plan("o卫") == "卫"
    assert room_name_for_plan("诊室(一") == "诊室（一）"

def test_real_names_untouched():
    for n in ("内科诊室1", "挂号室、药房", "诊室（二）", "PT", "留观室2", "B超一室"):
        assert room_name_for_plan(n) == n

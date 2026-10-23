#!/usr/bin/env python3
"""Build the offline Noto Sans SC variable-font subset for this demo.

Upstream: https://github.com/google/fonts/tree/main/ofl/notosanssc
Font: https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf
License: https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/OFL.txt
Downloaded source SHA-256: a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da
Run: python3 scripts/subset_font.py /path/to/NotoSansSC-wght.ttf
Requires fontTools and Brotli only for rebuilding; browsers load the output locally.
The subset retains the original SC outlines, license metadata and wght 100–900 axis.
"""

from argparse import ArgumentParser
from pathlib import Path
import hashlib
import json

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[1]
UI_TEXT = (
    "岐阜大学医学部附属医院室内导览当前楼层门诊楼二维平面三维地图开始模拟行走"
    "暂停继续停止回到全图出入口卫生间楼梯电梯自助服务扶梯全部地点搜索科室或设施"
    "起点终点当前位置从这里出发到这里去选择目的地导航路线暂无结果清除高级工具"
    "星期一二三四五六日年月未标定按图纸比例演示路线米图纸单位已到达目的地放大缩小"
    "返回地图正在生成电子地图"
    "，。！？：；、（）【】《》“”‘’·…—–－＋×÷°％／→←↑↓↔↕↖↗↘↙"
)


def text_values(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value:
            yield from text_values(item)
    elif isinstance(value, dict):
        for item in value.values():
            yield from text_values(item)


def requested_codepoints():
    text = UI_TEXT
    for filename in ["data/map.json", "data/gifu-1f-poi-annotations.json"]:
        path = ROOT / filename
        if path.exists():
            text += "".join(text_values(json.loads(path.read_text(encoding="utf-8"))))
    for path in sorted((ROOT / "preview").rglob("*")):
        if path.is_file() and path.suffix in {".html", ".js", ".css", ".json"}:
            text += path.read_text(encoding="utf-8")
    return {ord(char) for char in text if ord(char) >= 32} | set(range(32, 127))


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Official NotoSansSC[wght].ttf")
    args = parser.parse_args()
    requested = requested_codepoints()
    font = TTFont(args.source, recalcTimestamp=False)
    cmap = font.getBestCmap()
    missing = requested - set(cmap)
    missing_cjk = sorted(codepoint for codepoint in missing if 0x3400 <= codepoint <= 0x9FFF)
    if missing_cjk:
        raise ValueError("Source font lacks required Chinese characters: " + "".join(map(chr, missing_cjk)))
    options = subset.Options()
    options.flavor = "woff2"
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.name_legacy = True
    options.name_languages = ["*"]
    options.notdef_glyph = True
    options.notdef_outline = True
    builder = subset.Subsetter(options=options)
    builder.populate(unicodes=sorted(requested & set(cmap)))
    builder.subset(font)
    destination = ROOT / "assets/fonts/noto-sans-sc-demo.woff2"
    destination.parent.mkdir(parents=True, exist_ok=True)
    font.flavor = "woff2"
    font.save(destination)
    output = TTFont(destination)
    assert requested - set(output.getBestCmap()) == missing
    axes = {axis.axisTag: [axis.minValue, axis.maxValue] for axis in output["fvar"].axes}
    assert axes["wght"] == [100, 900]
    print(json.dumps({
        "output": str(destination.relative_to(ROOT)),
        "bytes": destination.stat().st_size,
        "supportedCodepoints": len(output.getBestCmap()),
        "unsupportedOptionalSymbols": [f"U+{codepoint:04X}" for codepoint in sorted(missing)],
        "variationAxes": axes,
        "sourceSha256": hashlib.sha256(args.source.read_bytes()).hexdigest(),
        "sha256": hashlib.sha256(destination.read_bytes()).hexdigest(),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

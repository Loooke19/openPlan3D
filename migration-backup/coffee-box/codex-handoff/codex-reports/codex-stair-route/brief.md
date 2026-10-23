# 任务C：修 verticalLinks 停靠点 + 房间54堵点   （目录 T=/workspace/codex-stair-route，后端端口 8913，需要截图时前端端口 5313，截图前缀 C-）
先读 /workspace/codex-stair-common.md。只改后端（be/），不改前端。
1. 现状（来自快照，先在 project.json 核实）：link-stairs-1 在 floor-1(2F) 的停靠点 (376,-118)、link-stairs-2 floor-1 (536,-238)，与 1F/3F 坐标（约 (1984,1188)/(2045,989) 和 (-1312,145)/(-1215,289)）差异很大；而 be/data/overrides/P1-2F.json 的 vertical_tag 写的是 (2054,1322)/(-1211,-50)。查清 2F 停靠点为什么落错（tag 没匹配上？识别出的楼梯位置？坐标系/原点没对齐？），按根因修，停靠点必须落在对应楼梯房间内并带 roomId。3F 南楼梯停靠点缺 roomId（3F 只识别出一个楼梯房间），查原因修好。修法要通用（规则/参数），并写进 overrides 使重新识别不丢，同步 project.json。
2. 2F 房间54（door-33）到不了任何楼梯：找出精确堵点（哪面墙/哪个门/网格断开处）并修，修在 overrides 或通用规则里。
3. 验证：verify_import 通过；路线 1F 挂号→3F 体检窗口、2F 房间54→3F 任一房间（如房间65）都通，报距离和分段；后端寻路接口见 scripts/floor_nav.py / kujiale_import_server.py。

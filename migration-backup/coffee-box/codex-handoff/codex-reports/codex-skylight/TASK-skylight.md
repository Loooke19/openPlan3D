# 任务：P1 3F 采光顶区域误铺地砖/误判可走（通用规则修复）
规则：严格遵守 /workspace/codex-luke-rules.md。只在 /workspace/codex-skylight 工作；不推送；不改 kit-wt / merge-wt。端口用 dev 5351、playwright 4221。
## Bug
- be/data/overrides/P1-3F.json 有 walls_remove_box {x0:400,y0:-1860,x1:1190,y1:-1270}（BYC1212 采光顶/排烟窗，非房间）。
- be/scripts/openplan_project.py ~L1656 把 PDF 边界直接写成 floor.footprint，未扣除该区域。
- kitDressing.ts ~L430 buildFloor(footprint) 整块铺地砖；floor_nav.py ~L760 把它当可走。
- 跨边界残留短墙 wall-303 / wall-309。
## 修复（通用规则，禁止针对单个房间/楼层写死）
1. 标记为非房间的 walls_remove_box 区域：从 footprint/地砖与可走区域中扣除（支持多 box、任意楼层）。
2. walls_remove_box 后跨边界残留的短墙（stub）按通用阈值删除。
## 测试（最简）
guard /workspace/codex-stair-guard.sh 必须 PASS；相关专项测试；verify_import；P1 3F 俯视前后截图（低画质）。
## 导出
/workspace/merge-3/：fe.patch、be.patch（相对 kit-wt 5f77cdca，累计包含 merge-2 内容），README.md（改动+测试结果+截图说明），shots/。另写 /workspace/codex-skylight/report.md。不推送。

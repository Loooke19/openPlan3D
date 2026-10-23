# 任务C（简化版，Luke 10/14 12:21 解除暂缓）
工作目录 /workspace/codex-taskc（基于 codex-skylight，已含 merge-3 全部改动）。先读 /workspace/codex-luke-rules.md 并严格遵守；参考 /workspace/codex-stair-route/brief.md（旧端口作废）。
端口：dev 5361，后端 8961，playwright 4231（改 playwright.config.ts 等）。不推送，不改 kit-wt / merge-wt。每步跑 /workspace/codex-stair-guard.sh 必须 PASS。只用 overrides 或通用规则，不按房间写代码分支。

1. 2F 房间54（door-33）到不了楼梯：不必找根因，直接在 be/data/overrides/P1-2F.json 加一扇门，让房间54能通到走廊/楼梯。
2. 2F 楼梯停靠点：link-stairs-1、link-stairs-2 在 floor-1 的停靠点改到各自楼梯间内并带 roomId；3F 南楼梯停靠点补 roomId。通过 overrides 或通用规则实现。
3. 最简测试：guard；verify_import；路线 1F 挂号→3F 体检窗口、2F 房间54→3F 房间65 都能通，报距离和分段；一张 P1 2F 截图展示穿过新门的路线（低画质，存 shots/）。
4. 导出累计补丁到 /workspace/merge-4/：fe.patch、be.patch（相对 kit-wt 5f77cdca，含 merge-3 全部内容），README.md（改动、验证、距离；并注明“任务C曾按 Luke 10/13 20:05 电话暂缓，10/14 12:21 解除并简化”），shots/。确认补丁可在干净 kit-wt 上 apply。
5. 写 /workspace/codex-taskc/report.md。

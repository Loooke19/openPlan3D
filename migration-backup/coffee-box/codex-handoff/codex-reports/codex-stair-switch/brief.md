# 任务B：老游戏式切层   （目录 T=/workspace/codex-stair-switch，前端端口 5312，后端端口 8912，截图前缀 B-）
先读 /workspace/codex-stair-common.md。
目标：导航路线模拟/第一人称行走时，走到楼梯（verticalLinks 的 stairs 停靠点/楼梯房间）上走两三级台阶后快速淡出（约 0.3s），直接加载下一层，从该层对应 verticalLinks 停靠点继续路线；下楼同理；电梯可沿用同一机制。替换现有 ThreeViewer.svelte 的 playStairClimb 连续爬升（不要两套并存），相关调用在 fe/src/routes/nav/+page.svelte、nav/route.ts。楼梯对象几何本身由另一个任务做，你这边若当前楼层没有 floor.stairs，就以停靠点为起点沿路线方向前进两三步再切层即可，不要依赖具体台阶几何。
验证：1F 挂号 → 3F 体检窗口 路线模拟一次跑通（含两次或一次切层，以路线为准），给出每次切层的楼层、停靠点坐标、耗时；切层前后截图 B-switch-before-*.png / B-switch-after-*.png。
\n补充：任务C暂缓，停靠点不修，按现有 verticalLinks 停靠点做；停靠点不准时可用 mock 停靠点验证机制，在 report 注明。

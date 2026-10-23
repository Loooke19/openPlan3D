# 给协调员的测试清单（只测已完成部分）
**规则：只测试，不改代码。发现问题时记下现象、复现步骤和截图路径，交回 coffeeeeeee/蓝鲸，由 Codex 修复。** 前端只用 kit-wt 或基于 kit-wt 的副本，不要用 /workspace/fe-shot。

1. **2F 后端**（handoff/2F-fix.patch 或 /workspace/codex-p1-fix-2F/repo）：运行 `verify_import.py f10 /workspace/pdf-compare/base`。通过标准：24 个命名房间都可达，区域重叠为 0，只允许出现任务 C 的 2F→3F 那 1 条失败。在导航里搜索 男卫/女卫/儿科/办公室，能找到；搜「房间」，不出现占位名。
2. **3F 后端**（/workspace/codex-p1-fix-3F/repo）：运行同一条 verify。通过标准：exit 0，跨层 125/125，抽样 30/30。挑空 room-2 不能走；细菌室和生化室是两间独立的房间。
3. **A 楼梯对象**（/workspace/codex-stair-obj/fe + be）：运行 guard 脚本（绝对路径），打开 nav 正常画质、kit 开启，逐层查看楼梯。通过标准：guard PASS；2F 有 2 个楼梯，3F 有 1 个，1F 东侧有 1 个（1F 西侧缺失是已知问题，只记录）；颜色为浅灰，侧面更深，有深灰防滑条，不发白、不浮空；楼梯高度与层高一致；顶部没有黑条，地面是 kit 材质。
4. **B 切层**（/workspace/codex-stair-switch/fe）：运行 guard，然后运行 `npx playwright test tests/browser/nav-floor-transfer.spec.ts`，再手动走一遍 1F 挂号 → 3F 体检窗口（模拟和第一人称各一次），以及反向。通过标准：guard PASS，测试 4/4；三步后屏幕全黑，加载完淡入，到达终点；中途点「结束」不会继续播放。另外记下每次切层的耗时，以及 kit=1 时的表现。

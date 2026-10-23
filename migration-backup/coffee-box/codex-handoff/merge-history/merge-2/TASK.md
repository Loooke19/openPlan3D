# merge-2 任务（工作目录 /workspace/codex-merge-2，已基于 kit-wt 5f77cdca + merge-1015 fe/be.patch）
规则：遵守 /workspace/codex-luke-rules.md；不改 kit-wt / merge-wt；不 push；端口用 dev 5341 / playwright 4211；通用规则不做逐房间改动；保留 ThreeViewer 的 holeCuts/holeKeeper kit 代码。
1. 合入：/workspace/codex-ab-on-kit 的第4轮（去楼梯牌 isStairSign）和第5轮（天花板/灯）改动（见其 report.md，与 kit-wt 5f77cdca 及 merge-1015 对比取差异）；/workspace/codex-doorframe-run 的门框修复；/workspace/codex-cutlayer-run 的切层提速。B-1 踏面未完成，不要合入。
2. doorframe/cutlayer 副本带有第5轮中途的改动，以 codex-ab-on-kit 第5轮最终版本为准对齐。
3. 验证（从简）：/workspace/codex-stair-guard.sh 必须 PASS；相关专项测试；build。
4. 截图（前=merge-1015 状态，后=本次）：楼梯牌、第一人称天花板、门框（P1）。测低画质切层耗时（上/下楼、第一人称）和电梯换层耗时。
5. 导出到 /workspace/merge-2/：fe.patch、be.patch（基准 kit-wt 5f77cdca，含 merge-1015 内容，验证可在干净 kit-wt 上 git apply）、README.md（内容/结果/耗时/未完成项）、logs、shots/。

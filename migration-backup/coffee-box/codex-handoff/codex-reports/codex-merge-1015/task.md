# 合并任务 merge-1015（只读其他目录，只写本副本和 /workspace/merge-1015/）
规则：/workspace/codex-luke-rules.md。不改 kit-wt/merge-wt，不推送，不碰 codex-ab-on-kit / codex-integ-fix / doorframe / cutlayer 等正在跑的副本（只读）。端口用 dev 5331、playwright 4201。
1. 前端：从 /workspace/codex-ab-on-kit 提取第3轮及之前已完成内容（A+B合并、A-1、A-2、B-2、E-1）。不要第4轮楼梯标牌去除(isStairSign)、不要第5轮天花板/灯、不要 B-1 踏步。用 git diff/status、report.md、run 日志来区分；改动大多未提交，必要时按文件/hunk 挑。应用到本副本。
2. 后端：/workspace/codex-integ-fix 第2轮 + F-1 已完成部分（未提交改动在 be/ 与 data/ 等），排除 .playwright-mcp 等垃圾文件。
3. 跑 /workspace/codex-stair-guard.sh + 相关定向测试（最少）。不做截图。
4. 导出 /workspace/merge-1015/fe.patch、be.patch（相对 kit-wt HEAD），README.md：每个补丁一句说明 + guard/测试结果 + 注意事项（排除了什么、冲突）。

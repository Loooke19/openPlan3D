# 门框修复（独立并行任务）
工作目录只限 /workspace/codex-doorframe-run。规则见 /workspace/codex-luke-rules.md（不 push、不碰 kit-wt/merge-wt、只用通用规则、保留 ThreeViewer 里 holeCuts/holeKeeper 那约 120 行 kit 代码）。
dev server 用端口 5321，playwright 用 4191（别用 5315/4188，另一个任务和第五轮在用）。
## A 部分：门框修复（先做）
根因分析在 /workspace/codex-doorframe/report.md，方案也照它的建议：生成前先做几何规范化。
- 共线重叠的墙合并成一堵。
- 门洞要把所有和它相交的墙都切开，接缝圆柱也要切开，踢脚线也要切开。
- 过梁不要再嵌进墙里。
- 门洞检查改成按体积相交扫描，不能只看三角形的中心点。
- 每一步都只用通用规则，不要逐个房间去改。
验证从简：
- 跑 /workspace/codex-stair-guard.sh，要通过。
- 跑门洞相关的专项测试。
- 拍 P1 一扇门修改前后各一张截图，存到 shots/。
结果追加到 report.md，标题写「第六轮 A 门框」。
结果写到本目录 report.md，标题「门框修复」。

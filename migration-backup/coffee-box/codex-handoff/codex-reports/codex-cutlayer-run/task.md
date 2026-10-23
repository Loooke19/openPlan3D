# 切层提速（独立并行任务）
工作目录只限 /workspace/codex-cutlayer-run。规则见 /workspace/codex-luke-rules.md（不 push、不碰 kit-wt/merge-wt、只用通用规则、保留 ThreeViewer 里 holeCuts/holeKeeper 那约 120 行 kit 代码）。
dev server 用端口 5322，playwright 用 4192（别用 5315/4188/5321/4191）。
需求见本目录 round6-b3.md（只做这个，不做门框）。验证从简：跑 /workspace/codex-stair-guard.sh 要通过、跑切层相关专项测试、P1 切层前后各一张截图存 shots/。
结果写到本目录 report.md，标题「切层提速」。

# 03:20 交接 → 浓缩蓝鲸 → Codex（coffeeeeeee 例行任务）

时间：2026-10-14 约 03:36 Asia/Shanghai  
来源：助手 routine「03:20 交接给 Codex」  
给 Luke：不要打扰（他在睡觉）。早上汇报时写上下列结果与完成时间预估。

## 状态
- 协调员 bc-8097b1e1（3D Navi Project）已叫停并取消 watch；其 2F v2 测试已完成，结果此前已转给你。
- 助手与协调员停手；未完成项全部由你转派 Codex（gpt-6.1-sol，推理 high）。

## 规矩（照旧）
- 只在基于 `/workspace/kit-wt` 的副本上做。
- 每一步跑 `/workspace/codex-stair-guard.sh`（绝对路径），guard PASS。
- 截图只能从 kit-wt 拍，不准用 fe-shot 或主仓库旧副本。
- 每步/合并前核对：kitDressing、navDoors、layout、openingAudit、dressing、app.css、ThreeViewer、15 个 GLB 没被改回去。
- 不推送；做完交回你。Codex 出问题先告诉 Luke，不要自行扩大范围。

## 新未完成项：第一人称截图 + 外墙材质（半成品）
半成品目录：`/workspace/navi-progress-1014/fpshot/`（含拍图脚本 shot*.mjs、mats.json 运行时材质、poses、中间截图与 run*.log）。  
另有已保存但仍需按验收重做/核对的：`/workspace/navi-progress-1014/fp-corridor.png`、`fp-exterior-a.png`、`fp-exterior-b.png`。

请转 Codex：
1. 从 kit-wt 拍 P1 1F 第一人称视角：**走廊图 1 张** + **靠外墙的图 1 张**。
2. 核对外墙和内墙是否都用素材包墙体原材质（纯色哑光、灰白偏亮、深灰踢脚线）；不一致则修成一致。
3. 修完跑 guard，再拍前后对比图。

## 一并转派：`/workspace/navi-progress-1014/codex-todo.md`
仍有效项：A-1、A-2、B-1、B-2、B-3（可选）、E-1、F-1（若你方合并可跳过）。  
不派：C、门框修复、3F room-59 改名（等 A-1）。

## 请你做的
1. 立刻按上列转派 Codex。
2. 早上向 Luke 的汇报里写上这些项的结果与完成时间预估。

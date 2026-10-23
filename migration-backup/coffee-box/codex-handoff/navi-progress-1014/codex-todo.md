# 给 Codex 的补充清单（经蓝鲸转交）
通用要求：fe 副本一律从 /workspace/kit-wt 最新状态复制。每步完成后执行 `/workspace/codex-stair-guard.sh /workspace/<副本>/fe <允许的文件>`，**必须用绝对路径**，结果写进 guard.log 并保持 PASS。不推送。做完交回蓝鲸。

1. **A-1 补 1F 西楼梯对象**：目标是为 1F 西楼梯（停靠点约 (-1312,145)，link-stairs-2）生成楼梯对象，使总数达到 5（1F 2 / 2F 2 / 3F 1）。用通用规则处理，例如没有闭合楼梯房间时按 verticalLinks 停靠点所在的区域生成，不能硬编码坐标。验收：重算命令输出 {"1F":2,"2F":2,"3F":1}；补一张截图；overrides 中除 stairs 外一字不改；guard PASS。
2. **A-2 pipeline.ts 改动收窄**：A 在全局关掉了 shadowMap 和 SSAO。要么只对楼梯禁用实时效果，要么拿出前后对比截图，证明其他区域的画面没有变化。验收：kit 开启、正常画质下，楼梯外区域的取样 RGB 与 kit-wt 相差 ≤2%；guard PASS。
3. **B-1 带 kit 和楼梯对象回归**：在合入了 A 楼梯对象的数据上，用 `kit=1`、正常画质重跑 nav-floor-transfer.spec.ts。验收：4/4 通过；截图里三步走在楼梯踏面上，不穿模；guard PASS。
4. **B-2 楼梯方位标签**：link-stairs-2 被标成「楼梯（东北）」，实际是西楼梯。按停靠点相对楼栋中心的方位通用计算标签。验收：P1 两部楼梯的标签与平面图一致；guard PASS。
5. **B-3 切层加载时长**（可选）：淡出到恢复透明目前要 7.6～10 秒。查明耗时在哪里，能缓存下一层就缓存。验收：低画质下 ≤3 秒，或给出瓶颈说明。
6. **E-1 重拍路线截图**：A、B 合入 kit-wt 后，从 kit-wt 构建，重拍 P1-route-3d-overview.png 和 P1-route-stair-transfer.png，换层那张要把楼梯口拍完整。验收：图片时间晚于合入时间；report 里写明构建目录为 kit-wt；guard PASS。
7. **F-1 后端整合**（如果由我合并，这条可以不派）：把 2F、3F、A 的 be 改动整合成一份基于 merge-wt 的副本，解决 floor_overrides.py、pdf_building.py 和 overrides 的冲突。验收：verify_import 只剩任务 C 那 1 条失败（或 exit 0），A 的 stairs 字段保留，2F/3F 的房间结果不变。
8. **不派**：C（暂停）、门框修复（等 Luke 决定）、3F room-59 改名（属于楼梯区域，等 A-1 完成后再定）。

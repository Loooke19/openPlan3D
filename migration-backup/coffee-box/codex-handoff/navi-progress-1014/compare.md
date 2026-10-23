# Codex 成果对照（10/14 00:55 核对，只读，未改代码、未启动 Codex）

| 项 | 结论 | 说明与证据 |
|---|---|---|
| A 楼梯对象 | **部分完成** | 实际生成 4 个，计划 5 个（1F 1/2F 2/3F 1，计划 1F 是 2 个）。原因：1F 西楼梯 (-1312,145) 没有闭合的「楼梯」房间轮廓，没生成；room-56 是室外台阶，已正确排除（codex-stair-obj/report.md 第1、28、76行）。高度按相邻层 elevation 差计算，生成时只要层高/17cm 取整。材质已从 MeshBasic 改成 MeshStandardMaterial，用 kit 的 bakeVertexAo 做顶点色烘焙；踏面 #e9e9e9，侧面 #c7c7c7，防滑条 #55595c；没有实时阴影和实时 AO。截图取样亮度比相邻地面约暗 2%。**所以「A 用了 MeshBasicMaterial」这条已知问题已过时，已修。** stairs 只写进 overrides 的独立字段，并附了重算命令。 |
| A 越界改动 | **有出入** | `nav/pipeline.ts` 对整个导航关掉了实时 shadowMap，也不再创建 SSAOPass。影响的是全场景，不只楼梯。这个文件不在 guard 检查范围内，需要 Luke 或我确认是否接受。 |
| B 切层 | **基本完成** | 三步（每步 28cm，升 16cm）→ 淡出 300ms → 加载 → 淡入 300ms。浏览器测试 4/4，单元测试 37/37（codex-stair-switch/report.md）。出入：① 只在 `quality=low&kit=0` 下验证过，没测 kit 开启和正常画质（tests/browser/nav-floor-transfer.spec.ts:19）。② B 的数据里 floor.stairs=0，没有和 A 的楼梯对象一起测过。③ 路线 1F→3F 直接切层，走 link-stairs-2，前端写成「楼梯东北」，实际是西楼梯，标签有误。④ 淡出开始到恢复透明总共 7.6～10.2 秒，加载偏慢。 |
| C 停靠点 | **确认没动** | ON_HOLD.md 时间是 10/13 20:05。codex-stair-route 下没有任何比它新的文件（find -newer 结果为空），run.log 也停在 20:05。 |
| D 材质/顶部黑条回退 | **原因已查明，修复还在** | 原因：截图是从 fe-shot（旧提交 42cd99d）构建的。kit-wt 仍有 27 个未提交文件。guard 已用绝对路径重跑：A 是 PASS（ThreeViewer 只「丢失」2 行，都是 A 有意改过的等价写法：import 增加了 bakeVertexAo/KIT_PALETTE，noceil 判断改成了 userData.navDressing）；B 是 PASS，丢失 0 行。15 个 GLB 和 6 个 nav/css 文件都一致。**「A、B 缺约 120 行」这条已知问题已过时**：用相对路径跑 guard 时，脚本在子 shell 里 cd 到 kit-wt，导致误报 120 行。正确用法必须传绝对路径。 |
| E 截图 | **部分完成** | A 楼梯截图 5 张（zone-audit/shots/A-stair-*，10/14 00:25–00:38）是从 A 副本拍的。这个副本基于 kit-wt，但并不是 kit-wt 本身，严格按规矩要合入 kit-wt 后再拍。B 截图 *-production.png 是 kit=0、低画质。**路线两张图 P1-route-3d-overview.png（10/13 19:49）和 P1-route-stair-transfer.png（19:57）没有重拍**，仍是作废的 fe-shot 版本。 |
| F 2F 后端 | **完成，待合并** | 24 个命名房间都可达，重叠 0，挑空不可通行（codex-p1-fix-2F/report.md）。run.log 最后停在「Reconnecting 2/5」，但报告完整，补丁 2F-fix.patch 也在。剩下的问题：面积和图注有差异；2F→3F 有 1 条失败，属于任务 C。 |
| F 3F 后端 | **完成，待合并** | 完整 verify exit 0，跨层 125/125，抽样 30/30（codex-p1-fix-3F/report.md）。剩下的问题：room-59 名称错误，交给 A；图注面积有差异。 |
| 门框 | **只有分析** | codex-doorframe/report.md 给了根因，没有派修复任务。 |
| 合并风险 | **有** | 2F、3F、A 三个副本都改了 `floor_overrides.py`、`pdf_building.py` 和 `data/overrides/P1-*.json`。2F/3F 基于 merge-wt，A 的 be 是另一份。三者还没有整合，也没有整合后的 verify。 |

## 盯 Codex 规矩
- 副本基于 kit-wt：A、B 的 fe 都是 5f77cdc 加上 kit-wt 的改动，guard PASS ✅。C 停在 18:07 的副本，已暂停，不用管。
- 每步跑 guard：A 有 guard.log（00:47 PASS），这次重跑仍 PASS ✅。B 目录里没有 guard.log，这次补跑 PASS ⚠️（过程中没有留下记录）。另外 guard 不覆盖 pipeline.ts、route.ts、+page.svelte。
- 9 点前交版本：navi-progress-1014/version.md 还是 10/13 20:10 的旧版，没有写 A/B/2F/3F 的新成果 ❌，需要蓝鲸更新。

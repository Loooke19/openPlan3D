已按 merge-1015 要求合入本副本并验证，未推送、未改其他工作副本、未生成新截图。

- `fe.patch`：合入 kit 基础及 A+B、第 3 轮 A-1/A-2/B-2、墙面材质校准，附 E-1 已验收的两张原图；共 35 个文件，含 15 个 GLB。
- `be.patch`：合入后端第 2 轮及 F-1 的完整运行代码、依赖、素材和覆盖数据，再接入 A+B 薄墙支路修复与 B-2 方位命名；共 135 个文件，路径均为 `be/`。

两份补丁都相对 `/workspace/kit-wt` HEAD `5f77cdcacae290e47ce439041371acadc0375325`，不是相对 kit-wt 当前未提交文件；包含 kit 已有的必要新增文件，需应用到该 HEAD 的干净副本，直接应用到已有 kit 改动的目录会重叠。后端在该 HEAD 尚不存在，因此 `be.patch` 包含完整后端，而非独立后端仓库的增量。

验证结果：

| 验证 | 本次结果 | 证据 |
| --- | --- | --- |
| stair guard | PASS，15/15 GLB 一致，ThreeViewer 新增行保留 120/120，无 WARN | `guard.log`、`invariants.json` |
| 前端专项 | 7 个文件，51/51 通过 | `fe-tests.log` |
| 后端专项 | 44/44 通过，含薄墙、穿门、跨层、楼梯重算及方位命名 | `be-tests.log` |
| 生产构建 | 成功，Vite 构建 31.29s | `build.log` |
| verify_import | PASS / exit 0；跨层 12/12 + 90/90 + 23/23；抽样 30/30，斜段 0、碰墙 0，中位 592ms、最大 1429ms | `verify-import.log` |
| P1 楼梯及命名 | 1F/2F/3F 为 2/2/1；stairs 与覆盖数据一致；东/西命名及平移复测通过，停靠点变化 0 | `p1-invariants.json` |
| 补丁可应用性 | 干净 HEAD 归档中两份补丁 check 和实际 apply 均 exit 0，170/170 文件内容及权限与本副本一致；改动源码空白检查通过 | `patch-validation.log` |

本次 guard 仅允许 `src/lib/components/viewer3d/nav/dressing.ts`：与 kit 相比仅 3 行差异，分别为墙面材质函数 import 和两处墙顶材质构造，已逐项核对；其他受保护文件逐字节一致。

冲突处理：以 integ-fix 第 2 轮保留房间修正、门洞交点及既有跨层图；`floor_overrides.py` 的楼梯生成/写回函数保持 A-1 原实现，9 份 overrides 与 integ-fix 逐字节一致；仅将 ab-on-kit 的 `_fill_room_spur`、`name_links` 及对应两项回归接入该后端，避免整文件覆盖回退 F-1。

排除第 4 轮 `isStairSign` 去牌、第 5 轮天花板/灯、第 6 轮缓存提速和 B-1 踩踏面修复；保留 A+B 原三步转场。E-1 原图仅复制到 `shots/P1-route-3d-overview.png`、`shots/P1-route-stair-transfer.png`，来源及哈希见 `e1-provenance.json`。未纳入 `.playwright-mcp`、编辑器技能目录、缓存、运行日志、历史验证附件及生成的工程数据。

本次 verify_import 使用 integ-fix 第 2 轮 retained 快照，对照 `/workspace/zone-audit/f10`，执行的是本副本脚本；未重新做 PDF/OCR 导入、全量类型检查或浏览器四场景测试。源报告中踏面错位、切层耗时及墙面偏暗等遗留问题仍保留，未宣称解决；已有工程未包含在补丁内，B-2 名称规则不会擅自改写既有工程的跨层图。浏览器回归默认端口改为 4201，并去掉截图调用；本次未启动开发服务（预留 5331）。

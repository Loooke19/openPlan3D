# P1 2F 修正数据任务（浓缩蓝鲸下发）
工作副本：/workspace/codex-p1-fix-2F/repo（merge-wt 的独立拷贝）。只能改这个副本，绝不能动 /workspace/merge-wt、导航仓库主工作目录，也不推送。
问题来源：/workspace/codex-p1-check/report.md 里 2F 的全部问题，以及「未被 overrides 覆盖的问题清单」中涉及 2F 的条目。
标准：/workspace/floorplan-3d/import-truth/pdf-a-menzhen-3f.md 的 2F 节；原图 /workspace/gen-test/67dd2d122f792d3756c1be797426f16ab1a921c2b5253a7705f467524cfc4afb.pdf（第1页=3F，第2页=2F）。
除外（暂缓，不要碰）：verticalLinks 的楼梯停靠点位置。这项由另一个任务负责，已暂停。
做法：优先用 data/overrides/P1-2F.json 的修正数据（以及 floor_overrides.py 已经支持的类型）来修：挑空、缺名和错名、碎块合并、拆开被合并的房间、走廊区域、房间类型。只改通用逻辑，不按 P1 硬编码。要保留手工画的房间、墙、门和改过的名字，房间 ID 保持稳定。附属房间不计数，「房间N」占位不能被搜到。
验证：改完后重新导入，跑 scripts/verify_import.py（新导入目录 vs 现有的 /workspace/zone-audit/f10），必须 exit 0，跨楼层路线全部走通。
报告：写到 /workspace/codex-p1-fix-2F/report.md，逐条写清问题、怎么改的、修完后的状态、还没修的和原因，并附上 verify 的输出。

## 补充（10/13 20:08，与 coffeeeeeee 对过）
- 楼梯区域只归任务 A。楼梯房间的轮廓、名称、碎块、停靠点都不要碰，也不要写修正数据里的 stairs 字段。
- 2F 房间 54 不通：原因是西楼梯和办公室区域有假墙 wall-86、wall-93、wall-212、wall-224，切出了 4 个碎面。把这些假墙删掉；如果 54 在 PDF 上是没有门的井道，就把它从可选目的地里排除掉。

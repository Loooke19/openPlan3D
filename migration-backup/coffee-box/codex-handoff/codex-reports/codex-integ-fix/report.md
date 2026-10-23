本副本已修复 1F 房间漏计和确认新增的 5 项单元测试回归，已重生成包含 4 张 PNG 实际二进制内容的 integ.patch。全新导入和保留原工程重导入的完整 verify_import 均 exit 0，跨层各 125/125、抽样各 30/30，斜段与碰墙均为 0。仍保留基准已有的 1 个单元测试失败、1 个错误；不能把单元测试表述为全部通过。未推送。

验证环境：Linux，Python 3.13，解释器 `/workspace/.venv-gifu/bin/python`。对照提交为 `1ceb2516b9eae991d2944a177437bb0a8019ee58`。协调员的 Windows 报告为指定 handoff/test-result-2F.md；下文明确区分其历史结果与本副本实测。

**1. P1 1F：45→44 的根因和修复**

本副本复现了全新导入旧口径 44，而原 2F golden 与保留原工程重导入为 45。少掉的不是几何房间，而是 `(190,1590)` 所在的 3.19㎡卫生间：原覆盖参数只改 `name=卫生间`，留下识别碎面携带的 `floorOpening=true`、`floorTexture=none`。golden 中同一多边形为 room-42，全新导入为 room-73；墙线与面积一致。

使用同一份原始 1F 识别结果，分别运行原 2F 的 floor_overrides.apply 和合并后的 apply，原 1F 参数下均得到该卫生间 `floorOpening=true`，现行计数 48；补齐参数后为 false，计数 49。因此问题在原有 1F 语义覆盖参数，不是 3F 合并误删房间，也不是 OCR 随机少识别一个名称。

最小改动：在 `data/overrides/P1-1F.json` 该卫生间条目补齐 `roomType=toilet`、`floorOpening=false`、`floorTexture=hospital-floor`。全新导入和保留原工程重导入均恢复原协调员口径 45；区域总数仍为 140。

| 1F 数据 | 区域总数 | 原协调员独立目的地口径 | 当前 verify_import 的房间语义口径 |
|---|---:|---:|---:|
| 原 2F golden | 140 | 45 | 49 |
| 修复前全新导入 | 140 | 44 | 48 |
| 修复后全新导入 | 140 | 45 | 49 |
| 修复后保留原工程重导入 | 140 | 45 | 49 |
| 原始 1ceb251 全新导入，无新增 overrides | 102 | 38 | 40 |

当前整合版 verify_import 的计数规则已经与协调员当时的版本不同，本次没有改计数规则或放宽门禁。45 和 49 必须分别比较，不能用口径变化掩盖 44 的问题。证据：`var/validation/1f-cause.log`、`room-comparison.log`、`final-invariants-finished.log`，及最终 fresh/retained/P1.json。

**2. 单元测试：基准对照及新增回归**

已实际执行 `python -m unittest discover -s tests -p 'test_*.py' -v`。第一次基准发现 8899 已被其它进程占用；完整可比对照将两版的 LiveApply 临时监听及对应请求统一改到空闲端口，仅在测试进程内重定向，未改测试源码、未停止占用进程。还同步本副本已有的被 git 忽略的测试工程快照，使两边都执行限制区用例，避免基准跳过、当前执行造成错误归因。

| 可比完整测试 | 总数 | 通过 | 失败 | 错误 | 跳过 |
|---|---:|---:|---:|---:|---:|
| 1ceb251 | 178 | 169 | 2 | 1 | 6 |
| 最终副本 | 195 | 187 | 1 | 1 | 6 |

整合版新增 17 个测试全部通过。最终副本 195 项耗时 233.491s。原始直接基准运行记录也保留在 `tests-baseline.log`，不能与含不同工程快照、不同跳过数的运行直接相减。

| 协调员列出的问题 | 1ceb251 同环境结果 | 最终结果及归因 |
|---|---|---|
| FloorNavTests.test_route_crosses_the_door | 通过 | 新增回归，已修复 |
| FloorNavTests.test_room_is_not_a_door_to_door_shortcut | 通过 | 新增回归，已修复 |
| FloorNavTests.test_route_string_pull_and_door_centers | 通过 | 新增回归，已修复 |
| CrossFloorTests.test_same_named_elevators_pair_and_the_trip_has_two_legs | 通过 | 新增回归，已修复 |
| EditorMcpTests.test_screenshot_writes_png_without_returning_bytes | 通过 | Linux 两版通过；测试源码未改，Windows 路径问题未在 Windows 重测 |
| WriteBackTests.test_save_bumps_revision_and_keeps_backup | 通过 | Linux 两版通过；测试源码未改，Windows 默认编码问题未在 Windows 重测 |
| HospitalNavigationTests.setUpClass | 正常，9 个测试通过 | Linux 两版通过；测试源码未改，Windows GBK 问题未在 Windows 重测 |
| ShaftTests.test_boxed_shaft_stands_in_its_lift_lobby_not_across_a_wall | KeyError: at | 基准已有，保留；没有修改楼梯/电梯停靠字段 |

另外发现 `P1ZoneTest.test_inside_destination_may_enter` 在基准通过、整合版失败，也已修复。采样室原内部点 `(880.5,1746.9)` 位于限制区，封闭房间的导航到达点却吸附到区外 `(620.5,1526.9)`；现在用已有 `interior` 坐标判断房间归属。专项复测 1/1 通过。

四项门回归的共同根因是路线简化去掉了门附近的顶点，原 usedDoorIds 只检查顶点，漏记实际穿门的长线段。现在按线段与有限门洞的交点判定使用门，并在最终折线保留实际穿门交点；交点位于原线段上，不改变路径形状。导航专项 31/31 通过。没有修改断言来接受空 usedDoorIds。

最终唯一失败为 `P1ZoneTest.test_sw_cluster_suggested_with_south_stair`：测试硬编码期望“楼梯”，原工程实际名称是“楼梯（西南）”；基准也失败，按要求保留楼梯名称。基准另外失败的 `test_main_lobby_to_2f_surgery_uses_north_stair` 在当前通过。唯一错误仍是上表的 `KeyError: at`。最终新增失败/错误集合为空。

完整证据：`var/validation/tests-baseline-controlled.log`、`tests-final-complete.log`、`tests-final-summary.json`；协调员指定用例单独对照为 `tests-baseline-coordinator.log`。

**3. 二进制补丁**

从原 2F 工作副本恢复丢失的验证附件，4 张 PNG 均经 Pillow 检查，且与原文件逐字节一致。生成命令：

```bash
git diff --binary 1ceb251 -- . ':(exclude)integ.patch' > integ.patch
```

补丁为 1,358,767 bytes，含 4 个 `GIT binary patch` 块；SHA-256 为 `929c56630ee7a31dfa291cffd0181f473e1e66db98c4b88861865efba348aa91`。已在独立干净的 1ceb251 工作树执行 `git apply --check` 和实际 `git apply`，均 exit 0；应用后 4 张 PNG 的完整 SHA-256 与本副本一致。report.md 是独立交付报告，未加入补丁。

| PNG | 字节数 | SHA-256 |
|---|---:|---|
| office-walls.png | 41047 | 62183bdad5735573ca484cfc0797837b436f1d9852bb85b7e46631b113ec8109 |
| pdf-fee-door.png | 23310 | 4351189ae72d4933333c86a26f184d045271d991bdf5f1c075b9970153e6e7b3 |
| pdf-office-small.png | 31572 | 745e9c2fe6b5880db91596fceca9c7688fae9224f1a9d15d784806870cbaf873 |
| pdf-offices.png | 35010 | 77ec81a492e0c9086cbb7a4a3533993cb996cb0609c4d0f3511c07e1d8d9a361 |

**4. 假墙、楼梯网格和挑空**

前态为 `/workspace/zone-audit/f10/P1.json`，后态为本副本 retained/P1.json；两者使用同一套最终导航算法，20cm 网格。2F 两边原点均为 `(-2613.87,-588.46)`，尺寸 264×130；3F 原点均为 `(-2304.83,-1360.86)`，尺寸 231×162。以下统计按固定世界坐标取格心，避免栅格偏移影响比较。

4 条原假墙 ID 均不存在。沿原墙线、向两侧扩到“半墙厚+20cm”的条带统计如下；保留下来的共线段是 PDF 真墙及楼梯侧原轮廓，不是把整条原长线重新作为假墙保留。

| 原墙 ID | 原长度 cm | 共线真墙保留 cm | 条带格数 | 可走格 前→后 | 封闭→开放 | 开放→封闭 |
|---|---:|---:|---:|---:|---:|---:|
| wall-86 | 769.29 | 640.43 | 78 | 14→19 | 5 | 0 |
| wall-93 | 571.45 | 198.97 | 116 | 19→47 | 35 | 7 |
| wall-212 | 318.53 | 114.55 | 45 | 9→19 | 17 | 7 |
| wall-224 | 338.25 | 0 | 34 | 19→33 | 15 | 1 |

楼梯区域使用明确包围盒内完整闭合面统计：2F 西 `[-1412.84,-498.92,-1016.03,235.04]`、东 `[1890.73,1022.47,2190.07,1709.87]`；3F 西 `[-1412.23,-498.92,-1016.37,245.97]`、东 `[1805.99,1022.34,2190.25,1709.87]`。不沿用未说明范围的旧“24个楼梯相关面”数字。

| 楼层 | 包围盒内完整面 | 格数 | 可走格 前→后 | 发生变化的格数 | 最大多边形几何差 cm² |
|---|---:|---:|---:|---:|---:|
| 2F | 23 | 1246 | 342→459 | 197 | 6.04×10^-12 |
| 3F | 25 | 1040 | 181→181 | 0 | 1.27×10^-11 |

楼梯面 ID、名称和语义字段无变化，floor.stairs 完全相等。已有补丁重建墙段导致墙引用 ID 更新，但轮廓差仅为浮点误差。2F 可走格变化来自清除假墙后网格连通及房间通行支线重建，不能将“几何不变”误写成“每个导航格都不变”。本次后续修复没有改楼梯房间、楼梯字段或停靠点。三栋 retained 工程的 verticalLinks 与 f10 逐字段完全相等。

| 实际挑空 | 面积㎡ | 格心落在挑空内 | 可走格 |
|---|---:|---:|---:|
| 2F 门厅上空 | 56.1149 | 1410 | 0 |
| 2F 庭院上空 | 36.9579 | 945 | 0 |
| 3F 上空 | 36.4179 | 884 | 0 |

2F 实际挑空合计 93.0728㎡、2355 格，可走 0；3F 884 格，可走 0。同算法前态分别有 1373、113 个可走格，后态均封闭。

协调员粗计“void-like≈10”可以复现：全新导入 2F 有 10 个携带 floorOpening/void 属性的区域，其中 2 个为上述实际挑空，另外 8 个是识别保留的外部/窄碎面，合计另有 169 格；全部 2524 格可走数为 0。保留原工程重导入只有 2 个实际挑空。最终全新导入 3F 的宽口径为 11 个区域、1046 格（实际挑空 884 格，外部/碎面 162 格），可走同样为 0。全新导入另外发现 3F 主走廊继承 `floorOpening=true`、`floorTexture=none`，已在该走廊覆盖参数明确改为非挑空和医院地面；不涉及楼梯字段。

数字证据：`var/validation/grid-audit-existing.log`、`stair-regions.log`、`void-counts-finished.log`。

**5. 最终导入验证及剩余限制**

三栋 PDF 均在本副本重新导入，分别检查无 previous_project 的 fresh 流程和以 f10 工程为 previous_project 的 retained 流程。retained 是符合“不改原有停靠点”约束的交付流程；从新几何匹配房间身份，原跨层图完全保留。全新导入的主走廊误标挑空也已修正，3F 两座楼梯恢复识别。

最终完整命令与输出记录：

```bash
/workspace/.venv-gifu/bin/python -u scripts/verify_import.py var/validation/retained /workspace/zone-audit/f10
/workspace/.venv-gifu/bin/python -u scripts/verify_import.py var/validation/fresh data/verification-p1-2f
```

最终输出见下方实测记录。全新导入原先将 `(400,880)` 的 3F 南段主走廊误保留为挑空，connect_shafts 因附近主通行空间被封闭而丢弃一座楼梯；明确该走廊为非挑空和医院地面后，3F 恢复两座楼梯。没有修改楼梯字段、楼梯识别/配对/停靠算法、PDF truth 或跳过路线。全新导入沿用既有自动停靠计算；已有工程重导入仍逐字段保留原停靠点。原 2F 验证附件仍作为历史 reference，不能把其中旧 audit/tests-known-baseline 的“既有失败”结论当作本次 1ceb251 对照结论。

最终验证均 **PASS / exit 0**。全新导入对原 2F golden：

```text
楼栋 楼层 | PDF楼梯/电梯 | 模型楼梯/电梯(识别+补画) | 跨层连通楼梯/电梯 | HEAD楼梯/电梯 | 独立房间(≥1.5㎡，排除附属/碎面) 新/HEAD
P1 1F | 2/0 | 5/0 | 2/0 | 5/0 | 49/49
P1 2F | 2/0 | 2/0 | 2/0 | 2/0 | 25/24
P1 3F | 2/0 | 2/0 | 2/0 | 2/0 | 36/34
P2 1F | 2/1 | 2/1 | 2/1 | 2/1 | 21/21
P2 2F | 2/1 | 2/1 | 2/1 | 2/1 | 32/32
P2 3F | 2/1 | 2/1 | 2/1 | 2/1 | 31/30
P2 4F | 2/1 | 2/1 | 2/1 | 2/1 | 28/28
P2 5F | 2/1 | 2/1 | 2/1 | 2/1 | 18/18
P3 1F | 2/0 | 2/0 | 2/0 | 2/0 | 14/14
P3 2F | 3/0 | 3/0 | 3/0 | 3/0 | 16/16
P3 3F | 2/0 | 2/0 | 2/0 | 2/0 | 14/14
P3 4F | 1/0 | 1/0 | 1/0 | 1/0 | 3/3
P1 楼梯电梯两两跨层 12/12
P2 楼梯电梯两两跨层 90/90
P3 楼梯电梯两两跨层 23/23
抽样 30/30 斜段 0 碰墙 0 耗时中位 330ms 最大 2412ms
PASS
```

保留原工程重导入对 f10：

```text
楼栋 楼层 | PDF楼梯/电梯 | 模型楼梯/电梯(识别+补画) | 跨层连通楼梯/电梯 | HEAD楼梯/电梯 | 独立房间(≥1.5㎡，排除附属/碎面) 新/HEAD
P1 1F | 2/0 | 5/0 | 2/0 | 5/0 | 49/49
P1 2F | 2/0 | 2/0 | 2/0 | 2/0 | 25/25
P1 3F | 2/0 | 2/0 | 2/0 | 2/0 | 36/34
P2 1F | 2/1 | 2/1 | 2/1 | 2/1 | 21/21
P2 2F | 2/1 | 2/1 | 2/1 | 2/1 | 32/32
P2 3F | 2/1 | 2/1 | 2/1 | 2/1 | 30/30
P2 4F | 2/1 | 2/1 | 2/1 | 2/1 | 28/28
P2 5F | 2/1 | 2/1 | 2/1 | 2/1 | 18/18
P3 1F | 2/0 | 2/0 | 2/0 | 2/0 | 14/14
P3 2F | 3/0 | 3/0 | 3/0 | 3/0 | 16/16
P3 3F | 2/0 | 2/0 | 2/0 | 2/0 | 14/14
P3 4F | 1/0 | 1/0 | 1/0 | 1/0 | 3/3
P1 楼梯电梯两两跨层 12/12
P2 楼梯电梯两两跨层 90/90
P3 楼梯电梯两两跨层 23/23
抽样 30/30 斜段 0 碰墙 0 耗时中位 531ms 最大 1566ms
PASS
```

最终日志为 `var/validation/verify-fresh-finished.log`、`verify-retained-finished.log`。`git diff --check` 与 `python -m compileall -q scripts tests` 均 exit 0。最终参数只改变 1F room-42 卫生间及 3F room-123 主走廊的语义，2F 房间字段逐项一致，三栋已有跨层图逐字段一致；详见 `final-invariants-finished.log`。

**6. 协调员 v2 补充：两套 HEAD 不是同一基准**

已核对 `addendum-0235.md` 指向的 test-result-2F-v2.md。其 1F=48/49 与上述 44/45 是同一间卫生间漏计，只是计数口径不同；本次两种口径都恢复。不能用另一份较少房间的历史导入数据替换 HEAD 来接受漏计。

| P1 基准目录 | 1F/2F/3F 区域数 | 当前规则独立房间数（不套用新语义） |
|---|---|---|
| /workspace/pdf-compare/base | 102 / 73 / 83 | 40 / 26 / 37 |
| /workspace/zone-audit/f10 | 140 / 84 / 122 | 49 / 27 / 41 |
| 原 verification-p1-2f golden | 140 / 65 / 122 | 49 / 25 / 41 |

pdf-compare/base 是较早的识别数据；P1 1F 门禁仅 40，无法检查 49→48。其 P1 2F 停靠 `(1917.3,982.6)`、`(-1582.7,122.6)`，而 f10/golden 是 `(376.1,-118.5)`、`(536.1,-238.5)`。P2 多层房间和停靠坐标也不同；P3 在 base 只有 2 条连接、5 个站点，在 f10/golden 有 3 条连接、8 个站点。f10 与 golden 的 P2/P3 数据一致，P1 的跨层图也完全一致；P1 2F 的区别是已应用 2F 区域修复。

PDF truth 的“3F 至少两座连通楼梯”检查不取决于 HEAD。因此 v2 中新工程只有一座楼梯时，单纯换 HEAD 不能消除该检查；声称对 base PASS 必须同时核对新工程文件、previous_project 参数、truth 和脚本版本。本次保留这些输入差异，分别记录结果。基准数据详情为 `var/validation/baseline-data-difference.log`；以同一 retained 工程对 pdf-compare/base 的额外门禁比较记录为 `verify-pdf-base-comparison.log`（此比较使用 --no-pairs，完整跨层另由最终全量运行验证，未用这条快速运行替代它）。


## 第二轮

已按 `addendum-0235.md` 逐项复核，并完成 F-1 后端整合。最终全新导入、保留原工程重导入的 `verify_import` 都为 **PASS / exit 0**，两套跨层配对各 **125/125**、抽样各 **30/30**，斜段与碰墙均为 0。P1 楼梯对象为 **1F=2、2F=2、3F=1，共 5 个**；A-1 后端以 `/workspace/codex-ab-on-kit/be` 为准。没有修改停靠点、楼梯房间名称或推送代码。

**补充清单第 1 条：基准差异及 1F 漏计**

重新核对三套基准：`pdf-compare/base` 的 P1 区域数为 102/73/83，当前房间口径为 40/26/37；`zone-audit/f10` 为 140/84/122、49/27/41；原 2F golden 为 140/65/122、49/25/41。较早的 base 不仅房间更少，停靠坐标和跨层站数也不同，不能替代旧 golden 检查 1F 漏计。本轮继续使用原 golden 和 f10，没有替换基准、修改 truth 或放宽门禁。

上一轮卫生间语义补齐保留：`P1-1F.json` 的 `(190,1590)` 明确 `roomType=toilet`、`floorOpening=false`、`floorTexture=hospital-floor`。本轮两种实际导入的 1F 均为 140 个区域、49 个独立房间；按上一轮协调员旧口径仍为 45。3F 主走廊的非挑空语义也保留，PDF 所需两条贯通楼梯连接均存在。基准及专项复测证据：`var/validation/second-round/addendum-review.log`；完整导入与字段比较：`import.log`、`import-invariants.log`。

**补充清单第 2 条：新增单元回归对照**

补充清单列出的门路线、电梯配对、截图、中文写回及 HospitalNavigation 用例，加上限制区目的地回归，合计 **16/16 通过**。保留原断言；Windows 的路径/GBK 问题仍仅有 Linux 对照结果，未宣称已在 Windows 重测。

完整测试在相同 Python 3.13 环境运行，并使用相同的 4 份忽略目录工程快照。LiveApply 仅在测试进程内把监听端口及请求统一换成动态空闲端口，未修改测试源码或断言。本次发现旧的 `codex-integ-baseline-1ceb251` 目录实际含上一轮补丁，因此将该次结果记为“第一轮副本”，重新从 `git archive 1ceb251` 建立干净对照；158 个受版本控制文件逐字节核对为提交原文。

| 完整测试 | 总数 | 通过 | 失败 | 错误 | 跳过 |
|---|---:|---:|---:|---:|---:|
| 纯 1ceb251 归档 | 178 | 169 | 2 | 1 | 6 |
| 第一轮副本 | 195 | 187 | 1 | 1 | 6 |
| 第二轮最终副本 | 198 | 190 | 1 | 1 | 6 |

第二轮耗时 278.733s，纯基准 180.642s。相对纯基准新增的 20 个测试全部通过；本轮新增的 3 个测试验证轮廓变化后重算、缺失房间轮廓补梯及单层台阶排除、原位写回保持其他覆盖文本。楼梯覆盖专项合计 **11/11 通过**。相对纯基准及第一轮，新增失败/错误集合均为空。

保留的失败为 `P1ZoneTest.test_sw_cluster_suggested_with_south_stair`（原楼梯名“楼梯（西南）”与硬编码“楼梯”不同）；保留的错误为 `ShaftTests.test_boxed_shaft_stands_in_its_lift_lobby_not_across_a_wall`（`KeyError: at`）。两项在纯基准都存在。纯基准另一个失败 `test_main_lobby_to_2f_surgery_uses_north_stair` 在整合版通过。证据：`tests-baseline-clean.log`、`tests-first-round.log`、`tests-final.log`、对应 summary.json 和 `final-summary.json`，均在 `var/validation/second-round/`。

**F-1：冲突处理及保持项**

- `scripts/floor_overrides.py`：保留本副本的房间身份匹配、手工修改保护和挑空语义；合入 A 的 `generate_stairs`、`write_stair_overrides` 及重算命令。这两个函数与 A-1 来源逐语法节点完全相等，未混入其他任务的楼梯实现。
- `scripts/pdf_building.py`：仅在上一轮实现中增加 A 的 `floor.height` 和楼层排序后的生成调用，保留 `previous_project`、房间统计及原跨层图保留流程。
- `P1-1F/2F/3F.json`：独立 `stairs` 数组逐字段取 A-1 来源；1F 西梯标记额外合入 A-1 的 polygon、thickness、stairType、rotation。其余覆盖字段全部保持上一轮，包括 1F 漏计修复及 2F/3F 墙、房间修正；其他楼栋的 overrides 全部不变。生成规则读取轮廓参数，没有在代码中硬编码 P1 坐标。

三栋两种导入共 **24 个楼层**，排除 A 新增的 `stairs`、`height` 后，楼层所有字段与上一轮完全相等。P1 2F/3F 仍为 **64/87 个区域、25/36 个独立房间**。两种导入的三栋 `verticalLinks` 都与上一轮逐字段相等；retained 还与 f10 完全相等，站点数为 P1=6、P2=15、P3=8。retained 的 P1 `floor.stairs == overrides.stairs == A-1 stairs`，完整字段一致；全新导入随实际房间身份生成对象 ID，位置、尺寸等生成规则相同。证据：`merge-invariants.log`、`import-invariants.log`。

本地 P1 项目只更新 `stairs`，其他字段保持原值；重算命令实际输出 `{"1F": 2, "2F": 2, "3F": 1}`，再次执行项目及全部 overrides 哈希不变：

```bash
/workspace/.venv-gifu/bin/python /workspace/codex-integ-fix/scripts/floor_overrides.py /workspace/codex-integ-fix/data/kujiale-import/projects/b1f10000000000000000000000000001/project.json
```

证据：`var/validation/second-round/recompute.log`。工程文件位于原有忽略目录，补丁交付通过通用导入入口和 overrides 保留生成能力。

**最终门禁及二进制补丁**

```bash
/workspace/.venv-gifu/bin/python -u scripts/verify_import.py var/validation/second-round/fresh data/verification-p1-2f
/workspace/.venv-gifu/bin/python -u scripts/verify_import.py var/validation/second-round/retained /workspace/zone-audit/f10
```

| 流程 | P1 跨层 | P2 跨层 | P3 跨层 | 抽样 | 斜段/碰墙 | 中位/最大耗时 | exit |
|---|---:|---:|---:|---:|---:|---|---:|
| 全新导入 | 12/12 | 90/90 | 23/23 | 30/30 | 0/0 | 279/2281ms | 0 |
| 保留原工程重导入 | 12/12 | 90/90 | 23/23 | 30/30 | 0/0 | 580/1812ms | 0 |

日志：`var/validation/second-round/verify-fresh.log`、`verify-retained.log`。未使用 `--no-pairs`，全部跨层路线执行。`git diff --check`、`python -m compileall -q scripts tests` 均 exit 0。

最终重新执行：

```bash
git diff --binary 1ceb251 -- . ':(exclude)integ.patch' > integ.patch
```

`integ.patch` 为 **1,368,652 bytes**，包含 **4 个 GIT binary patch 块**，SHA-256：`cd9308ff694f40e703a14160ba035ee972be1087f00c594c36cf2fddcaddf4bd`。在独立干净 1ceb251 归档中 `git apply --check --binary` 和实际 `git apply --binary` 均 exit 0，应用后 35 个变更文件逐字节一致；4 张 PNG 哈希与上一轮完全一致。最终重生成后哈希保持一致，反向应用检查也 exit 0。证据：`var/validation/second-round/patch-validation.log`。

剩余问题仅为上述纯基准已有的 1 个单元失败、1 个错误，以及 Windows 专项未重测；不能把单元测试表述为全部通过。未推送。`report.md` 作为独立报告保留，未加入补丁。

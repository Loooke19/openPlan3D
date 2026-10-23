# 任务 B 验证报告

切层功能及相关测试已验证通过：1F 挂号 → 3F 体检窗口的模拟导航、第一人称上楼和反向下楼均跑通，生产构建浏览器测试 **4/4**、相关单元测试 **37/37** 通过。全量检查尚未全部通过：后端固定抽样仍有 1 条既有阻断路线，类型检查仍有既有错误，详见剩余问题。未推送代码。

## 改动及原因

- `fe/src/lib/components/viewer3d/ThreeViewer.svelte`：已有断点代码用 `playFloorTransfer` 替换 `playStairClimb`，沿当前路线末段方向走三步，每步 28cm、升降 16cm，总位移 84cm、升降 48cm；电梯接近不升降。第一人称移动相机，模拟导航移动路线标记；结束播放会取消动画并释放等待。
- `fe/src/lib/components/viewer3d/nav/route.ts`：已有 `transferStepPose` 统一计算短距离三步动作，不使用目标层坐标插值，也不依赖楼梯几何。
- `fe/src/routes/nav/+page.svelte`：已有统一切层流程在三步结束后淡出 300ms，遮住楼层加载和下一段播放恢复，然后淡入 300ms。请求与切层令牌阻止点击“结束”后的迟到响应继续播放。
- `fe/tests/nav-route-depth.test.ts`：保留已有上下楼、电梯测试，本次补齐动画进度边界和三次踏步落点测试。
- `fe/tests/browser/nav-floor-transfer.spec.ts`：本次新增可重复运行的生产构建回归，覆盖模拟上楼、第一人称上下楼、加载目标层期间结束导航；检查路线停靠点衔接、淡出/淡入时长、加载时全黑、终点到达和最终进度。

本次只补测试和验证材料，没有继续改动业务实现、后端数据、门洞规则或其他已有改动。

## 路线、坐标及耗时

使用本目录 `fe/` 的新生产构建，前端端口 **5312**、后端端口 **8912**，系统 Chrome / SwiftShader，960×640，`quality=low&kit=0`，播放速度 3×。没有使用其他目录的构建或服务。

`verification/P1.json` 的项目内容与当前 `be/data/kujiale-import/projects/b1f10000000000000000000000000001/project.json` 完全一致。三个楼层的 `floor.stairs` 数量均为 **0**，验证使用真实 `verticalLinks` 停靠点，没有 mock 或修改停靠点。

1F 挂号 → 3F 体检窗口的路线长 **1219cm**，包含 1F 段 **899cm**、3F 段 **320cm**；使用 `link-stairs-2`（楼梯东北），直接从 1F 切到 3F，**只切层一次**。反向同样只切一次。

| 场景 | 楼层 | 出发停靠点 (x,y)，cm | 目标停靠点 (x,y)，cm | 淡出开始至目标层状态加载 | 加载至恢复透明 | 淡出开始至恢复透明合计 |
| --- | --- | --- | --- | ---: | ---: | ---: |
| 模拟上楼 | 1F → 3F | (-1312.3, 144.8) | (-1214.8, 289.1) | 4570.7ms | 3024.6ms | 7595.3ms |
| 第一人称上楼 | 1F → 3F | (-1312.3, 144.8) | (-1214.8, 289.1) | 4641.8ms | 5602.3ms | 10244.1ms |
| 第一人称下楼 | 3F → 1F | (-1214.8, 289.1) | (-1312.3, 144.8) | 5150.6ms | 3265.2ms | 8415.8ms |

表中“加载”以页面楼层 URL 更新为观测点，“恢复透明”以遮罩 opacity 回到 0 为观测点；不包含接近楼梯的三步动画。三步动画设定为 `max(450, 900 / speed)` ms，3× 时为 **450ms**。上述总耗时包含请求、场景重建及浏览器渲染等待，不能等同于 300ms 淡出。三次切层的淡出及淡入 CSS 事件共 **6/6**，每次 `elapsedTime` 都是 **300ms**；加载时遮罩 opacity 均为 **1**。

原始时间、完整路线及浏览器错误记录：`verification/sim-up-production.json`、`verification/fp-up-production.json`、`verification/fp-down-production.json`。三项均 **0 个 pageerror**，最终进度 **100%**。各目标层路线首点与对应 `transfer.to` 完全一致。

保留的断点证据 `verification/switches.json` 另有第一人称实际相机测量：上楼三步末端高度 **208cm**、下楼 **112cm**（基础视高 160cm，±48cm）；切层恢复时相机平面坐标与目标停靠点相同，误差 **0cm**。该文件属于前次开发模式测量，未冒充本次生产构建数据。

## 截图

本次生产构建生成以下切层前后截图，均在 `/workspace/zone-audit/shots/`：

| 场景 | 切层前 | 切层后 |
| --- | --- | --- |
| 模拟上楼 | `B-switch-before-sim-up-production.png` | `B-switch-after-sim-up-production.png` |
| 第一人称上楼 | `B-switch-before-fp-up-production.png` | `B-switch-after-fp-up-production.png` |
| 第一人称下楼 | `B-switch-before-fp-down-production.png` | `B-switch-after-fp-down-production.png` |

截图为播放中的页面快照；切层后截图可能已继续走到终点，精确停靠点相机位置见上述保留的开发模式记录。

## 验证命令及结果

在 `fe/` 下运行：

```sh
npm run build
npm test -- tests/nav-route-depth.test.ts tests/route-progress.test.ts tests/roomMapLabel.test.ts
npx playwright test tests/browser/nav-floor-transfer.spec.ts --project=chromium
NODE_ENV=production npm run check
git diff --check
```

- 构建成功，日志 `verification/build.log`。
- 单元测试 **3 个文件、37 项通过**，日志 `verification/frontend-tests.log`。
- 浏览器 **4/4 通过，耗时 3.9 分钟**，日志 `verification/browser-tests.log`。取消测试挂住目标层 nav 响应，点击结束后放行；等待响应处理后仍停在原层，遮罩透明、暂停按钮隐藏、状态为“已结束”。
- `git diff --check` 通过。
- 类型检查 **32 个错误、17 个警告，分布于 4 个文件**，与断点前记录相同。没有切层实现或新增测试的类型错误；错误涉及已有 `DoorRow`/`Door` 类型、纹理 image 类型、`PlacePicker.svelte` 及 `verticalFacility.test.ts`。

后端使用下列命令复跑，两个参数都是与当前项目一致的既有 P1 验证快照，仅验证当前状态，并非独立历史 HEAD 的回归比较：

```sh
cd be
/workspace/.venv-gifu/bin/python scripts/verify_import.py ../verification ../verification --buildings P1
```

结果：楼梯停靠点两两跨层 **12/12**，固定种子路线抽样 **9/10**，斜段 **0**、碰墙 **0**；耗时中位 **191ms**、最大 **317ms**，整体退出码 **1**。日志 `verification/backend.log`。

复跑浏览器测试前需启动本目录服务；后端允许来源必须与前端端口一致：

```sh
# be/ 下
NAV_WARM=0 OPENPLAN_ORIGIN=http://127.0.0.1:5312 /workspace/.venv-gifu/bin/python scripts/kujiale_import_server.py --port 8912
# fe/ 下（完成构建后）
PORT=5312 HOST=127.0.0.1 node build
```

浏览器测试使用系统 Chrome，现有 Playwright 配置还会自动启动本目录构建于 4188；该端口应保持空闲。

## 剩余问题

1. **后端必需校验尚未全通过。** 既有失败为 2F“房间 54”→3F“房间 65”返回 `blocked`。本次拆分定位：2F“房间 54”到两个楼梯停靠点的本层路线均失败，3F“房间 65”到两个停靠点均成功；两端坐标都不在墙内。阻断位于 2F 出发端的本层连通性，不是前端切层机制。详细结果写入 `verification/backend-blocked.json`。进一步修复需改后端寻路或识别/通行数据，超出本任务范围，且公共背景禁止修改门洞部分，因此未改动或降低校验门槛。
2. **全量类型检查仍有既有错误。** 没有扩大任务范围修复与切层无关的类型问题。
3. **总切层等待明显长于淡出。** 当前软件渲染测试环境中，淡出开始至恢复透明为 7.6–10.2 秒；页面加载和场景重建性能仍需后续工作。300ms 是透明度过渡本身的时长。
4. **停靠点位置和楼梯几何仍按现有数据。** Task C 暂缓，未调整停靠点；P1 无实际 `floor.stairs`，此次验证覆盖停靠点三步分支。P1 没有电梯，电梯分支仅有位移单元测试。

## 第二轮

**后端阻断已修复并复跑通过：固定种子抽样 10/10、跨层停靠点两两 12/12，斜段 0、碰墙 0，必需校验退出码 0。** 原失败的 2F「房间 54」→3F「房间 65」使用旧坐标也能返回成功路线。本轮只修改后端寻路规则和一个回归测试；未改楼梯轮廓、停靠点或 overrides 的 stairs 字段，未推送。

### 根因与改动

- `be/scripts/floor_nav.py` 的 `_fill_room_spur`：墙体栅格化会按至少 **0.55 个格子半宽**封墙，20cm 格子对应 11cm；但后续房间支路只按墙体实际半宽避墙。2F 的 `wall-226` 厚 10cm，支路因而按 5cm 避墙，将原来封住的格子重新涂通。具体由 `door-19` 的支路打开格子中心 **(-1563.87, 21.54)**，与 **(-1583.87, 21.54)** 虚假连接。主通路计算把孤立区域算进来，房间目的地吸附到不可达区域；寻路碰墙检查禁用这条边后，出发端被阻断。
- 修复让房间支路复用 `_wall_paint_half` 的栅格封闭宽度，并复用已有的墙体/对齐门洞判定；支路加宽也统一使用该判定。只调整寻路时的局部墙体副本，不改项目墙体或门洞几何。上述格子由可走变为封闭，2F 主连通区由 **9580** 格校正为 **9418** 格。
- `be/tests/test_floor_nav.py`：新增薄墙回归，验证支路不能重开门洞外的封闭格、正常门洞仍能通行、路线不穿墙。该测试在内存恢复的修复前实现上失败，在当前实现上 **1/1 通过**。

### 重跑结果

在 `be/` 下运行：

```sh
/workspace/.venv-gifu/bin/python scripts/verify_import.py ../verification ../verification --buildings P1
/workspace/.venv-gifu/bin/python -m unittest discover -s tests -p 'test_*floor_nav.py' -v
/workspace/.venv-gifu/bin/python -m unittest discover -s tests -p 'test_floor_nav.py' -k 'room_spur_preserves' -v
git diff --check -- scripts/floor_nav.py tests/test_floor_nav.py
```

- 必需后端校验 **PASS，退出码 0**：抽样 **10/10**、跨层停靠点 **12/12**、斜段 **0**、碰墙 **0**；耗时中位 **206ms**、最大 **331ms**。日志 `verification/backend-round2.log`。另以内存恢复修复前实现复跑同一校验，仍是 **9/10**，原路线 `blocked`，退出码 **1**。两个目录参数仍是同一 P1 快照，不是历史 HEAD 对比。
- 原失败路线分别使用第一轮保存的坐标和当前生成的目的地坐标复跑，均成功，长度均为 **6941cm**；使用 `link-stairs-2`，2F 停靠点 **(536.1, -238.5)**、3F 停靠点 **(-1214.8, 289.1)**，各层路线与停靠点衔接误差 **0cm**，斜段和碰墙均为 **0**。
- 两端到楼梯停靠点的本层验证 **4/4**：2F「房间 54」到南/东北楼梯分别 **6498cm / 6801cm**；3F「房间 65」到南/东北楼梯分别 **3952cm / 140cm**。均成功，斜段 **0**、碰墙 **0**。完整路线、根因格子和数据哈希见 `verification/backend-blocked-round2.json`。
- 本层及跨层测试 **26/30 通过**，新增回归通过，剩余 **4 项既有失败**。内存恢复修复前实现后，同样四项失败，另加新增回归失败，即 **25/30 通过**；无新增既有测试失败。日志 `verification/backend-unit-round2.log`、`verification/backend-baseline-unit-round2.log`。四项为 `test_route_crosses_the_door`、`test_route_string_pull_and_door_centers`、`test_room_is_not_a_door_to_door_shortcut`、`test_same_named_elevators_pair_and_the_trip_has_two_legs`，涉及路线门中心或 `usedDoorIds` 断言。
- 改动文件的 `git diff --check` 通过。当前项目、`verification/P1.json`、三个 P1 overrides 共 **5/5** 文件 SHA-256 与修复前完全一致；快照项目内容仍与当前项目一致。楼梯轮廓、停靠点和 overrides 全部保留原数据。

### 剩余问题及验证边界

「房间 54」的内部区域仍封闭，本轮修复的是虚假网格连通性，未补画房间门。校正后沿用既有的“封闭目的地吸附到主通路”规则：目的地从 **(-1443.9, -178.5)** 校正为 **(-1603.9, -18.5)**；传入旧坐标时，路线也从后者出发，吸附距离 **226.3cm**。房间 `interior` 坐标仍为 **(-1303.9, -458.5)**。因此以上成功表示从真实主通路可导航，不能据此声称已打通房间内部。

上述四项后端既有测试失败未扩大范围修复。前端未改动，本轮没有重跑生产浏览器、构建及类型检查；第一轮记录的类型错误和切层加载耗时问题仍保留。

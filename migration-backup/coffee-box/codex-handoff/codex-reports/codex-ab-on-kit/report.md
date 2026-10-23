已完成 A → B（含第二轮）集成，并补齐 1F 西楼梯闭合轮廓。kit 的 120 条新增行全部保留，guard 无 WARN、全部 PASS；P1 楼梯为 2/2/1，共 5 个。最终前端专项单元测试 71/71、生产浏览器四个场景均通过；后端跨层配对 125/125、路线抽样 30/30，斜段 0、碰墙 0。所需六张截图均已从本副本拍摄并逐张查看。未提交、未推送；操作和产物均在 /workspace/codex-ab-on-kit 内，未改 kit-wt、merge-wt 本体。

前端目录是 `/workspace/codex-ab-on-kit` 根目录；后端是本副本 `be/`，复制 A 的后端后再叠加 B 第二轮修复。

改动及原因：

- `src/lib/components/viewer3d/ThreeViewer.svelte`、`src/lib/utils/floors.ts`、`src/lib/models/types.ts`：合入 A 的实际层高、踏步/平台几何和材质；再合入 B 的三步换层接近动作、取消动画和房间标签轮廓复用。楼梯采用 `MeshStandardMaterial`，复用 kit 的 `bakeVertexAo`，踏面细分保留烘焙渐变，roughness=0.55、metalness=0、vertexColors=true，参与场景环境和色调映射。
- `src/lib/components/viewer3d/nav/pipeline.ts`：沿用 A 的静态烘焙光照方式，关闭实时 shadowMap/SSAO，保留 HDR、bloom 和场景色调映射。
- `be/scripts/floor_overrides.py`、`be/scripts/pdf_building.py`：合入 A 的闭合轮廓生成、室外单层台阶排除、独立 stairs 原位写回和重新识别接入。补充读取既有 vertical_tag/vertical_add 的 polygon 作为缺失房间轮廓时的楼梯输入，复用同一尺寸生成规则。
- `be/data/overrides/P1-1F.json`：在已有 P1-stair-west 标记中补入四点闭合轮廓、边界厚度和 PDF 所示直梯朝向；2F/3F stairs 和 P1 project 同步保留。西梯数据依据原始 PDF 第 3 页踏步外缘，不按附近空名房间猜测。来源坐标和换算见 [west-contour-source.json](verification/west-contour-source.json)。
- `src/lib/components/viewer3d/nav/route.ts`、`src/routes/nav/+page.svelte`：合入 B 的 3×28cm 接近、楼梯升降 ±48cm、淡出 300ms → 遮住换层/恢复 → 淡入 300ms，以及停止播放时的请求与切层令牌。电梯接近保持水平。
- `be/scripts/floor_nav.py`、`be/tests/test_floor_nav.py`：合入 B 第二轮薄墙支路修复。支路复用墙体栅格封闭半宽及对齐门洞判定，避免把薄墙封住的格子重新涂通。
- `tests/floors.test.ts`、`tests/nav-route-depth.test.ts`、`tests/browser/nav-floor-transfer.spec.ts`：合入 A/B 专项验证；浏览器服务端口和产物路径指向本副本。

西梯轮廓为 `(-1402.08,18.81) → (-1222.58,18.81) → (-1222.58,234.69) → (-1402.08,234.69)`，单位 cm。生成对象如下，其他四个对象沿用 A：

| 楼层 | 对象 | 中心 (x,y)，cm | rotation | 宽×深，cm | 类型 | 级数/层高 |
| --- | --- | --- | ---: | --- | --- | --- |
| 1F | stair-room-39 | (1966.25,1146.77) | 0° | 110.30×188.90 | U 型 | 18 / 300cm |
| 1F | stair-P1-stair-west | (-1312.33,126.75) | 180° | 147.40×183.78 | 直梯 | 18 / 300cm |
| 2F | stair-room-37 | (2115.01,1323.15) | 0° | 105.20×220.45 | U 型 | 18 / 300cm |
| 2F | stair-room-42 | (-1114.95,-123.72) | 90° | 111.37×153.12 | U 型 | 18 / 300cm |
| 3F | stair-room-70 | (-1123.03,-78.53) | 90° | 83.65×147.23 | U 型 | 18 / 300cm |

每级高度 16.6667cm，18 级踏面顶高 300cm，含防滑条的网格最高点 300.29999cm。实际源代码转译生成 274 个网格，274/274 带烘焙顶点色、全部 Standard 材质、castShadow/receiveShadow 均为 0；顶点色范围 0.575884—1.000000。5/5 楼梯网格的 20/20 个平面包围角点位于其源闭合轮廓内。证据：[meshes-final.json](verification/meshes-final.json)、[footprints-final.json](verification/footprints-final.json)。

最终 project 的 stairs 之外全部字段与 A、B 源项目相等，墙体、门洞、房间和 verticalLinks 坐标保留；三个 overrides 的 stairs 与 project 一致。重复生成、原位写回不改变结果或文件哈希；P1/P2/P3 通用输入生成 5/3/3 个正尺寸对象，P2/P3 仅作验证。见 [generation-final.json](verification/generation-final.json)、[A-generation.json](verification/A-generation.json)。重算命令：

```sh
/workspace/.venv-gifu/bin/python /workspace/codex-ab-on-kit/be/scripts/floor_overrides.py /workspace/codex-ab-on-kit/be/data/kujiale-import/projects/b1f10000000000000000000000000001/project.json
```

guard 和构建/测试证据：

| 阶段 | guard | 构建 | 专项结果 |
| --- | --- | --- | --- |
| 初始副本 | PASS，15 GLB 一致 | — | [guard-baseline.log](verification/guard-baseline.log) |
| A 完成 | PASS，无 WARN | 成功 | 4 文件、34/34；274 个烘焙网格；后端 125/125 配对、29/30 抽样，复现 B 第二轮修复前阻断 |
| 合入 B 前 | PASS，无 WARN | — | [guard-pre-B.log](verification/guard-pre-B.log) |
| B 完成 | PASS，无 WARN | 成功 | 3 文件、37/37；后端 125/125 配对、30/30 抽样 |
| 西梯朝向最终校准 | PASS，无 WARN | 成功 | A+B 7 文件、71/71；P1 再验 12/12 配对、10/10 抽样 |

每次执行的 guard 命令均为 `/workspace/codex-stair-guard.sh /workspace/codex-ab-on-kit`，没有允许文件参数。六份 guard 日志均为以下原文：

```text
GLB 检查 15 个
GUARD PASS /workspace/codex-ab-on-kit
```

日志：[guard-A.log](verification/guard-A.log)、[guard-B.log](verification/guard-B.log)、[guard-final.log](verification/guard-final.log)、[guard-report.log](verification/guard-report.log)。独立校验确认 kit-wt 相对 5f77cdc 的 120 条新增非空唯一行全部存在；holeCuts/holeKeeper 所在核心块 35 行逐字一致；kitDressing.ts、navDoors.ts、layout.ts、openingAudit.ts、openingRules.ts、dressing.ts、app.css 以及 15 个 GLB 与 kit-wt 一致。见 [kit-preservation.json](verification/kit-preservation.json)。

构建日志：[build-A.log](verification/build-A.log)、[build-B.log](verification/build-B.log)、[build-final.log](verification/build-final.log)。测试日志：[tests-A.log](verification/tests-A.log)、[tests-B.log](verification/tests-B.log)、[tests-final.log](verification/tests-final.log)。修改脚本 py_compile、git diff --check 均通过。

后端整体验证使用 `python be/scripts/verify_import.py verification/current verification/baseline`：P1/P2/P3 两两跨层分别 12/12、90/90、23/23，抽样 30/30、斜段 0、碰墙 0，耗时中位 429ms、最大 2273ms，退出码 0。P1 包装的 project 为本副本实际项目，识别统计沿用原包装，不把识别统计中的台阶数冒充 floor.stairs 对象数。最终朝向校准后 P1 再验中位 216ms、最大 474ms，退出码 0。见 [backend-A.log](verification/backend-A.log)、[backend-B.log](verification/backend-B.log)、[backend-final-P1.log](verification/backend-final-P1.log)。

后端单元测试 26/30，通过新增薄墙回归 1/1；在本副本内存恢复 A 的修复前实现复跑相同 30 项，25/30，失败项多出新增回归，新增既有失败 0。四项共同失败为 test_route_crosses_the_door、test_route_string_pull_and_door_centers、test_room_is_not_a_door_to_door_shortcut、test_same_named_elevators_pair_and_the_trip_has_two_legs。见 [backend-unit-B.log](verification/backend-unit-B.log)、[backend-baseline-unit.log](verification/backend-baseline-unit.log)、[backend-test-comparison.json](verification/backend-test-comparison.json)。

生产浏览器四个场景均通过：模拟上楼、第一人称上楼、第一人称下楼、加载期间结束导航。前三项在首轮通过，取消项在最终构建服务重启后重跑 1/1；首轮取消项未进入流程的启动超时保留在日志中。普通导航使用本副本生产服务 5314、后端 8914，960×640、quality=low&kit=0、速度 3×，没有替换项目或 route/nav 响应。三个正常场景均 pageerror=0、最终进度 100%，6/6 淡出/淡入事件各 300ms，加载时 opacity=1；停靠点衔接一致。日志：[browser-B.log](verification/browser-B.log)、[browser-cancel-final.log](verification/browser-cancel-final.log)。

| 生产场景 | 淡出开始至楼层 URL 更新 | URL 更新至恢复透明 | 总等待 |
| --- | ---: | ---: | ---: |
| sim-up | 6992.6ms | 6115.9ms | 13108.5ms |
| fp-up | 7759ms | 10320.3ms | 18079.3ms |
| fp-down | 4397.2ms | 3472.1ms | 7869.3ms |

上述等待包含请求和场景重建，300ms 仅为透明度过渡时长。原始记录：[sim-up-production.json](verification/sim-up-production.json)、[fp-up-production.json](verification/fp-up-production.json)、[fp-down-production.json](verification/fp-down-production.json)。

所需截图均为本副本 5315 开发服务、当前最终源码，1280×800，high 质量、HDR+bloom、kit 开启、280cm 原墙高、500cm 特写相机；既有 noceil 钩子用于顶视特写。high 截图使用已有 hf0_bloom_nolut 测试模式绕过软件渲染环境的 LUT shader 问题，没有据此宣称默认 LUT 编译正常。请求项目只附加从现有几何计算出的有效 floorPolygon 缓存；源项目未写入该缓存。见 [screenshot-project.json](verification/screenshot-project.json)、[stair-shots.json](verification/stair-shots.json)。

| 截图 | 绝对路径 |
| --- | --- |
| 1F 西梯特写 | [stair-1F.png](/workspace/codex-ab-on-kit/shots/stair-1F.png) |
| 2F 西梯特写 | [stair-2F.png](/workspace/codex-ab-on-kit/shots/stair-2F.png) |
| 3F 西梯特写 | [stair-3F.png](/workspace/codex-ab-on-kit/shots/stair-3F.png) |
| 切层前，完整西梯口 | [fade-before.png](/workspace/codex-ab-on-kit/shots/fade-before.png) |
| 切层中，全黑遮罩 | [fade-middle.png](/workspace/codex-ab-on-kit/shots/fade-middle.png) |
| 切层后，3F | [fade-after.png](/workspace/codex-ab-on-kit/shots/fade-after.png) |

切层截图走本副本真实 1F 挂号 → 3F 体检窗口路线，换层一次。为稳定拍到全黑中间帧，仅延迟真实目标层 nav.json 响应放行，未替换内容；前后用现有截图相机接口构图，前帧相机坐标误差 <0.01cm、opacity=0，中间 opacity=1，淡出/淡入均为 300ms，pageerror=0。中间图 (220,200)—(780,600) 的 224000 个像素全部 RGB=(0,0,0)。这组受控截图不作为正常切层耗时或目标停靠点相机位置证据。见 [fade-shots.json](verification/fade-shots.json)、[shots-final.json](verification/shots-final.json)。生产测试另产生六张前后辅助图，均在本副本 shots/。

材质取样来自三张原始特写 PNG，以所列中心取 9×9 均值，Y′=0.2126R+0.7152G+0.0722B；亮度只是同帧显示值比较：

| 楼层 | 踏面中心 | 踏面 RGB | kit 地面中心 | 地面 RGB | 相对亮度差 |
| --- | --- | --- | --- | --- | ---: |
| 1F | [550, 550] | [161.96, 162.43, 163.23] | [820, 560] | [176.62, 175.28, 171.0] | -7.34% |
| 2F | [440, 500] | [165.43, 166.07, 166.78] | [830, 630] | [171.52, 170.49, 166.59] | -2.61% |
| 3F | [470, 510] | [168.78, 169.48, 170.23] | [820, 660] | [171.01, 168.73, 163.11] | +0.34% |

三层踏面取样均 B≥R，没有木色发黄；相邻地面与踏面亮度差为 −7.34% 至 +0.34%，烘焙明暗和深色防滑条可辨。见 [material-pixels.json](verification/material-pixels.json)。

剩余问题与验证边界：

- 全量类型检查仍为 32 errors、17 warnings、4 个文件，与 A/B 原报告一致；见 [check.log](verification/check.log)。楼梯/切层专项测试全部通过，不代表全量类型检查通过。
- 后端四项既有单元断言失败保留。B 第二轮修复的是虚假栅格连通性；房间 54 内部仍封闭，成功导航依赖既有向真实主通路吸附规则，不代表补通了房间内部。
- 默认 LUT 的软件渲染问题、正常切层 7.9—18.1 秒的总等待仍保留；2F 特写中的既有吊顶灯板遮挡部分上跑，截图保留了装饰组与 kit。
- 本轮未重跑整套 PDF/OCR，已验证生成入口、轮廓重算、独立 overrides 持久化和重复写回；仅补了用户指定的 1F 西梯轮廓，其他楼层的停靠点与房间识别沿用原数据。


## 第三轮

### A-1：西楼梯对象复核

沿用上一轮基于闭合轮廓/vertical 标记的通用生成规则，没有再改坐标。原命令重算输出 `{"1F":2,"2F":2,"3F":1}`，总计 5 个；3/3 P1 overrides 重算前后整文件字节一致（stairs 之外零改动）。证据：`verification/third-A1.json`。本副本西梯补图：`/workspace/codex-ab-on-kit/shots/third-A1-west-stair.png`；初始默认 high 发现既有 LUT 编译错误，A-1 图使用 high 的已有 no-LUT 模式，A-2 将修复默认模式。guard PASS，15/15 GLB 一致，日志 `verification/guard-third-A1.log` 和 `guard.log`。

### A-2：恢复全局正常画质

恢复 kit-wt 的 `shadowMap.enabled = quality !== 'low'` 和非 Windows SSAO，楼梯网格继续不投射/接收实时阴影；`pipeline.ts` 与 kit-wt 只剩 `texture3D` → WebGL2 `texture` 一处编译兼容修正。生产构建通过；默认 high、kit=1 的实测 pipeline 为 `hf_s4_ssao_bloom_lut_nowin_default`，无 shader/pageerror（见 `verification/third-A2.json`）。本副本以相同 kit 参数、隐藏 A 新楼梯对象作参考帧；两张墙面取样图各 5 个 9×9 RGB 样本、两块 800×600 区域差异均为 0.000%，满足 ≤2%。该比较验证恢复 kit 参数后新楼梯对远端墙面无影响，不是启动 kit-wt 拍图。原图 `shots/third-A2-{corridor,exterior}-{after,kit-reference}.png`，数字 `verification/third-A2-pixels.json`。guard PASS，日志 `verification/guard-third-A2.log`。A-1 西梯图已用修复后的默认 high 重拍。

### B-1：kit=1、正常画质回归（几何验收未通过）

测试改为 `quality=high&kit=1`，默认服务端口对齐 Playwright 管理的 4188，测试允许 300s 以容纳软件 GPU 正常画质加载。真实后端 8914、未替换项目/导航响应；四个场景一次完整重跑 **4/4 通过，7.0 分钟**，pageerror=0，三条到达路线进度 100%，6/6 淡入淡出各 300ms，加载期间取消通过。日志 `verification/browser-third-B1-retry.log`；首次运行独立 5314 服务退出导致的 3 个连接拒绝保留在 `verification/browser-third-B1.log`。图片 `shots/third-B-switch-{before,after}-{sim-up,fp-up,fp-down}-production.png`。相关前端专项 51/51 通过，`verification/tests-third.log`；guard PASS，`verification/guard-third-B1.log`。

**不能宣称 B-1 整项通过：**现有 B 动作每步固定 28cm / 16cm，没有读取 A 的踏面几何。1F 西梯实际踏深 10.21cm、级高 16.6667cm；入口停靠点处踏面已高 133.3333cm，第一至第三步实际踏面分别高 166.6667、216.6667、266.6667cm，脚底却只有 16、32、48cm，差值 150.6667～218.6667cm。3F 下楼的停靠点距西梯中心约 378.91cm，三步 3/3 均在楼梯矩形范围外。数据 `verification/third-B1-treads.json`，西梯可见形状 `shots/third-fp-candidate-2.png`。本项是回归检查；发现的原 B 动作和跨层停靠点/踏面入口关系需要联合修正，单独调步长或抬高相机不能解决下楼入口错位。本轮没有用相机跳转、改停靠点坐标或替换响应掩盖这项失败，也没有拍出可声称“三步踩踏面”的图。

### B-2：按平面图停靠点方位命名

`pdf_building.name_links` 不再平均不同层的图纸坐标；取最低层停靠点，并相对该层墙体范围中心计算八方位（按平面图坐标轴，不再旋转 northBearing）。P1 中心 `(90.15,619.93)`，东梯停靠点 `(1984.2,1187.7)` → `楼梯（东）`，西梯停靠点 `(-1312.3,144.8)` → `楼梯（西）`，**2/2 与平面图位置一致**。实际 project 只有两个 link.name 改动，所有停靠点、楼梯几何、房间、overrides 保留；整楼平移 `(+9000,-4200)` 后仍为东/西。证据 `verification/third-B2.json`。新增“上层图纸原点不同、stops/floors 乱序、无北箭头回退 A/B”回归通过；后端本文件共 16 项中 15 通过，另一个 boxed-shaft 测试报 `KeyError: at`，不涉及 name_links 调用，日志 `verification/tests-third-B2.log`。guard PASS，`verification/guard-third-B2.log`；可见标签截图接 E-1。

### E-1：路线图重拍

构建目录 **`/workspace/codex-ab-on-kit`（基于 kit-wt 的本副本）**，生产构建成功：`verification/build-third-E1.log`。按本轮“截图只从本副本、不改 kit-wt 本体”指令，实际截图服务也是本副本 5315 当前源码，没有把目录虚写成 kit-wt。默认 high、kit=1，真实 1F 挂号 → 3F 体检窗口路线，pageerror=0。两张 1280×800 图均晚于本轮 A-2/B-2 改动和构建日志时间，逐张查看：

- 总览：`/workspace/codex-ab-on-kit/shots/P1-route-3d-overview.png`。
- 换层前完整西楼梯口：`/workspace/codex-ab-on-kit/shots/P1-route-stair-transfer.png`，相机视高 160cm，暂停第一段播放后构图，保留完整入口和踏步；这张是入口可见性图，**不作为 B-1 三步踩踏面的通过证据**。

路线、时间和相机证据 `verification/third-E1.json`；guard PASS，`verification/guard-third-E1.log`。

### 第一人称截图、墙面材质核对

本副本默认 high、kit=1、1280×800、视高 160cm，走廊和靠外墙各一张，逐张查看。coffeeeeeee 的旧 poses 在本副本部分落点直接面对近墙，最终走廊相机改取本副本真实挂号 → 西药房路线上的位置 `(-745.1,889.7)`；靠外墙相机 `(-2050,174)`，视线命中本副本 `wall-185` 外侧面，距墙 153.33cm，内外材质均实测同值。

- 走廊最终图：`/workspace/codex-ab-on-kit/shots/P1-1F-fp-corridor.png`。
- 靠外墙最终图：`/workspace/codex-ab-on-kit/shots/P1-1F-fp-exterior.png`。
- 同相机前后：`/workspace/codex-ab-on-kit/shots/third-wall-corridor-before.png`、`third-wall-corridor-after.png`；`shots/third-wall-exterior-before.png`、`third-wall-exterior-after.png`。相机记录 `verification/third-wall-{before,after}.json`。

根因是医院墙面材质附加 shader 与自发光，以及墙顶、内外侧使用不同构造。现在导航内外墙和墙顶统一复用 `createHospitalSurfaceMaterial` 的原墙面分支，保留 kit 烘焙 AO，删除附加墙面 shader 和自发光；原素材 `MH02_Clinic_Wall_Module.glb` 的 `MAT_WHITE.001` 线性 RGB=`(0.78,0.82,0.80)`、roughness=0.36、metalness=0.03、无贴图/自发光、DoubleSide，数值误差 <1e-7。**354/354 个墙网格、2124/2124 个材质槽全部符合；内侧槽 4 和外侧槽 5 各 354/354 一致，异常 0。**现有踢脚线和 kit-skirt 统一 `#7d817f`、roughness=0.82、metalness=0，301/301 网格一致。原文件与哈希证据 `verification/third-wall-source.json`。

材质核对边界：原包 Base_Trim 实际是深青色 MAT_TEAL_DARK，并不是深灰；按本轮明确要求保留 kit 已认可的深灰，不把它冒充原包的青色原参数。恢复原墙面零自发光后，当前灯光下外墙三个 9×9 样本显示亮度下降 21.27%～21.51%，墙面 RGB 由约 `(161,159,154)` 变为 `(122,126,125)`；走廊左墙样本下降 25.63%。**原材质参数一致，但当前场景受光仍偏暗，未额外改变全局灯光来伪装成原包展示照明。**数字 `verification/third-wall-pixels.json`。

最终构建通过 `verification/build-third-final.log`；前端专项 51/51 `verification/tests-third-final.log`；全量 check 仍为 32 errors / 17 warnings / 4 files，`verification/check-third.log`，不宣称全量类型检查通过。guard PASS，`verification/guard-third-wall-final.log`、`verification/guard-third-FPS.log`。唯一允许差异为 `dressing.ts` 的 import 和两个墙顶材质构造，共 3 行；独立逐字核对其余内容与 kit-wt 一致。ThreeViewer 的 kit 新增行 120/120 保留，15/15 GLB 一致，`verification/third-kit-preservation.json`。

### B-3（可选）：切层耗时定位，≤3 秒未达到

最终生产构建目录 `/workspace/codex-ab-on-kit`，本副本生产 5314 / 后端 8914，960×640、low、kit=1、真实第一人称 1F 挂号 → 3F 体检窗口；无其他自动化浏览器并行，pageerror=0。淡出开始到恢复透明 **16980ms（16.980 秒）**，不宣称 ≤3 秒。按浏览器 Resource Timing 和同一 rAF 记录分解：

| 区间 | 毫秒 |
| --- | ---: |
| 开始淡出 → 发起 nav 请求 | 301.1 |
| 目标层 nav 请求 | 93.3 |
| nav 响应完成 → 楼层 URL 已更新 | 13957.2 |
| URL 更新 → 恢复透明 | 2628.4 |
| 总计 | 16980.0 |

**瓶颈在客户端切层/场景重建和恢复阶段，目标层请求只占 0.55%。**后端缓存命中 HTTP 实测三层 6.55、7.19、8.29ms；客户端房间共享几何与旧标签 fallback 合计 1F/2F/3F 46.6/7.3/10.4ms，不能将十几秒归因于房间几何计算。最终墙材质下稳定靠外墙视角 GPU 同步帧基准 9.83ms/帧（3 帧、309 calls、58749 triangles），也不代表首次重建的成本。现有 navCache 已缓存 nav 数据；提前拿到下一层响应最多省本次 93.3ms，不能把 16.98 秒降到 3 秒，所以没有为这点收益新增缓存层。已定位到响应后重建/恢复阶段，**尚未拆分具体构建函数和首帧 shader/GPU 的各自耗时，也没有实施 3D 场景缓存。**证据 `verification/third-B3-low.json`、`third-B3-geometry-profile.json`、`third-wall-after.json`。

正常 high 回归的三次总等待分别 18.352、18.062、27.130 秒，分段数字 `verification/third-B3-transfer-times.json`；它们在墙面原参数修正之前采集，不拿它们与最终 low 测量作同条件性能提升比较。guard PASS，日志 `verification/guard-third-B3.log`。

### 第三轮验收结论

A-1 的 2/2/1 楼梯计数、A-2 正常 pipeline 恢复、B-2 东/西标签、E-1 路线图、本副本两张第一人称图、墙面原参数/深灰踢脚线一致性均有数字和原图证据。B-1 浏览器流程 4/4，但“三步踩踏面、不穿模”仍未通过；B-3 已给出客户端瓶颈分段，低画质 ≤3 秒未达到。墙面原参数恢复后在现有灯光下仍偏暗；全量类型检查 32 errors / 17 warnings 和后端 boxed-shaft 1 个报错保留。仅改本副本，未推送，未改 kit-wt / merge-wt 本体。

最终产物核查：本轮 9/9 张指定/对比图片均存在且逐张查看，改动源文件定向 `git diff --check` 通过，`verification/third-source-diff-check.log` 为空。全范围 diff 检查包含此前复制的 be/vendor、PDF 和原始测试日志，因这些文件的原始空白报错；保留证据和任务范围外文件，没有为通过检查清理素材或改写日志。最终 guard 仍为 PASS。


## 第四轮

已按通用规则去掉三栋楼 3D 场景的楼梯门牌、吊牌及房间名称牌；其他房间牌子、搜索列表和导航换层文字保留。未推送。

本轮只改三个源码文件：`nav/signs.ts` 统一按原名称、显示名称、stairs 图标或换层点 kind 判断楼梯，在原布局计算后筛除楼梯牌子，避免其他门牌因释放空间而移动；`ThreeViewer.svelte` 将同一规则用于本层、跨层总览和普通 3D 房间名称牌；`routes/nav/+page.svelte` 只补传换层点 kind。净改动为新增 19 行、删除 12 行，未改门洞、楼梯几何、灯光或源项目数据。定向差异：[fourth-source.patch](verification/fourth-source.patch)，反向应用检查及三个源码文件的 `git diff --check` 均通过。

12 层原几何输入逐层复算，楼梯门牌和吊牌 **21→0**；其他 **316/316** 个牌子的完整布局数据（名称、坐标、朝向、尺寸和高度）逐项一致。楼梯原名、英文名称、显示别名、图标和 kind 分类检查 8/8 通过。证据：[fourth-before.json](verification/fourth-before.json)、[fourth-sign-validation.json](verification/fourth-sign-validation.json)。此表统计门牌/吊牌布局，不把总览文字或楼梯搜索项重复计入。

| 楼栋 | 楼层数 | 楼梯牌子前→后 | 其他牌子保持一致 |
| --- | ---: | ---: | ---: |
| P1 | 3 | 10→0 | 118/118 |
| P2 | 5 | 5→0 | 150/150 |
| P3 | 4 | 6→0 | 48/48 |
| 合计 | 12 | 21→0 | 316/316 |

生产构建通过：[build-fourth.log](verification/build-fourth.log)。门牌、房间名称、导航文案及路线专项测试 **27/27** 通过：[tests-fourth.log](verification/tests-fourth.log)。全量类型检查仍为既有 **32 errors / 17 warnings / 4 files**，没有新增，不宣称全量 check 通过：[check-fourth.log](verification/check-fourth.log)。

Guard 命令及结果：

```text
/workspace/codex-stair-guard.sh /workspace/codex-ab-on-kit src/lib/components/viewer3d/nav/dressing.ts src/lib/components/viewer3d/ThreeViewer.svelte
GUARD PASS /workspace/codex-ab-on-kit
```

允许项已逐项核对：`dressing.ts` 仍只有第三轮记录的三行墙面材质差异，本轮未修改；ThreeViewer 的 WARN 2 行分别为增加 `isStairSign` 导入、补传 `labelIcon`。kit 的 120 条新增行中 118 条原样保留；去除这两处增补后 120/120 条全部存在，15/15 个 GLB 逐字节一致。日志及独立核对：[guard-fourth.log](verification/guard-fourth.log)、[fourth-kit-preservation.json](verification/fourth-kit-preservation.json)。

截图全部来自本副本 `http://127.0.0.1:5315` 当前源码，1280×800、默认 high、kit=1，pipeline 实测 `hf_s4_ssao_bloom_lut_nowin_default`，同相机前后对比，共 **8/8** 张已查看。P1 使用本副本实际 project，P2/P3 使用本副本已有 `verification/current` 快照；截图项目仅附加由原几何计算的 floorPolygon 缓存，导航视图由本副本 `floor_nav.nav_view` 生成，响应快照用于稳定构图，未写回源项目。输入证据：[fourth-screenshot-projects.json](verification/fourth-screenshot-projects.json)、[fourth-screenshot-nav.json](verification/fourth-screenshot-nav.json)。

| 对比场景 | 修改前 | 修改后 |
| --- | --- | --- |
| P1 西梯吊牌 | [前图](shots/fourth-P1-stair-before.png) | [后图](shots/fourth-P1-stair-after.png) |
| P2 楼梯 A 吊牌 | [前图](shots/fourth-P2-stair-before.png) | [后图](shots/fourth-P2-stair-after.png) |
| P3 楼梯门牌及相邻房间 | [前图](shots/fourth-P3-stair-before.png) | [后图](shots/fourth-P3-stair-after.png) |
| P1 总览名称牌 | [前图](shots/fourth-P1-overview-before.png) | [后图](shots/fourth-P1-overview-after.png) |

三栋楼浏览器场景 **3/3** 通过，实际场景楼梯门牌/吊牌和本层总览名称牌均为 0，pageerror=0；相机、其他门牌的名称/位置/方向与修改前一致。楼梯搜索索引 **11/11** 项完全保留（P1/P2/P3 为 5/3/3）。P1 的真实后端 8914 挂号→3F体检窗口路线仍提示「走楼梯（西）上到 3楼（共 2 层）」；跨层总览中仅保留路线连接点「在此换乘：楼梯（西）」文字，房间楼梯名称牌为 0。证据：[fourth-shots-before.json](verification/fourth-shots-before.json)、[fourth-shots-other-before.json](verification/fourth-shots-other-before.json)、[fourth-shots-after.json](verification/fourth-shots-after.json)。

三张第一人称对比图逐像素核对，变化像素分别为 P1 **5906**、P2 **28841**、P3 **6243**；变化边界分别为 `(444,248)-(578,339)`、`(346,258)-(654,449)`、`(445,376)-(573,430)`，均只覆盖楼梯牌子及支架，各边界之外像素差异 **0**。图片尺寸和 SHA-256 证据：[fourth-shots-validation.json](verification/fourth-shots-validation.json)。

剩余问题：上述既有全量类型检查错误仍保留；本轮不涉及第三轮的踏面动作、切层耗时和墙面受光问题。最终汇总采用程序逐层求和的 21→0，纠正了中途手工加总的 24。仅修改本副本，未推送。


## 第五轮

已修复第一人称走廊宽通行区漏灯，天花板统一为素材包墙体原色的纯色哑光；灯板保留发光贴片和原灯框，去掉地面模拟光斑，未增加实时光源。仅修改本副本，未推送。

根因：正常第一人称一直会生成覆盖走廊的天花板。原图 `third-fp-candidate-4.png` 顶部的深灰区域就是旧色天花板；同相机复现时 visible=true、高度 **279.5cm**、裁切面 **1000000cm**。原图与本轮前图三处 9×9 天花板样本最大差异 **1、0、1** 个色阶，支持“已生成且未隐藏”的判断。灯板布局只覆盖房间和横截面不超过 **450cm** 的窄走廊，原图前方更宽的通行区没有灯板。证据：[原图核对](verification/fifth-original-ceiling.json)、[修改前场景](verification/fifth-before.json)、[布局复算](verification/fifth-layout.json)。

源码改动：`nav/layout.ts` 为三面围合、可留开放入口的宽通行区补充 **300cm** 网格灯板，避开房间、墙体和建筑边缘；原 **19/19** 个窄走廊灯位及排列完全一致，宽区新增 **30** 个。`nav/dressing.ts` 和 `ThreeViewer.svelte` 的覆盖天花板、房间天花板复用现有墙面材质工厂，再设 roughness=**0.95**、metalness=**0**，不加贴图或材质纹理；删去灯板附带的地面光斑。现有布局测试补充开放入口宽厅和两面开放室外空间两项回归。

P1 1F 浏览器实测：**142/142** 片天花板（141 片房间天花板及 1 片整体覆盖天花板）线性 RGB 均为 **(0.78,0.82,0.80)**，与原素材 `MH02_Clinic_Wall_Module.glb / MAT_WHITE.001` 颜色误差 <**3e-8**，均无贴图、无自发光且为上述哑光参数。**2124/2124** 个墙面材质槽仍保持原颜色、roughness=0.36、metalness=0.03。灯板总数 **77→107**，原图前方新增 **3** 块，中心为 `(-1500,276,900)`、`(-1200,276,900)`、`(-900,276,900)`（cm），使用高于 1 的 MeshBasicMaterial 颜色配合现有 bloom；场景 PointLight/SpotLight 均为 **0**，全局灯光参数未改。证据：[修改后场景与材质](verification/fifth-after.json)、[原素材参数与哈希](verification/third-wall-source.json)。

前后图均从 **/workspace/codex-ab-on-kit** 的 **http://127.0.0.1:5315** 当前源码拍摄，1280×800、默认 high、kit 开启、原墙高 **280cm**、视高 **160cm**，同相机位置 `(-745.1,160,889.7)`、目标 `(-1245.1,150,889.7)`，均已逐张查看。使用本副本第四轮已有 P1 项目/nav 快照及第三轮挂号→西药房路线响应稳定构图，未写回源项目，没有调用隐藏天花板的钩子。实际点击「第一人称」并等待正常显示，实测 look=walk、裁切面=1000000；点击「结束」后 look=overview、裁切面=115、天花板/灯板组隐藏。随后冻结同一第一人称相机拍对比图，pageerror=**0**。[正常模式切换](verification/fifth-view-modes.json)。

| 修改前 | 修改后 |
| --- | --- |
| [第一人称走廊前图](shots/fifth-fp-corridor-before.png) | [第一人称走廊后图](shots/fifth-fp-corridor-after.png) |

后图天花板区域检出 **10** 个新增高亮灯板连通区域、**6270** 个高亮像素；此数为截图可见区域的图像统计，不等于全层灯板总数。[截图尺寸、SHA-256 和区域阈值](verification/fifth-shots-validation.json)。

验证：生产构建通过，[build-fifth.log](verification/build-fifth.log)；布局、墙高、标牌专项 **32/32** 通过，[tests-fifth.log](verification/tests-fifth.log)；改动源码、测试和报告的 `git diff --check` 通过。

Guard 命令及结果：

```text
/workspace/codex-stair-guard.sh /workspace/codex-ab-on-kit src/lib/components/viewer3d/nav/layout.ts src/lib/components/viewer3d/nav/dressing.ts src/lib/components/viewer3d/ThreeViewer.svelte
GUARD PASS /workspace/codex-ab-on-kit
```

允许项是本轮灯位、吊顶材质及灯板改动；`dressing.ts` 的三行墙顶材质差异继承第三轮。ThreeViewer 的 WARN 仍为第四轮已核对的两行楼梯标牌增补，本轮没有新增丢失行；kit 新增行 **118/120** 原样保留，另两行保持第四轮修改。**15/15** 个 GLB、kitDressing/navDoors/openingAudit/app.css 与 kit-wt 逐字节一致：[guard-fifth.log](verification/guard-fifth.log)、[独立保留核对](verification/fifth-kit-preservation.json)。

剩余问题：全量类型检查仍有既有 **32 errors / 17 warnings / 4 files**，错误与警告文本均与第四轮逐条一致，未新增；没有把全量 check 记为通过。[check-fifth.log](verification/check-fifth.log)、[前轮对比](verification/fifth-check-comparison.json)。

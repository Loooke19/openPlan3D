复核要求的楼梯材质、独立 overrides 持久化、房间核实和截图已修改并验证，guard 为 PASS。P1 现有 4 个楼梯对象，分层为 1/2/1；1F 室外台阶误生成的层间楼梯已排除。verify_import 仍有任务 C 暂缓的唯一失败；未修复该路线，也未修改房间命名或门洞几何。

本轮改动文件及原因：

- [floor_overrides.py](/workspace/codex-stair-obj/be/scripts/floor_overrides.py)：保留从闭合楼梯房间轮廓求旋转包围矩形的通用规则；增加对只在单层出现的 stairs link 标记的排除，避免把明确不连楼层的室外台阶拉高为层间楼梯。新增原位写入 stairs 字段及重算命令，更新该字段时不重新序列化其他内容。
- [pdf_building.py](/workspace/codex-stair-obj/be/scripts/pdf_building.py)：生成步骤传入楼栋名称以读取通用 overrides 标记；重新识别仍从修改后的轮廓重新计算，不依赖旧 stairs 数组。沿用第一版的 floor.height 与层高计算。
- [P1-1F.json](/workspace/codex-stair-obj/be/data/overrides/P1-1F.json)、[P1-2F.json](/workspace/codex-stair-obj/be/data/overrides/P1-2F.json)、[P1-3F.json](/workspace/codex-stair-obj/be/data/overrides/P1-3F.json)：仅插入独立 stairs 数组。与本轮开始时原文比较，原有内容逐字节保留；其他字段值全部相等。当前 [project.json](/workspace/codex-stair-obj/be/data/kujiale-import/projects/b1f10000000000000000000000000001/project.json) 仅 floors[*].stairs 的值改变。
- [ThreeViewer.svelte](/workspace/codex-stair-obj/fe/src/lib/components/viewer3d/ThreeViewer.svelte)：楼梯改用 MeshStandardMaterial，复用 kit 的 bakeVertexAo，在生成时烘焙高度接触明暗、立面明暗及踏面后缘遮蔽；细分踏面的纵向顶点以保留渐变。楼层高度继续取相邻 elevation 差，顶层用 height 或上一层差。修正现有开发截图接口：相机高度同步到漫游高度，noceil 能隐藏嵌套 ceiling 网格。未隐藏 NavDressing 组。
- [pipeline.ts](/workspace/codex-stair-obj/fe/src/lib/components/viewer3d/nav/pipeline.ts)：导航管线关闭实时 shadowMap，取消创建 SSAOPass，保留高质量 HDR、bloom 和色调映射；静态 AO 仍来自 kit 的烘焙层及顶点色。

材质依据已核实：hospitalMaterials.ts 的普通医院地面是 MeshStandardMaterial + 程序化/PBR 细节；启用 kit 后，实际覆盖地面的是 kitDressing.ts 的 kit-floor，MeshStandardMaterial、roughness=0.55、metalness=0，CanvasTexture 为 sRGB。主砖面 KIT_PALETTE.MAT_WHITE=#eceae4，即 RGB(236,234,228)，接缝底色 #e2e0da。该地面材质自身没有 lightMap/aoMap；NavDressing 把墙体足迹预计算为 1024² 的乘法 AO 蒙版，kit 的墙体和设备使用烘焙顶点色。

楼梯采用同类 Standard 材质与同一 kit 顶点色烘焙函数。踏面颜色取主砖面线性 RGB 均值后去色偏，实际为 #e9e9e9；侧面 #c7c7c7，前缘条 #55595c。它们都参与同一环境、曝光和最终色调映射。没有引入外部瓷砖贴图、实时 AO 或楼梯 castShadow。烘焙顶点色范围为 0.575884—1.000000。

截图取样使用原 PNG 中以所列坐标为中心的 9×9 像素均值，坐标原点为左上角，单位为原图像素。亮度差使用显示值代理 Y′=0.2126R+0.7152G+0.0722B；比较同一帧内邻近的 kit 砖面与踏面：

| 楼层 | 地面取样坐标 | kit 地面 RGB | 踏面取样坐标 | 楼梯踏面 RGB | 踏面相对亮度差 |
| --- | --- | --- | --- | --- | ---: |
| 1F | (270, 950) | (178.0, 177.1, 173.3) | (850, 790) | (172.3, 173.0, 173.9) | -2.32% |
| 2F | (1430, 1100) | (174.0, 173.0, 169.0) | (800, 830) | (169.0, 169.7, 170.3) | -1.94% |
| 3F | (1000, 1150) | (180.0, 178.8, 174.0) | (850, 790) | (168.5, 169.1, 169.9) | -5.44% |

踏面均略暗于相邻地面，三个取样的 B 均不低于 R，未出现发黄或明显过亮。1F 同图立面 RGB=(92.8,93.8,93.9)，前缘条 RGB=(27.3,32.6,36.6)，可区分踏面、立面和防滑条；取样坐标、精确均值与相机证据均在 [screenshots.json](/workspace/codex-stair-obj/validation/screenshots.json)。

1F 房间核实结果：

- 两个名为“楼梯”的房间是 room-39 与 room-56。room-39 轮廓范围 x=1891.32—2041.18、y=1032.54—1261.00，包含东楼梯跨层站点 (1984.2,1187.7)，保留 stair-room-39。
- room-56 轮廓范围 x=2041.18—2155.35、y=1661.20—1887.24，包含 P1-steps-east=(2150.9,1808.6)。既有 1F overrides 明确把它标为室外台阶、不连楼层；第一版按名称生成 stair-room-56 确实把这处台阶当成了楼梯间，本轮排除其层间对象，保留原房间名称。
- 西楼梯站点 (-1312.3,144.8) 不在任何现有闭合房间轮廓内，当前 project.json 没有可对应它的房间名。最近的 room-136、room-125、room-25 名称均为空；附近 room-4 叫“挂号”，也不包含该点，不能把它认作西楼梯间。没有可用于生成的楼梯房间轮廓，因此不凭邻近关系补造对象。
- 没有采用 verticalLinks.roomId 作为唯一筛选依据：1F 东梯 stop 的 roomId 仍为 room-38（名“卫生”），而站点坐标实际落在 room-39。通用规则继续按名为“楼梯”的实际轮廓生成，仅排除单层独立标记；不修改既有站点或房间数据。

| 楼层 | 名为“楼梯”的房间 | 排除的单层台阶房间 | floor.stairs / overrides.stairs |
| --- | ---: | ---: | ---: |
| 1F | 2 | 1 | 1 / 1 |
| 2F | 2 | 0 | 2 / 2 |
| 3F | 1 | 0 | 1 / 1 |

对象参数：坐标、宽、深和高度单位 cm，rotation 单位度。全部 direction=up、stairType=u-shaped。

| 楼层 | id | position(x,y) | rotation | width | depth | riserCount | 总高度 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1F | stair-room-39 | (1966.25,1146.77) | 0 | 110.30 | 188.90 | 18 | 300 |
| 2F | stair-room-37 | (2115.01,1323.15) | 0 | 105.20 | 220.45 | 18 | 300 |
| 2F | stair-room-42 | (-1114.95,-123.72) | 90 | 111.37 | 153.12 | 18 | 300 |
| 3F | stair-room-70 | (-1123.03,-78.53) | 90 | 83.65 | 147.23 | 18 | 300 |

四个对象各自的第 1—18 级踏面高度均为：16.67、33.33、50.00、66.67、83.33、100.00、116.67、133.33、150.00、166.67、183.33、200.00、216.67、233.33、250.00、266.67、283.33、300.00。网格最高点约 300.30cm，含 0.30cm 前缘条。

房间轮廓变化后，重算 overrides 与 project.json 的命令（从任意目录运行）：

```bash
/workspace/.venv-gifu/bin/python /workspace/codex-stair-obj/be/scripts/floor_overrides.py /workspace/codex-stair-obj/be/data/kujiale-import/projects/b1f10000000000000000000000000001/project.json
```

已实际执行，输出 `{"1F": 1, "2F": 2, "3F": 1}`；再次运行项目内容、三份 overrides 原文均保持不变。生成尺寸仍沿用墙厚加 10cm 总余量、长宽比 ≥1.8 选直梯，否则 U 型、层高/17cm 取整的规则，不引用 P1 固定坐标。

验证结果：

- 最终 `npm run build` 成功，生产版 5311 导航页 HTTP 200；8911 项目接口成功。见 [build.log](/workspace/codex-stair-obj/build.log)。
- 层高、楼层堆叠、楼梯朝向和平面轮廓专项测试 4 个文件、34/34 通过，见 [tests.log](/workspace/codex-stair-obj/tests.log)。
- 实际 buildStairs 源码转译后构建 4 个对象、220 个 Mesh：220/220 含顶点色，材质全部 Standard，楼梯 castShadow=0、receiveShadow=0，最高点 300.29999cm。见 [stair-meshes.json](/workspace/codex-stair-obj/validation/stair-meshes.json)。
- P1/P2/P3 当前验证输入合计生成 10 个对象（4/3/3），尺寸均为正，重复生成一致；仅 P1 写回项目。旋转与层高用例：30°/340cm→20 级，−25°/390cm→23 级，顶层 360cm→21 级，全部通过。
- 两个后端脚本 py_compile、前后端 git diff --check 通过。
- 要求的 guard 命令为 PASS，15 个 GLB 一致。两条允许文件内的 WARN 对应扩展 kit import 与修正 noceil 条件，已核对原 kit 功能保留。见 [guard.log](/workspace/codex-stair-obj/guard.log)。
- `verify_import.py ../validation/current ../validation/baseline`：跨层配对 P1=12/12、P2=90/90、P3=23/23，合计 125/125；路线抽样 29/30、斜段 0、碰墙 0。唯一失败仍为 P1“2F 房间54 → 3F 房间65”，blocked，退出码 1，按复核第 5 条留给暂缓的任务 C。见 [verify-import.log](/workspace/codex-stair-obj/verify-import.log)。P1 包装中的 project 来自本次实际 project.json，识别统计沿用原包装；对象数量以 floor.stairs 为准。
- 全量 `npm run check` 仍为原有的 32 errors、17 warnings（4 个文件），楼梯材质和本轮生成逻辑没有新增诊断。见 [check.log](/workspace/codex-stair-obj/check.log)。

截图均来自本任务 fe 的代码，最终构建同源；使用开发版 5313 的既有截图接口，high 质量、HDR+bloom、现有 hf0_bloom_nolut 模式绕过测试环境的 NavFinalLut texture3D 编译错误。墙高保留 280cm，截面裁剪提升到 1e6，NavDressing 和 kit 组显示，仅隐藏天花板；相机高 500cm。逻辑视口 1440×900，原图 2160×1350。请求项目只附加已有房间轮廓缓存，未改墙体、房间名称和项目文件，见 [screenshot-project.json](/workspace/codex-stair-obj/validation/screenshot-project.json)。五张均已逐张查看，覆盖原文件：

- [1F 东楼梯特写](/workspace/zone-audit/shots/A-stair-1F-stair-room-39.png)
- [1F 室外台阶区域：已排除层间对象](/workspace/zone-audit/shots/A-stair-1F-stair-room-56.png)
- [2F 东楼梯特写](/workspace/zone-audit/shots/A-stair-2F-stair-room-37.png)
- [2F 西楼梯特写](/workspace/zone-audit/shots/A-stair-2F-stair-room-42.png)
- [3F 楼梯特写](/workspace/zone-audit/shots/A-stair-3F-stair-room-70.png)

剩余问题：任务 C 的唯一导航阻断和既有全量类型错误保留；1F 西楼梯缺少可对应的闭合房间轮廓，未越界修补房间/墙体。2F 截图保留的吊顶灯板局部遮挡上跑，左侧踏步仍清晰可见。未重跑整套 PDF/OCR，已验证重新识别中的通用接入步骤及从现有轮廓重算、原位写回命令。未提交或推送代码。

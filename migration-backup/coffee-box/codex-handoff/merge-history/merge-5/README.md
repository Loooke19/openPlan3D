已合入 task C 并完成 floor3 通用修复；累计补丁基于 `5f77cdcacae290e47ce439041371acadc0375325`，包含 merge-3b（slab2）及 task C，未推送。

- **1F 外围地砖环：slab2 已修复，本轮未重复改导入器。** `maker_cad.cad_footprint` 从 CAD 墨迹闭合轮廓生成 boundary，`openplan_project.py` 将其写为 footprint；原渲染直接铺满 footprint，没有要求房间/走廊支撑。尺寸线是否贡献了特定轮廓尚未逐条核实，确定的根因是将识别轮廓当作可铺地面。保留 slab2 的房间/走廊有效地面规则：P1/P2/P3 1F 分别排除原 footprint 的 **389.89 / 240.33 / 68.63 ㎡**；前后图均确认无外围地砖环。
- **3F 无纹理：发生于跨层展开视图。** 活动层原本有地砖；`setNavFloorStack` 通过 `buildFloorIntoGroup` 只生成纯色房间楼板。提取并复用 `createKitFloorMesh`，跨层楼板使用同一纹理、200 cm 世界坐标 UV、floorRegions 和排除框。跨层 P1 3F 新增 **1 个带纹理地面网格，991.91458 ㎡**。
- **高柱：是 kit 墙角/墙面装饰柱，不是 PDF 结构柱或门框/接缝圆柱。** 12 层数据的 columns 均为 0；装饰柱固定高 277 cm，且 navDressing 被概览裁切跳过，墙却裁到 115 cm。通用规则将装饰高度限制为宿主墙高，墙角取相接墙的较低高度；`setCut` 同步调整实例几何，保留封闭顶面，第一人称恢复完整高度。P1 3F **177 根柱**数量不变，概览顶高 **277→115 cm**；局部后图已确认无高出墙顶的柱。

Task C 仅合入功能增量：2F 房间54的 100 cm 门、楼梯走廊侧入口、三个 2F/3F 落点 override，以及导航保留显式落点坐标。三个点均在对应房间内，重复应用结果不变。没有楼栋/楼层/房间 ID 的显示规则分支。

| 验证 | 结果 |
|---|---|
| 每步 guard | PASS，15/15 GLB 字节一致 |
| task C 合入后、最终寻路/跨层测试 | 两次均 20＋12＝**32/32** |
| FE 关联测试 / BE override | **66/66 / 21/21** |
| verify_import | 跨层 **125/125**，抽样 **30/30**，斜段/碰墙 **0/0** |
| 三栋共 12 层渲染规则 | 纹理 **12/12**；面积最大误差 **0.329 cm²**；高度违规 **0**；概览顶高≤115 cm，完整高度恢复≤宿主墙高 |
| build / diff-check / 浏览器 | 成功 / PASS / pageerror **0** |
| 干净基准补丁 check＋实际 apply | 两项 exit 0；**174/174** 文件内容及权限一致 |

guard 沿用 slab2 允许项。相对 merge-3b，163 个文件逐字节保留；本轮未改 layout、dressing、openingAudit、navDoors、app.css 或 GLB。ThreeViewer 原有裁门/楼板洞逻辑保留，guard 的额外行匹配提示来自增加地砖函数的 import；详见 [scope-audit](logs/scope-audit.json)、[guard](logs/guard-final.log)。完整数字见 [verify_import](logs/verify-taskc.log)、[12层规则检查](logs/general-render-audit.json)、[补丁检查](logs/patch-validation.json)。

截图由 **kit-wt** 的 Vite/渲染器在 4251 启动，以只读源码覆盖读取当前工作副本；kit-wt 源文件未改，也未使用 fe-shot。960×640、low、kit=1；前图为 slab2＋task C、后图为本轮修复，同机位，原始截图未改像素。所有六组后图已打开目视核验。

| 画面 | 前图 | 后图 |
|---|---|---|
| P1 1F | [前](shots/P1-1F-overview-before.png) | [后](shots/P1-1F-overview-after.png) |
| P2 1F | [前](shots/P2-1F-overview-before.png) | [后](shots/P2-1F-overview-after.png) |
| P3 1F | [前](shots/P3-1F-overview-before.png) | [后](shots/P3-1F-overview-after.png) |
| P1 3F 活动层 | [前](shots/P1-3F-floor-before.png) | [后](shots/P1-3F-floor-after.png) |
| P1 1F→3F 展开层 | [前](shots/P1-1F-3F-stack-before.png) | [后](shots/P1-1F-3F-stack-after.png) |
| P1 3F 高柱局部 | [前](shots/P1-3F-posts-area-before.png) | [后](shots/P1-3F-posts-area-after.png) |

另附 [3F 展开层地砖近图](shots/P1-3F-stack-detail-after.png)。机位及网格记录见 logs/shots-*.json；高柱最终机位见 [posts-area-camera](logs/posts-area-camera.json)。

在干净基准根目录应用累计补丁，不叠加旧累计补丁：

```sh
git apply --check /workspace/merge-5/fe.patch /workspace/merge-5/be.patch
git apply /workspace/merge-5/fe.patch /workspace/merge-5/be.patch
```

dev 5381，Playwright 4251，后端 8981。logs/P1.json、P2.json、P3.json 保存验收快照（project 字段为运行模型）；运行数据沿用忽略规则，不进入补丁。既有项目需重导入或同步快照以应用 task C。剩余验证范围：未重跑全量 PDF/OCR；本轮 verify_import 使用已验收导入快照及当前有效地面规则。

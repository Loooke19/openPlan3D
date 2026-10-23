已完成采光顶的通用规则修复。累计补丁相对 kit-wt 基准 `5f77cdcacae290e47ce439041371acadc0375325`，包含 merge-2 全部内容；未提交或推送，未修改 kit-wt、merge-wt。

## 改动与原因

- `walls_remove_box` 原先只删除框内墙体，没有表示非房间区域。给非房间框增加明确的 `roomType: "void"` 标记，导入后生成 `floor.footprintExclusions`；有效 footprint 为原外轮廓减去这些框。仅给 P1-3F 既有采光顶框补充语义标记，运行规则没有楼栋、楼层或墙 ID 分支。
- Kit 地砖直接扣除排除框的几何，支持多框、重叠框、跨外边界框及任意楼层，保留原世界坐标砖纹。无排除框时保留原几何。Kit 墙面方向判断也避开排除区。
- 寻路在门洞和房间通道绘制完成后屏蔽排除区，并将排除框纳入几何缓存键，避免门洞重新开放禁行区或复用旧网格。路线的碰撞检测也按排除框的实心矩形求交，防止平滑将绕行路径拉直穿过排除区；该障碍只用于寻路，不生成可见墙体。
- 删墙框同时删除一端进入框内、框外残长不超过 **200 cm** 的短墙；纯外部、仅接触边界、长墙、穿框长墙、手工墙和手工门宿主保留。P1 两段残墙的框外长度均为 192.37 cm；关联自动门随宿主删除。
- Playwright 端口改为 **4221**，开发服务使用 **5351**。

## 验证结果

| 检查 | 结果 | 证据 |
|---|---|---|
| guard | PASS，15/15 GLB 一致 | [guard-final.log](logs/guard-final.log) |
| 前端回归 | 18 文件，168/168 通过；包含原 merge-2 全部 154 项 | [fe-tests-final.log](logs/fe-tests-final.log) |
| 删墙与排除区 | 15/15 通过，覆盖多楼层、多框、门洞禁行、缓存、阈值、手工几何及路线平滑绕行 | [be-overrides.log](logs/be-overrides.log) |
| 寻路专项 | 20/20 通过 | [be-nav.log](logs/be-nav.log) |
| verify_import 全量 | P1/P2/P3 共 12 层；跨层 125/125，抽样 30/30，斜段 0、碰墙 0，PASS | [verify-import.log](logs/verify-import.log) |
| P1 原 PDF 重导入 | 3 页，47.55 秒；排除框自动写入，两段残墙自动删除；跨层 12/12，抽样 10/10，斜段 0、碰墙 0，PASS | [reimport.log](logs/reimport.log)、[verify-reimport-P1.log](logs/verify-reimport-P1.log) |
| 生产构建 | 成功 | [build.log](logs/build.log) |
| 4221 生产浏览器 | low、kit=1；3F 激活、画布可见，pageerror 0 | [browser-production.json](logs/browser-production.json) |
| 累计补丁 | check/apply 均 exit 0，173/173 文件内容及权限一致 | [patch-validation.json](logs/patch-validation.json) |
| merge-2 保留 | 164 文件逐字节相同；仅本任务 8 个既有文件变化，新增 1 个测试；楼梯几何与材质不变 | [invariants.json](logs/invariants.json) |
| 源码空白 | PASS | [diff-check.log](logs/diff-check.log) |

P1 3F 增量修复的实际数据：墙 **258→256**，门 **67→67**，房间 **122→122**；采光顶框与 footprint 交集的误铺砖面积 **41.15232 ㎡→0**。浏览器地砖网格面积与独立 Shapely 求差结果相差 **0.0457 cm²**。修改前排除框内的同一组 200 个网格中心采样，可走 **188→0**；修改后墙体范围收缩，该框已在导航网格范围外。多框落在网格内的强制禁行另由专项测试覆盖。[数值证据](logs/area-nav.json)

## 截图说明

按 TASK 的“只在本副本工作、不改 kit-wt”限制，截图使用基于 kit-wt 的 `/workspace/codex-skylight`，没有使用 fe-shot。两图均为 `quality=low&kit=1`、960×640、开发服务 5351，精确相同的俯视相机；相机位置 `(800,2900,-1470)`，目标 `(800,600,-1470)`。两图均已目视查看，差异像素 **19860**，pageerror **0**。[前图相机](logs/shot-before.json)、[后图相机及网格](logs/shot-after.json)、[截图校验](logs/shots-validation.json)

- [P1 3F 修复前](shots/P1-3F-before.png)：merge-2 的实际导入数据，无排除框；地砖与短墙仍在。
- [P1 3F 修复后](shots/P1-3F-after.png)：同一数据只重新应用删墙框规则，采光顶区域无砖、两段短墙消失。

另附 [4221 生产构建的 3F 画面](shots/P1-3F-production.png)，为默认全层相机，不参与前后像素对比。

前图通过无排除框的原几何路径渲染，后图通过排除框求差路径渲染；没有隐藏构件、替换材质或修改截图像素。浏览器测试输入为真实 Python `nav_view` 输出，使用 Playwright 拦截项目与导航请求提供文件快照。

## 应用

在 `5f77cdcacae290e47ce439041371acadc0375325` 的干净副本根目录执行：

```sh
git apply --check /workspace/merge-3/fe.patch /workspace/merge-3/be.patch
git apply /workspace/merge-3/fe.patch /workspace/merge-3/be.patch
```

[fe.patch](fe.patch) 含 38 文件，[be.patch](be.patch) 含 135 文件，是累计补丁，不叠加到 merge-2 的未提交改动上。运行数据、验证快照和导出文件未纳入补丁；已有工程需重新导入，或通过既有 override 应用入口重新应用删墙框规则。

## 剩余问题

扩展导入测试 `test_pdf_building.py` 为 21/22 通过：`test_boxed_shaft_stands_in_its_lift_lobby_not_across_a_wall` 出现 `KeyError: 'at'`，在未改动的 merge-2 源码中也逐项复现，未扩大范围修改电梯逻辑。[本次结果](logs/be-import.log)、[原版复现](logs/be-import-baseline.log)。未运行全部 PDF/OCR 和全量类型检查。

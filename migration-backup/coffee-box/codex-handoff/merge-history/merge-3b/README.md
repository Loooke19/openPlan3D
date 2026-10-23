已完成 slab2 通用规则修复；累计补丁以 `5f77cdcacae290e47ce439041371acadc0375325` 为基准，包含 merge-3 全部改动，未推送。

## 改动

- 地砖与导航共用有效地面：房间/显式通行区域并集，10 cm 边缘容差；通过 240 cm 半径的闭运算恢复两侧有房间、未封闭端部的走廊（最大约 480 cm 间距），再与 footprint 相交，扣除楼板洞及排除框。门槛单独补桥，路线平滑也禁止穿出有效地面。无楼栋、楼层或特定 ID 分支。
- 按端点连接和闭合房间边界删除孤立自动墙，保留门宿主、房间边界及手工墙；人工 override 墙用 manual 标记。既有项目在项目 JSON 读取时计算有效地面，不必重导入；新导入同时写入 floorRegions。
- ThreeViewer 保留 holeCuts、holeKeeper；楼梯几何/材质及 15 个 GLB 均未改动。开发端口 5371，生产浏览器 4241。

## 数字与验证

| 项目 | 结果 |
|---|---|
| P1 3F 北侧问题框（x149..1179，y−1798..−443） | 地砖 **77.84419㎡→0** |
| P1 3F 全层 kit 地砖 | **1108.55974㎡→991.91458㎡** |
| P1 墙数 1F / 2F / 3F | **247→247 / 200→198 / 256→254** |
| 12 层门、房间数量 | 全部不变；有效地面外可走点 **0/79,889** |
| 新规则及既有关联测试 | FE **132/132**（19 文件），BE **59/59**（地面/override 21、寻路 20、跨层 12、手工编辑原测试函数 6） |
| verify_import | 跨层 **125/125**，抽样 **30/30**，斜段 **0**、碰墙 **0**，PASS |
| guard / build / 4241 浏览器 | PASS；15/15 GLB 相同；构建成功；3F、low、kit=1、画布可见、pageerror=0 |
| 累计补丁 | FE 38 文件、BE 135 文件；干净基准 check/apply 均 exit 0；**173/173** 内容与权限一致 |

数值和完整日志见 [geometry-nav.json](logs/geometry-nav.json)、[verify_import](logs/verify-import-final240.log)、[补丁校验](logs/patch-validation.json)。guard 使用上一轮允许变更清单；ThreeViewer 的累计行差异已人工核对，holeCuts/holeKeeper 调用保留。相对 merge-3 只改 10 个文件，其余 163 个文件逐字节保留。

## 截图

[3F 前图](shots/P1-3F-before.png) / [3F 后图](shots/P1-3F-after.png)：5371，low、kit=1、960×640；相机位置 `(800,2900,-1470)`、目标 `(800,600,-1470)`，与 merge-3 完全相同。前图使用 merge-3 原数据和整块 footprint 地砖，后图使用通用有效地面；均通过真实渲染截图，没有修改像素。前图与 merge-3 原后图逐像素一致（差异 **0**），本轮前后差异 **44,372** 像素；已打开后图确认北侧无裸楼板、无外部孤立墙段，1F/2F 全景真实房间地面完整。

另附 [1F 全景](shots/P1-1F-overview.png)、[2F 全景](shots/P1-2F-overview.png)、[3F 全景](shots/P1-3F-overview.png)。遵循本任务“只在 codex-slab2 工作”的明确限制，在 kit-wt 基准的副本内拍摄，没有使用 fe-shot 或改动 kit-wt。

## 应用与剩余问题

在干净基准根目录运行 `git apply --check fe.patch be.patch`，再运行 `git apply fe.patch be.patch`；不要叠加到 merge-3 的未提交改动上。

扩展 PDF 导入测试 **21/22**：`test_boxed_shaft_stands_in_its_lift_lobby_not_across_a_wall` 的 `KeyError: 'at'` 在 merge-3 原版单项复现，未扩大范围修改该电梯逻辑。未运行全部 PDF/OCR 和全量类型检查。

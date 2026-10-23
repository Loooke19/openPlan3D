已完成 slab2 通用修复，累计补丁输出到 `/workspace/merge-3b/`；未推送，未改 kit-wt、merge-wt、codex-taskc 或其他工作副本。

地砖与导航从整块 PDF footprint 改为房间/通行区域并集；10 cm 容差、最大约 480 cm 的有边界支撑走廊间距、门槛补桥，再裁入 footprint 并扣除楼板洞/排除框。路线平滑也受同一地面边界约束。孤立墙按端点连接及闭合房间边界识别，门宿主和手工墙保留。没有楼栋、楼层或特定 ID 分支。旧项目读取时自动计算有效地面，新导入同时写入 floorRegions。

P1 3F 北侧问题框地砖 77.84419㎡→0，全层 kit 地砖 1108.55974㎡→991.91458㎡；墙 256→254、门 67→67、房间 122→122。12 层总共清除 6 段孤立墙，783 个房间、455 扇门均不变；79,889 个可走网格点中，地面之外的点为 0。浏览器 3F 网格面积与独立 Shapely 面积相差 0.0314 cm²。

验证：FE 19 文件 132/132；BE 地面/override 21/21、寻路 20/20、跨层 12/12、手工编辑原函数 6/6（独立 tmp_path），共 59/59。verify_import 跨层 125/125、抽样 30/30、斜段/碰墙均 0，PASS。guard PASS（沿用允许修改清单），15/15 GLB 字节一致，holeCuts/holeKeeper 保留；生产 build 成功；4241 浏览器 low、kit=1、3F 画布可见、pageerror=0。

截图：5371、960×640。3F 前后相机与 merge-3 完全一致，前图与 merge-3 后图差异 0 像素，本轮前后差异 44,372 像素；已打开最终后图确认北侧无裸楼板和外部孤立墙段。1F/2F 全景已打开目视检查，真实房间地面完整。

累计 fe.patch / be.patch 以 5f77cdcacae290e47ce439041371acadc0375325 为基准，38/135 文件；在干净基准独立目录实际 check/apply 均 exit 0，173/173 内容及权限一致。相对 merge-3 只改 10 个文件，其余 163 个逐字节保留。补丁、截图、完整数字和日志见 `/workspace/merge-3b/README.md`。

剩余问题：扩展 PDF 导入测试 21/22，`test_boxed_shaft_stands_in_its_lift_lobby_not_across_a_wall` 的 KeyError: 'at' 在 merge-3 原版同样单项复现，未改动该电梯逻辑。未跑全部 PDF/OCR 或全量类型检查。

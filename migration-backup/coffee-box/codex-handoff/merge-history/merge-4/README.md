已完成任务C的最小数据修正。累计补丁相对 kit-wt 基准 `5f77cdcacae290e47ce439041371acadc0375325`，包含 merge-3 全部内容；未推送，未修改 kit-wt / merge-wt 文件。

任务C曾按 Luke 10/13 20:05 电话暂缓，10/14 12:21 解除并简化。

`P1-2F.json` 为原房间54（door-33，模型 room-57）增加 100 cm 门 `door-ov-5`，位于 (-1412.84,-365)。给它稳定的名称“房间54（door-33）”，防止通用房间编号随识别结果变化；已有办公室/管道井 overrides 同步到运行项目。楼梯停靠点移入楼梯间后，另补走廊侧入口 `door-ov-6`，确保路线实际抵达楼梯停靠点。

新增通用 `vertical_stops` override：按链接和楼层修正坐标，并通过房间多边形计算 roomId；在保留 previous_project 的旧连接后应用，避免重导入恢复错点。导航层保留链接显式坐标，避免 roomId 查到的目的地吸附点再次覆盖坐标。没有按房间写代码分支。

| 停靠点 | 坐标（cm） | roomId |
|---|---|---|
| link-stairs-1 · 2F | (2115.0,1322.2) | room-37 |
| link-stairs-2 · 2F | (-1115.0,-123.7) | room-42 |
| link-stairs-1 · 3F 南楼梯 | (1967.7,1105.8) | room-69 |

3F 南楼梯原落点在房间外，改到现有闭合房间并通过 override 标为楼梯。三个点均通过多边形包含检查，重复应用结果不变。端口为 dev 5361、后端 8961、Playwright 4231；同步修改 package.json、playwright.config.ts 和已有浏览器测试的端口。

| 路线 | 接口距离 | 分段 | 换层 |
|---|---|---|---|
| 1F 挂号→3F 体检窗口 | 12.41 米 | 1F 8.99＋3F 3.42 米 | 东北楼梯，上行 2 层 |
| 2F 房间54→3F 房间65 | 71.03 米 | 2F 70.01＋3F 1.02 米 | 东北楼梯，上行 1 层 |

以上是接口 lengthCm 的平面行走距离，不含竖向楼梯长度。第二条使用新门 door-ov-5，2F 分段末点与楼梯 transfer.from 完全一致。[路线54](logs/route-room54.json)、[挂号路线](logs/route-registration.json)。

验证：guard 每步 PASS，15/15 GLB 一致；全量 verify_import 跨层 125/125（P1 12、P2 90、P3 23）、抽样 30/30，斜段 0、碰墙 0；寻路相关测试 32/32；生产 build 成功。guard 沿用 merge-3 的五个已验收前端文件允许项，人工核对这些文件与 merge-3 内容完全一致，本任务未改这些实现。[guard](logs/guard-final.log)、[verify_import](logs/verify-import-final.log)、[停靠点](logs/stops.json)。

fe.patch 39 文件、be.patch 135 文件。相对 merge-3 的 173 文件，166 个逐字节保留，7 个按任务修改，另改 package.json。在独立干净基准上 --check、实际 apply 均 exit 0，174/174 文件内容和权限一致。[应用验证](logs/patch-validation.json)。

在上述基准的干净副本根目录应用累计补丁，不叠加 merge-3：

```sh
git apply --check /workspace/merge-4/fe.patch /workspace/merge-4/be.patch
git apply /workspace/merge-4/fe.patch /workspace/merge-4/be.patch
```

运行 project.json 已同步；该运行数据目录沿用原项目的忽略规则，不进入代码补丁。logs/P1.json 是本次已验证快照（project 字段为运行模型），P2/P3 为全量验收基准。已有项目需重新导入以应用 overrides，或使用该快照的 project 字段恢复本次运行模型。后端启动：

```sh
cd be
NAV_WARM=0 OPENPLAN_ORIGIN=http://127.0.0.1:5361 EXTRA_CORS_ORIGINS=http://127.0.0.1:4231 /workspace/.venv-gifu/bin/python scripts/kujiale_import_server.py --port 8961
```

截图为 shots/C-P1-2F-new-door-route.png，使用 kit-wt 的现有构建只读运行于 4231，960×640、quality=low&kit=1；平面局部放大展示新门及穿门路线。房间65是被搜索器隐藏的通用编号，截图终点选可搜索的体检窗口；指定房间65路线已独立验证。截图未改像素，详情见 logs/screenshot.json。

剩余范围：本次按简化任务未重跑全量 PDF/OCR、全部前端测试和类型检查；未扩大处理 merge-3 已记录的无关电梯测试问题。

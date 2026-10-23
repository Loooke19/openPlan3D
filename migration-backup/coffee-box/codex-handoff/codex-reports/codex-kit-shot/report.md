# P1 2F/3F 修复与截图报告

**P1 重新导入、完整 verify PASS、guard PASS、三张可见截图和报告均已落地。三张截图最晚于 01:14:18 生成，最终 verify 于 01:16:25 通过，早于 01:45；报告初稿和第一轮数字/截图路径也已在截止前写入。最终报告整理于 02:20，晚于截止时间。跨层路线 125/125，抽样 30/30，斜段 0、碰墙 0。**

所有产物在 `/workspace/codex-kit-shot`。前端基于 `/workspace/kit-wt` 完整副本，前端源码未编辑；未推送，未改 kit-wt/merge-wt 本体。

## 数据修改与来源

只应用指定的楼层 overrides 与重新导入数据，没有合并两份修复 patch，也没有合并任务 A 的楼梯修改。

- 2F：`/workspace/codex-p1-fix-2F/repo/data/overrides/P1-2F.json` → `be/data/overrides/P1-2F.json`，文件字节完全一致。
- 3F：`/workspace/codex-p1-fix-3F/repo/data/overrides/P1-3F.json` → `be/data/overrides/P1-3F.json`，文件字节完全一致。
- 从原 P1 PDF 重新识别，按两份修复各自的导入工具生成对应楼层，再组装 P1。这样保留 2F 工具支持的“开水炉”设备标注和 3F 工具支持的墙段裁剪。导入工具未修改；`be/` 是 3F 工具的本地运行副本，2F 导入使用原 2F 工具。
- 基线：`be/data/baseline/P1.json`，来自 `/workspace/zone-audit/f10/P1.json`；开始时已确认其三个楼层和 verticalLinks 与 kit-wt 使用的 merge-wt P1 数据一致。
- 最终导入：[/workspace/codex-kit-shot/be/data/imported/P1.json](/workspace/codex-kit-shot/be/data/imported/P1.json)。API 项目：`be/data/kujiale-import/projects/b1f10000000000000000000000000001/project.json`。

| 最终楼层 | 墙 | 区域 | 门 | 有名区域 | 设备/文字标注 | verify 独立房间 新/基线 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 2F | 189 | 64 | 38 | 33 | 1 | 25/25 |
| 3F | 243 | 87 | 61 | 48 | 1 | 36/34 |

2F 两间办公室、女卫、男卫合并、针灸推拿入口、走廊类型、附属关系、两处挑空及开水炉标注已导入；3F 生化室与细菌室分区、控制室区域、手术区/走廊碎面修正、附属关系及上空标记已导入。表中独立房间采用 verify 的统一语义口径，不能直接当作 PDF 真值房间总数。

**stairs 字段 3/3 完全未改；verticalLinks 两条连接、6 个停靠点完全未改；1F 楼层对象完全未改；P2/P3 与基线字节完全一致。** 原始各层 `stairs` 数组均为空，本次保持原值；原有楼梯识别统计与跨层连通保留，不能将空数组误读为没有跨层楼梯。证据：[data-check.json](evidence/data-check.json)。

首次全栋重导入耗时 54.48 秒；最终 2F 专用工具重导入耗时 200.98 秒。原始日志：[import.log](evidence/import.log)、[import-2F.log](evidence/import-2F.log)。

## 验证数字

最终命令（没有跳过跨层两两检查）：

```sh
cd /workspace/codex-kit-shot
OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 /workspace/.venv-gifu/bin/python -u \
  be/scripts/verify_import.py be/data/imported be/data/baseline
```

**exit 0 / PASS**，原始输出：[verify-final.log](evidence/verify-final.log)。

| 检查 | 成功/总数 |
| --- | ---: |
| P1 楼梯电梯两两跨层 | 12/12 |
| P2 楼梯电梯两两跨层 | 90/90 |
| P3 楼梯电梯两两跨层 | 23/23 |
| 跨层合计 | 125/125 |
| 路线抽样，每栋 10 条 | 30/30 |

抽样斜段 **0**、碰墙 **0**；耗时中位 **658ms**、最大 **2576ms**。P1 每层连通楼梯均为 2；识别楼梯数 1F/2F/3F 为 5/2/2，沿用基线。

挑空另做实数据检查：2F 门厅上空 **1410** 个内部网格单元、庭院上空 **945** 个，3F 上空 **884** 个；合计 **3239** 个内部单元，可走数全部 **0**，全部不生成目的地。证据：[void-check.json](evidence/void-check.json)。

## Guard

```sh
/workspace/codex-stair-guard.sh /workspace/codex-kit-shot
```

初始、重导入后、截图后及交付检查均 **exit 0 / GUARD PASS**，未设置允许改动的文件。

```text
GLB 检查 15 个
GUARD PASS /workspace/codex-kit-shot
```

kitDressing.ts、navDoors.ts、layout.ts、openingAudit.ts、dressing.ts、app.css 与 kit-wt 一致，ThreeViewer.svelte 的受保护新增行全部保留，15 个 GLB 全部一致。最终日志：[guard-final.log](evidence/guard-final.log)。截止前截图后 guard 也已通过，见 [guard-after-shots.log](evidence/guard-after-shots.log)。

## 截图

全部从本副本前端 `http://127.0.0.1:5288` 和本副本后端 `http://127.0.0.1:8888` 实时拍摄，未使用 fe-shot 页面或旧截图。1600×1000，Chromium，`quality=low`；该参数使用前端已有的直接渲染路径，保留 kit 模型和烘焙明暗。

| 图片 | 绝对路径 | 内容 |
| --- | --- | --- |
| [2F 俯视](shots/P1-2F-top.png) | `/workspace/codex-kit-shot/shots/P1-2F-top.png` | 最终 2F 数据，相机 topDown=true |
| [3F 俯视](shots/P1-3F-top.png) | `/workspace/codex-kit-shot/shots/P1-3F-top.png` | 最终 3F 数据，相机 topDown=true |
| [跨层路线](shots/P1-2F-to-3F-route.png) | `/workspace/codex-kit-shot/shots/P1-2F-to-3F-route.png` | 2F 儿科 → 3F 生化室，双层展开与路线 |

两张俯视图相机 lookY≈**-1**；跨层路线 **3511cm（约35米）**，2F **1764cm** + 3F **1747cm**，楼梯上行 **1** 层。截图中可见楼层、起终点、路径和换层说明，楼梯入口区域完整入画；墙、门及模型有明暗和体积感。3F 数据与源修复的导入结果完全一致，最终 2F 补标注后已重拍 2F 和路线图。

浏览器错误 **0**，GLB 请求成功 **15/15**。证据：[browser-final.json](evidence/browser-final.json)、[browser.json](evidence/browser.json)、[shots-final.log](evidence/shots-final.log)。

本地查看：`http://127.0.0.1:5288/nav?id=b1f10000000000000000000000000001&apiOrigin=http%3A%2F%2F127.0.0.1%3A8888&floor=floor-1&quality=low`。

服务启动命令：

```sh
npm run dev -- --host 127.0.0.1 --port 5288 --strictPort
OPENPLAN_ORIGIN=http://127.0.0.1:5288 /workspace/.venv-gifu/bin/python \
  be/scripts/kujiale_import_server.py --host 127.0.0.1 --port 8888
```

## 剩余问题

五项产物没有缺项，但最终报告补全晚于 01:45；以下既有问题保留：

- 当前软件 GPU 的默认 high 后处理路径出现黑画布，最终截图使用已有 `quality=low` 直接渲染参数。未修改渲染源码，截图不代表默认 high 后处理效果。
- 挑空数据与禁行已生效，但 kit 既有整层地板按 footprint 铺设，仍覆盖挑空，截图未呈现视觉镂空。根因在 `kitDressing.ts` 的整层 `kit-floor`，按本任务范围和 guard 保留前端原实现。
- 楼梯错名、碎面与停靠点偏位，以及部分 PDF 图注面积与几何面积差异，沿用源修复报告的剩余项。本次没有调整 stairs、楼梯区域或跨层停靠点；路线可达不代表楼梯物理位置已修正。

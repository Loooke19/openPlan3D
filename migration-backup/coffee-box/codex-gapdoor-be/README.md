# 岐阜大学医院一楼 · 2D / 3D 室内导览

交付真实图纸的解析结果、可复现生成脚本及电子地图 Demo。基于医院[中文地图页](https://www.hosp.gifu-u.ac.jp/chn/map.html)的[官方PDF](https://www.hosp.gifu-u.ac.jp/img/chn/chn_hospital_map.pdf)第1页；原图和PDF已保存在 `source/`。

## 查看结果

接手开发先读 [项目概览与 PDF 导入技术计划](项目概览与PDF导入技术计划.md)：当前技术栈、已有/待做边界、六阶段计划、建议选型与验收。材质细节见 [材质与光照实现说明](材质与光照实现说明.md)。这两份文档不代表通用 PDF 上传器已实现。

图纸制作（上传 PDF、选页、裁剪）需要本地 API。在项目根目录安装依赖后运行：

```sh
python3 -m pip install -r requirements.txt
python3 scripts/maker_server.py --host 127.0.0.1 --port 8765
```

打开 <http://127.0.0.1:8765/preview/>，点「导入图纸」。工程写在 `var/projects/`，不会覆盖 `data/` 或 `source/` 里的岐阜示例。若只看现成导览、不上传文件，仍可用 `python3 -m http.server 8765 --bind 127.0.0.1`；此时导入面板会提示改用制作服务。

可以搜索并选择64个科室/设施，查看路线、可行走区域和拓扑；支持拖动、缩放、关闭/恢复通道后重算、两点距离标定，以及JSON导入/导出。关路与比例保存在浏览器本地，导出的JSON携带这些修改。刷新恢复关路/比例；导入文件的其他数据需再次导入。

## 电子地图与 3D

- 默认展示真实 Three.js 三维场景：低饱和房间地面、灰色无顶墙体、演示门洞和设施标注。拖动旋转、右键平移、滚轮缩放。
- 可切换到纯 SVG 2D 电子地图。两种视图共用房间轮廓、颜色、地点与走廊路线，不再显示 PDF 图片或蓝色图例。
- 按最新要求改为原创“院内”导览台：白色界面、浅冷灰地图背景与深绿色点缀，左侧目的地索引、右侧地图及底部路线操作条，不再沿用参考站布局。保留医院真实布局及 SC 字体。3D 标签不使用位移缓动，逐帧跟随相机。
- 实际接入本地托管的 `@ambientcss/css` 3.0.1，用其统一光源、凹槽表面与立体边缘样式构建搜索框、实体按钮和路线条。当前采用纯 CSS 包，未引入 React 组件包；后续允许按需要引入 React。
- 选起点和终点后可“模拟导航”：圆形标识沿走廊折线移动（2D / 3D），跨层时自动切换楼层；另提供 3D「第一人称」漫游。相机位置不使用会切过墙角的曲线平滑。
- 文字使用本地托管 Noto Sans SC 简体中文字体。Three.js 也随项目本地提供，页面运行无需外部 CDN 或付费模型 API。
- 图层检查、临时关闭通道、距离标定和 JSON 管理收纳在“地图工具”中。WebGL 不可用时会提示并回退 2D。

这是几何导览 Demo，不是写实 BIM 或数字孪生：门位、墙高和行走视高为示意，房间并非医院施工图级分隔。支持演示跨楼层导航（竖向电梯/楼梯链接 + 圆标模拟）；无实时室内定位。

## 已完成的解析

- PDF原生文字提取：116个文字片段及坐标，区分实际地图与底部图例，无额外OCR/API费用。
- 模型视觉核对：64个科室、入口和设施。编号图例被映射到图上实际符号；重复名称保留独立ID。
- 矢量几何：建筑外轮廓、52个房间/柜台/禁行对象及建筑线段；庭院、井道和楼梯本体明确禁行。
- 白色走廊及用户指定的深蓝入口可走。文字遮罩和图标白色内孔不会被误当成走廊。
- 单层中心线网络和POI接入边；主入口可达全部64个演示到达点。
- 朝走廊的演示门位置与到达点分开存储；门不意味着可以穿过房间内部。
- 稳定、归一化地图格式和TypeScript接口可供后续2D/Three.js应用接入。

这是**针对该PDF的已审核适配器 + 当前模型完成的语义标注**。没有把任意图片全自动识别、实时GPT API或网页上传器伪装成已实现功能；换图需要新的结构配置与语义标注。因为此图含原生文字和矢量边界，直接提取比把整图反复交给OCR更合适。

## 重建和测试

标准 Python 3.10+ 环境安装 `requirements.txt`，然后运行：

```sh
python3 scripts/build_map.py
python3 -m unittest discover -s tests -v
```

前端寻路与 3D 插值回归测试（需 Node.js 22+）：

```sh
node tests/test_preview.mjs
```

该测试会自动启用 Node 的实验 VM 模块加载本地 Three.js；终端提示 ExperimentalWarning 属于 Node 提示，不是测试失败。

本机已经使用 Codex 内置 Python 及其现有依赖运行成功：

```sh
/Users/luke/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 scripts/build_map.py
/Users/luke/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 -m unittest discover -s tests -v
```

浏览器预览无需安装 Node 或请求大模型 API。当前拓扑是通用 nodes/edges，预览用独立 Dijkstra 实现；后续可适配 Graphology。3D 使用同一走廊图，而非 Recast NavMesh。完整地图编辑器、任意图片上传识别与 PWA 留在下一阶段。

## 文件与坐标约定

| 文件 | 用途 |
| --- | --- |
| `data/map.json` | 主交付：边界、障碍、演示门、POI及导航图 |
| `data/map-types.ts` | 后续TypeScript应用接口 |
| `data/gifu-1f-profile.json` | 本图的矢量对象、颜色、排除区域与原始PDF哈希 |
| `data/gifu-1f-poi-annotations.json` | 当前模型整理的名称和候选入口，可直接修改后重建 |
| `data/text-extraction.json` | 可追溯的原生文字和边界框 |
| `data/walkable-mask.png` / `safe-mask.png` | 可走区域与留边后的区域，800×1210，白可走/黑不可走 |
| `data/sample-routes.json` | 主入口到全部地点的路线结果 |
| `data/validation-report.json` | 生成统计、不可达警告及尚未标定的事项 |
| `tests/test_navigation.py` | 独立几何与拓扑回归测试 |
| `preview/viewer.js` / `routing.js` | 页面交互、2D 矢量地图与共享寻路 |
| `preview/scene3d.js` / `map-art.js` | Three.js 场景、漫游与共享地图样式 |
| `assets/vendor/` / `assets/fonts/` | 本地依赖及开源许可证 |

原PDF页面为800×1210，源PNG为2000×3025。POI初始标注用源PNG像素；生成的 `position`、`polygon`、`polyline` 使用完整原页上的0..1坐标。不要以预览裁剪窗口作为归一化基准。

`lengthMapUnits` 用PDF坐标单位计算。真实比例默认 `null`，不输出真实米数；预览中完成两点标定后，可通过 `metersPerMapUnit` 换算显示距离。当前2单位留边为示意像素留边，并未验证0.35米人体半径或无障碍通道宽度。

`confidence` 表示名称/符号识别把握，不代表门位测绘精度。按照用户的Demo要求，未绘明的门选在走廊侧；AED等在房间内的设施部分使用最近的接待到达点。电梯与楼梯仅作为单层目的地，未建立跨楼层连接。

PDF保留少量孤立白色区域，未强行连成一体。导航只连接真实几何可走区域；验收不以“全图一个连通分量”为目标。

修改障碍与语义点：编辑profile/annotations，再运行生成脚本。`walkableOverrides`仅用于显式添加多边形演示通道，坐标为PDF单位。源文件哈希不一致会拒绝继续，防止将旧图索引误用于另一张PDF。

电子地图由结构化几何直接渲染，不使用 AI 生成的位图替代可导航几何。医院原图版权归原发布方。

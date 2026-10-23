# merge-2

已在 `/workspace/codex-merge-2` 合入指定前端改动；基准为 kit-wt HEAD `5f77cdcacae290e47ce439041371acadc0375325`，包含 merge-1015 原有内容。没有提交或推送，没有修改 kit-wt、merge-wt 或其他源副本。

## 内容

- [fe.patch](fe.patch)：37 个文件。第四轮 `isStairSign` 去除楼梯门牌、吊牌和房间名称牌；第五轮最终版宽通行区补灯、墙体原色哑光天花板、去掉模拟地面光斑；门框副本的通用墙体归并、共享洞口切割和表面求并；切层副本的 35% 路线进度预取、请求去重、场景缓存和遮罩期间暂停渲染。
- [be.patch](be.patch)：135 个文件，逐字节沿用 merge-1015，保留其后端第 2 轮、F-1 和 A+B 整合。此次没有后端增量。
- 第五轮 `layout.ts`、`dressing.ts` 和标牌实现与 ab-on-kit 最终源码逐字节一致。ThreeViewer 以该最终版为共同祖先合并门框和切层改动，没有文本冲突。`kitDressing.ts`、`navDoors.ts`、`app.css` 和 15 个 GLB 与 kit-wt 相同；ThreeViewer 中 `holeCuts`、`holeKeeper` 的门洞/重复记录处理仍接入墙体、踢脚线、接缝及 kit。门框分支对共享切口高度和重复洞口的通用规则更新已保留。
- 未合入 B-1 踏面动作。楼梯几何与材质函数块和 merge-1015 完全相同。门框测试原先引用源副本的 verification 附件，改用仓库已有的多层测试夹具；P1 实际三层另作独立校验。

## 验证

| 检查 | 本次结果 | 证据 |
| --- | --- | --- |
| stair guard | PASS；15/15 GLB 一致 | [guard-final.log](logs/guard-final.log) |
| 前端专项 | 15 文件、154/154 通过 | [fe-tests-final.log](logs/fe-tests-final.log) |
| 后端专项 | 沿用 merge-1015 的 44 项，44/44 通过 | [be-tests.log](logs/be-tests.log) |
| 生产浏览器 | 上楼/下楼/电梯/取消加载，5/5 通过，7.0 分钟 | [browser.log](logs/browser.log) |
| 生产 build | 成功；客户端 9.55s、服务端 16.09s | [build.log](logs/build.log) |
| 标牌通用规则 | P1/P2/P3 共 12 层，楼梯门牌/吊牌 21→0，其他牌子布局逐项一致 | [rules-validation.json](logs/rules-validation.json) |
| P1 场景实测 | 142/142 天花板原色哑光、无贴图；107 灯板；楼梯标牌 0；PointLight/SpotLight 为 0 | [shots-after.json](logs/shots-after.json) |
| P1 门洞扫描 | door-1 共面/斜面/反向洞侧/占用全为 0；整层共面 133、占用 6 | [shots-after.json](logs/shots-after.json) |
| P1 门洞归并 | 三层墙数 247→236、200→196、258→248；门数 62/40/67 不变，失效门宿主 0 | [rules-validation.json](logs/rules-validation.json) |
| 保留与范围 | 后端 135/135 文件不变；第五轮最终版对齐；B-1 未纳入 | [invariants.json](logs/invariants.json) |
| 补丁应用 | 干净 HEAD 上 check、实际 apply 均 exit 0；172/172 文件内容和权限一致 | [patch-validation.json](logs/patch-validation.json) |
| 改动源码空白检查 | exit 0 | [diff-check.log](logs/diff-check.log) |

Guard 允许的文件只有本次涉及的 layout、openingAudit、dressing、ThreeViewer。120 条 kit 新增行中 106 条原样保留；14 条文本变化全部对应已核对的门框几何/审计、冗余赋值清理和第四轮标牌字段增补，与门框源副本一致，没有删除 kit 功能。完整差异列在 invariants.json。补丁应用出现的空白告警来自沿用的后端第三方资产及 PDF，未改动这些文件。

## 低画质切层实测

Chromium/SwiftShader，生产服务 4211，`quality=low&kit=1`，960×640，速度 3×，走真实后端 8914。时间起点为淡出开始，终点为遮罩完全透明；包含各 300ms 的淡出和淡入。

| 场景 | 淡出至 URL 切层 | URL 切层至透明 | 合计 | 显示缓存场景 |
| --- | ---: | ---: | ---: | ---: |
| P1 模拟上楼 | 0.644s | 0.810s | **1.454s** | 20.1ms |
| P1 第一人称上楼 | 1.691s | 1.192s | **2.884s** | 17.3ms |
| P1 第一人称下楼 | 0.699s | 1.616s | **2.315s** | 4.6ms |
| P2 第一人称电梯上楼 | 0.914s | 0.904s | **1.818s** | 24.7ms |

四个场景均实际到达、进度 100%、pageerror=0；目标层请求在淡出之前发出且仅请求一次，淡出之后场景重建次数 0。P1 为挂号↔3F 体检窗口；P1 没有电梯，电梯场景使用既有 P2 工程登记室→4F 护士办公室，勾选只乘电梯，实际 transfer.kind=elevator。[汇总](logs/timings.json)、[模拟上楼](logs/sim-up-production.json)、[第一人称上楼](logs/fp-up-production.json)、[第一人称下楼](logs/fp-down-production.json)、[电梯](logs/lift-up-production.json)。

## 截图与输入

前图为本副本应用 merge-1015 后、合入本次改动前的实际源码；后图为合入后的实际源码，均使用 5341 开发服务。两侧 P1 工程数据相同，相机、1280×800、默认 high、kit=1 一致。没有隐藏天花板或修改导航响应。按照 TASK 的“不改 kit-wt”限制，拍摄使用由 kit-wt 基准创建的本工作副本。

| P1 场景 | 前 | 后 |
| --- | --- | --- |
| 西楼梯吊牌 | [前](shots/P1-stair-sign-before.png) | [后](shots/P1-stair-sign-after.png) |
| 第一人称天花板 | [前](shots/P1-fp-ceiling-before.png) | [后](shots/P1-fp-ceiling-after.png) |
| door-1 门框 | [前](shots/P1-doorframe-before.png) | [后](shots/P1-doorframe-after.png) |

六张图片均已目视查看，尺寸、哈希和前后变化像素数见 [shots-validation.json](logs/shots-validation.json)。142 片天花板线性 RGB 全部为 `(0.78,0.82,0.80)`，roughness=0.95、metalness=0，均无贴图、无自发光。

相机记录见 [修改前](logs/shots-before.json)、[修改后](logs/shots-after.json)。P1 浏览器输入为 ab-on-kit 现有 project，P2 为 integ-fix 的 retained P2 工程，仅分配测试用项目 ID；数据来源和 P1 哈希见 invariants.json。运行工程数据沿用 merge-1015 的排除规则，没有纳入补丁。标牌 12 层复算使用第四轮已有项目快照；此项验证过滤规则保留其他布局，不将门框归并后的牌位变化混入过滤统计。

## 应用

在 `5f77cdcacae290e47ce439041371acadc0375325` 的干净副本根目录执行：

```sh
git apply --check /workspace/merge-2/fe.patch /workspace/merge-2/be.patch
git apply /workspace/merge-2/fe.patch /workspace/merge-2/be.patch
```

两份补丁均是相对 HEAD 的完整整合补丁，不能直接叠加到已有 kit 或 merge-1015 未提交改动的目录。

## 剩余问题

- B-1 踏面动作未完成，按要求排除。
- 本次 P1 1F 全层复测仍有 133 对共面和 6 项净空占用，door-1 全为 0。计数为三角形相交对或洞口×构件，不是问题门数量；没有扩大为曲墙实体布尔修复或逐房间修正。
- 预建仍占用主线程，上楼目标层场景预建约 10 秒，已移出切层关键路径；缓存增加内存占用。第一人称上楼距 3 秒较近，四项数字是本环境单次实测。
- 本次未运行全量类型检查或全套 PDF/OCR；既有全量类型检查问题不据此宣称已修复。

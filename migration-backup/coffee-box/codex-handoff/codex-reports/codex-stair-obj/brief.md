# 任务A：楼梯对象 + 层高 + 材质   （目录 T=/workspace/codex-stair-obj，前端端口 5311，后端端口 8911，截图前缀 A-）
先读 /workspace/codex-stair-common.md。
1. 通用规则（三栋楼都适用，不按 P1 硬编码）：对每层名为“楼梯”的房间，按房间轮廓推导生成 OpenPlan Stair 对象（fe/src/lib/models/types.ts 的 Stair：id/position/rotation/width/depth/riserCount/direction/stairType），写入 floor.stairs。朝向沿房间长边，宽深从轮廓得出（留出墙厚余量），riserCount 按层高/约 17cm 取整，stairType 按房间长宽比选 straight 或 u-shaped。规则放在后端识别/修正流程里（pdf_building.py 或 floor_overrides.py 的通用步骤），保证重新识别不丢；并更新 be/data/kujiale-import/projects/b1f1...0001/project.json，三层都要有。
2. fe ThreeViewer.svelte 的 buildStairs：总高度改为跟楼层层高（相邻楼层 elevation 差或楼层高度字段）走，不再写死 260；STAIR_STOREY_CM 一并统一。材质：先用纯色——与素材包（Animated Emergency Clinic & Medical Equipment Kit，见 fe/src/lib/utils/hospitalMaterials.ts、fe/src/lib/components/viewer3d/nav/kitDressing.ts）地面一致的中性浅灰（不偏黄），侧面稍深，踏步前缘深灰防滑条。若纯色效果明显不行，再找免费可商用灰白瓷砖贴图铺踏面，并在 report 记录来源 URL 和许可。只用预烘焙光照，不加实时阴影/AO（去掉 castShadow）。
3. 验证：verify_import 通过；每层楼梯对象数与楼梯房间数对照表；每个楼梯对象的楼层、position、rotation、width、depth、riserCount、高度列表；正常墙高下楼梯特写截图每层至少一张（A-stair-1F-*.png 等）。

补充（协调）：楼梯对象只写进每层 overrides 的独立字段 "stairs"（由通用规则从楼梯房间轮廓生成，overrides 里 stairs 字段可为生成结果或生成参数），不要改 overrides 里其他字段（另有任务在改 2F/3F 的墙/房间修正）。生成逻辑必须能在房间轮廓变化后重新跑出结果（给出一条重新生成命令）。纯色浅灰优先，做不出来再用免费可商用灰白瓷砖贴图并记录来源许可。report 需列：楼梯对象个数，每个的楼层、位置、朝向、宽、深、台阶数、高度，以及材质效果截图。

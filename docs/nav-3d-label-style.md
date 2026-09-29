# Nav 3D 房间标签样式

## 结论
`navShell` 下 3D 地面标签改为**深色字 + 白色描边**，仅房间名，**去掉面积**与深色气泡。

## 改动
- 文件：`openPlan3D` → `src/lib/components/viewer3d/ThreeViewer.svelte`
- 条件：`navShell === true`
- 实现：`canvas` `strokeText`（白）+ `fillText`（`#222`）；无 `roundRect` 气泡；不画 `formatArea`
- 编辑器 3D：仍为气泡 + 名称 + 面积

## 证据
- after：`media/nav-labels/after-3d-labels.png`（深色字+白描边、无面积、无气泡）
- PR：https://github.com/Loooke19/openPlan3D/pull/3（base: `cursor/hospital-nav-shell-a695`）
- 样例：`f9e6bb1cdf994280b5f506c130ec2aeb`

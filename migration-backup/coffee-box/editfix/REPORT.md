# 编辑入口修复结论
已在 `kit-wt` 项目管理页的每张项目卡片加入常显“编辑项目”链接，直达该项目的 `/editor?id=...`。
原因：医院导入项目的导航链接把 `libraryUrl` 指向前端 `/`；该页只读浏览器本地项目，医院项目卡片因此不可见。
通用修复：导航返回地址优先按 `projectUrl`/`apiOrigin` 定位项目所属导入服务的 `/files#p-{id}`，本地项目仍按显式 `libraryUrl` 返回。
验证：`tests/projectLibraryUrl.test.ts` 5/5 通过；浏览器实测 1 张卡片的“编辑项目”链接可见，点击进入 `/editor`。
截图：`shots/manage.png`（1440×900）；补丁：`fe.patch`（7 个文件，29 增 15 删，已通过反向应用检查）。
`codex-stair-guard.sh /workspace/kit-wt`：PASS，检查 15 个 GLB；补丁未涉及 kitDressing、navDoors、layout、openingAudit、dressing、app.css、ThreeViewer 或 GLB。
剩余问题：`be/` 当前在工作区被删除，导入服务 `/files` 的显式操作行无法在本次 `kit-wt` 改动中验证或添加；现有服务卡片的名称和缩略图仍可进入编辑页。
全局 `svelte-check` 仍有原有的 32 个错误、17 个警告，集中于已有 3D 导航代码和测试类型；本次改动页面已通过浏览器编译与点击验证。

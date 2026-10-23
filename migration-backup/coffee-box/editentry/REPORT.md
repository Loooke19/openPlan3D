# 医院 3D 导航项目编辑入口调查

**结论：编辑页和链接没有被删除；医院项目从导航返回时被送到另一套项目库，项目卡片不出现，因而看不到编辑入口。** 仓库内没有发现“前端根路径自动跳 `/nav`”的规则；前端 `/` 仍是项目库，后端 `/` 是导入页。

## 路由与组件
- openPlan3D `/`：`src/routes/+page.svelte` 项目库；`/editor`：`src/routes/editor/+page.svelte` 编辑页；`/nav`：`src/routes/nav/+page.svelte` 导航页。
- 前端项目库卡片的缩略图、名称和操作菜单均通往 `/editor?id=...`（`+page.svelte:225,239,247`）；只有 `projects.length > 0` 才渲染卡片（`:202-222`）。
- 医院后端 `/files`：`preview/files.html` + `preview/files.js`；后端 `/` 是导入页，`/nav` 302 到前端 `/nav`（`scripts/kujiale_import_server.py:322-337`）。后端文件卡片缩略图、名称仍链接 `file.editorUrl`（`files.js:75,78`），该 URL 由 `editor_url()` 生成，指向前端 `/editor?projectUrl=后端/api/projects/{id}.json`（`:185-186`）。

## 原因与触发条件
1. 后端提交 `f3e61c5` 把 `nav_url()` 的 `filesUrl` 从本后端 `/files` 改成前端 `/`，并新增同样指向前端 `/` 的显式 `libraryUrl`；当前代码见 `kujiale_import_server.py:189-200`。
2. 前端提交 `8ba02c0` 把导航返回目标改成 `resolveProjectLibraryUrl()`；该函数先采纳显式 `libraryUrl`（`projectLibraryUrl.ts:17-29`），所以即使提交 `ccc61cd` 后能把 `filesUrl=/files` 解析为项目所属文件卡片，也不会处理这个优先级更高的 `/`（`nav/+page.svelte:1079-1080,1130`）。
3. 前端 `/` 只调用浏览器 IndexedDB 的 `localStore.list()`（`+page.svelte:47-53`、`datastore.ts:119-134`），不读取后端 `/api/projects`。医院项目只存在后端、或当前浏览器尚未进入过编辑页时，`projects.length===0`，编辑链接随卡片一起不渲染；导航页自身也没有编辑按钮。
4. 后端 `/files` 并未失去编辑功能，但 `files.js:81-85` 的显式操作行只有“导航浏览/导入楼层/新建楼层”；编辑入口藏在可点击的缩略图和名称里。这是可发现性问题，非路由失效。

## 最小通用修复建议（未实施）
- 统一按项目来源决定返回地址：导入服务生成的导航 URL 把 `libraryUrl` 设为本服务 `/files#p-{id}`，并让前端公共解析函数在有项目来源 `projectUrl`/`apiOrigin` 时优先返回所属服务的文件卡片；没有导入来源的本地项目继续返回前端 `/`。不要按医院项目 ID 特判。
- 在后端 `/files` 每张卡片的操作行加一个常显的“编辑项目”链接，复用现有 `file.editorUrl`；保留缩略图和名称链接。

验证：前端 `tests/projectLibraryUrl.test.ts` 4/4、后端 `tests/test_files_nav_entry.py` 3/3 通过；现有前端测试 `:23-29` 还明确确认“显式 `libraryUrl=/` 优先”，与上述触发条件一致。未改动项目代码、未推送；未验证实际部署的反向代理或浏览器 IndexedDB 状态。

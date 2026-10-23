# 项目卡片编辑入口
结论：后端 `/files` 项目卡片的“导航浏览”旁新增常显“编辑项目”按钮，沿用项目 `editorUrl`，无新页面。
原因：原卡片仅缩略图和标题可进入编辑页，操作行缺少明确入口。
前端 `kit-wt` 未找到显示“导航浏览”的项目卡片；已有管理卡片编辑入口保持原样，`fe.patch` 保留上一轮 7 文件改动。
后端在基于 `1ceb251` 的干净 worktree 修改；`be.patch` 仅含 `preview/files.js`、`preview/files.css`，未触碰原后端的已有改动。
验证：后端单测 4/4、前端相关测试 5/5 通过；浏览器模拟 1 张卡片，两按钮同一操作行且可见，编辑链接点击跳转 `/editor?id=demo-123`；后端补丁可应用到原仓库。
截图：`shots/card.png`（558×682，浏览器模拟项目数据）。
`/workspace/codex-stair-guard.sh /workspace/kit-wt`：PASS，检查 15 个 GLB。
剩余问题：截图使用模拟项目数据，静态截图服务不提供真实编辑页；未 push。

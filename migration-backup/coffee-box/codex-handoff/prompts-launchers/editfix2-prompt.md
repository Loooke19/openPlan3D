用中文回答。不要 push。先读 /workspace/editfix/REPORT.md。
用户澄清：项目卡片上（就是有「导航浏览」按钮的那张卡片）也要有进编辑页的入口，和「导航浏览」并排放一个「编辑项目」按钮，用这个项目已有的 editorUrl 或 /editor 链接。不要额外加页面。找出所有显示「导航浏览」的项目卡片（前端 /workspace/kit-wt，以及后端 gifu-hospital-3d-tour 基础 1ceb251 的 preview/files.js；如果 kit-wt 里的 be/ 被删了，就用干净副本 git worktree，从 1ceb251 建），统一加上。不要回退已有改动。改完运行 /workspace/codex-stair-guard.sh。
输出：/workspace/editfix2/fe.patch，后端如果有改动就再存一份 be.patch；截图存到 /workspace/editfix2/shots/card.png，要能看到卡片上的「导航浏览」和「编辑项目」两个按钮；REPORT.md 写在 15 行以内。

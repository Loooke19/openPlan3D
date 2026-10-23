# 公共背景（医院 3D 导航，P1 楼）
- 本任务目录 = $T（见各自 brief）。fe/ = 前端 openPlan3D 副本（含未提交改动，基于它继续改），be/ = 后端 gifu-hospital-3d-tour 副本。只改自己目录，别碰 /workspace/kit-wt、/workspace/merge-wt、其他 codex-stair-* 目录。不要 git push，不要 commit 到远端；本地可以 git diff 留痕。
- 不碰门框/门洞几何（openingAudit.ts、openingRules.ts、wallJoints.ts 的门洞部分）。
- 后端启动：cd be && NAV_WARM=0 /workspace/.venv-gifu/bin/python scripts/kujiale_import_server.py --port <你的后端端口>  。项目数据在 be/data/kujiale-import/projects/<id>/project.json，P1 的 id = b1f10000000000000000000000000001。修正数据在 be/data/overrides/P1-{1F,2F,3F}.json（scripts/floor_overrides.py 说明格式）；重新识别会从 PDF 重建再叠修正数据，所以持久改动要进 overrides 或识别规则（pdf_building.py），并同步到 project.json。
- 前端：cd fe && npm run build && PORT=<你的前端端口> node build 。导航页 http://127.0.0.1:<前端端口>/nav?projectUrl=http://127.0.0.1:<后端端口>/api/projects/b1f10000000000000000000000000001.json  编辑页同理 /editor?projectUrl=...
- 截图参考脚本（playwright）：/workspace/fe-shot/shot5.tmp.mjs 只可复制脚本逻辑；必须用本任务 fe/ 的代码构建并截图，绝不能用 /workspace/fe-shot 的构建或服务（它是旧提交）。截图存 /workspace/zone-audit/shots/，文件名前缀见 brief。
- 后端校验：cd be && /workspace/.venv-gifu/bin/python scripts/verify_import.py（看其用法），必须通过。
- PDF：/workspace/gen-test/67dd2d12*.pdf（第1页3F，第2页2F）。快照 /workspace/zone-audit/f10/P1.json 可能过期，以 project.json 为准。
- 楼梯房间：识别结果里名为“楼梯”的房间，1F 两个、2F 两个、3F 一个。verticalLinks: link-stairs-1 楼梯（南）、link-stairs-2 楼梯（东北），覆盖数据里 link 名 P1-stair-east / P1-stair-west。
- 测试精简，只测改动部分。完成后写 report.md（中文，结论在前：改动文件、数字、截图路径、剩余问题）。

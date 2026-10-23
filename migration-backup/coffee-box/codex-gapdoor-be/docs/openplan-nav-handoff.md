# openPlan 导航模块交接（给其他模型）

更新：2026-09-23。主机：Windows `DESKTOP-VR4LMP5`（WSL2）。给接手导航（含 MCP）的模型用。

## 一句话现状

独立导航页跑在 **openPlan ThreeViewer 壳**上，寻路在 **gifu `floor_nav.py`**；数据读已保存 `project.json` 的墙/门/房。刚做了斜线/门心/箭头/已走变灰，但 **3D 路径线用了 `depthTest:false` 抬高，用户反馈斜线整段悬在墙和房间之上**——优先修渲染高度/深度，不要再抬层。

## 本机文件在哪

| 用途 | 路径 | 分支 / 说明 |
|------|------|-------------|
| **导航 API + 寻路 + 导入服务 + MCP 脚本** | `/tmp/gifu-openplan-nav-shell` | gifu worktree · `cursor/openplan-nav-shell-a695` · PR [#38](https://github.com/Loooke19/gifu-hospital-3d-cloud/pull/38) |
| **主仓检出（别当导航工作区）** | `/home/loooke/Projects/gifu-hospital-3d-cloud` | 可能停在旧 MCP 分支；改导航请用上面 worktree |
| **工程数据** | `/home/loooke/Projects/gifu-hospital-3d-cloud/data/kujiale-import` | worktree 里软链到此 |
| **编辑器 + `/nav` 壳 + 材质预设** | `/home/loooke/Projects/openPlan3D` | `cursor/hospital-nav-shell-a695`（fork `Loooke19/openPlan3D`；勿推 laanlabs 上游） |
| **Project Context（文档/截图）** | Agent Store `bc-8097b1e1-0215-4b44-93fa-f96676d9b948` | 本机挂载约 `~/.local/state/cursor/agent-stores/cursor_agent_stores/bc-8097b1e1-0215-4b44-93fa-f96676d9b948/files/` |

### 关键源文件（导航）

**gifu worktree**

- `scripts/floor_nav.py` — 格网、走道优先、门心、8 向 A*、string-pull、不穿墙
- `scripts/kujiale_import_server.py` — `:8882` 文件页、`/nav` 302、`/api/projects/.../route`、`map.json`
- `scripts/openplan_editor_mcp.py` / `scripts/openplan_editor_session.py` — MCP
- `tests/test_floor_nav.py`

**openPlan**

- `src/routes/nav/+page.svelte` — 导航页（无编辑工具）
- `src/lib/components/.../ThreeViewer`（或同树导航相关）— 路径线、箭头、已走灰；**悬空多半在这里**（`depthTest:false` / 抬高）
- 材质预设：`hospital-wall`（医院墙面）、`hospital-floor`（医院地砖）

### 样例工程

- id：`f9e6bb1cdf994280b5f506c130ec2aeb`
- JSON：`http://127.0.0.1:8882/api/projects/f9e6bb1cdf994280b5f506c130ec2aeb.json`

## 本机 URL（当前约定）

| 服务 | URL |
|------|-----|
| 导入 / 文件 | http://127.0.0.1:8882/ · http://127.0.0.1:8882/files |
| 导航短链 | http://127.0.0.1:8882/nav?id=f9e6bb1cdf994280b5f506c130ec2aeb&floor=floor-0 |
| 导航壳 | http://127.0.0.1:5173/nav?projectUrl=…&apiOrigin=http://127.0.0.1:8882&floor=floor-0 |
| 编辑器 | http://127.0.0.1:5173/editor |
| MCP | http://127.0.0.1:8879/mcp |
| MCP health | http://127.0.0.1:8879/bridge/health |
| MCP config | http://127.0.0.1:8879/bridge/config |

导入/文件/导航 API = **8882**；MCP = **8879**；openPlan = **5173**。一般不起 8877。

详细 tmux/PID/再起命令：`internal/local-remake-stack-urls.md`。

## 架构（别走错）

```
文件卡片「导航浏览」→ :8882/nav 302
    → openPlan :5173/nav（Three 壳，无编辑）
         起终点/途经点/模拟/第一人称/设施筛选
         路径渲染在 ThreeViewer
    ← POST :8882/api/projects/{id}/route  （floor_nav）
    ← GET  project.json / map.json
```

- **不要**把户型再送回旧 Maker `build_snapshot` 做寻路（见 [可行性](openplan-to-nav-feasibility.md)）。
- 导航读**磁盘已保存** JSON；编辑器保存时先写 IndexedDB，再（防抖）`PUT :8882/api/projects/{id}.json` 写回，带 `revision` 乐观并发，冲突 409 由用户选择（gifu `7911ae7`，openPlan3D `3d15267`）。
- 跨楼层寻路已实现（电梯/楼梯 `verticalLinks`，`floor_nav` 多层路由）。

## 已定规则（接手时保持）

1. **走道优先**：走廊可走；非起终点有门的房间只经「一门 → 中心」spur，不穿房抄近路。
2. **不穿墙**：墙带全封锁；门洞有上限与几何回扫。
3. **斜线**：8 向 A* + string-pull（曾因穿墙改过 4 向，已恢复）。
4. **门心 / 离墙**：过门折叠到门中心；离墙代价。
5. **视觉**：箭头；模拟已走灰、未走蓝——但 **3D 勿再用整段 depthTest:false 悬空**。

## 已知问题（下一位优先）

| 问题 | 线索 | 状态（2026-10-10） |
|------|------|------|
| **斜线/路径悬空，压在墙房之上** | path-style 里为防遮挡对 3D 路径/`chevron` 用了 `depthTest:false` 或抬高 | **已修**：导航 3D 路线改为贴地（y≈4.6cm）、全部参与深度测试的 `NavRouteVisual` 色带（openPlan3D `34e166a`）；回归测试 `tests/nav-route-depth.test.ts` |
| 编辑器改墙未写回时导航仍是旧 JSON | 需保存回 `:8882` 工程，或另做写回 | **已修**：编辑器写回 + 修订号/409 冲突/历史备份（gifu `7911ae7` + `tests/test_project_writeback.py`；openPlan3D `3d15267`） |
| 房间名多为「房间 N」 | OCR 房间名另一条线，未完全进测试环境 | **已修**：PDF 文字/OCR 命名已在主线（`_apply_pdf_room_names`），`rapidocr` 已在 requirements；新增端到端测试 `tests/test_pdf_import_e2e.py`（真实 OCR 栈导入合成两层 PDF，房间名全部来自图纸） |
| （新发现）PDF 导入电梯点落进隔壁房间 | 封闭电梯井连不上走廊，兜底按直线最近格子越墙 | **已修**：gifu `aaba2ef`，回归测试在 `tests/test_pdf_building.py` |

相关内部记录：`internal/openplan-nav-shell-result.md`、`openplan-nav-corridor-result.md`、`openplan-nav-wallfix-result.md`、`openplan-nav-path-style-result.md`。

## PR 链

| PR | 内容 |
|----|------|
| [#33](https://github.com/Loooke19/gifu-hospital-3d-cloud/pull/33) | 酷家乐×openPlan 重做基线（楼板+曾合入 MCP） |
| [#34](https://github.com/Loooke19/gifu-hospital-3d-cloud/pull/34) | 编辑器 MCP（已并入 #33 叙述） |
| [#36](https://github.com/Loooke19/gifu-hospital-3d-cloud/pull/36) | 单层平面导航起步 |
| [#37](https://github.com/Loooke19/gifu-hospital-3d-cloud/pull/37) | Maker scene3d 完整导航（后被壳方案取代） |
| [#38](https://github.com/Loooke19/gifu-hospital-3d-cloud/pull/38) | **当前主线**：openPlan 壳 + 材质预设 + 走道/穿墙/路径样式 |

---

## MCP 部署方式

### 作用

**编辑器 MCP**（不是导航 MCP）：让 Cursor 等客户端读写**当前打开的** openPlan 编辑器会话（墙/门/房间补丁）。修导航边界时可用来对照几何；**寻路本身不走 MCP**，走 `floor_nav` HTTP。

### 启动（WSL，在 gifu 导航 worktree）

```bash
cd /tmp/gifu-openplan-nav-shell
.venv/bin/python scripts/openplan_editor_mcp.py --host 127.0.0.1 --port 8879
# 或：python3 scripts/openplan_editor_mcp.py
```

环境变量（可选）：

| 变量 | 默认 |
|------|------|
| `OPENPLAN_MCP_HOST` | `127.0.0.1` |
| `OPENPLAN_MCP_PORT` | `8879` |
| `OPENPLAN_MCP_TOKEN` | 空（若设则要 Bearer） |

只绑 loopback。健康检查：`curl -s http://127.0.0.1:8879/bridge/health`  
部署参数：`http://127.0.0.1:8879/bridge/config`

tmux 常用 session 名：`openplan-editor-mcp`。

### Cursor 客户端配置

本机已写过：`C:\Users\offic\.cursor\mcp.json`（保留其他服务如 blender 的同时加入）：

```json
{
  "mcpServers": {
    "openplan-editor": {
      "url": "http://127.0.0.1:8879/mcp"
    }
  }
}
```

若设了 token：

```json
{
  "mcpServers": {
    "openplan-editor": {
      "url": "http://127.0.0.1:8879/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

改完后在 Cursor Desktop **Reload MCP**（或重开窗口）。编辑器页保持打开，右下角气泡为绿色后再调工具。改 MCP 端口时编辑器用 `?mcpOrigin=http://127.0.0.1:端口`。

### 工具一览

| 工具 | 作用 |
|------|------|
| `editor_session` | 在线会话 |
| `editor_get_project` | 工程摘要（无完整墙坐标） |
| `editor_get_floor` | 墙/门窗/房间；大图层用 `ids` |
| `editor_set_walls` / `editor_set_openings` / `editor_set_room` | 补丁（走撤销栈） |
| `editor_load_project` | 按 `projectUrl` 载入 |

多标签时传 `sessionId`。详情与气泡说明见 `internal/openplan-editor-mcp-result.md`；可行性见 [openplan-mcp-feasibility.md](openplan-mcp-feasibility.md)。

### 和导航一起用的建议

1. 浏览器打开编辑器并载入同一 `projectUrl`。
2. MCP `editor_get_floor` 核对墙厚/门洞。
3. 同一工程在 `/nav` 跑路线，对照是否穿墙、贴门、悬空。
4. 改的是 `floor_nav.py` 或 Three 路径渲染，不是 MCP 协议本身。

---

## 建议接手顺序

1. 确认三服务：8882 / 8879 / 5173（见上）。
2. **先修 3D 路径悬空**（贴地 + 正确 depth）。
3. 回归：斜线、门心、离墙、箭头、已走变灰、不穿墙、走道优先。
4. 有几何疑问再用 MCP 读墙门房。
5. 提交推到 `#38` 分支 / 更新 PR。

## 相关文档

- [openplan-to-nav-feasibility.md](openplan-to-nav-feasibility.md) — 为何不接 Maker 寻路
- [kujiale-openplan-remake.md](kujiale-openplan-remake.md) — 重做 UX/3D 规则
- [openplan-mcp-feasibility.md](openplan-mcp-feasibility.md) — MCP 范围

#!/usr/bin/env python3
"""Loopback MCP for the openPlan editor session.

One process serves Cursor at ``POST /mcp`` and the editor page at ``/bridge``.
Patches are applied in the open page (undo stays in the editor). This server
does not wrap the upstream share MCP, drive Chinese menus, or execute page JS.

Start: ``python3 scripts/openplan_editor_mcp.py``
Bind is fixed to 127.0.0.1. Optional ``OPENPLAN_MCP_TOKEN``.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import sys
import uuid
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

sys.path.insert(0, str(Path(__file__).resolve().parent))

import openplan_project_tools as project_tools  # noqa: E402
from openplan_editor_session import (  # noqa: E402
    DEFAULT_PORT,
    DETAIL_LIMIT,
    Hub,
    SessionError,
    floor_detail,
    summarize_project,
    validate_load,
    validate_new_walls,
    validate_openings,
    validate_room,
    validate_room_face,
    validate_screenshot,
    validate_upsert_rooms,
    validate_wall_patches,
)

PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
SERVER_INFO = {"name": "openplan-editor", "version": "0.1.0"}
INSTRUCTIONS = (
    "本服务只读写已经打开的 openPlan 编辑器会话（127.0.0.1）。"
    "先看 editor_session。get 默认是摘要；墙坐标用 editor_get_floor，可用 ids 过滤。"
    "editor_set_walls / editor_set_openings / editor_set_room 改当前页，并记入编辑器撤销。"
    "editor_add_walls 可以新建墙。editor_upsert_rooms 可以新建房间或改已有房间的名字、颜色、地面材质。"
    "editor_add_room_face 按多边形铺一块地面，墙没闭合也能画出来。editor_screenshot 截当前 2D 或 3D 画面并写成 PNG。"
    "不会写回 :8877 的 project.json。editor_load_project 会整页载入本机 JSON 并清空撤销。"
    "没有 select_room、execute_js，也不连接上游 share MCP。"
    "project_* 工具不需要打开编辑器：直接经导入服务（OPENPLAN_IMPORT_API，默认 :8882）读写 project.json，"
    "带版本号乐观并发；可改房间显示名/别名、楼梯电梯连通、指北方向、按已知长度校准比例，并导出模型做比对。"
    "门窗 position 必须在 [0,1]，墙或房间不存在就拒绝。多个编辑器页同时开着时要传 sessionId。"
)


def assert_loopback(host: str) -> None:
    if host != "127.0.0.1":
        raise SystemExit("openplan editor MCP 只绑定 127.0.0.1")


def _tools() -> list[dict]:
    session = {"type": "string", "description": "多个编辑器页同时在线时必填"}
    floor = {"type": "string", "description": "楼层 id，省略则用当前楼层"}
    return [
        {
            "name": "editor_session",
            "description": "当前打开的编辑器会话：工程 id、楼层数量、是否过期。没有坐标。",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        },
        {
            "name": "editor_get_project",
            "description": "当前会话的工程摘要：楼层数量、包围盒。不返回墙坐标。",
            "inputSchema": {
                "type": "object",
                "properties": {"sessionId": session},
                "additionalProperties": False,
            },
        },
        {
            "name": "editor_get_floor",
            "description": "一面楼的墙、门窗、房间。超过 200 个时只给 id，请用 ids 再取。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sessionId": session,
                    "floorId": floor,
                    "ids": {"type": "array", "items": {"type": "string"}, "description": "只返回这些墙/门/窗/房 id"},
                },
                "additionalProperties": False,
            },
        },
        {
            "name": "editor_set_walls",
            "description": "按 id 改已有墙的端点、厚度、高度、颜色。不新建、不删除。写入当前编辑器并可撤销。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sessionId": session,
                    "floorId": floor,
                    "patches": {
                        "type": "array",
                        "items": {"type": "object"},
                        "description": "每项含 id，以及 start/end/thickness/height/color 中的若干字段",
                    },
                },
                "required": ["patches"],
                "additionalProperties": False,
            },
        },
        {
            "name": "editor_set_openings",
            "description": "改或新建门窗。position 必须在 [0,1]，wallId 必须存在，越界直接拒绝。已有 id 不存在则拒绝，不会另造一个同 id。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sessionId": session,
                    "floorId": floor,
                    "doors": {"type": "array", "items": {"type": "object"}},
                    "windows": {"type": "array", "items": {"type": "object"}},
                },
                "additionalProperties": False,
            },
        },
        {
            "name": "editor_set_room",
            "description": "改已有房间的 name、color、floorTexture。房间不存在就拒绝，不会按矩形新建房间。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sessionId": session,
                    "floorId": floor,
                    "id": {"type": "string"},
                    "name": {"type": "string"},
                    "color": {"type": "string"},
                    "floorTexture": {"type": "string"},
                },
                "required": ["id"],
                "additionalProperties": False,
            },
        },
        {
            "name": "editor_add_walls",
            "description": "新建墙。每项要有 start/end（厘米）。可选 id、thickness、height、color。不会改已有墙。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sessionId": session,
                    "floorId": floor,
                    "walls": {
                        "type": "array",
                        "items": {"type": "object"},
                        "description": "start/end 为 {x,y}。id 省略则由编辑器生成",
                    },
                },
                "required": ["walls"],
                "additionalProperties": False,
            },
        },
        {
            "name": "editor_upsert_rooms",
            "description": "新建或更新房间。已有 id 改 name/color/floorTexture/walls；没有 id 则新建，新建必须带 walls（已有墙 id）。过道用地砖 ceramic-gray，房间用 none。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sessionId": session,
                    "floorId": floor,
                    "rooms": {
                        "type": "array",
                        "items": {"type": "object"},
                        "description": "每项含 id。floorTexture 例如 none 或 ceramic-gray",
                    },
                },
                "required": ["rooms"],
                "additionalProperties": False,
            },
        },
        {
            "name": "editor_add_room_face",
            "description": "按多边形铺一块房间地面。墙没闭合成环也能画出来。polygon 至少 3 个 {x,y}（厘米）。floorTexture 默认 none，过道用 ceramic-gray。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sessionId": session,
                    "floorId": floor,
                    "id": {"type": "string"},
                    "name": {"type": "string"},
                    "color": {"type": "string"},
                    "floorTexture": {"type": "string"},
                    "polygon": {
                        "type": "array",
                        "items": {"type": "object"},
                        "description": "地面轮廓，厘米坐标，按顺序闭合",
                    },
                },
                "required": ["polygon"],
                "additionalProperties": False,
            },
        },
        {
            "name": "editor_screenshot",
            "description": "截当前编辑器画面。view 为 2d、3d 或 both。PNG 写到本机路径，不把图片正文塞回对话。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sessionId": session,
                    "view": {"type": "string", "description": "2d、3d 或 both，默认 3d"},
                },
                "additionalProperties": False,
            },
        },
        {
            "name": "editor_load_project",
            "description": "让打开的编辑器载入本机 projectUrl（例如 :8877 的 project.json）。会清空撤销栈。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sessionId": session,
                    "projectUrl": {"type": "string"},
                },
                "required": ["projectUrl"],
                "additionalProperties": False,
            },
        },
        *project_tools.tool_specs(),
    ]


def _mcp_config(port: int, token_required: bool) -> dict:
    server: dict = {"url": f"http://127.0.0.1:{port}/mcp"}
    if token_required:
        server["headers"] = {"Authorization": "Bearer YOUR_TOKEN"}
    return {"mcpServers": {"openplan-editor": server}}


def _deploy(port: int, token_required: bool) -> dict:
    return {
        "host": "127.0.0.1",
        "port": port,
        "mcpPath": "/mcp",
        "bridgePath": "/bridge",
        "mcpUrl": f"http://127.0.0.1:{port}/mcp",
        "healthUrl": f"http://127.0.0.1:{port}/bridge/health",
        "tokenRequired": token_required,
        "env": {
            "OPENPLAN_MCP_HOST": "127.0.0.1",
            "OPENPLAN_MCP_PORT": str(port),
            "OPENPLAN_MCP_TOKEN": "可选，留空则不校验",
        },
        "start": [
            "python3 scripts/openplan_editor_mcp.py",
            "py -3 scripts/openplan_editor_mcp.py",
        ],
        "mcpJson": _mcp_config(port, token_required),
        "notes": [
            "在 gifu-hospital-3d-tour 仓库里启动，进程只听 127.0.0.1。",
            "Cursor 使用下面的 mcp.json。编辑器页保持打开，气泡为绿色后再改工程。",
            "改端口时，用 ?mcpOrigin=http://127.0.0.1:端口 打开编辑器。",
        ],
    }


SHOT_DIR = Path("/tmp/openplan-editor-shots")


def _store_screenshots(summary: dict) -> dict:
    images = summary.get("images") if isinstance(summary, dict) else None
    if not isinstance(images, list) or not images:
        raise SessionError("截图是空的")
    SHOT_DIR.mkdir(parents=True, exist_ok=True)
    saved = []
    for image in images:
        if not isinstance(image, dict):
            continue
        raw = image.get("pngBase64")
        if not isinstance(raw, str) or not raw.strip():
            continue
        payload = raw.strip()
        if payload.startswith("data:"):
            comma = payload.find(",")
            payload = payload[comma + 1:] if comma >= 0 else ""
        try:
            data = base64.b64decode(payload, validate=True)
        except Exception:
            continue
        if len(data) < 32 or not data.startswith(b"\x89PNG\r\n\x1a\n"):
            continue
        view = image.get("view") if image.get("view") in {"2d", "3d"} else "view"
        path = SHOT_DIR / f"{view}-{uuid.uuid4().hex[:8]}.png"
        path.write_bytes(data)
        saved.append({
            "view": view,
            "path": str(path),
            "width": image.get("width") if isinstance(image.get("width"), int) else None,
            "height": image.get("height") if isinstance(image.get("height"), int) else None,
        })
    if not saved:
        raise SessionError("截图是空的")
    return {"images": saved}


def create_app(hub: Hub | None = None, token: str = "", port: int = DEFAULT_PORT) -> FastAPI:
    hub = hub or Hub()
    token = token.strip()
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"http://(127\.0\.0\.1|localhost)(:\d+)?$",
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["*"],
    )

    def authorized(request: Request) -> bool:
        if not token:
            return True
        header = request.headers.get("x-openplan-token", "")
        auth = request.headers.get("authorization", "")
        bearer = auth[7:] if auth.lower().startswith("bearer ") else ""
        return header == token or bearer == token

    def deny() -> JSONResponse:
        return JSONResponse({"ok": False, "error": "需要 token"}, status_code=401)

    @app.get("/bridge/health")
    def health():
        return {
            "ok": True,
            "service": "openplan-editor-mcp",
            "host": "127.0.0.1",
            "port": port,
            "tokenRequired": bool(token),
            "sessions": len(hub.list_sessions()),
        }

    @app.get("/bridge/config")
    def config():
        return _deploy(port, bool(token))

    @app.post("/bridge/session")
    async def session(request: Request):
        if not authorized(request):
            return deny()
        body = await request.json()
        try:
            return hub.snapshot(
                str(body.get("sessionId") or ""),
                body.get("project"),
                str(body.get("editor") or ""),
                bool(body.get("heartbeat")),
            )
        except SessionError as exc:
            return JSONResponse({"ok": False, "error": exc.message}, status_code=400)

    @app.get("/bridge/commands")
    def commands(request: Request, sessionId: str):
        if not authorized(request):
            return deny()
        try:
            return {"commands": hub.poll(sessionId)}
        except SessionError as exc:
            return JSONResponse({"ok": False, "error": exc.message}, status_code=404)

    @app.post("/bridge/ack")
    async def ack(request: Request):
        if not authorized(request):
            return deny()
        body = await request.json()
        try:
            hub.ack(
                str(body.get("sessionId") or ""),
                str(body.get("id") or ""),
                bool(body.get("ok")),
                body.get("error"),
                body.get("summary") if isinstance(body.get("summary"), dict) else None,
                body.get("project") if isinstance(body.get("project"), dict) else None,
            )
        except SessionError as exc:
            return JSONResponse({"ok": False, "error": exc.message}, status_code=404)
        return {"ok": True}

    def call_tool(name: str, arguments: dict) -> dict:
        session_id = arguments.get("sessionId")
        if session_id is not None and not isinstance(session_id, str):
            raise SessionError("sessionId 无效")
        floor_id = arguments.get("floorId")
        if floor_id is not None and not isinstance(floor_id, str):
            raise SessionError("floorId 无效")
        if name in project_tools.TOOLS:
            # File-level tools: no editor tab, no bridge round-trip (never blocks on a page).
            try:
                return {"ok": True, **project_tools.TOOLS[name][0](arguments)}
            except project_tools.ToolError as exc:
                return {"ok": False, "error": exc.message}
        if name == "editor_session":
            rows = hub.list_sessions()
            return {"ok": True, "sessions": rows}
        if name == "editor_get_project":
            sid, project, age = hub.read_project(session_id)
            return {"ok": True, **summarize_project(project, sid, age)}
        if name == "editor_get_floor":
            sid, project, _age = hub.read_project(session_id)
            ids = arguments.get("ids")
            if ids is not None and (
                not isinstance(ids, list) or len(ids) > DETAIL_LIMIT or not all(isinstance(item, str) for item in ids)
            ):
                raise SessionError("ids 必须是不超过 200 个的字符串数组")
            detail = floor_detail(project, floor_id, ids, DETAIL_LIMIT)
            detail["ok"] = True
            detail["sessionId"] = sid
            return detail
        if name == "editor_set_walls":
            _sid, project, _age = hub.read_project(session_id)
            command = validate_wall_patches(project, floor_id, arguments.get("patches"))
        elif name == "editor_set_openings":
            _sid, project, _age = hub.read_project(session_id)
            command = validate_openings(project, floor_id, arguments.get("doors"), arguments.get("windows"))
        elif name == "editor_set_room":
            _sid, project, _age = hub.read_project(session_id)
            room = {
                key: arguments[key]
                for key in ("id", "name", "color", "floorTexture")
                if key in arguments
            }
            command = validate_room(project, floor_id, room)
        elif name == "editor_add_walls":
            _sid, project, _age = hub.read_project(session_id)
            command = validate_new_walls(project, floor_id, arguments.get("walls"))
        elif name == "editor_upsert_rooms":
            _sid, project, _age = hub.read_project(session_id)
            command = validate_upsert_rooms(project, floor_id, arguments.get("rooms"))
        elif name == "editor_add_room_face":
            _sid, project, _age = hub.read_project(session_id)
            command = validate_room_face(project, floor_id, arguments)
        elif name == "editor_screenshot":
            command = validate_screenshot(arguments.get("view"))
            result = hub.submit(session_id, command, timeout=25)
            if not result.get("ok"):
                return {"ok": False, "error": result.get("error") or "编辑器拒绝了修改", "sessionId": result.get("sessionId")}
            return {"ok": True, "sessionId": result.get("sessionId"), **_store_screenshots(result.get("summary") or {})}
        elif name == "editor_load_project":
            command = validate_load(arguments.get("projectUrl"))
        else:
            raise SessionError(f"未知工具: {name}")
        result = hub.submit(session_id, command)
        if not result.get("ok"):
            return {"ok": False, "error": result.get("error") or "编辑器拒绝了修改", "sessionId": result.get("sessionId")}
        return {"ok": True, "sessionId": result.get("sessionId"), **(result.get("summary") or {})}

    def rpc(body: dict) -> dict | None:
        if not isinstance(body, dict) or body.get("jsonrpc") != "2.0" or "method" not in body:
            return {"jsonrpc": "2.0", "id": body.get("id") if isinstance(body, dict) else None, "error": {"code": -32600, "message": "Invalid Request"}}
        method = body["method"]
        request_id = body.get("id")
        if method == "notifications/initialized" or method.startswith("notifications/"):
            return None
        if method == "initialize":
            params = body.get("params") or {}
            version = params.get("protocolVersion")
            if version not in PROTOCOL_VERSIONS:
                version = PROTOCOL_VERSIONS[1]
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "protocolVersion": version,
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": SERVER_INFO,
                    "instructions": INSTRUCTIONS,
                },
            }
        if method == "ping":
            return {"jsonrpc": "2.0", "id": request_id, "result": {}}
        if method == "tools/list":
            return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": _tools()}}
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": "Method not found"}}

    async def tool_result(request_id, name, arguments):
        if not isinstance(name, str) or not isinstance(arguments, dict):
            return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32602, "message": "Invalid params"}}
        try:
            payload = await asyncio.to_thread(call_tool, name, arguments)
        except SessionError as exc:
            payload = {"ok": False, "error": exc.message}
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}],
                "isError": not payload.get("ok", False),
            },
        }

    @app.post("/mcp")
    async def mcp(request: Request):
        if not authorized(request):
            return deny()
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}, status_code=400)
        session_header = {}
        if isinstance(body, dict) and body.get("method") == "initialize":
            session_header["Mcp-Session-Id"] = uuid.uuid4().hex
        if isinstance(body, list):
            replies = []
            for entry in body:
                if isinstance(entry, dict) and entry.get("method") == "tools/call":
                    params = entry.get("params") or {}
                    replies.append(await tool_result(entry.get("id"), params.get("name"), params.get("arguments") or {}))
                else:
                    reply = rpc(entry)
                    if reply is not None:
                        replies.append(reply)
            if not replies:
                return Response(status_code=202, headers=session_header)
            return JSONResponse(replies, headers=session_header)
        if not isinstance(body, dict):
            return JSONResponse({"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid Request"}}, status_code=400)
        if body.get("method") == "tools/call":
            params = body.get("params") or {}
            reply = await tool_result(body.get("id"), params.get("name"), params.get("arguments") or {})
            return JSONResponse(reply, headers=session_header)
        reply = rpc(body)
        if reply is None:
            return Response(status_code=202, headers=session_header)
        return JSONResponse(reply, headers=session_header)

    @app.get("/mcp")
    def mcp_get():
        return JSONResponse({"ok": False, "error": "use POST"}, status_code=405)

    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="openPlan editor MCP (loopback)")
    parser.add_argument("--host", default=os.environ.get("OPENPLAN_MCP_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("OPENPLAN_MCP_PORT", str(DEFAULT_PORT))))
    args = parser.parse_args()
    assert_loopback(args.host)
    token = os.environ.get("OPENPLAN_MCP_TOKEN", "")
    app = create_app(token=token, port=args.port)
    print(f"openplan editor MCP http://127.0.0.1:{args.port}/mcp", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=args.port, reload=False)


if __name__ == "__main__":
    main()

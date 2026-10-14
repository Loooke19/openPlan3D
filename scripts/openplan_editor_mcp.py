#!/usr/bin/env python3
"""
Loopback OpenPlan editor MCP + browser bridge + optional project API.

- MCP (JSON-RPC):     http://127.0.0.1:8879/mcp
- Editor bridge:      http://127.0.0.1:8879/bridge/*
- Project files API:  http://127.0.0.1:8882/api/projects/{id}.json

Environment:
  OPENPLAN_MCP_HOST, OPENPLAN_MCP_PORT (8879)
  OPENPLAN_API_PORT (8882)
  OPENPLAN_MCP_TOKEN (optional)
  OPENPLAN_DATA_DIR (directory tree with */project.json)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Deque
from urllib.parse import parse_qs, urlparse

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from openplan_mcp_apply import apply_command, project_counts  # noqa: E402
from openplan_project_io import (  # noqa: E402
    ProjectValidationError,
    atomic_write_project,
    index_project_files,
    load_project_file,
    validate_project_structure,
)

MCP_PROTOCOL_VERSION = "2025-06-18"
SERVER_INFO = {"name": "openplan-editor", "version": "0.2.0"}
INSTRUCTIONS = (
    "OpenPlan 本机编辑器 MCP。先打开浏览器编辑器并保持 MCP 气泡为绿色（已关联工程），"
    "再通过工具修改；修改会写入内存中的工程副本。save_project 会把当前副本安全写回 project.json。"
)


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    return int(raw)


def env_host() -> str:
    return os.environ.get("OPENPLAN_MCP_HOST", "127.0.0.1").strip() or "127.0.0.1"


def env_token() -> str:
    return os.environ.get("OPENPLAN_MCP_TOKEN", "").strip()


def data_dir() -> Path:
    raw = os.environ.get("OPENPLAN_DATA_DIR", "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    return (SCRIPT_DIR.parent / "tests" / "fixtures").resolve()


@dataclass
class Session:
    session_id: str
    editor: str = ""
    project: dict[str, Any] | None = None
    project_file: Path | None = None
    linked: bool = False
    updated_at: float = field(default_factory=time.time)
    commands: Deque[dict[str, Any]] = field(default_factory=deque)
    command_results: dict[str, dict[str, Any]] = field(default_factory=dict)


class AppState:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.sessions: dict[str, Session] = {}
        self.project_paths: dict[str, Path] = {}
        self.refresh_index()

    def refresh_index(self) -> None:
        self.project_paths = index_project_files(data_dir())

    def get_session(self, session_id: str) -> Session:
        with self.lock:
            session = self.sessions.get(session_id)
            if session is None:
                session = Session(session_id=session_id)
                self.sessions[session_id] = session
            return session

    def pick_session(self, session_id: str | None) -> Session:
        with self.lock:
            if session_id:
                return self.get_session(session_id)
            linked = [s for s in self.sessions.values() if s.linked and s.project]
            if len(linked) == 1:
                return linked[0]
            if self.sessions:
                return max(self.sessions.values(), key=lambda item: item.updated_at)
            return self.get_session("default")

    def bind_project_file(self, session: Session, project_id: str | None = None) -> Path | None:
        if session.project_file and session.project_file.is_file():
            return session.project_file
        pid = project_id or (session.project or {}).get("id")
        if isinstance(pid, str) and pid in self.project_paths:
            session.project_file = self.project_paths[pid]
            return session.project_file
        return None

    def enqueue(self, session: Session, command: dict[str, Any]) -> dict[str, Any]:
        command = {**command, "id": command.get("id") or str(uuid.uuid4())}
        if session.project is not None:
            applied = apply_command(session.project, command)
            if applied.get("ok") and applied.get("project") is not None:
                session.project = applied["project"]
                session.updated_at = time.time()
        with self.lock:
            session.commands.append(command)
        return command


STATE = AppState()


def authorized(headers: dict[str, str]) -> bool:
    token = env_token()
    if not token:
        return True
    auth = headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip() == token
    return headers.get("x-openplan-token", "").strip() == token


def json_response(handler: BaseHTTPRequestHandler, status: int, payload: Any) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def read_json(handler: BaseHTTPRequestHandler) -> Any:
    length = int(handler.headers.get("Content-Length", "0") or "0")
    raw = handler.rfile.read(length) if length else b"{}"
    return json.loads(raw.decode("utf-8") or "{}")


def bridge_config() -> dict[str, Any]:
    host = env_host()
    port = env_int("OPENPLAN_MCP_PORT", 8879)
    origin = f"http://{host}:{port}"
    token_required = bool(env_token())
    server: dict[str, Any] = {"url": f"{origin}/mcp"}
    if token_required:
        server["headers"] = {"X-OpenPlan-Token": "YOUR_TOKEN"}
    return {
        "host": host,
        "port": port,
        "mcpPath": "/mcp",
        "mcpUrl": f"{origin}/mcp",
        "apiPort": env_int("OPENPLAN_API_PORT", 8882),
        "apiOrigin": f"http://{host}:{env_int('OPENPLAN_API_PORT', 8882)}",
        "viteDev": "http://127.0.0.1:5173/editor",
        "env": {
            "OPENPLAN_MCP_HOST": host,
            "OPENPLAN_MCP_PORT": str(port),
            "OPENPLAN_API_PORT": str(env_int("OPENPLAN_API_PORT", 8882)),
            "OPENPLAN_MCP_TOKEN": "可选，留空则不校验",
            "OPENPLAN_DATA_DIR": str(data_dir()),
        },
        "start": [
            "python3 scripts/openplan_editor_mcp.py",
            "py -3 scripts/openplan_editor_mcp.py",
        ],
        "notes": [
            "在本仓库根目录启动：python3 scripts/openplan_editor_mcp.py",
            "进程只监听 127.0.0.1。Vite 开发服默认 http://127.0.0.1:5173/editor",
            "Cursor 使用下面的 mcp.json；编辑器页保持打开，气泡变绿后再改工程。",
            "save_project 会把当前内存工程写回 OPENPLAN_DATA_DIR 下匹配的 project.json。",
        ],
        "mcpJson": {"mcpServers": {"openplan-editor": server}},
    }


def mcp_tools() -> list[dict[str, Any]]:
    session_arg = {
        "sessionId": {
            "type": "string",
            "description": "编辑器 session id；省略时使用最近关联的会话",
        }
    }
    return [
        {
            "name": "editor_status",
            "description": "查看桥接状态、是否已关联工程、计数摘要。",
            "inputSchema": {"type": "object", "properties": session_arg},
        },
        {
            "name": "get_project",
            "description": "返回当前内存中的工程 JSON。",
            "inputSchema": {"type": "object", "properties": session_arg},
        },
        {
            "name": "set_room",
            "description": "修改已有房间名称/颜色/地面材质（同时排队给浏览器编辑器）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    **session_arg,
                    "floorId": {"type": "string"},
                    "room": {"type": "object"},
                },
                "required": ["room"],
            },
        },
        {
            "name": "set_walls",
            "description": "修改墙体坐标或尺寸（同时排队给浏览器编辑器）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    **session_arg,
                    "floorId": {"type": "string"},
                    "patches": {"type": "array", "items": {"type": "object"}},
                },
                "required": ["patches"],
            },
        },
        {
            "name": "save_project",
            "description": "把当前内存工程安全写回 project.json（备份、原子写入、结构校验）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    **session_arg,
                    "projectFile": {
                        "type": "string",
                        "description": "可选，显式 project.json 路径；默认按工程 id 在 OPENPLAN_DATA_DIR 中查找",
                    },
                },
            },
        },
    ]


def tool_result(value: Any, is_error: bool = False) -> dict[str, Any]:
    return {
        "content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False, indent=2)}],
        "structuredContent": value,
        "isError": is_error,
    }


def call_tool(name: str, args: dict[str, Any]) -> dict[str, Any]:
    session = STATE.pick_session(args.get("sessionId"))
    if name == "editor_status":
        project = session.project
        return tool_result(
            {
                "sessionId": session.session_id,
                "linked": session.linked,
                "editor": session.editor,
                "projectId": project.get("id") if project else None,
                "projectFile": str(session.project_file) if session.project_file else None,
                "counts": project_counts(project) if project else None,
                "pendingCommands": len(session.commands),
            }
        )
    if name == "get_project":
        if session.project is None:
            return tool_result({"error": "没有工程副本"}, is_error=True)
        return tool_result({"project": session.project})

    if name in ("set_room", "set_walls"):
        command = {"op": name, "floorId": args.get("floorId")}
        if name == "set_room":
            command["room"] = args.get("room") or {}
        else:
            command["patches"] = args.get("patches") or []
        if session.project is None:
            return tool_result({"error": "没有工程副本，请先在编辑器打开工程"}, is_error=True)
        queued = STATE.enqueue(session, command)
        return tool_result({"queued": queued["id"], "counts": project_counts(session.project or {})})

    if name == "save_project":
        if session.project is None:
            return tool_result({"error": "没有可保存的工程"}, is_error=True)
        target: Path | None = None
        explicit = args.get("projectFile")
        if isinstance(explicit, str) and explicit.strip():
            target = Path(explicit).expanduser().resolve()
        else:
            STATE.refresh_index()
            target = STATE.bind_project_file(session)
        if target is None:
            return tool_result({"error": "找不到 project.json，请设置 OPENPLAN_DATA_DIR 或传入 projectFile"}, is_error=True)
        try:
            backup = atomic_write_project(target, session.project)
            session.project_file = target
            return tool_result(
                {
                    "saved": str(target),
                    "backup": str(backup) if backup != target else None,
                    "projectId": session.project.get("id"),
                }
            )
        except (ProjectValidationError, OSError, json.JSONDecodeError) as error:
            return tool_result({"error": str(error)}, is_error=True)

    return tool_result({"error": f"Unknown tool: {name}"}, is_error=True)


def handle_mcp_message(message: dict[str, Any]) -> dict[str, Any] | None:
    if not isinstance(message, dict) or not isinstance(message.get("method"), str):
        return {"jsonrpc": "2.0", "id": message.get("id"), "error": {"code": -32600, "message": "Invalid request"}}
    method = message["method"]
    msg_id = message.get("id")
    if method.startswith("notifications/") or msg_id is None:
        return None
    params = message.get("params") or {}
    if method == "initialize":
        requested = params.get("protocolVersion") or MCP_PROTOCOL_VERSION
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "protocolVersion": requested,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": SERVER_INFO,
                "instructions": INSTRUCTIONS,
            },
        }
    if method == "ping":
        return {"jsonrpc": "2.0", "id": msg_id, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": msg_id, "result": {"tools": mcp_tools()}}
    if method == "tools/call":
        name = str(params.get("name", ""))
        arguments = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
        return {"jsonrpc": "2.0", "id": msg_id, "result": call_tool(name, arguments)}
    return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32601, "message": f"Method not found: {method}"}}


class McpBridgeHandler(BaseHTTPRequestHandler):
    server_version = "openplan-editor-mcp/0.2"

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
        sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), format % args))

    def _headers_map(self) -> dict[str, str]:
        return {key.lower(): value for key, value in self.headers.items()}

    def _reject_auth(self) -> bool:
        if authorized(self._headers_map()):
            return False
        json_response(self, 401, {"detail": "unauthorized"})
        return True

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-OpenPlan-Token")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self._reject_auth():
            return
        parsed = urlparse(self.path)
        if parsed.path == "/bridge/health":
            json_response(self, 200, {"ok": True, "tokenRequired": bool(env_token())})
            return
        if parsed.path == "/bridge/config":
            json_response(self, 200, bridge_config())
            return
        if parsed.path == "/bridge/commands":
            query = parse_qs(parsed.query)
            session_id = (query.get("sessionId") or [""])[0]
            session = STATE.get_session(session_id)
            with STATE.lock:
                commands = list(session.commands)
                session.commands.clear()
            json_response(self, 200, {"commands": commands})
            return
        json_response(self, 404, {"detail": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self._reject_auth():
            return
        parsed = urlparse(self.path)
        if parsed.path == "/mcp":
            try:
                payload = read_json(self)
            except json.JSONDecodeError:
                json_response(self, 400, {"error": "invalid json"})
                return
            if isinstance(payload, list):
                responses = [handle_mcp_message(item) for item in payload]
                json_response(self, 200, [item for item in responses if item is not None])
                return
            response = handle_mcp_message(payload)
            if response is None:
                self.send_response(202)
                self.end_headers()
                return
            json_response(self, 200, response)
            return

        body = read_json(self)
        if parsed.path == "/bridge/session":
            session_id = str(body.get("sessionId") or "")
            if not session_id:
                json_response(self, 400, {"detail": "sessionId"})
                return
            session = STATE.get_session(session_id)
            session.editor = str(body.get("editor") or session.editor)
            heartbeat = bool(body.get("heartbeat"))
            if not heartbeat and body.get("project") is not None:
                session.project = validate_project_structure(body["project"])
                session.linked = True
                session.updated_at = time.time()
                STATE.bind_project_file(session)
            elif heartbeat:
                session.linked = session.project is not None
            json_response(self, 200, {"ok": True, "linked": session.linked})
            return

        if parsed.path == "/bridge/ack":
            session_id = str(body.get("sessionId") or "")
            command_id = str(body.get("id") or "")
            session = STATE.get_session(session_id)
            if body.get("project") is not None:
                try:
                    session.project = validate_project_structure(body["project"])
                except ProjectValidationError:
                    pass
            session.command_results[command_id] = {
                "ok": bool(body.get("ok")),
                "error": body.get("error"),
                "summary": body.get("summary"),
            }
            session.updated_at = time.time()
            json_response(self, 200, {"ok": True})
            return

        json_response(self, 404, {"detail": "not found"})


class ApiHandler(BaseHTTPRequestHandler):
    server_version = "openplan-editor-api/0.2"

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
        sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), format % args))

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        match = parsed.path
        if match.startswith("/api/projects/") and match.endswith(".json"):
            from urllib.parse import unquote

            project_id = unquote(match[len("/api/projects/") : -len(".json")])
            STATE.refresh_index()
            path = STATE.project_paths.get(project_id)
            if path is None:
                json_response(self, 404, {"detail": "not found"})
                return
            try:
                project = load_project_file(path)
            except (OSError, json.JSONDecodeError, ProjectValidationError):
                json_response(self, 500, {"detail": "invalid project file"})
                return
            json_response(self, 200, project)
            return
        json_response(self, 404, {"detail": "not found"})


def serve() -> None:
    host = env_host()
    if host not in ("127.0.0.1", "localhost"):
        raise SystemExit("OPENPLAN_MCP_HOST must be loopback")
    mcp_port = env_int("OPENPLAN_MCP_PORT", 8879)
    api_port = env_int("OPENPLAN_API_PORT", 8882)

    mcp_server = ThreadingHTTPServer((host, mcp_port), McpBridgeHandler)
    api_server = ThreadingHTTPServer((host, api_port), ApiHandler)

    def run(server: ThreadingHTTPServer) -> None:
        with server:
            server.serve_forever()

    threads = [
        threading.Thread(target=run, args=(mcp_server,), name="mcp-bridge", daemon=True),
        threading.Thread(target=run, args=(api_server,), name="project-api", daemon=True),
    ]
    for thread in threads:
        thread.start()

    print(
        json.dumps(
            {
                "mcp": f"http://{host}:{mcp_port}/mcp",
                "bridge": f"http://{host}:{mcp_port}/bridge/health",
                "api": f"http://{host}:{api_port}/api/projects/{{id}}.json",
                "dataDir": str(data_dir()),
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        mcp_server.shutdown()
        api_server.shutdown()


def main() -> None:
    parser = argparse.ArgumentParser(description="OpenPlan editor MCP (loopback)")
    parser.add_argument("--check-config", action="store_true", help="Print bridge config JSON and exit")
    args = parser.parse_args()
    if args.check_config:
        print(json.dumps(bridge_config(), ensure_ascii=False, indent=2))
        return
    serve()


if __name__ == "__main__":
    main()

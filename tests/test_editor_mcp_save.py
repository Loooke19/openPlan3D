#!/usr/bin/env python3
"""Minimal MCP change → save → reload test on a temporary project copy."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "save-conflicts.openplan.json"
SCRIPT = ROOT / "scripts" / "openplan_editor_mcp.py"


def http_json(method: str, url: str, payload: dict | None = None) -> dict:
    data = None
    headers = {"Content-Type": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read().decode("utf-8"))


def mcp_call(url: str, tool: str, arguments: dict) -> dict:
    body = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": tool, "arguments": arguments},
    }
    return http_json("POST", url, body)["result"]


def wait_health(bridge: str, timeout: float = 10.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            http_json("GET", f"{bridge}/health")
            return
        except (urllib.error.URLError, TimeoutError):
            time.sleep(0.15)
    raise RuntimeError("MCP server did not start")


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="openplan-mcp-save-") as tmp:
        data_dir = Path(tmp) / "data" / "mcp-save-case"
        data_dir.mkdir(parents=True)
        project_path = data_dir / "project.json"
        shutil.copyfile(FIXTURE, project_path)
        original = json.loads(project_path.read_text(encoding="utf-8"))
        room_id = original["floors"][0]["rooms"][0]["id"]
        old_name = original["floors"][0]["rooms"][0]["name"]
        new_name = f"{old_name} MCP-SAVE"

        env = os.environ.copy()
        env["OPENPLAN_MCP_PORT"] = "18879"
        env["OPENPLAN_API_PORT"] = "18882"
        env["OPENPLAN_DATA_DIR"] = str(Path(tmp) / "data")
        proc = subprocess.Popen(
            [sys.executable, str(SCRIPT)],
            cwd=str(ROOT),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            bridge = "http://127.0.0.1:18879/bridge"
            mcp_url = "http://127.0.0.1:18879/mcp"
            wait_health(bridge)

            session_id = "test-session"
            project = json.loads(project_path.read_text(encoding="utf-8"))
            http_json(
                "POST",
                f"{bridge}/session",
                {"sessionId": session_id, "editor": "http://127.0.0.1:5173/editor", "project": project},
            )

            change = mcp_call(
                mcp_url,
                "set_room",
                {"sessionId": session_id, "room": {"id": room_id, "name": new_name}},
            )
            if change.get("isError"):
                raise AssertionError(f"set_room failed: {change}")

            save = mcp_call(mcp_url, "save_project", {"sessionId": session_id})
            structured = save.get("structuredContent") or json.loads(save["content"][0]["text"])
            if save.get("isError") or "saved" not in structured:
                raise AssertionError(f"save_project failed: {save}")

            reloaded = json.loads(project_path.read_text(encoding="utf-8"))
            if reloaded["floors"][0]["rooms"][0]["name"] != new_name:
                raise AssertionError("project.json was not updated after save")

            api_url = f"http://127.0.0.1:18882/api/projects/{project['id']}.json"
            via_api = http_json("GET", api_url)
            if via_api["floors"][0]["rooms"][0]["name"] != new_name:
                raise AssertionError("API reload did not reflect saved change")

            print(json.dumps({"ok": True, "saved": structured["saved"], "room": new_name}, ensure_ascii=False))
            return 0
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())

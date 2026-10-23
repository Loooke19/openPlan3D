"""Editor MCP: loopback session, patch checks, and the page apply round trip."""
import json
import sys
import threading
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from openplan_editor_mcp import assert_loopback, create_app
from openplan_editor_session import Hub, SessionError, floor_detail


def sample_project(walls=1):
    return {
        "id": "p1",
        "name": "1F",
        "activeFloorId": "floor-1",
        "updatedAt": "2026-09-22T00:00:00",
        "floors": [{
            "id": "floor-1",
            "name": "1F",
            "level": 1,
            "walls": [
                {
                    "id": f"wall-{index}",
                    "start": {"x": 0, "y": index},
                    "end": {"x": 100, "y": index},
                    "thickness": 12,
                    "height": 280,
                    "color": "#e2e6e3",
                }
                for index in range(1, walls + 1)
            ],
            "doors": [{
                "id": "door-1",
                "wallId": "wall-1",
                "position": 0.5,
                "width": 90,
                "height": 210,
                "type": "single",
            }],
            "windows": [],
            "rooms": [{
                "id": "room-1",
                "name": "",
                "walls": ["wall-1"],
                "floorTexture": "none",
                "color": "#ddeeff",
                "area": 10,
            }],
            "stairs": [{"id": "stair-1"}],
        }],
    }


class EditorMcpTests(unittest.TestCase):
    def setUp(self):
        self.hub = Hub()
        self.client = TestClient(create_app(self.hub, port=8879))
        self.client.post("/bridge/session", json={
            "sessionId": "s1",
            "editor": "http://127.0.0.1:5173/editor",
            "project": sample_project(),
        })

    def test_refuses_non_loopback_bind(self):
        with self.assertRaises(SystemExit):
            assert_loopback("0.0.0.0")

    def test_health_and_config_stay_on_loopback(self):
        health = self.client.get("/bridge/health").json()
        self.assertTrue(health["ok"])
        self.assertEqual(health["host"], "127.0.0.1")
        self.assertFalse(health["tokenRequired"])
        config = self.client.get("/bridge/config").json()
        self.assertEqual(config["mcpUrl"], "http://127.0.0.1:8879/mcp")
        self.assertNotIn("headers", config["mcpJson"]["mcpServers"]["openplan-editor"])

    def test_mcp_lists_editor_tools_only(self):
        init = self.client.post("/mcp", json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}},
        })
        self.assertEqual(init.status_code, 200)
        self.assertTrue(init.headers.get("mcp-session-id") or init.headers.get("Mcp-Session-Id"))
        self.assertNotIn("summarize_share", init.json()["result"]["instructions"])
        listed = self.client.post("/mcp", json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        names = [tool["name"] for tool in listed.json()["result"]["tools"] if not tool["name"].startswith("project_")]
        self.assertEqual(names, [
            "editor_session",
            "editor_get_project",
            "editor_get_floor",
            "editor_set_walls",
            "editor_set_openings",
            "editor_set_room",
            "editor_add_walls",
            "editor_upsert_rooms",
            "editor_add_room_face",
            "editor_screenshot",
            "editor_load_project",
        ])
        self.assertTrue(all(name.startswith("editor_") for name in names))

    def test_get_project_is_a_summary(self):
        payload = self._tool("editor_get_project", {})
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["floors"][0]["walls"], 1)
        self.assertNotIn("start", json.dumps(payload["floors"]))
        self.assertEqual(payload["bbox"]["maxX"], 100)
        detail = self._tool("editor_get_floor", {"ids": ["wall-1", "room-1"]})
        self.assertEqual(detail["walls"][0]["id"], "wall-1")
        self.assertEqual(detail["rooms"][0]["name"], "")
        self.assertNotIn("area", detail["rooms"][0])

    def test_large_floor_asks_for_ids(self):
        self.client.post("/bridge/session", json={"sessionId": "s1", "project": sample_project(walls=201)})
        detail = floor_detail(self.hub.read_project("s1")[1], None, None)
        self.assertTrue(detail["truncated"])
        self.assertNotIn("walls", detail)
        self.assertEqual(len(detail["wallIds"]), 201)

    def test_rejects_bad_opening_and_missing_room(self):
        opening = self._tool("editor_set_openings", {"doors": [{"id": "door-1", "position": 1.2}]})
        self.assertFalse(opening["ok"])
        self.assertIn("[0,1]", opening["error"])
        missing_wall = self._tool("editor_set_openings", {"doors": [{"wallId": "missing", "position": 0.2}]})
        self.assertIn("wallId", missing_wall["error"])
        room = self._tool("editor_set_room", {"id": "room-new", "name": "新建"})
        self.assertIn("不会新建", room["error"])
        added = self._tool("editor_add_walls", {"walls": [{"start": {"x": 0, "y": 0}, "end": {"x": 0, "y": 0}}]})
        self.assertIn("长度为 0", added["error"])
        created = self._tool("editor_upsert_rooms", {"rooms": [{"id": "room-new", "name": "走廊", "floorTexture": "ceramic-gray"}]})
        self.assertIn("需要 walls", created["error"])
        short = self._tool("editor_add_room_face", {"polygon": [{"x": 0, "y": 0}, {"x": 10, "y": 0}]})
        self.assertIn("至少要 3 个点", short["error"])
        flat = self._tool("editor_add_room_face", {"polygon": [{"x": 0, "y": 0}, {"x": 10, "y": 0}, {"x": 20, "y": 0}]})
        self.assertIn("面积为 0", flat["error"])
        shot = self._tool("editor_screenshot", {"view": "top"})
        self.assertIn("2d", shot["error"])
        wall = self._tool("editor_set_walls", {"patches": [{"id": "wall-1", "thickness": True}]})
        self.assertFalse(wall["ok"])
        remote = self._tool("editor_load_project", {"projectUrl": "https://example.com/p.json"})
        self.assertIn("本机", remote["error"])
        self.assertEqual(self.client.get("/bridge/commands", params={"sessionId": "s1"}).json()["commands"], [])

    def test_patch_waits_for_the_editor(self):
        import time
        found = {}

        def call():
            try:
                found["result"] = self.hub.submit("s1", {
                    "op": "set_room",
                    "floorId": "floor-1",
                    "room": {"id": "room-1", "name": "护士站"},
                }, timeout=2)
            except Exception as exc:
                found["error"] = exc

        worker = threading.Thread(target=call)
        worker.start()
        command = None
        for _ in range(40):
            rows = self.client.get("/bridge/commands", params={"sessionId": "s1"}).json()["commands"]
            if rows:
                command = rows[0]
                break
            time.sleep(0.05)
        self.assertIsNotNone(command)
        self.assertEqual(command["room"]["name"], "护士站")
        project = sample_project()
        project["floors"][0]["rooms"][0]["name"] = "护士站"
        self.client.post("/bridge/ack", json={
            "sessionId": "s1",
            "id": command["id"],
            "ok": True,
            "summary": {"changed": ["room-1"], "undo": "editor"},
            "project": project,
        })
        worker.join(2)
        self.assertNotIn("error", found)
        self.assertEqual(found["result"]["summary"]["changed"], ["room-1"])
        detail = self._tool("editor_get_floor", {"ids": ["room-1"]})
        self.assertEqual(detail["rooms"][0]["name"], "护士站")

    def test_screenshot_writes_png_without_returning_bytes(self):
        import time
        png = (
            "data:image/png;base64,"
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        )
        found = {}

        def call():
            try:
                found["result"] = self._tool("editor_screenshot", {"view": "2d"})
            except Exception as exc:
                found["error"] = exc

        worker = threading.Thread(target=call)
        worker.start()
        command = None
        for _ in range(40):
            rows = self.client.get("/bridge/commands", params={"sessionId": "s1"}).json()["commands"]
            if rows:
                command = rows[0]
                break
            time.sleep(0.05)
        self.assertIsNotNone(command)
        self.assertEqual(command["op"], "screenshot")
        self.assertEqual(command["view"], "2d")
        self.client.post("/bridge/ack", json={
            "sessionId": "s1",
            "id": command["id"],
            "ok": True,
            "summary": {"images": [{"view": "2d", "width": 1, "height": 1, "pngBase64": png}]},
            "project": sample_project(),
        })
        worker.join(2)
        self.assertNotIn("error", found)
        image = found["result"]["images"][0]
        self.assertEqual(image["view"], "2d")
        self.assertEqual(image["width"], 1)
        self.assertTrue(image["path"].startswith("/tmp/openplan-editor-shots/2d-"))
        self.assertTrue(Path(image["path"]).is_file())
        self.assertNotIn("pngBase64", json.dumps(found["result"]))
        faced = sample_project()
        faced["floors"][0]["rooms"][0]["floorPolygon"] = [
            {"x": 0, "y": 0}, {"x": 40, "y": 0}, {"x": 40, "y": 20},
        ]
        self.client.post("/bridge/session", json={"sessionId": "s1", "project": faced})
        detail = self._tool("editor_get_floor", {"ids": ["room-1"]})
        self.assertEqual(detail["rooms"][0]["floorFacePoints"], 3)

    def test_token_on_mcp_and_bridge(self):
        client = TestClient(create_app(Hub(), token="local-secret", port=8879))
        self.assertEqual(client.post("/bridge/session", json={"sessionId": "s", "project": sample_project()}).status_code, 401)
        self.assertEqual(client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).status_code, 401)
        ok = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, headers={"Authorization": "Bearer local-secret"})
        self.assertEqual(ok.status_code, 200)
        health = client.get("/bridge/health").json()
        self.assertTrue(health["tokenRequired"])
        self.assertIn("YOUR_TOKEN", json.dumps(client.get("/bridge/config").json()))

    def test_missing_editor_is_an_error(self):
        client = TestClient(create_app(Hub(), port=8879))
        response = client.post("/mcp", json={
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "editor_get_project", "arguments": {}},
        })
        payload = json.loads(response.json()["result"]["content"][0]["text"])
        self.assertTrue(response.json()["result"]["isError"])
        self.assertIn("没有打开的编辑器会话", payload["error"])

    def test_two_sessions_need_an_id(self):
        self.client.post("/bridge/session", json={"sessionId": "s2", "project": sample_project()})
        payload = self._tool("editor_get_project", {})
        self.assertIn("sessionId", payload["error"])
        chosen = self._tool("editor_get_project", {"sessionId": "s2"})
        self.assertEqual(chosen["sessionId"], "s2")

    def _tool(self, name, arguments):
        response = self.client.post("/mcp", json={
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        })
        self.assertEqual(response.status_code, 200)
        return json.loads(response.json()["result"]["content"][0]["text"])


class LiveApplyTests(unittest.TestCase):
    def test_tool_call_does_not_block_the_bridge(self):
        import time
        import httpx
        import uvicorn

        import socket
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        app = create_app(Hub(), port=port)
        server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error"))
        thread = threading.Thread(target=server.run, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{port}"
        try:
            deadline = time.time() + 5
            while time.time() < deadline:
                try:
                    if httpx.get(f"{base}/bridge/health", timeout=0.3).status_code == 200:
                        break
                except Exception:
                    time.sleep(0.05)
            else:
                self.fail("mcp did not start")
            self.assertEqual(httpx.post(f"{base}/bridge/session", json={
                "sessionId": "live",
                "project": sample_project(),
            }, timeout=2).status_code, 200)
            box = {}

            def call():
                response = httpx.post(f"{base}/mcp", json={
                    "jsonrpc": "2.0",
                    "id": 7,
                    "method": "tools/call",
                    "params": {"name": "editor_set_walls", "arguments": {"patches": [{"id": "wall-1", "height": 300}]}},
                }, timeout=5)
                box["payload"] = json.loads(response.json()["result"]["content"][0]["text"])

            worker = threading.Thread(target=call)
            worker.start()
            command = None
            for _ in range(40):
                rows = httpx.get(f"{base}/bridge/commands", params={"sessionId": "live"}, timeout=2).json()["commands"]
                if rows:
                    command = rows[0]
                    break
                time.sleep(0.05)
            self.assertIsNotNone(command)
            self.assertEqual(command["patches"][0]["height"], 300)
            project = sample_project()
            project["floors"][0]["walls"][0]["height"] = 300
            httpx.post(f"{base}/bridge/ack", json={
                "sessionId": "live",
                "id": command["id"],
                "ok": True,
                "summary": {"changed": ["wall-1"], "undo": "editor"},
                "project": project,
            }, timeout=2)
            worker.join(3)
            self.assertEqual(box["payload"]["changed"], ["wall-1"])
        finally:
            server.should_exit = True
            thread.join(3)


class HubTimeoutTests(unittest.TestCase):
    def test_submit_times_out_without_ack(self):
        hub = Hub()
        hub.snapshot("s1", sample_project(), "", False)
        with self.assertRaises(SessionError):
            hub.submit("s1", {"op": "set_room"}, timeout=0.05)


if __name__ == "__main__":
    unittest.main()



class ProjectToolsTest(unittest.TestCase):
    def test_listed_and_fail_cleanly_without_server(self):
        import os
        import openplan_project_tools as pt
        os.environ["OPENPLAN_IMPORT_API"] = "http://127.0.0.1:9"
        names = {t["name"] for t in pt.tool_specs()}
        self.assertTrue({"project_export", "project_update_rooms", "project_set_vertical_links", "project_set_orientation", "project_calibrate_scale"} <= names)
        with self.assertRaises(pt.ToolError) as ctx:
            pt.project_export("x")
        self.assertIn("连不上", ctx.exception.message)

    def test_calibrate_rejects_silly_factor(self):
        import openplan_project_tools as pt
        with self.assertRaises(pt.ToolError):
            pt.project_calibrate_scale("x", 1, 1000)

    def test_stale_session_fails_fast(self):
        import time
        hub = Hub()
        hub.snapshot("s1", {"id": "p", "activeFloorId": "f", "floors": [{"id": "f", "walls": [], "doors": [], "windows": [], "rooms": []}]}, "test", False)
        hub.sessions["s1"]["seen"] = time.time() - 999
        t0 = time.time()
        with self.assertRaises(SessionError):
            hub.submit("s1", {"type": "noop"})
        self.assertLess(time.time() - t0, 1)

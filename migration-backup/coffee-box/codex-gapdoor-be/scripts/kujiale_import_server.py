#!/usr/bin/env python3
"""Kujiale-style drawing import. Loopback only. Does not touch Maker room tools."""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

ROOT = Path(__file__).resolve().parents[1]
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))

import name_overrides  # noqa: E402
from floor_nav import (  # noqa: E402
    add_vertical_link,
    bind_adjacent_vertical_link,
    map_document,
    nav_view,
    remove_vertical_link,
    route_view,
    vertical_links,
)
from openplan_project import recognize_pdf  # noqa: E402
from pdf_building import assign_floors, import_building, read_sheet_titles, sheet_scale  # noqa: E402

STORE = ROOT / "data" / "kujiale-import"
SHEETS = STORE / "sheets"
PROJECTS = STORE / "projects"
OPENPLAN_ORIGIN = os.environ.get("OPENPLAN_ORIGIN", "http://127.0.0.1:5173").rstrip("/")
_PUBLIC_ORIGIN = os.environ.get("KUJIALE_PUBLIC_ORIGIN", "").rstrip("/")

app = FastAPI(docs_url=None, redoc_url=None)
app.add_middleware(GZipMiddleware, minimum_size=2048)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[OPENPLAN_ORIGIN, "http://localhost:5173", *[o.strip().rstrip("/") for o in os.environ.get("EXTRA_CORS_ORIGINS", "").split(",") if o.strip()]],
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["*"],
)



@app.middleware("http")
async def no_stale_pages(request: Request, call_next):
    """Pages/scripts change with every branch; without this browsers heuristically cache an old
    files.html / files.js (and its 导航浏览 links) after the stack is updated or swapped."""
    response = await call_next(request)
    path = request.url.path
    if path in ("/", "/files") or path.startswith("/preview/") or path.startswith("/api/projects"):
        response.headers["Cache-Control"] = "no-cache"
    return response

def public_origin(request: Request | None = None) -> str:
    if _PUBLIC_ORIGIN:
        return _PUBLIC_ORIGIN
    if request is not None:
        host, port = request.scope.get("server") or ("127.0.0.1", 8877)
        if host in ("0.0.0.0", "::"):
            host = "127.0.0.1"
        if ":" in host and not host.startswith("["):
            host = f"[{host}]"
        return f"{request.scope.get('scheme', 'http')}://{host}:{port}"
    return "http://127.0.0.1:8877"


def set_public_origin(value: str) -> None:
    global _PUBLIC_ORIGIN
    _PUBLIC_ORIGIN = value.rstrip("/")


def _sheet_dir(sheet_id: str) -> Path:
    path = SHEETS / sheet_id
    if not path.is_dir() or not (path / "page.pdf").is_file():
        raise HTTPException(404, "sheet")
    return path


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _project_id(value: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{32}", value or ""):
        raise HTTPException(400, "project")
    return value


def _project_folder(project_id: str) -> Path:
    folder = (PROJECTS / _project_id(project_id)).resolve()
    if folder.parent != PROJECTS.resolve():
        raise HTTPException(400, "project")
    return folder


def _read_project(project_id: str) -> tuple[Path, dict]:
    folder = _project_folder(project_id)
    path = folder / "project.json"
    if not path.is_file():
        raise HTTPException(404, "project")
    return path, json.loads(path.read_text(encoding="utf-8"))


_WRITE_LOCK = threading.RLock()
_HISTORY_KEEP = 20
# Keys the import server owns; editor write-back never replaces them.
_SERVER_KEYS = ("verticalLinks", "northBearing", "northSource", "sourceSha", "restrictedZones")


def _revision(project: dict | None) -> int:
    try:
        return int((project or {}).get("revision") or 0)
    except (TypeError, ValueError):
        return 0


def _write_project(path: Path, project: dict) -> None:
    """Atomic write: bump the monotonic ``revision``, back up the previous file, then replace."""
    with _WRITE_LOCK:
        previous = None
        if path.is_file():
            try:
                previous = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                previous = None
            history = path.parent / "history"
            history.mkdir(exist_ok=True)
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
            shutil.copy2(path, history / f"project-r{_revision(previous)}-{stamp}.json")
            for stale in sorted(history.glob("project-r*.json"), key=lambda f: f.stat().st_mtime)[:-_HISTORY_KEEP]:
                stale.unlink(missing_ok=True)
        project["revision"] = max(_revision(previous), _revision(project) - 1) + 1
        project["updatedAt"] = _now()
        tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        tmp.write_text(json.dumps(project, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, path)


class ProjectConflict(Exception):
    def __init__(self, current: dict):
        super().__init__("conflict")
        self.current = current


def save_project_from_editor(project_id: str, incoming: dict, base_revision: int | None, force: bool = False) -> dict:
    """Editor write-back with optimistic concurrency; never overwrites a newer revision silently."""
    if not isinstance(incoming, dict) or not isinstance(incoming.get("floors"), list) or not incoming["floors"]:
        raise HTTPException(400, "project")
    if str(incoming.get("id") or "") != project_id:
        raise HTTPException(400, "project-id")
    with _WRITE_LOCK:
        path, current = _read_project(project_id)
        if not force and (base_revision is None or int(base_revision) != _revision(current)):
            raise ProjectConflict(current)
        merged = dict(incoming)
        for key in _SERVER_KEYS:
            if key in current:
                merged[key] = current[key]
            else:
                merged.pop(key, None)
        merged["revision"] = _revision(current)
        merged.setdefault("createdAt", current.get("createdAt"))
        _write_project(path, merged)
        # Names a person set (editor / MCP) are authoritative across re-imports of this PDF.
        name_overrides.record(STORE / "name-overrides", merged)
        name_overrides.record_drawn(STORE / "name-overrides", merged)
        name_overrides.record_edits(STORE / "name-overrides", merged)
        return {"revision": merged["revision"], "updatedAt": merged["updatedAt"]}


def editor_url(project_id: str, request: Request | None = None, origin: str = "") -> str:
    return f"{OPENPLAN_ORIGIN}/editor?projectUrl={origin or public_origin(request)}/api/projects/{project_id}.json"


def nav_url(project_id: str, floor: str = "", request: Request | None = None, origin: str = "") -> str:
    origin = origin or public_origin(request)
    params = {
        "projectUrl": f"{origin}/api/projects/{project_id}.json",
        "id": project_id,
        "apiOrigin": origin,
        "filesUrl": f"{origin}/files",
        "libraryUrl": f"{origin}/files",
    }
    if floor:
        params["floor"] = floor
    return f"{OPENPLAN_ORIGIN}/nav?{urlencode(params)}"


def _blank_floor(name: str, level: int) -> dict:
    return {
        "id": f"floor-{level}",
        "name": name,
        "level": level,
        "elevation": level * 300,
        "walls": [],
        "rooms": [],
        "doors": [],
        "windows": [],
        "furniture": [],
        "stairs": [],
        "columns": [],
        "guides": [],
        "measurements": [],
        "annotations": [],
        "textAnnotations": [],
        "groups": [],
    }


def _next_floor_id(floors: list, level: int) -> str:
    used = {floor.get("id") for floor in floors}
    candidate = f"floor-{level}"
    number = 2
    while candidate in used:
        candidate = f"floor-{level}-{number}"
        number += 1
    return candidate


def attach_floor(project: dict, floor: dict) -> dict:
    floors = project.setdefault("floors", [])
    if not isinstance(floors, list):
        floors = []
        project["floors"] = floors
    level = max((int(item.get("level") or 0) for item in floors if isinstance(item, dict)), default=-1) + 1
    incoming = dict(floor)
    incoming["id"] = _next_floor_id(floors, level)
    incoming["level"] = level
    incoming["elevation"] = level * 300
    floors.append(incoming)
    project["activeFloorId"] = incoming["id"]
    project["updatedAt"] = _now()
    return project


def summarize_project(project: dict, request: Request | None = None) -> dict:
    floors = [floor for floor in project.get("floors") or [] if isinstance(floor, dict)]
    project_id = str(project.get("id") or "")
    return {
        "id": project_id,
        "name": project.get("name") or "未命名",
        "updatedAt": project.get("updatedAt") or "",
        "createdAt": project.get("createdAt") or "",
        "activeFloorId": project.get("activeFloorId") or "",
        "floors": [
            {
                "id": floor.get("id") or "",
                "name": floor.get("name") or "",
                "level": floor.get("level"),
                "walls": len(floor.get("walls") or []),
                "rooms": len(floor.get("rooms") or []),
            }
            for floor in floors
        ],
        "editorUrl": editor_url(project_id, request),
        "navUrl": nav_url(project_id, str(project.get("activeFloorId") or ""), request),
    }


def list_projects(request: Request | None = None) -> list[dict]:
    if not PROJECTS.is_dir():
        return []
    rows = []
    for folder in PROJECTS.iterdir():
        path = folder / "project.json"
        if not path.is_file():
            continue
        try:
            project = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(project, dict):
            continue
        project.setdefault("id", folder.name)
        rows.append(summarize_project(project, request))
    rows.sort(key=lambda row: row["updatedAt"], reverse=True)
    return rows


def create_project(name: str, request: Request | None = None) -> dict:
    title = re.sub(r"\s+", " ", (name or "").strip())[:40] or "未命名"
    project_id = uuid.uuid4().hex
    now = _now()
    floor = _blank_floor("1F", 0)
    project = {
        "id": project_id,
        "name": title,
        "floors": [floor],
        "activeFloorId": floor["id"],
        "createdAt": now,
        "updatedAt": now,
    }
    folder = PROJECTS / project_id
    folder.mkdir(parents=True, exist_ok=False)
    _write_project(folder / "project.json", project)
    return summarize_project(project, request)


def add_empty_floor(project_id: str, name: str, request: Request | None = None) -> dict:
    path, project = _read_project(project_id)
    floors = [floor for floor in project.get("floors") or [] if isinstance(floor, dict)]
    title = re.sub(r"\s+", " ", (name or "").strip())[:40] or f"{len(floors) + 1}F"
    attach_floor(project, _blank_floor(title, 0))
    _write_project(path, project)
    return summarize_project(project, request)


@app.get("/")
def home():
    return FileResponse(ROOT / "preview" / "kujiale-import.html")


@app.get("/files")
def files_page():
    return FileResponse(ROOT / "preview" / "files.html")


@app.get("/nav")
def nav_page(request: Request, id: str = "", floor: str = ""):
    """Redirect to openPlan ThreeViewer nav shell (no editor tools)."""
    if not id:
        raise HTTPException(400, "id")
    return RedirectResponse(nav_url(id, floor, request), status_code=302)


_NAV_CACHE: dict[tuple, bytes] = {}
_NAV_CACHE_LOCK = threading.Lock()


def _nav_bytes(project_id: str, floor: str) -> bytes:
    """nav.json is pure in project.json, so cache the encoded body per file version: the first
    patient load computed walk grids for every floor (P1/P2 took 10–25 s on a busy box)."""
    folder = _project_folder(project_id)
    path = folder / "project.json"
    if not path.is_file():
        raise HTTPException(404, "project")
    st = path.stat()
    key = (project_id, floor, st.st_mtime_ns, st.st_size)
    hit = _NAV_CACHE.get(key)
    if hit is not None:
        return hit
    project = json.loads(path.read_text(encoding="utf-8"))
    body = json.dumps(nav_view(project, floor or None), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with _NAV_CACHE_LOCK:
        for k in [k for k in _NAV_CACHE if k[:2] == key[:2]]:
            _NAV_CACHE.pop(k, None)
        _NAV_CACHE[key] = body
    return body


@app.get("/api/projects/{project_id}/nav.json")
def project_nav(project_id: str, floor: str = ""):
    return Response(_nav_bytes(project_id, floor), media_type="application/json")


def _warm_nav_cache() -> None:
    """Background: precompute nav.json for every project floor so QA's first open is instant."""
    import time as _t
    for folder in sorted(PROJECTS.glob("*/project.json"), key=lambda p: -p.stat().st_mtime)[:12]:
        try:
            pid = folder.parent.name
            floors = [f.get("id") for f in json.loads(folder.read_text(encoding="utf-8")).get("floors") or [] if isinstance(f, dict)]
            for fid in ["", *floors]:
                _nav_bytes(pid, fid or "")
                _t.sleep(0.05)
        except Exception:  # noqa: BLE001 - warming is best effort
            continue


if os.environ.get("NAV_WARM", "1") != "0":
    threading.Thread(target=_warm_nav_cache, daemon=True).start()


@app.get("/api/projects/{project_id}/map.json")
def project_map(project_id: str, floor: str = ""):
    _path, project = _read_project(project_id)
    return map_document(project, floor or None)


@app.post("/api/projects/{project_id}/route")
async def project_route(project_id: str, request: Request):
    _path, project = _read_project(project_id)
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(400, "route")
    vias = body.get("via") or body.get("vias") or []
    if not isinstance(vias, list):
        vias = []
    # route_view is CPU-bound: run it off the event loop so nav.json / floor switches
    # are not frozen while a route is being computed.
    return await run_in_threadpool(
        route_view,
        project,
        str(body.get("floor") or ""),
        body.get("from"),
        body.get("to"),
        vias,
        accessible=bool(body.get("accessible")),
        stairs_only=bool(body.get("stairsOnly") or body.get("stairs_only")),
    )


@app.post("/api/projects/{project_id}/restricted-zones")
async def project_restricted_zones(project_id: str, request: Request):
    """Set 限制通行区 polygons ({floorId, polygon:[{x,y}], name?, provisional?}); recorded so
    they survive re-imports of the same PDF."""
    body = await request.json()
    zones = body.get("zones") if isinstance(body, dict) else body
    if not isinstance(zones, list):
        raise HTTPException(400, "zones")
    clean = []
    for i, z in enumerate(zones):
        poly = [{"x": float(p["x"]), "y": float(p["y"])} for p in (z or {}).get("polygon") or []]
        if len(poly) < 3 or not z.get("floorId"):
            raise HTTPException(400, f"zone {i}")
        clean.append({"id": str(z.get("id") or f"zone-{i + 1}"), "floorId": str(z["floorId"]),
                      "name": str(z.get("name") or "限制通行区"), "polygon": poly,
                      "source": str(z.get("source") or "manual"), "provisional": bool(z.get("provisional", False)),
                      **({"rooms": z["rooms"]} if isinstance(z.get("rooms"), list) else {})})
    with _WRITE_LOCK:
        path, current = _read_project(project_id)
        current["restrictedZones"] = clean
        _write_project(path, current)
        name_overrides.record_zones(STORE / "name-overrides", current)
    return {"zones": clean, "revision": current.get("revision")}


@app.get("/api/projects/{project_id}/vertical-links.json")
def project_vertical_links(project_id: str):
    _path, project = _read_project(project_id)
    return {"links": vertical_links(project)}


@app.post("/api/projects/{project_id}/vertical-links")
async def project_add_vertical_link(project_id: str, request: Request):
    path, project = _read_project(project_id)
    try:
        link = add_vertical_link(project, await request.json())
    except (ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(400, str(exc) or "link") from exc
    project["updatedAt"] = _now()
    _write_project(path, project)
    return {"link": link, "links": vertical_links(project)}


@app.put("/api/projects/{project_id}/vertical-links")
async def project_replace_vertical_links(project_id: str, request: Request):
    """Replace all links (stair/lift floor connectivity), e.g. from the MCP after a review."""
    body = await request.json()
    links = body.get("links") if isinstance(body, dict) else None
    if not isinstance(links, list):
        raise HTTPException(400, "links")
    with _WRITE_LOCK:
        path, project = _read_project(project_id)
        floors = {f.get("id") for f in project.get("floors") or []}
        for link in links:
            stops = link.get("stops") if isinstance(link, dict) else None
            if link.get("kind") not in ("stairs", "elevator") or not isinstance(stops, list) or len(stops) < 2:
                raise HTTPException(400, "link")
            if any(s.get("floorId") not in floors or not all(isinstance(s.get(k), (int, float)) for k in ("x", "y")) for s in stops):
                raise HTTPException(400, "stop")
        project["verticalLinks"] = links
        _write_project(path, project)
    return {"links": links, "revision": project.get("revision")}


@app.put("/api/projects/{project_id}/orientation")
async def project_set_orientation(project_id: str, request: Request):
    """North-arrow bearing on the plan (0 = up, 90 = right, 270 = left); null = unknown."""
    body = await request.json()
    value = body.get("northBearing") if isinstance(body, dict) else None
    if value is not None and not isinstance(value, (int, float)):
        raise HTTPException(400, "northBearing")
    with _WRITE_LOCK:
        path, project = _read_project(project_id)
        if value is None:
            project.pop("northBearing", None)
        else:
            project["northBearing"] = float(value) % 360
        _write_project(path, project)
    return {"northBearing": project.get("northBearing"), "revision": project.get("revision")}


@app.post("/api/projects/{project_id}/vertical-links/bind")
async def project_bind_vertical_link(project_id: str, request: Request):
    """Editor one-to-one adjacent bind (replace existing upward/downward edge)."""
    path, project = _read_project(project_id)
    try:
        result = bind_adjacent_vertical_link(project, await request.json())
    except (ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(400, str(exc) or "link") from exc
    project["updatedAt"] = _now()
    _write_project(path, project)
    return result


@app.delete("/api/projects/{project_id}/vertical-links/{link_id}")
def project_remove_vertical_link(project_id: str, link_id: str):
    path, project = _read_project(project_id)
    if not remove_vertical_link(project, link_id):
        raise HTTPException(404, "link")
    project["updatedAt"] = _now()
    _write_project(path, project)
    return {"links": vertical_links(project)}


@app.get("/api/projects")
def projects_index(request: Request):
    return list_projects(request)


@app.post("/api/projects")
async def projects_create(request: Request):
    name = ""
    if request.headers.get("content-type", "").startswith("application/json"):
        body = await request.json()
        if isinstance(body, dict):
            name = str(body.get("name") or "")
    return create_project(name, request)


@app.post("/api/projects/{project_id}/floors")
async def project_add_floor(project_id: str, request: Request):
    name = ""
    if request.headers.get("content-type", "").startswith("application/json"):
        body = await request.json()
        if isinstance(body, dict):
            name = str(body.get("name") or "")
    return add_empty_floor(project_id, name, request)


@app.delete("/api/projects/{project_id}")
def project_delete(project_id: str):
    folder = _project_folder(project_id)
    if not folder.is_dir():
        raise HTTPException(404, "project")
    shutil.rmtree(folder)
    return {"ok": True}


@app.post("/api/sheets")
async def upload_sheet(file: UploadFile = File(...)):
    raw = await file.read()
    if not raw or len(raw) > 40_000_000:
        raise HTTPException(400, "pdf")
    if not raw.startswith(b"%PDF"):
        raise HTTPException(400, "pdf")
    try:
        import fitz
    except ImportError as exc:
        raise HTTPException(500, "pymupdf") from exc
    sheet_id = uuid.uuid4().hex
    folder = SHEETS / sheet_id
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "page.pdf").write_bytes(raw)
    doc = fitz.open(stream=raw, filetype="pdf")
    try:
        page = doc[0]
        dpi = 96
        pix = page.get_pixmap(matrix=fitz.Matrix(dpi / 72, dpi / 72), alpha=False)
        image = pix.tobytes("png")
        (folder / "preview.png").write_bytes(image)
        meta = {
            "sheetId": sheet_id,
            "dpi": dpi,
            "pages": doc.page_count,
            "pageWidth": float(page.rect.width),
            "pageHeight": float(page.rect.height),
            "imageWidth": pix.width,
            "imageHeight": pix.height,
        }
    finally:
        doc.close()
    (folder / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    return meta


@app.get("/api/sheets/{sheet_id}/preview.png")
def sheet_preview(sheet_id: str):
    path = _sheet_dir(sheet_id) / "preview.png"
    return FileResponse(path, media_type="image/png")


def _sheet_floors(sheet: Path) -> dict:
    """Storey per page from the sheet titles, cached next to the PDF."""
    cache = sheet / "floors.json"
    if cache.is_file():
        return json.loads(cache.read_text(encoding="utf-8"))
    with _IMPORT_LOCK:
        titles = assign_floors(read_sheet_titles(sheet / "page.pdf"))
    scale = sheet_scale(titles)
    denominators = [row["scale"] for row in titles if row.get("scale")]
    body = {
        "floors": [
            {key: row.get(key) for key in ("page", "name", "level", "title", "detected")}
            for row in sorted(titles, key=lambda item: item["page"])
        ],
        "scale": max(set(denominators), key=denominators.count) if denominators else None,
        "cmPerPoint": round(scale, 5) if scale else None,
    }
    cache.write_text(json.dumps(body, ensure_ascii=False), encoding="utf-8")
    return body


@app.get("/api/sheets/{sheet_id}/floors.json")
def sheet_floors(sheet_id: str):
    return _sheet_floors(_sheet_dir(sheet_id))


_IMPORT_LOCK = threading.Lock()
_JOBS: dict[str, dict] = {}
_MAX_JOBS = 32


def _run_building_job(job: dict, sheet: Path, scale: float | None, name: str, origin: str, room_names=None) -> None:
    def progress(done, total, text):
        job.update(done=done, total=total, text=text)

    try:
        source_sha = name_overrides.pdf_sha(sheet / "page.pdf")
        previous = [json.loads(p.read_text(encoding="utf-8")) for p in PROJECTS.glob("*/project.json")]
        previous_project = max((p for p in previous if p.get("sourceSha") == source_sha),
                               key=lambda p: p.get("updatedAt", ""), default=None)
        with _IMPORT_LOCK:
            built = import_building(sheet / "page.pdf", scale=scale, name=name, progress=progress,
                                    room_names=room_names, previous_project=previous_project)
        project = built["project"]
        project["sourceSha"] = source_sha
        name_overrides.apply_drawn(STORE / "name-overrides", project)
        name_overrides.apply_edits(STORE / "name-overrides", project)
        name_overrides.apply(STORE / "name-overrides", project)
        name_overrides.apply_zones(STORE / "name-overrides", project)
        folder = PROJECTS / project["id"]
        folder.mkdir(parents=True, exist_ok=True)
        _write_project(folder / "project.json", project)
        job.update(
            state="done",
            text="完成",
            result={
                "projectId": project["id"],
                "editorUrl": editor_url(project["id"], origin=origin),
                "navUrl": nav_url(project["id"], project["activeFloorId"], origin=origin),
                "floors": built["floors"],
                "links": [
                    {"id": link["id"], "kind": link["kind"], "name": link["name"],
                     "floors": [stop["floorId"] for stop in link["stops"]]}
                    for link in built["links"]
                ],
                "cmPerPoint": built["scale"],
            },
        )
    except ValueError as exc:
        job.update(state="error", text=str(exc) or "import")
    except Exception as exc:  # noqa: BLE001 - surfaced to the import dialog
        job.update(state="error", text="recognize", detail=str(exc)[:200])


def _parse_room_names(text: str):
    """Optional room list for OCR correction: JSON ``{\"1F\": [..]}`` or plain text with
    ``[1F]`` headers and one name per line (no header = every floor)."""
    text = (text or "").strip()
    if not text:
        return None
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            return {str(k): [str(v).strip() for v in vals if str(v).strip()] for k, vals in data.items() if isinstance(vals, list)}
        if isinstance(data, list):
            return {"*": [str(v).strip() for v in data if str(v).strip()]}
    except ValueError:
        pass
    out, key = {}, "*"
    for line in text.splitlines():
        line = line.strip()
        m = re.fullmatch(r"[\[【]\s*(.+?)\s*[\]】]", line)
        if m:
            key = m.group(1)
            continue
        for part in re.split(r"[,，、\t]", line):
            if part.strip():
                out.setdefault(key, []).append(part.strip())
    return out or None


@app.post("/api/import-building")
def import_building_start(
    request: Request,
    sheetId: str = Form(...),
    name: str = Form(""),
    x1: float = Form(0),
    y1: float = Form(0),
    x2: float = Form(0),
    y2: float = Form(0),
    lengthMm: float = Form(0),
    roomNames: str = Form(""),
):
    """Every page of the sheet becomes a floor; poll ``/api/jobs/{id}``."""
    sheet = _sheet_dir(sheetId)
    meta = json.loads((sheet / "meta.json").read_text(encoding="utf-8"))
    scale = None
    if lengthMm > 0:
        dpi = float(meta["dpi"])
        length_pt = math.hypot(x2 - x1, y2 - y1) * 72 / dpi
        if length_pt < 2:
            raise HTTPException(400, "ruler")
        from openplan_project import cm_per_point
        scale = cm_per_point(length_pt, lengthMm)
    elif not _sheet_floors(sheet).get("cmPerPoint"):
        raise HTTPException(400, "scale")
    finished = [key for key, job in _JOBS.items() if job["state"] != "running"]
    for stale in finished[: max(0, len(_JOBS) + 1 - _MAX_JOBS)]:
        del _JOBS[stale]
    job_id = uuid.uuid4().hex
    job = {"id": job_id, "state": "running", "done": 0, "total": int(meta.get("pages") or 1) + 1, "text": "排队"}
    _JOBS[job_id] = job
    thread = threading.Thread(
        target=_run_building_job,
        args=(job, sheet, scale, name, public_origin(request), _parse_room_names(roomNames)),
        daemon=True,
    )
    thread.start()
    return {"jobId": job_id}


@app.get("/api/jobs/{job_id}")
def import_job(job_id: str):
    job = _JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "job")
    return job


def _underlay_image(sheet: Path, scale: float) -> dict | None:
    import fitz
    doc = fitz.open(sheet / "page.pdf")
    try:
        page = doc[0]
        dpi = 72
        pix = page.get_pixmap(matrix=fitz.Matrix(dpi / 72, dpi / 72), alpha=False)
        data = pix.tobytes("jpeg", jpg_quality=55)
    finally:
        doc.close()
    if len(data) > 1_500_000:
        return None
    import base64
    width_cm = float(json.loads((sheet / "meta.json").read_text())["pageWidth"]) * scale
    # BackgroundImage.scale is centimetres per pixel; the bitmap is centered on position.
    cm_per_px = width_cm / pix.width
    return {
        "dataUrl": "data:image/jpeg;base64," + base64.b64encode(data).decode("ascii"),
        "position": {"x": round(width_cm / 2, 2), "y": round(float(json.loads((sheet / "meta.json").read_text())["pageHeight"]) * scale / 2, 2)},
        "scale": round(cm_per_px, 6),
        "opacity": 0.85,
        "rotation": 0,
        "locked": True,
    }


@app.post("/api/recognize")
def recognize(
    request: Request,
    sheetId: str = Form(...),
    x1: float = Form(...),
    y1: float = Form(...),
    x2: float = Form(...),
    y2: float = Form(...),
    lengthMm: float = Form(...),
    mode: str = Form("generate"),
    floor: str = Form(""),
    projectId: str = Form(""),
):
    if mode not in ("generate", "underlay"):
        raise HTTPException(400, "mode")
    if lengthMm <= 0:
        raise HTTPException(400, "length")
    sheet = _sheet_dir(sheetId)
    meta = json.loads((sheet / "meta.json").read_text(encoding="utf-8"))
    dpi = float(meta["dpi"])
    ruler = (
        x1 * 72 / dpi,
        y1 * 72 / dpi,
        x2 * 72 / dpi,
        y2 * 72 / dpi,
    )
    if (ruler[2] - ruler[0]) ** 2 + (ruler[3] - ruler[1]) ** 2 < 4:
        raise HTTPException(400, "ruler")
    background = None
    if mode == "underlay":
        from openplan_project import cm_per_point
        import math
        scale = cm_per_point(math.hypot(ruler[2] - ruler[0], ruler[3] - ruler[1]), lengthMm)
        background = _underlay_image(sheet, scale)
    try:
        result = recognize_pdf(
            sheet / "page.pdf",
            ruler,
            lengthMm,
            mode=mode,
            floor_name=floor,
            background=background,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(500, "recognize") from exc
    project = result["project"]
    if projectId:
        path, existing = _read_project(projectId)
        floor_record = (project.get("floors") or [None])[0]
        if not isinstance(floor_record, dict):
            raise HTTPException(500, "recognize")
        attach_floor(existing, floor_record)
        _write_project(path, existing)
        project_id = existing["id"]
        project = existing
        folder = path.parent
    else:
        project_id = project["id"]
        folder = PROJECTS / project_id
        folder.mkdir(parents=True, exist_ok=True)
        _write_project(folder / "project.json", project)
    display = result["display"]
    display["editorUrl"] = editor_url(project_id, request)
    (folder / "display.json").write_text(json.dumps(display, ensure_ascii=False), encoding="utf-8")
    if mode == "underlay":
        preview = sheet / "preview.png"
        if preview.is_file():
            (folder / "underlay.png").write_bytes(preview.read_bytes())
    return {
        "projectId": project_id,
        "editorUrl": display["editorUrl"],
        "displayUrl": f"{public_origin(request)}/preview/kujiale-display.html?id={project_id}",
        **result["stats"],
    }


@app.put("/api/projects/{project_id}.json")
async def project_save(project_id: str, request: Request):
    """Write the editor's project back. Body: ``{project, baseRevision, force?}``; 409 carries the server copy."""
    _project_id(project_id)
    body = await request.json()
    try:
        return save_project_from_editor(project_id, body.get("project"), body.get("baseRevision"), bool(body.get("force")))
    except ProjectConflict as conflict:
        return Response(
            json.dumps({"error": "conflict", "revision": _revision(conflict.current), "project": conflict.current}, ensure_ascii=False),
            status_code=409,
            media_type="application/json",
        )


@app.get("/api/projects/{project_id}.json")
def project_json(project_id: str):
    path = PROJECTS / project_id / "project.json"
    if not path.is_file():
        raise HTTPException(404, "project")
    from floor_nav import prepare_floor
    project = json.loads(path.read_text(encoding="utf-8"))
    for floor in project.get("floors") or []:
        prepare_floor(floor)
    return Response(json.dumps(project, ensure_ascii=False), media_type="application/json")


@app.get("/api/display/{project_id}.json")
def display_json(project_id: str):
    path = PROJECTS / project_id / "display.json"
    if not path.is_file():
        raise HTTPException(404, "display")
    return Response(path.read_text(encoding="utf-8"), media_type="application/json")


@app.get("/api/display/{project_id}/underlay.png")
def display_underlay(project_id: str):
    path = PROJECTS / project_id / "underlay.png"
    if not path.is_file():
        raise HTTPException(404, "underlay")
    return FileResponse(path, media_type="image/png")


app.mount("/preview", StaticFiles(directory=ROOT / "preview"), name="preview")
app.mount("/assets", StaticFiles(directory=ROOT / "assets"), name="assets")
# openPlan static (textures/fonts) — clients that resolve relative to :8884 would 404 otherwise
_OPENPLAN_STATIC = ROOT / "openPlan3D" / "static"
if (_OPENPLAN_STATIC / "nav-textures").is_dir():
    app.mount("/nav-textures", StaticFiles(directory=_OPENPLAN_STATIC / "nav-textures"), name="nav-textures")
if (_OPENPLAN_STATIC / "fonts").is_dir():
    app.mount("/fonts", StaticFiles(directory=_OPENPLAN_STATIC / "fonts"), name="fonts")
if (_OPENPLAN_STATIC / "textures").is_dir():
    app.mount("/textures", StaticFiles(directory=_OPENPLAN_STATIC / "textures"), name="textures")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8877)
    args = parser.parse_args()
    set_public_origin(f"http://{args.host}:{args.port}")
    STORE.mkdir(parents=True, exist_ok=True)
    uvicorn.run(app, host=args.host, port=args.port, reload=False)

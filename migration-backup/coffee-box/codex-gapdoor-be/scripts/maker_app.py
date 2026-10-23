"""Local map-making API. Upload once, add floors, edit names, and generate 3D snapshots."""
from pathlib import Path
import sys
import threading

from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parent
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from maker_pdf import PdfRejected
from maker_store import MAX_PAGES, MAX_UPLOAD_BYTES, ProjectStore, normalize_source_kind

PROJECTS_DIR = Path(__import__("os").environ.get("HOSPITAL_PROJECTS_DIR", ROOT / "var" / "projects"))
store = ProjectStore(PROJECTS_DIR, max_upload_bytes=MAX_UPLOAD_BYTES, max_pages=MAX_PAGES)
app = FastAPI(title="Hospital map maker", version="0.4.0")
build_lock = threading.Lock()


class CropBody(BaseModel):
    x: float
    y: float
    width: float
    height: float


class FloorBody(BaseModel):
    id: Optional[str] = None
    code: Optional[str] = None
    name: Optional[str] = None
    description: Optional[str] = None


class DraftBody(BaseModel):
    revision: int = Field(..., ge=1)
    pageIndex: int = Field(..., ge=1)
    rotation: int = 0
    crop: Optional[CropBody] = None
    floor: Optional[FloorBody] = None
    sourceKind: Optional[str] = None


class BuildBody(BaseModel):
    revision: int = Field(..., ge=1)


class FacilityIconBody(BaseModel):
    id: Optional[str] = None
    category: str = "service"
    name: Optional[str] = None
    position: list[float]
    roomId: Optional[str] = None


class EditsBody(BaseModel):
    revision: int = Field(..., ge=1)
    floorId: Optional[str] = None
    renamedPois: Optional[dict[str, str]] = None
    renamedRooms: Optional[dict[str, str]] = None
    facilityIcons: Optional[list[FacilityIconBody]] = None
    movedPois: Optional[dict[str, list[float]]] = None
    roomColors: Optional[dict[str, Optional[str]]] = None
    confirmedIds: Optional[list[str]] = None


class InstitutionBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=40)


def raise_pdf(error: PdfRejected):
    raise HTTPException(status_code=error.status_code, detail=str(error)) from error


@app.get("/api/health")
def health():
    return {"ok": True, "stage": 4, "maxUploadBytes": store.max_upload_bytes, "maxPages": store.max_pages}


@app.get("/api/projects")
def list_projects():
    return {"projects": store.list_projects()}


@app.post("/api/projects")
async def create_project(
    file: UploadFile = File(...),
    sourceKind: Optional[str] = Form(None),
):
    data = await file.read()
    try:
        kind = normalize_source_kind(sourceKind, required=sourceKind is not None)
        return store.create_from_upload(file.filename, data, kind)
    except PdfRejected as error:
        raise_pdf(error)


@app.post("/api/projects/empty")
def create_empty_project(body: InstitutionBody):
    """Create a named institution with no PDF (import drawings later)."""
    try:
        return store.create_empty(body.name)
    except PdfRejected as error:
        raise_pdf(error)


@app.post("/api/projects/{project_id}/source")
async def attach_project_source(
    project_id: str,
    file: UploadFile = File(...),
    sourceKind: Optional[str] = Form(None),
):
    """First PDF for an empty institution."""
    data = await file.read()
    try:
        kind = normalize_source_kind(sourceKind, required=True)
        return store.attach_first_pdf(project_id, file.filename, data, kind)
    except PdfRejected as error:
        raise_pdf(error)


@app.get("/api/projects/{project_id}")
def get_project(project_id: str):
    try:
        return store.get(project_id)
    except PdfRejected as error:
        raise_pdf(error)


@app.patch("/api/projects/{project_id}")
def rename_project(project_id: str, body: InstitutionBody):
    try:
        return store.rename(project_id, body.name)
    except PdfRejected as error:
        raise_pdf(error)


@app.delete("/api/projects/{project_id}")
def delete_project(project_id: str):
    try:
        return store.delete(project_id)
    except PdfRejected as error:
        raise_pdf(error)


@app.get("/api/projects/{project_id}/file")
def get_project_file(project_id: str, sha256: Optional[str] = None):
    try:
        path = store.resolve_pdf(project_id, sha256)
    except PdfRejected as error:
        raise_pdf(error)
    return FileResponse(path, media_type="application/pdf", filename="source.pdf", content_disposition_type="inline")


@app.post("/api/projects/{project_id}/floor-pdf")
async def upload_floor_pdf(
    project_id: str,
    file: UploadFile = File(...),
    sourceKind: Optional[str] = Form(None),
):
    data = await file.read()
    try:
        kind = normalize_source_kind(sourceKind, required=sourceKind is not None)
        return store.attach_floor_pdf(project_id, file.filename, data, kind)
    except PdfRejected as error:
        raise_pdf(error)


@app.put("/api/projects/{project_id}/draft")
def put_draft(project_id: str, body: DraftBody):
    crop = None if body.crop is None else body.crop.model_dump()
    floor = None if body.floor is None else body.floor.model_dump()
    try:
        return store.save_draft(
            project_id, body.revision, body.pageIndex, body.rotation, crop, floor, body.sourceKind,
        )
    except PdfRejected as error:
        raise_pdf(error)


@app.post("/api/projects/{project_id}/build")
def build_project(project_id: str, body: BuildBody):
    if not build_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="正在生成三维地图，请稍候。")
    try:
        from maker_build import build_snapshot
        project = store.get(project_id)
        # Ignore client revision: crop autosave often races the generate button.
        pdf = store.draft_pdf(project_id)
        document, report, images, candidates, pending = build_snapshot(pdf, project)
        # Draft revision may advance during the long CAD build; pin to latest.
        revision = int(store.get(project_id)["draft"]["revision"])
        project = store.save_snapshot(project_id, revision, document, report, images, candidates, pending)
        return {"project": project, "map": document, "report": report}
    except PdfRejected as error:
        try:
            store.mark_failed(project_id, str(error))
        except PdfRejected:
            pass
        raise_pdf(error)
    except HTTPException:
        raise
    except Exception as error:
        try:
            store.mark_failed(project_id, "生成失败，请检查图纸是否含有房间色块和文字。")
        except PdfRejected:
            pass
        raise HTTPException(status_code=500, detail="生成失败，请检查图纸是否含有房间色块和文字。") from error
    finally:
        build_lock.release()


@app.patch("/api/projects/{project_id}/edits")
def patch_edits(project_id: str, body: EditsBody):
    icons = None if body.facilityIcons is None else [item.model_dump() for item in body.facilityIcons]
    try:
        return store.save_edits(project_id, body.revision, body.floorId, {
            "renamedPois": body.renamedPois,
            "renamedRooms": body.renamedRooms,
            "facilityIcons": icons,
            "movedPois": body.movedPois,
            "roomColors": body.roomColors,
            "confirmedIds": body.confirmedIds,
        })
    except PdfRejected as error:
        raise_pdf(error)


@app.delete("/api/projects/{project_id}/floors/{floor_id}")
def delete_floor(project_id: str, floor_id: str):
    try:
        return store.delete_floor(project_id, floor_id)
    except PdfRejected as error:
        raise_pdf(error)


@app.get("/api/projects/{project_id}/map")
def get_map(project_id: str, floor: Optional[str] = None):
    try:
        return store.load_map(project_id, floor)
    except PdfRejected as error:
        raise_pdf(error)


@app.get("/api/projects/{project_id}/maps/{floor_id}/{name}")
def get_map_asset(project_id: str, floor_id: str, name: str):
    try:
        path = store.map_asset(project_id, name, floor_id)
    except PdfRejected as error:
        raise_pdf(error)
    media = "application/json" if name.endswith(".json") else "image/png"
    return FileResponse(path, media_type=media)


@app.get("/")
def root():
    return RedirectResponse("/preview/")


app.mount("/preview", StaticFiles(directory=ROOT / "preview", html=True), name="preview")
app.mount("/assets", StaticFiles(directory=ROOT / "assets"), name="assets")
app.mount("/data", StaticFiles(directory=ROOT / "data"), name="data")
app.mount("/source", StaticFiles(directory=ROOT / "source"), name="source")
app.mount("/tests", StaticFiles(directory=ROOT / "tests"), name="tests")

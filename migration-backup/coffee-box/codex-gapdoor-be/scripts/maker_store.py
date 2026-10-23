"""Local project folders. Never writes into data/ or source/."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import uuid

from maker_pdf import PdfRejected, inspect_pdf

PROJECT_ID = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")
FLOOR_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,11}$")
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
MAX_PAGES = 30
MAX_FILENAME = 180
MAX_INSTITUTION_NAME = 40
CN_FLOOR = {1: "一", 2: "二", 3: "三", 4: "四", 5: "五", 6: "六", 7: "七", 8: "八", 9: "九", 10: "十"}
SOURCE_KINDS = ("floorplan", "cad")


def normalize_source_kind(value, required=False):
    """Explicit floorplan | cad. Never infer from PDF contents."""
    if value is None:
        text = ""
    else:
        text = str(value).strip().lower()
    if text in SOURCE_KINDS:
        return text
    if text or required:
        raise PdfRejected("请选择图纸类型：平面地图或 CAD。")
    return "floorplan"


def pending_for_source_kind(source_kind):
    if source_kind == "cad":
        return [{
            "id": "cad-crop",
            "kind": "crop",
            "message": "CAD：可框选有效区域后再生成，不框则整页。四周标尺用于距离标定，不会画进地图。请填写楼层后生成。",
        }]
    return [{
        "id": "choose-crop",
        "kind": "crop",
        "message": "请填写楼层信息，选择楼层页并框选地图范围，排除图例。归一化仍以完整原页为准。",
    }]


def utc_now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def safe_filename(name):
    base = Path(str(name or "upload.pdf")).name
    base = re.sub(r"[^A-Za-z0-9._-]+", "_", base).strip("._") or "upload.pdf"
    if not base.lower().endswith(".pdf"):
        base += ".pdf"
    return base[:MAX_FILENAME]


def default_floor_name(page_index):
    n = int(page_index)
    stem = CN_FLOOR.get(n, str(n))
    return f"{stem}楼"


def display_floor_code(floor_id):
    text = str(floor_id or "").upper()
    digits = re.sub(r"[^0-9]", "", text)
    if text.startswith("B") and digits:
        return f"B{digits}"[:4]
    if digits:
        return digits.zfill(2)[:4]
    return text[:4] or "01"


def default_institution_name(filename):
    stem = Path(str(filename or "")).stem.strip() or "未命名机构"
    stem = re.sub(r"\s+", " ", stem).strip() or "未命名机构"
    return stem[:MAX_INSTITUTION_NAME]


def normalize_institution_name(name, fallback="未命名机构"):
    text = re.sub(r"\s+", " ", str(name or "").strip())
    if not text:
        raise PdfRejected("请填写机构名称。")
    if len(text) > MAX_INSTITUTION_NAME:
        raise PdfRejected(f"机构名称请控制在 {MAX_INSTITUTION_NAME} 字以内。")
    return text


def normalize_floor(floor, page_index, taken=None):
    data = floor or {}
    page_index = int(page_index)
    floor_id = str(data.get("id") or f"{page_index}F").strip().upper().replace(" ", "")
    if not FLOOR_ID.match(floor_id):
        raise PdfRejected("楼层编号请用 1F、2F、B1 这种短编号（字母、数字或连字符）。")
    owner = (taken or {}).get(floor_id)
    if owner not in (None, page_index, str(page_index)):
        raise PdfRejected(f"楼层编号 {floor_id} 已用于第 {owner} 页。")
    name = str(data.get("name") or default_floor_name(page_index)).strip()
    if not name or len(name) > 40:
        raise PdfRejected("请填写楼层名称（40 字以内）。")
    description = str(data.get("description") or "").strip()
    if len(description) > 80:
        raise PdfRejected("功能说明请控制在 80 字以内。")
    code = str(data.get("code") or display_floor_code(floor_id)).strip()[:8] or display_floor_code(floor_id)
    return {
        "id": floor_id,
        "code": code,
        "name": name,
        "description": description,
        "pageIndex": page_index,
    }


def empty_edits():
    return {
        "renamedPois": {},
        "renamedRooms": {},
        "facilityIcons": [],
        "movedPois": {},
        "roomColors": {},
        "polygonOverrides": {},
        "maskStrokes": [],
        "confirmedIds": [],
    }


def normalize_room_color(value):
    """Accept #RGB / #RRGGBB (optional leading #); return lowercase #rrggbb or None."""
    text = str(value or "").strip()
    if not text:
        return None
    if text.startswith("#"):
        text = text[1:]
    if len(text) == 3 and all(ch in "0123456789abcdefABCDEF" for ch in text):
        text = "".join(ch * 2 for ch in text)
    if len(text) == 6 and all(ch in "0123456789abcdefABCDEF" for ch in text):
        return f"#{text.lower()}"
    return None


def empty_draft(project_id, source_file, page, source_kind="floorplan"):
    size = list(page["originalSize"])
    floor = normalize_floor(None, page["index"])
    kind = normalize_source_kind(source_kind)
    return {
        "schemaVersion": "draft-1.0.0",
        "id": project_id,
        "revision": 1,
        "sourceFile": source_file,
        "sourceKind": kind,
        "page": {
            "index": page["index"],
            "originalSize": size,
            "rotation": 0,
            "crop": None,
            "pixelSize": size,
        },
        "floor": floor,
        "candidates": {"rooms": [], "corridors": [], "labels": [], "doors": []},
        "edits": empty_edits(),
        "pending": pending_for_source_kind(kind),
        "mapDocument": None,
    }


class ProjectStore:
    def __init__(self, root: Path, max_upload_bytes=MAX_UPLOAD_BYTES, max_pages=MAX_PAGES):
        self.root = Path(root)
        self.max_upload_bytes = max_upload_bytes
        self.max_pages = max_pages
        self.root.mkdir(parents=True, exist_ok=True)

    def _dir(self, project_id):
        if not PROJECT_ID.match(project_id or ""):
            raise PdfRejected("工程 ID 无效。", 404)
        path = (self.root / project_id).resolve()
        if path.parent != self.root.resolve():
            raise PdfRejected("工程 ID 无效。", 404)
        return path

    def _ensure_name(self, payload):
        if payload.get("name"):
            return payload
        source = (payload.get("draft") or {}).get("sourceFile") or payload.get("sourceFile") or {}
        payload["name"] = default_institution_name(source.get("fileName"))
        return payload

    def _read(self, folder):
        payload = json.loads((folder / "project.json").read_text(encoding="utf-8"))
        self._ensure_name(payload)
        source = (payload.get("draft") or {}).get("sourceFile") or payload.get("sourceFile")
        sha256 = (source or {}).get("sha256")
        if sha256:
            payload["fileUrl"] = f"/api/projects/{payload['id']}/file?sha256={sha256}"
        else:
            payload["fileUrl"] = f"/api/projects/{payload['id']}/file"
        return payload

    def _summary(self, payload):
        floors = list((payload.get("floors") or {}).values())
        ready = [item for item in floors if item.get("status") == "ready" and item.get("id")]
        source = (payload.get("draft") or {}).get("sourceFile") or payload.get("sourceFile") or {}
        status = payload.get("status") or "uploaded"
        if not source.get("sha256") and status not in {"ready", "failed"}:
            status = "empty"
        return {
            "id": payload["id"],
            "name": payload.get("name") or default_institution_name(source.get("fileName")),
            "status": status,
            "createdAt": payload.get("createdAt"),
            "updatedAt": payload.get("updatedAt"),
            "activeFloor": payload.get("activeFloor"),
            "floorCount": len(ready),
            "sourceFileName": source.get("fileName"),
            "mapUrl": payload.get("mapUrl"),
        }

    def list_projects(self):
        items = []
        root = self.root.resolve()
        if not root.is_dir():
            return items
        for folder in sorted(root.iterdir(), key=lambda path: path.name):
            if not folder.is_dir() or not PROJECT_ID.match(folder.name):
                continue
            if not (folder / "project.json").is_file():
                continue
            try:
                items.append(self._summary(self._read(folder)))
            except (OSError, json.JSONDecodeError, KeyError):
                continue
        items.sort(key=lambda item: item.get("updatedAt") or item.get("createdAt") or "", reverse=True)
        return items

    def get(self, project_id):
        folder = self._dir(project_id)
        if not (folder / "project.json").is_file():
            raise PdfRejected("找不到该工程。", 404)
        return self._read(folder)

    def rename(self, project_id, name):
        folder, record = self._record(project_id)
        self._ensure_name(record)
        record["name"] = normalize_institution_name(name, record.get("name"))
        record["updatedAt"] = utc_now()
        self._write_json(folder, record)
        return self._read(folder)

    def create_empty(self, name):
        """Named institution with no PDF yet — user imports drawings later."""
        text = normalize_institution_name(name)
        project_id = str(uuid.uuid4())
        folder = self._dir(project_id)
        folder.mkdir(parents=True, exist_ok=False)
        draft = {
            "schemaVersion": "draft-1.0.0",
            "id": project_id,
            "revision": 1,
            "sourceFile": None,
            "sourceKind": None,
            "page": None,
            "floor": None,
            "candidates": {"rooms": [], "corridors": [], "labels": [], "doors": []},
            "edits": empty_edits(),
            "pending": [],
            "mapDocument": None,
        }
        record = {
            "id": project_id,
            "name": text,
            "status": "empty",
            "sourceKind": None,
            "createdAt": utc_now(),
            "updatedAt": utc_now(),
            "sourceFile": None,
            "pages": [],
            "floors": {},
            "editsByFloor": {},
            "draft": draft,
            "lastError": None,
        }
        self._write_json(folder, record)
        return self._read(folder)

    def attach_first_pdf(self, project_id, filename, data: bytes, source_kind=None):
        """Bind the first source PDF to an empty named institution."""
        if len(data) > self.max_upload_bytes:
            raise PdfRejected(f"文件过大（上限 {self.max_upload_bytes // (1024 * 1024)} MB）。")
        if len(data) < 5:
            raise PdfRejected("不是有效的 PDF 文件。")
        folder, record = self._record(project_id)
        existing = (record.get("draft") or {}).get("sourceFile") or record.get("sourceFile")
        if existing and existing.get("sha256"):
            raise PdfRejected("该机构已有图纸。请用「新增楼层」上传，或新建机构。")
        kind = normalize_source_kind(source_kind, required=True)
        pdf_path = folder / "source.pdf"
        pdf_path.write_bytes(data)
        try:
            pages = inspect_pdf(pdf_path, self.max_pages)
        except PdfRejected:
            pdf_path.unlink(missing_ok=True)
            raise
        source_file = {
            "sha256": hashlib.sha256(data).hexdigest(),
            "fileName": safe_filename(filename),
            "byteLength": len(data),
        }
        draft = empty_draft(project_id, source_file, pages[0], kind)
        draft["revision"] = int((record.get("draft") or {}).get("revision") or 1) + 1
        record["status"] = "uploaded"
        record["sourceKind"] = kind
        record["sourceFile"] = source_file
        record["pages"] = pages
        record["floors"] = {str(pages[0]["index"]): {**draft["floor"], "status": "draft"}}
        record["draft"] = draft
        record["updatedAt"] = utc_now()
        record["lastError"] = None
        # Keep the user-chosen institution name; never overwrite from PDF stem.
        if not record.get("name"):
            record["name"] = default_institution_name(source_file["fileName"])
        self._write_json(folder, record)
        return self._read(folder)

    def delete(self, project_id):
        folder = self._dir(project_id)
        if not (folder / "project.json").is_file():
            raise PdfRejected("找不到该工程。", 404)
        summary = self._summary(self._read(folder))
        shutil.rmtree(folder)
        return summary

    def source_pdf(self, project_id):
        folder = self._dir(project_id)
        pdf = folder / "source.pdf"
        if not pdf.is_file():
            raise PdfRejected("找不到该工程。", 404)
        return pdf

    def _record(self, project_id):
        folder = self._dir(project_id)
        if not (folder / "project.json").is_file():
            raise PdfRejected("找不到该工程。", 404)
        return folder, json.loads((folder / "project.json").read_text(encoding="utf-8"))

    def resolve_pdf(self, project_id, sha256=None):
        folder, record = self._record(project_id)
        target = sha256
        if not target:
            source = (record.get("draft") or {}).get("sourceFile") or record.get("sourceFile")
            target = (source or {}).get("sha256")
        if not target:
            return self.source_pdf(project_id)
        primary_sha = (record.get("sourceFile") or {}).get("sha256")
        if target == primary_sha:
            pdf = folder / "source.pdf"
            if pdf.is_file():
                return pdf
        alt = folder / "sources" / f"{target[:16]}.pdf"
        if alt.is_file():
            return alt
        raise PdfRejected("找不到该 PDF。", 404)

    def draft_pdf(self, project_id):
        return self.resolve_pdf(project_id)

    def _next_floor_id(self, record):
        taken = {item["id"] for item in (record.get("floors") or {}).values() if item.get("id")}
        index = max((int(re.sub(r"[^0-9]", "", floor_id) or 0) for floor_id in taken), default=0) + 1
        candidate = f"{index}F"
        while candidate in taken:
            index += 1
            candidate = f"{index}F"
        return candidate

    def create_from_upload(self, filename, data: bytes, source_kind=None):
        if len(data) > self.max_upload_bytes:
            raise PdfRejected(f"文件过大（上限 {self.max_upload_bytes // (1024 * 1024)} MB）。")
        if len(data) < 5:
            raise PdfRejected("不是有效的 PDF 文件。")
        project_id = str(uuid.uuid4())
        folder = self._dir(project_id)
        folder.mkdir(parents=True, exist_ok=False)
        pdf_path = folder / "source.pdf"
        pdf_path.write_bytes(data)
        try:
            pages = inspect_pdf(pdf_path, self.max_pages)
        except PdfRejected:
            shutil.rmtree(folder, ignore_errors=True)
            raise
        source_file = {
            "sha256": hashlib.sha256(data).hexdigest(),
            "fileName": safe_filename(filename),
            "byteLength": len(data),
        }
        draft = empty_draft(project_id, source_file, pages[0], source_kind)
        record = {
            "id": project_id,
            "name": default_institution_name(source_file["fileName"]),
            "status": "uploaded",
            "sourceKind": draft["sourceKind"],
            "createdAt": utc_now(),
            "updatedAt": utc_now(),
            "sourceFile": source_file,
            "pages": pages,
            "floors": {str(pages[0]["index"]): {**draft["floor"], "status": "draft"}},
            "editsByFloor": {},
            "draft": draft,
        }
        (folder / "project.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        return self._read(folder)

    def attach_floor_pdf(self, project_id, filename, data: bytes, source_kind=None):
        if len(data) > self.max_upload_bytes:
            raise PdfRejected(f"文件过大（上限 {self.max_upload_bytes // (1024 * 1024)} MB）。")
        if len(data) < 5:
            raise PdfRejected("不是有效的 PDF 文件。")
        folder, record = self._record(project_id)
        ready = [item for item in (record.get("floors") or {}).values() if item.get("status") == "ready" and item.get("id")]
        if not ready:
            raise PdfRejected("请先完成首层导入并生成 3D，再为新增楼层上传 PDF。")
        sha256 = hashlib.sha256(data).hexdigest()
        sources = folder / "sources"
        sources.mkdir(parents=True, exist_ok=True)
        pdf_path = sources / f"{sha256[:16]}.pdf"
        if not pdf_path.is_file():
            pdf_path.write_bytes(data)
        try:
            pages = inspect_pdf(pdf_path, self.max_pages)
        except PdfRejected:
            if pdf_path.exists() and (record.get("sourceFile") or {}).get("sha256") != sha256:
                pdf_path.unlink(missing_ok=True)
            raise
        source_file = {
            "sha256": sha256,
            "fileName": safe_filename(filename),
            "byteLength": len(data),
        }
        kind = normalize_source_kind(source_kind)
        # Ready floors stay available for switching; free page slots for the new PDF draft.
        preserved = {}
        for item in (record.get("floors") or {}).values():
            if item.get("status") == "ready" and item.get("id"):
                preserved[f"id:{item['id']}"] = {**item, "pageIndex": item.get("pageIndex")}
        record["floors"] = preserved
        taken = {item["id"]: item.get("pageIndex") for item in preserved.values() if item.get("id")}
        floor = normalize_floor({"id": self._next_floor_id(record)}, pages[0]["index"], taken)
        size = list(pages[0]["originalSize"])
        record["pages"] = pages
        record["draft"]["revision"] = int(record["draft"]["revision"]) + 1
        record["draft"]["sourceFile"] = source_file
        record["draft"]["sourceKind"] = kind
        record["sourceKind"] = kind
        record["draft"]["page"] = {
            "index": pages[0]["index"],
            "originalSize": size,
            "rotation": 0,
            "crop": None,
            "pixelSize": size,
        }
        record["draft"]["floor"] = floor
        record["draft"]["edits"] = empty_edits()
        record["draft"]["candidates"] = {"rooms": [], "corridors": [], "labels": [], "doors": []}
        record["draft"]["pending"] = pending_for_source_kind(kind)
        record["draft"]["mapDocument"] = None
        record["updatedAt"] = utc_now()
        self._write_json(folder, record)
        return self._read(folder)

    def save_draft(self, project_id, revision, page_index, rotation, crop, floor=None, source_kind=None):
        folder, record = self._record(project_id)
        current = int(record["draft"]["revision"])
        if int(revision) != current:
            raise PdfRejected("草稿已被更新，请重新载入后再保存。", 409)
        page = next((item for item in record["pages"] if item["index"] == int(page_index)), None)
        if not page:
            raise PdfRejected("没有这一页。")
        if rotation not in (0, 90, 180, 270):
            raise PdfRejected("旋转只能是 0、90、180 或 270 度。")
        previous_kind = normalize_source_kind(record["draft"].get("sourceKind") or record.get("sourceKind"))
        kind = previous_kind if source_kind is None else normalize_source_kind(source_kind, required=True)
        size = page["originalSize"]
        crop_box = normalize_crop(crop, size)
        pixel = [crop_box["height"], crop_box["width"]] if rotation in (90, 270) else [crop_box["width"], crop_box["height"]]
        floors = record.setdefault("floors", {})
        existing = floors.get(str(page["index"]))
        if floor is not None:
            payload = floor
        elif existing:
            payload = existing
        else:
            payload = None
        taken = {item["id"]: item["pageIndex"] for item in floors.values() if item.get("id")}
        info = normalize_floor(payload, page["index"], taken)
        previous = floors.get(str(page["index"])) or {}
        if previous.get("id") == info["id"]:
            status = previous.get("status") or "draft"
            map_url = previous.get("mapUrl")
        else:
            # New floor id on this page: never inherit another floor's ready bit.
            twin = next(
                (
                    item for key, item in floors.items()
                    if key != str(page["index"]) and item.get("id") == info["id"]
                ),
                None,
            )
            status = (twin or {}).get("status") or "draft"
            map_url = (twin or {}).get("mapUrl")
            if previous.get("status") == "ready" and previous.get("id"):
                floors[f"id:{previous['id']}"] = {
                    **previous,
                    "pageIndex": previous.get("pageIndex", page["index"]),
                }
        floors[str(page["index"])] = {**info, "status": status, "mapUrl": map_url}
        edits_by_floor = record.setdefault("editsByFloor", {})
        old_floor_id = (record["draft"].get("floor") or {}).get("id")
        if old_floor_id:
            edits_by_floor.setdefault(old_floor_id, record["draft"].get("edits") or empty_edits())
        record["draft"]["revision"] = current + 1
        record["draft"]["sourceKind"] = kind
        record["sourceKind"] = kind
        record["draft"]["page"] = {
            "index": page["index"],
            "originalSize": list(size),
            "rotation": rotation,
            "crop": None if crop is None else crop_box,
            "pixelSize": pixel,
        }
        record["draft"]["floor"] = info
        record["draft"]["edits"] = edits_by_floor.get(info["id"]) or empty_edits()
        if kind != previous_kind or not record["draft"].get("pending"):
            record["draft"]["pending"] = pending_for_source_kind(kind)
        record["updatedAt"] = utc_now()
        (folder / "project.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        return self._read(folder)

    def snapshot_dir(self, project_id, floor_id="latest"):
        slug = str(floor_id or "latest")
        if slug != "latest" and not FLOOR_ID.match(slug):
            raise PdfRejected("楼层编号无效。", 404)
        return self._dir(project_id) / "maps" / slug

    def load_map(self, project_id, floor_id=None):
        if floor_id:
            path = self.snapshot_dir(project_id, floor_id) / "map.json"
        else:
            path = self.snapshot_dir(project_id, "latest") / "map.json"
        if not path.is_file():
            raise PdfRejected("尚未生成三维地图。", 404)
        return json.loads(path.read_text(encoding="utf-8"))

    def map_asset(self, project_id, name, floor_id="latest"):
        allowed = {
            "map.json",
            "validation-report.json",
            "walkable-mask.png",
            "safe-mask.png",
            "walkable-overlay.png",
        }
        if name not in allowed:
            raise PdfRejected("找不到该文件。", 404)
        path = self.snapshot_dir(project_id, floor_id) / name
        if not path.is_file():
            raise PdfRejected("尚未生成三维地图。", 404)
        return path

    def save_snapshot(self, project_id, revision, document, report, images, candidates, pending):
        folder = self._dir(project_id)
        if not (folder / "project.json").is_file():
            raise PdfRejected("找不到该工程。", 404)
        record = json.loads((folder / "project.json").read_text(encoding="utf-8"))
        if int(revision) != int(record["draft"]["revision"]):
            raise PdfRejected("草稿已被更新，请重新载入后再生成。", 409)
        floor_id = (document.get("floor") or {}).get("id") or record["draft"].get("floor", {}).get("id") or "latest"
        page_index = str(record["draft"]["page"]["index"])
        for slug in {floor_id, "latest"}:
            snap = self.snapshot_dir(project_id, slug)
            if snap.exists():
                shutil.rmtree(snap)
            snap.mkdir(parents=True, exist_ok=True)
            (snap / "map.json").write_text(json.dumps(document, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            (snap / "validation-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            for name, image in images.items():
                image.save(snap / name)
        record["status"] = "ready"
        record["lastError"] = None
        record["activeFloor"] = floor_id
        record["mapUrl"] = f"/api/projects/{project_id}/map?floor={floor_id}"
        record["updatedAt"] = utc_now()
        record["draft"]["candidates"] = candidates
        record["draft"]["pending"] = pending
        record["draft"]["mapDocument"] = None
        floors = record.setdefault("floors", {})
        current = floors.get(page_index) or {**record["draft"].get("floor", {}), "pageIndex": int(page_index)}
        floors[page_index] = {**current, "id": floor_id, "status": "ready", "mapUrl": record["mapUrl"]}
        (folder / "project.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        return self._read(folder)

    def _write_json(self, folder, record):
        (folder / "project.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")

    def _write_map(self, project_id, floor_id, document, also_latest=False):
        slugs = {floor_id}
        if also_latest:
            slugs.add("latest")
        payload = json.dumps(document, ensure_ascii=False, separators=(",", ":"))
        for slug in slugs:
            snap = self.snapshot_dir(project_id, slug)
            snap.mkdir(parents=True, exist_ok=True)
            (snap / "map.json").write_text(payload, encoding="utf-8")

    def save_edits(self, project_id, revision, floor_id, patch):
        folder = self._dir(project_id)
        if not (folder / "project.json").is_file():
            raise PdfRejected("找不到该工程。", 404)
        record = json.loads((folder / "project.json").read_text(encoding="utf-8"))
        if int(revision) != int(record["draft"]["revision"]):
            raise PdfRejected("草稿已被更新，请重新载入后再保存。", 409)
        floor_id = str(floor_id or record.get("activeFloor") or (record["draft"].get("floor") or {}).get("id") or "").strip()
        if not FLOOR_ID.match(floor_id):
            raise PdfRejected("楼层编号无效。")
        known = {item.get("id") for item in (record.get("floors") or {}).values() if item.get("id")}
        if floor_id not in known:
            raise PdfRejected("没有这一层。", 404)
        by_floor = record.setdefault("editsByFloor", {})
        current = {**empty_edits(), **(by_floor.get(floor_id) or {})}
        if patch.get("renamedPois") is not None:
            merged = dict(current.get("renamedPois") or {})
            for key, value in (patch["renamedPois"] or {}).items():
                text = str(value or "").strip()[:40]
                if text:
                    merged[str(key)] = text
            current["renamedPois"] = merged
        if patch.get("renamedRooms") is not None:
            merged = dict(current.get("renamedRooms") or {})
            for key, value in (patch["renamedRooms"] or {}).items():
                text = str(value or "").strip()[:40]
                if text:
                    merged[str(key)] = text
            current["renamedRooms"] = merged
        if patch.get("facilityIcons") is not None:
            icons = []
            for index, icon in enumerate(patch["facilityIcons"] or [], start=1):
                pos = icon.get("position") if isinstance(icon, dict) else None
                if not isinstance(pos, (list, tuple)) or len(pos) != 2:
                    continue
                poi_id = str(icon.get("id") or f"icon-{index}")
                if not poi_id.startswith("icon-"):
                    poi_id = f"icon-{poi_id}"
                icons.append({
                    "id": poi_id,
                    "category": str(icon.get("category") or "service"),
                    "name": str(icon.get("name") or "").strip()[:40],
                    "position": [float(pos[0]), float(pos[1])],
                    "roomId": str(icon.get("roomId") or "").strip()[:40] or None,
                })
            current["facilityIcons"] = icons
        if patch.get("movedPois") is not None:
            merged = dict(current.get("movedPois") or {})
            for key, value in (patch["movedPois"] or {}).items():
                if not isinstance(value, (list, tuple)) or len(value) != 2:
                    continue
                try:
                    x, y = float(value[0]), float(value[1])
                except (TypeError, ValueError):
                    continue
                if 0 <= x <= 1 and 0 <= y <= 1:
                    merged[str(key)] = [x, y]
            current["movedPois"] = merged
        if patch.get("roomColors") is not None:
            merged = dict(current.get("roomColors") or {})
            for key, value in (patch["roomColors"] or {}).items():
                room_id = str(key or "").strip()[:40]
                if not room_id:
                    continue
                # Empty / null clears the override so the default palette returns.
                if value is None or str(value).strip() == "":
                    merged.pop(room_id, None)
                    continue
                color = normalize_room_color(value)
                if color:
                    merged[room_id] = color
            current["roomColors"] = merged
        if patch.get("confirmedIds") is not None:
            current["confirmedIds"] = [str(item) for item in patch["confirmedIds"]]
        by_floor[floor_id] = current
        record["draft"]["revision"] = int(record["draft"]["revision"]) + 1
        if (record["draft"].get("floor") or {}).get("id") == floor_id:
            record["draft"]["edits"] = current
        document = None
        path = self.snapshot_dir(project_id, floor_id) / "map.json"
        if path.is_file():
            from maker_build import apply_map_edits
            document = apply_map_edits(json.loads(path.read_text(encoding="utf-8")), current)
            self._write_map(project_id, floor_id, document, also_latest=record.get("activeFloor") == floor_id)
        record["updatedAt"] = utc_now()
        self._write_json(folder, record)
        payload = self._read(folder)
        payload["map"] = document
        return payload

    def delete_floor(self, project_id, floor_id):
        folder = self._dir(project_id)
        if not (folder / "project.json").is_file():
            raise PdfRejected("找不到该工程。", 404)
        floor_id = str(floor_id or "").strip()
        if not FLOOR_ID.match(floor_id) or floor_id.lower() == "latest":
            raise PdfRejected("楼层编号无效。")
        record = json.loads((folder / "project.json").read_text(encoding="utf-8"))
        floors = record.setdefault("floors", {})
        keys = [key for key, item in floors.items() if item.get("id") == floor_id]
        if not keys:
            raise PdfRejected("没有这一层。", 404)
        remaining = [item for key, item in floors.items() if key not in keys]
        ready_left = [item for item in remaining if item.get("status") == "ready" and item.get("id")]
        if not ready_left:
            raise PdfRejected("至少保留一层三维地图，不能删除最后一层。")
        snap = self.snapshot_dir(project_id, floor_id)
        if snap.exists():
            shutil.rmtree(snap)
        for key in keys:
            del floors[key]
        (record.setdefault("editsByFloor", {})).pop(floor_id, None)
        ready = [item for item in floors.values() if item.get("status") == "ready" and item.get("id")]
        latest = self.snapshot_dir(project_id, "latest")
        if latest.exists():
            shutil.rmtree(latest)
        if ready:
            chosen = ready[-1]
            source = self.snapshot_dir(project_id, chosen["id"])
            if source.exists():
                shutil.copytree(source, latest)
            record["status"] = "ready"
            record["activeFloor"] = chosen["id"]
            record["mapUrl"] = f"/api/projects/{project_id}/map?floor={chosen['id']}"
        else:
            record["status"] = "uploaded"
            record["activeFloor"] = None
            record["mapUrl"] = None
            record["lastError"] = None
        if (record["draft"].get("floor") or {}).get("id") == floor_id:
            leftover = next(iter(floors.values()), None)
            if leftover and leftover.get("id"):
                record["draft"]["floor"] = {
                    "id": leftover["id"],
                    "code": leftover.get("code") or leftover["id"],
                    "name": leftover.get("name") or leftover["id"],
                    "description": leftover.get("description") or "",
                    "pageIndex": leftover.get("pageIndex"),
                }
                record["draft"]["edits"] = (record.get("editsByFloor") or {}).get(leftover["id"]) or empty_edits()
            else:
                record["draft"]["edits"] = empty_edits()
        record["updatedAt"] = utc_now()
        self._write_json(folder, record)
        return self._read(folder)

    def mark_failed(self, project_id, message):
        folder = self._dir(project_id)
        if not (folder / "project.json").is_file():
            raise PdfRejected("找不到该工程。", 404)
        record = json.loads((folder / "project.json").read_text(encoding="utf-8"))
        record["status"] = "failed"
        record["lastError"] = message
        record["updatedAt"] = utc_now()
        (folder / "project.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        return self._read(folder)


def normalize_crop(crop, page_size):
    width, height = float(page_size[0]), float(page_size[1])
    if crop is None:
        return {"x": 0, "y": 0, "width": width, "height": height}
    x, y = float(crop["x"]), float(crop["y"])
    crop_w, crop_h = float(crop["width"]), float(crop["height"])
    if crop_w <= 0 or crop_h <= 0:
        raise PdfRejected("裁剪范围必须大于零。")
    if x < -1e-6 or y < -1e-6 or x + crop_w > width + 1e-6 or y + crop_h > height + 1e-6:
        raise PdfRejected("裁剪必须落在原始页面内，不能改写 0～1 坐标基准。")
    return {
        "x": round(x, 4),
        "y": round(y, 4),
        "width": round(crop_w, 4),
        "height": round(crop_h, 4),
    }

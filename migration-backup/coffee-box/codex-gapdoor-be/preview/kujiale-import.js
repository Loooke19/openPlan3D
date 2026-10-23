const into = new URLSearchParams(location.search).get("into");
if (into) {
  const title = document.querySelector("#title");
  if (title) title.textContent = "导入为新楼层";
}
const fileInput = document.querySelector("#file");
const pick = document.querySelector("#pick");
const sheet = document.querySelector("#sheet");
const page = document.querySelector("#page");
const canvas = document.querySelector("#ruler");
const lengthInput = document.querySelector("#length");
const lengthLabel = document.querySelector("#length-label");
const floorInput = document.querySelector("#floor");
const floorField = document.querySelector("#floor-field");
const buildingOption = document.querySelector("#building-option");
const pages = document.querySelector("#pages");
const pagesHead = document.querySelector("#pages-head");
const pageList = document.querySelector("#page-list");
const form = document.querySelector("#form");
const ok = document.querySelector("#ok");
const status = document.querySelector("#status");
const done = document.querySelector("#done");
const openNav = document.querySelector("#open-nav");
const openEditor = document.querySelector("#open-editor");

let sheetId = null;
let sheetName = "";
let ruler = null;
let drag = null;
let floors = null;
let running = false;

function say(text) {
  status.hidden = !text;
  status.textContent = text || "";
}

function mode() {
  return new FormData(form).get("mode");
}

pick.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  say("");
  done.hidden = true;
  const body = new FormData();
  body.append("file", file);
  const response = await fetch("/api/sheets", { method: "POST", body });
  if (!response.ok) {
    say("无法打开");
    return;
  }
  const meta = await response.json();
  sheetId = meta.sheetId;
  sheetName = file.name.replace(/\.pdf$/i, "");
  page.src = `/api/sheets/${sheetId}/preview.png`;
  pick.hidden = true;
  sheet.hidden = false;
  ruler = null;
  floors = null;
  const multi = !into && (meta.pages || 1) > 1;
  buildingOption.hidden = !multi;
  pages.hidden = !multi;
  if (multi) {
    form.querySelector('input[value="building"]').checked = true;
    pagesHead.textContent = `共 ${meta.pages} 页，正在读取页底图名`;
    pageList.replaceChildren();
    readFloors(sheetId);
  }
  paint();
  sync();
});

async function readFloors(id) {
  const response = await fetch(`/api/sheets/${id}/floors.json`);
  if (id !== sheetId) return;
  if (!response.ok) {
    pagesHead.textContent = "没读到页底图名，请拉一段比例尺";
    sync();
    return;
  }
  floors = await response.json();
  const scale = floors.scale ? `比例 1:${floors.scale}` : "没读到比例，请拉一段比例尺";
  pagesHead.textContent = `共 ${floors.floors.length} 页 · ${scale}`;
  pageList.replaceChildren();
  const byLevel = [...floors.floors].sort((a, b) => b.level - a.level);
  for (const row of byLevel) {
    const item = document.createElement("li");
    const tag = document.createElement("span");
    tag.className = row.detected ? "floor-tag" : "floor-tag unknown";
    tag.textContent = row.name;
    const note = document.createElement("span");
    note.className = "page-note";
    note.textContent = `第 ${row.page} 页${row.title ? ` · ${row.title}` : " · 没读到图名"}`;
    item.append(tag, note);
    pageList.append(item);
  }
  sync();
}

function imagePoint(event) {
  const rect = page.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width * page.naturalWidth;
  const y = (event.clientY - rect.top) / rect.height * page.naturalHeight;
  return { x, y };
}

canvas.addEventListener("pointerdown", (event) => {
  if (!sheetId || !page.naturalWidth) return;
  canvas.setPointerCapture(event.pointerId);
  const point = imagePoint(event);
  drag = point;
  ruler = { x1: point.x, y1: point.y, x2: point.x, y2: point.y };
  paint();
});

canvas.addEventListener("pointermove", (event) => {
  if (!drag) return;
  const point = imagePoint(event);
  ruler = { x1: drag.x, y1: drag.y, x2: point.x, y2: point.y };
  paint();
});

function endDrag(event) {
  if (!drag) return;
  drag = null;
  if (ruler && Math.hypot(ruler.x2 - ruler.x1, ruler.y2 - ruler.y1) < 8) ruler = null;
  paint();
  sync();
}

canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);
lengthInput.addEventListener("input", sync);
form.addEventListener("change", sync);
window.addEventListener("resize", paint);

function rulerReady() {
  return Boolean(ruler) && Number(lengthInput.value) > 0;
}

function sync() {
  const building = mode() === "building";
  floorField.hidden = building;
  const titledScale = building && floors && floors.cmPerPoint;
  lengthLabel.textContent = titledScale
    ? `比例尺（可不拉，已读到 1:${floors.scale}）`
    : building && sheetId && floors
      ? "未读到比例：在图上沿一扇门（约 900–1000 mm）或已知尺寸拉线，填实际长度"
      : "比例尺";
  ok.disabled = running || !sheetId || !(rulerReady() || titledScale);
}

function paint() {
  const rect = page.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width));
  canvas.height = Math.max(1, Math.round(rect.height));
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!ruler || !page.naturalWidth) return;
  const sx = canvas.width / page.naturalWidth;
  const sy = canvas.height / page.naturalHeight;
  const x1 = ruler.x1 * sx;
  const y1 = ruler.y1 * sy;
  const x2 = ruler.x2 * sx;
  const y2 = ruler.y2 * sy;
  ctx.strokeStyle = "#1a7af8";
  ctx.fillStyle = "#1a7af8";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  for (const [x, y] of [[x1, y1], [x2, y2]]) {
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  const mm = lengthInput.value.trim();
  if (mm) {
    ctx.font = "12px sans-serif";
    ctx.fillText(`${mm} mm`, (x1 + x2) / 2 + 6, (y1 + y2) / 2 - 6);
  }
}

function rulerFields(body) {
  if (!rulerReady()) return;
  body.append("x1", String(ruler.x1));
  body.append("y1", String(ruler.y1));
  body.append("x2", String(ruler.x2));
  body.append("y2", String(ruler.y2));
  body.append("lengthMm", lengthInput.value.trim());
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function importBuilding() {
  const body = new FormData();
  body.append("sheetId", sheetId);
  body.append("name", sheetName);
  rulerFields(body);
  const names = document.getElementById("room-names")?.value.trim();
  if (names) body.append("roomNames", names);
  const response = await fetch("/api/import-building", { method: "POST", body });
  if (!response.ok) {
    say(response.status === 400 ? "请拉一段比例尺并填写长度" : "没能开始识别");
    return;
  }
  const { jobId } = await response.json();
  for (;;) {
    await wait(800);
    const poll = await fetch(`/api/jobs/${jobId}`);
    if (!poll.ok) {
      say("识别中断了");
      return;
    }
    const job = await poll.json();
    if (job.state === "running") {
      say(`识别中 ${job.done}/${job.total} · ${job.text}`);
      continue;
    }
    if (job.state === "error") {
      say(job.text === "scale" ? "请拉一段比例尺并填写长度" : "未识别到墙");
      return;
    }
    const result = job.result;
    const names = [...result.floors].sort((a, b) => b.level - a.level).map((row) => row.name).join(" · ");
    const links = result.links.map((link) => `${link.name}（${link.floors.length} 层）`).join("、");
    say(`已导入 ${result.floors.length} 层：${names}${links ? `。已接 ${links}` : "。没找到电梯或楼梯"}`);
    openNav.href = result.navUrl;
    openEditor.href = result.editorUrl;
    done.hidden = false;
    return;
  }
}

async function importSheet(chosen) {
  const body = new FormData();
  body.append("sheetId", sheetId);
  rulerFields(body);
  body.append("mode", chosen);
  body.append("floor", floorInput.value.trim());
  if (into) body.append("projectId", into);
  const response = await fetch("/api/recognize", { method: "POST", body });
  if (!response.ok) {
    say("未识别到墙");
    return;
  }
  const result = await response.json();
  if (chosen === "generate" && !result.walls) {
    say("未识别到墙");
    return;
  }
  location.href = result.editorUrl;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (ok.disabled) return;
  running = true;
  done.hidden = true;
  sync();
  say("识别中");
  try {
    const chosen = mode();
    if (chosen === "building") await importBuilding();
    else await importSheet(chosen);
  } catch {
    say("识别中断了");
  } finally {
    running = false;
    sync();
  }
});

// Optional room-name list file → textarea (txt with [1F] headers, csv or JSON).
document.getElementById("room-names-file")?.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (file) document.getElementById("room-names").value = await file.text();
});

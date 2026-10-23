const grid = document.querySelector("#grid");
const status = document.querySelector("#status");
const newFile = document.querySelector("#new-file");

function edited(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "已保存";
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60000));
  if (minutes < 1) return "刚刚编辑";
  if (minutes < 60) return `${minutes} 分钟前编辑`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前编辑`;
  const days = Math.round(hours / 24);
  return `${days} 天前编辑`;
}

function say(text) {
  status.hidden = !text;
  status.textContent = text || "";
}

function drawThumb(canvas, project) {
  const floor = (project.floors || []).find((item) => item.id === project.activeFloorId) || (project.floors || [])[0];
  const walls = (floor && floor.walls) || [];
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  ctx.fillStyle = "#eef0f2";
  ctx.fillRect(0, 0, width, height);
  if (!walls.length) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const wall of walls) {
    for (const point of [wall.start, wall.end]) {
      if (!point) continue;
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }
  if (!Number.isFinite(minX)) return;
  const pad = 16;
  const scale = Math.min((width - pad * 2) / Math.max(1, maxX - minX), (height - pad * 2) / Math.max(1, maxY - minY));
  const ox = (width - (maxX - minX) * scale) / 2;
  const oy = (height - (maxY - minY) * scale) / 2;
  ctx.strokeStyle = "#334155";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  for (const wall of walls) {
    if (!wall.start || !wall.end) continue;
    ctx.moveTo(ox + (wall.start.x - minX) * scale, oy + (wall.start.y - minY) * scale);
    ctx.lineTo(ox + (wall.end.x - minX) * scale, oy + (wall.end.y - minY) * scale);
  }
  ctx.stroke();
}

async function paintThumb(canvas, id) {
  const response = await fetch(`/api/projects/${id}.json`);
  if (!response.ok) return;
  drawThumb(canvas, await response.json());
}

function card(file, duplicate = false) {
  const article = document.createElement("article");
  article.className = "card";
  article.id = `p-${file.id}`;
  const floors = (file.floors || []).map((floor) => floor.name || floor.id).filter(Boolean);
  const floorQuery = file.activeFloorId ? `&floor=${encodeURIComponent(file.activeFloorId)}` : "";
  const navUrl = file.navUrl || `/nav?id=${encodeURIComponent(file.id)}${floorQuery}`;
  article.innerHTML = `
    <div class="thumb">
      <a class="thumb-link" href="${file.editorUrl}"><canvas width="480" height="296"></canvas></a>
    </div>
    <div class="meta">
      <a class="name" href="${file.editorUrl}"></a>
      <p class="when"></p>
      <p class="floors"></p>
      <div class="row">
        <a class="nav-entry" href="${navUrl}">导航浏览</a>
        <button type="button" data-act="import">导入楼层</button>
        <button type="button" data-act="floor">新建楼层</button>
      </div>
    </div>`;
  article.querySelector(".name").textContent = file.name || "未命名";
  if (duplicate) {
    // Same-named files: tell them apart by a short project ID.
    const tag = document.createElement("span");
    tag.className = "file-id";
    tag.textContent = `#${String(file.id).slice(0, 6)}`;
    tag.title = file.id;
    article.querySelector(".name").after(tag);
  }
  article.querySelector(".when").textContent = edited(file.updatedAt);
  article.querySelector(".floors").textContent = floors.length ? floors.join(" · ") : "还没有楼层";
  article.querySelector('[data-act="import"]').addEventListener("click", () => {
    location.href = `/?into=${encodeURIComponent(file.id)}`;
  });
  article.querySelector('[data-act="floor"]').addEventListener("click", async () => {
    say("正在新建楼层");
    const response = await fetch(`/api/projects/${file.id}/floors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!response.ok) {
      say("没能新建楼层");
      return;
    }
    const next = await response.json();
    location.href = next.editorUrl;
  });
  paintThumb(article.querySelector("canvas"), file.id);
  return article;
}

async function load() {
  say("");
  const response = await fetch("/api/projects");
  if (!response.ok) {
    say("文件列表没有打开");
    return;
  }
  const files = await response.json();
  grid.replaceChildren();
  if (!files.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "还没有文件。可以新建一个，或导入图纸。";
    grid.append(empty);
    return;
  }
  const counts = new Map();
  for (const file of files) counts.set(file.name || "未命名", (counts.get(file.name || "未命名") || 0) + 1);
  for (const file of files) grid.append(card(file, counts.get(file.name || "未命名") > 1));
  revealReturnedCard();
}

newFile.addEventListener("click", async () => {
  newFile.disabled = true;
  say("正在新建文件");
  const response = await fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "未命名" }),
  });
  newFile.disabled = false;
  if (!response.ok) {
    say("没能新建文件");
    return;
  }
  const file = await response.json();
  location.href = file.editorUrl;
});

load();
// Back from the editor can restore this page from the back/forward cache; refresh the list and links.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) load();
});

/** Back from the editor / nav lands on #p-<id>: scroll that card into view and flash it. */
function revealReturnedCard() {
  const id = decodeURIComponent(location.hash.replace(/^#/, ""));
  const target = id && document.getElementById(id);
  if (!target) return;
  target.scrollIntoView({ block: "center" });
  target.classList.add("returned");
  setTimeout(() => target.classList.remove("returned"), 2400);
}

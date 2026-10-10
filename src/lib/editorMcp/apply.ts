import { get } from 'svelte/store';
import {
  addDoor,
  addRoomFace,
  addWallSpec,
  addWindow,
  beginUndoGroup,
  currentProject,
  endUndoGroup,
  loadProject,
  setActiveFloor,
  viewMode,
  updateDoor,
  updateRoom,
  updateWall,
  updateWindow,
  upsertRoomRecord,
} from '$lib/stores/project';
import { autoSave } from '$lib/stores/saveStatus';
import { readProject } from '$lib/utils/projectValidation';
import type { Door, Wall, Window } from '$lib/models/types';

const DOOR_TYPES = new Set(['single', 'double', 'sliding', 'french', 'pocket', 'bifold', 'opening', 'garage']);
const WINDOW_TYPES = new Set(['standard', 'fixed', 'casement', 'sliding', 'bay']);

export type EditorCommand = {
  id?: string;
  op: string;
  floorId?: string;
  projectUrl?: string;
  patches?: Record<string, unknown>[];
  openings?: Record<string, unknown>[];
  room?: Record<string, unknown>;
  walls?: Record<string, unknown>[];
  rooms?: Record<string, unknown>[];
  face?: Record<string, unknown>;
  view?: string;
};

export type ApplyResult = {
  ok: boolean;
  error?: string;
  summary?: Record<string, unknown>;
  project?: unknown;
};

function fail(error: string): ApplyResult {
  return { ok: false, error, project: plainProject() };
}

function plainProject(): unknown {
  const project = get(currentProject);
  return project ? JSON.parse(JSON.stringify(project)) : undefined;
}

function counts() {
  const project = get(currentProject);
  const floor = project?.floors.find((item) => item.id === project.activeFloorId);
  return {
    walls: floor?.walls.length ?? 0,
    doors: floor?.doors.length ?? 0,
    windows: floor?.windows.length ?? 0,
    rooms: floor?.rooms.length ?? 0,
  };
}

export function loopbackProjectUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && !url.username;
  } catch {
    return false;
  }
}

function finitePoint(value: unknown): value is { x: number; y: number } {
  if (!value || typeof value !== 'object') return false;
  const point = value as { x?: unknown; y?: unknown };
  return typeof point.x === 'number' && Number.isFinite(point.x) && typeof point.y === 'number' && Number.isFinite(point.y);
}

function requireFloor(floorId?: string) {
  const project = get(currentProject);
  if (!project) throw new Error('没有打开的工程');
  const id = floorId || project.activeFloorId;
  const floor = project.floors.find((item) => item.id === id);
  if (!floor) throw new Error('楼层不存在');
  return floor;
}

function applyWalls(patches: Record<string, unknown>[]) {
  const floor = requireFloor(get(currentProject)?.activeFloorId);
  const changed: string[] = [];
  for (const patch of patches) {
    const id = patch.id;
    if (typeof id !== 'string') throw new Error('墙缺少 id');
    const wall = floor.walls.find((item) => item.id === id);
    if (!wall) throw new Error(`墙不存在: ${id}`);
    const updates: Partial<Wall> = {};
    if (patch.start !== undefined) {
      if (!finitePoint(patch.start)) throw new Error(`墙 ${id} 的 start 不是坐标`);
      updates.start = { x: patch.start.x, y: patch.start.y };
    }
    if (patch.end !== undefined) {
      if (!finitePoint(patch.end)) throw new Error(`墙 ${id} 的 end 不是坐标`);
      updates.end = { x: patch.end.x, y: patch.end.y };
    }
    const start = updates.start ?? wall.start;
    const end = updates.end ?? wall.end;
    if (start.x === end.x && start.y === end.y) throw new Error(`墙 ${id} 长度为 0`);
    if (patch.thickness !== undefined) {
      if (typeof patch.thickness !== 'number' || !(patch.thickness > 0) || patch.thickness > 200) throw new Error(`墙 ${id} 厚度无效`);
      updates.thickness = patch.thickness;
    }
    if (patch.height !== undefined) {
      if (typeof patch.height !== 'number' || patch.height < 0 || patch.height > 2000) throw new Error(`墙 ${id} 高度无效`);
      updates.height = patch.height;
    }
    for (const key of ['color', 'interiorColor', 'exteriorColor'] as const) {
      const value = patch[key];
      if (value !== undefined) {
        if (typeof value !== 'string' || !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)) throw new Error(`墙 ${id} 颜色无效`);
        updates[key] = value;
      }
    }
    updateWall(id, updates);
    changed.push(id);
  }
  return changed;
}

function applyOpenings(openings: Record<string, unknown>[]) {
  const floor = requireFloor(get(currentProject)?.activeFloorId);
  const wallIds = new Set(floor.walls.map((wall) => wall.id));
  const changed: string[] = [];
  const created: { kind: string; id: string }[] = [];
  for (const patch of openings) {
    const kind = patch.kind === 'window' ? 'window' : 'door';
    const position = patch.position;
    if (position !== undefined && (typeof position !== 'number' || position < 0 || position > 1)) {
      throw new Error('position 超出 [0,1]，已拒绝');
    }
    if (typeof patch.wallId === 'string' && !wallIds.has(patch.wallId)) throw new Error(`${kind === 'door' ? '门' : '窗'} 的 wallId 不存在`);
    if (patch.create) {
      if (typeof patch.wallId !== 'string' || typeof position !== 'number') throw new Error('新建门窗缺少 wallId 或 position');
      const id = kind === 'door'
        ? addDoor(patch.wallId, position, (DOOR_TYPES.has(String(patch.type)) ? patch.type : 'single') as Door['type'])
        : addWindow(patch.wallId, position, (WINDOW_TYPES.has(String(patch.type)) ? patch.type : 'standard') as Window['type']);
      const updates: Record<string, unknown> = {};
      if (typeof patch.width === 'number') updates.width = patch.width;
      if (typeof patch.height === 'number') updates.height = patch.height;
      if (kind === 'window' && typeof patch.sillHeight === 'number') updates.sillHeight = patch.sillHeight;
      if (Object.keys(updates).length) {
        if (kind === 'door') updateDoor(id, updates as Partial<Door>);
        else updateWindow(id, updates as Partial<Window>);
      }
      created.push({ kind, id });
      changed.push(id);
      continue;
    }
    if (typeof patch.id !== 'string') throw new Error('门窗缺少 id');
    const updates: Record<string, unknown> = {};
    if (typeof patch.wallId === 'string') updates.wallId = patch.wallId;
    if (typeof position === 'number') updates.position = position;
    if (typeof patch.width === 'number') updates.width = patch.width;
    if (typeof patch.height === 'number') updates.height = patch.height;
    if (typeof patch.type === 'string') updates.type = patch.type;
    if (kind === 'window' && typeof patch.sillHeight === 'number') updates.sillHeight = patch.sillHeight;
    if (kind === 'door') updateDoor(patch.id, updates as Partial<Door>);
    else updateWindow(patch.id, updates as Partial<Window>);
    changed.push(patch.id);
  }
  return { changed, created };
}

function applyAddWalls(walls: Record<string, unknown>[]) {
  const created: string[] = [];
  for (const wall of walls) {
    if (!finitePoint(wall.start) || !finitePoint(wall.end)) throw new Error('新墙坐标无效');
    const id = addWallSpec({
      id: typeof wall.id === 'string' ? wall.id : undefined,
      start: { x: wall.start.x, y: wall.start.y },
      end: { x: wall.end.x, y: wall.end.y },
      thickness: typeof wall.thickness === 'number' ? wall.thickness : undefined,
      height: typeof wall.height === 'number' ? wall.height : undefined,
      color: typeof wall.color === 'string' ? wall.color : undefined,
    });
    created.push(id);
  }
  return created;
}

function applyUpsertRooms(rooms: Record<string, unknown>[]) {
  const changed: string[] = [];
  for (const room of rooms) {
    if (typeof room.id !== 'string') throw new Error('房间缺少 id');
    const walls = Array.isArray(room.walls) ? room.walls.filter((id): id is string => typeof id === 'string') : undefined;
    upsertRoomRecord({
      id: room.id,
      name: typeof room.name === 'string' ? room.name : undefined,
      color: typeof room.color === 'string' ? room.color : undefined,
      floorTexture: typeof room.floorTexture === 'string' ? room.floorTexture : undefined,
      walls,
      area: typeof room.area === 'number' ? room.area : undefined,
      floorOpening: typeof room.floorOpening === 'boolean' ? room.floorOpening : undefined,
    });
    changed.push(room.id);
  }
  return changed;
}

function applyAddRoomFace(face: Record<string, unknown>) {
  const polygon = face.polygon;
  if (!Array.isArray(polygon) || polygon.length < 3 || !polygon.every(finitePoint)) throw new Error('房间面至少要 3 个点');
  const points = polygon.map((point) => ({ x: point.x, y: point.y }));
  let signed = 0;
  for (let index = 0; index < points.length; index++) {
    const next = points[(index + 1) % points.length];
    signed += points[index].x * next.y - next.x * points[index].y;
  }
  if (Math.abs(signed) < 1) throw new Error('房间面面积为 0');
  const id = addRoomFace({
    id: typeof face.id === 'string' ? face.id : undefined,
    polygon: points,
    name: typeof face.name === 'string' ? face.name : undefined,
    color: typeof face.color === 'string' ? face.color : undefined,
    floorTexture: typeof face.floorTexture === 'string' ? face.floorTexture : undefined,
    area: Math.round(Math.abs(signed) / 200) / 100,
  });
  return [id];
}

function canvasOf(view: '2d' | '3d'): HTMLCanvasElement | null {
  const node = document.querySelector(view === '3d' ? 'canvas[data-plan3d-canvas]' : 'canvas[data-plan2d-canvas]');
  return node instanceof HTMLCanvasElement ? node : null;
}

async function waitForCanvas(view: '2d' | '3d'): Promise<HTMLCanvasElement> {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const canvas = canvasOf(view);
    if (canvas && canvas.width > 2 && canvas.height > 2) {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (view === '3d') await new Promise((resolve) => setTimeout(resolve, 500));
      return canvas;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(view === '3d' ? '3D 画面还没出来' : '2D 画面还没出来');
}

async function captureEditorViews(view: string) {
  const wanted: ('2d' | '3d')[] = view === 'both' ? ['2d', '3d'] : view === '2d' ? ['2d'] : ['3d'];
  const previous = get(viewMode);
  const images: { view: '2d' | '3d'; width: number; height: number; pngBase64: string }[] = [];
  try {
    for (const item of wanted) {
      viewMode.set(item);
      const canvas = await waitForCanvas(item);
      images.push({
        view: item,
        width: canvas.width,
        height: canvas.height,
        pngBase64: canvas.toDataURL('image/png'),
      });
    }
  } finally {
    if (get(viewMode) !== previous) viewMode.set(previous);
  }
  return images;
}

function applyRoom(room: Record<string, unknown>) {
  const floor = requireFloor(get(currentProject)?.activeFloorId);
  const id = room.id;
  if (typeof id !== 'string' || !floor.rooms.some((item) => item.id === id)) throw new Error('房间不存在，不会新建房间');
  const updates: { name?: string; color?: string; floorTexture?: string } = {};
  if (typeof room.name === 'string') updates.name = room.name;
  if (typeof room.color === 'string') updates.color = room.color;
  if (typeof room.floorTexture === 'string') updates.floorTexture = room.floorTexture;
  updateRoom(id, updates);
  return [id];
}

export async function applyEditorCommand(command: EditorCommand): Promise<ApplyResult> {
  try {
    if (command.op === 'screenshot') {
      if (!get(currentProject)) return fail('没有打开的工程');
      const images = await captureEditorViews(command.view || '3d');
      return { ok: true, summary: { images }, project: plainProject() };
    }
    if (command.op === 'load_project') {
      if (!command.projectUrl || !loopbackProjectUrl(command.projectUrl)) return fail('projectUrl 只能是本机 http 地址');
      const response = await fetch(command.projectUrl);
      if (!response.ok) return fail(`载入失败 ${response.status}`);
      const project = readProject(await response.json());
      loadProject(project);
      try { await autoSave(); } catch { /* 工程留在当前页 */ }
      return { ok: true, summary: { loaded: project.id, undo: 'cleared', counts: counts() }, project: plainProject() };
    }
    requireFloor(command.floorId);
    const label = command.op === 'set_walls' ? 'MCP 修改墙'
      : command.op === 'add_walls' ? 'MCP 添加墙'
      : command.op === 'set_openings' ? 'MCP 修改门窗'
      : command.op === 'upsert_rooms' ? 'MCP 铺房间地面'
      : command.op === 'add_room_face' ? 'MCP 添加房间地面'
      : 'MCP 修改房间';
    beginUndoGroup();
    let summary: Record<string, unknown> = { undo: 'editor', counts: counts() };
    try {
      if (command.floorId) setActiveFloor(command.floorId);
      if (command.op === 'set_walls') summary.changed = applyWalls(command.patches ?? []);
      else if (command.op === 'add_walls') summary.created = applyAddWalls(command.walls ?? []);
      else if (command.op === 'set_openings') Object.assign(summary, applyOpenings(command.openings ?? []));
      else if (command.op === 'set_room' && command.room) summary.changed = applyRoom(command.room);
      else if (command.op === 'upsert_rooms') summary.changed = applyUpsertRooms(command.rooms ?? []);
      else if (command.op === 'add_room_face' && command.face) summary.created = applyAddRoomFace(command.face);
      else throw new Error('未知命令');
    } finally {
      endUndoGroup(label);
    }
    summary = { ...summary, counts: counts() };
    return { ok: true, summary, project: plainProject() };
  } catch (error) {
    return fail(error instanceof Error ? error.message : '编辑器拒绝了修改');
  }
}

import { get } from 'svelte/store';
import {
  addDoor,
  addWindow,
  beginUndoGroup,
  currentProject,
  endUndoGroup,
  loadProject,
  setActiveFloor,
  updateDoor,
  updateRoom,
  updateWall,
  updateWindow,
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
    const label = command.op === 'set_walls' ? 'MCP 修改墙' : command.op === 'set_openings' ? 'MCP 修改门窗' : 'MCP 修改房间';
    beginUndoGroup();
    let summary: Record<string, unknown> = { undo: 'editor', counts: counts() };
    try {
      if (command.floorId) setActiveFloor(command.floorId);
      if (command.op === 'set_walls') summary.changed = applyWalls(command.patches ?? []);
      else if (command.op === 'set_openings') Object.assign(summary, applyOpenings(command.openings ?? []));
      else if (command.op === 'set_room' && command.room) summary.changed = applyRoom(command.room);
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

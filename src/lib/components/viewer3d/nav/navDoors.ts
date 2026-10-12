/**
 * Match server ``floor_nav._nav_doors``: drawn rooms often only store ``doorAt``.
 * Without a doors[] row the 3D wall stays solid while the planner walks the jamb —
 * the blue line then looks like it cuts through a black wall.
 */
export type P2 = { x: number; y: number };
export type WallSeg = { id?: string; start: P2; end: P2; thickness?: number };
export type DoorRow = {
  id?: string;
  wallId?: string;
  position?: number;
  width?: number;
  height?: number;
  type?: string;
  fromDoorAt?: boolean;
  [key: string]: unknown;
};

function hostWall(walls: WallSeg[], x: number, y: number, pad = 30): WallSeg | null {
  let best: WallSeg | null = null;
  let bestDist = 1e9;
  for (const wall of walls) {
    const x0 = wall.start.x, y0 = wall.start.y, x1 = wall.end.x, y1 = wall.end.y;
    const dx = x1 - x0, dy = y1 - y0;
    const lenSq = dx * dx + dy * dy;
    const thick = (wall.thickness ?? 15) / 2 + pad;
    let dist: number;
    if (lenSq < 1e-9) dist = Math.hypot(x - x0, y - y0);
    else {
      const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / lenSq));
      dist = Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy));
    }
    if (dist <= thick && dist < bestDist) {
      best = wall;
      bestDist = dist;
    }
  }
  return best;
}

/** ``doors[]`` plus synthetic rows from ``room.doorAt`` snapped onto the host wall. */
export function navDoors(
  floor: { doors?: DoorRow[]; rooms?: { id?: string; name?: string; doorAt?: P2; doorWidth?: number }[]; walls?: WallSeg[] },
): DoorRow[] {
  const walls = floor.walls || [];
  const doors: DoorRow[] = (floor.doors || []).map((d) => ({ ...d }));
  const existing: P2[] = [];
  for (const door of doors) {
    const wall = walls.find((w) => w.id && w.id === door.wallId);
    if (!wall) continue;
    const t = Math.max(0, Math.min(1, door.position ?? 0.5));
    existing.push({
      x: wall.start.x + (wall.end.x - wall.start.x) * t,
      y: wall.start.y + (wall.end.y - wall.start.y) * t,
    });
  }
  for (const room of floor.rooms || []) {
    const at = room.doorAt;
    if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) continue;
    if (existing.some((p) => Math.hypot(p.x - at.x, p.y - at.y) <= 40)) continue;
    const host = hostWall(walls, at.x, at.y, 30);
    if (!host?.id) continue;
    const dx = host.end.x - host.start.x, dy = host.end.y - host.start.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-9) continue;
    const t = Math.max(0, Math.min(1, ((at.x - host.start.x) * dx + (at.y - host.start.y) * dy) / lenSq));
    doors.push({
      id: `doorAt-${room.id || room.name || 'room'}`,
      wallId: host.id,
      position: t,
      width: room.doorWidth || 100,
      height: 210,
      // Plain opening (no wood leaf): doorAt marks the passage the planner uses; a closed
      // leaf would read as a solid wall from the overview camera.
      type: 'opening',
      fromDoorAt: true,
    });
    existing.push({ x: host.start.x + dx * t, y: host.start.y + dy * t });
  }
  return doors;
}

// Geometry-only placement rules; labels never infer a clinical department name.
export function containsPoint(polygon, x, z) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

export function closestPointOnPolygon(polygon, x, z) {
  if (!polygon?.length) return [x, z];
  if (containsPoint(polygon, x, z)) return [x, z];
  let best = null;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const ax = polygon[j][0], ay = polygon[j][1], bx = polygon[i][0], by = polygon[i][1];
    const dx = bx - ax, dy = by - ay;
    const denom = dx * dx + dy * dy;
    const t = denom ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - ay) * dy) / denom)) : 0;
    const px = ax + t * dx, py = ay + t * dy;
    const dist = (px - x) ** 2 + (py - z) ** 2;
    if (best === null || dist < best.dist) best = { dist, point: [px, py] };
  }
  return best ? best.point : [x, z];
}

export function wallSignPlacements(wall, polygon, repeat = true) {
  if (wall.height < 15 || wall.length < 3) return [];
  let nx = Math.sin(wall.angle), nz = Math.cos(wall.angle);
  if (containsPoint(polygon, wall.x + nx * .15, wall.z + nz * .15)) { nx = -nx; nz = -nz; }
  const count = repeat ? Math.max(1, Math.ceil(wall.length / 38)) : 1;
  const width = Math.min(14, wall.length / count - 1);
  return Array.from({ length: count }, (_, i) => {
    const along = ((i + .5) / count - .5) * wall.length;
    return { x: wall.x + Math.cos(wall.angle) * along, z: wall.z - Math.sin(wall.angle) * along, nx, nz, width };
  });
}

import type { TranslationKey } from '$lib/i18n';

/** Map-app POI style room labels (icon circle + name). */

export type RoomLabelStyle = 'stroke' | 'mapPoi' | 'mapPoiSoft' | 'hidden';

export type RoomLabelIcon =
  | 'elevator'
  | 'stairs'
  | 'restroom'
  | 'clinic'
  | 'service'
  | 'food'
  | 'exit'
  | 'general';

export interface RoomLabelIconPreset {
  id: RoomLabelIcon;
  /** Default map category colour (circle fill). */
  color: string;
  labelKey: TranslationKey;
}

export const ROOM_LABEL_STYLES: { id: RoomLabelStyle; labelKey: TranslationKey }[] = [
  { id: 'stroke', labelKey: 'roomProperties.labelStyleStroke' },
  { id: 'mapPoi', labelKey: 'roomProperties.labelStyleMapPoi' },
  { id: 'mapPoiSoft', labelKey: 'roomProperties.labelStyleMapPoiSoft' },
  { id: 'hidden', labelKey: 'roomProperties.labelStyleHidden' },
];

export const ROOM_LABEL_ICONS: RoomLabelIconPreset[] = [
  { id: 'elevator', color: '#3B82F6', labelKey: 'roomProperties.labelIconElevator' },
  { id: 'stairs', color: '#0D9488', labelKey: 'roomProperties.labelIconStairs' },
  { id: 'restroom', color: '#6366F1', labelKey: 'roomProperties.labelIconRestroom' },
  { id: 'clinic', color: '#F97316', labelKey: 'roomProperties.labelIconClinic' },
  { id: 'service', color: '#8B5CF6', labelKey: 'roomProperties.labelIconService' },
  { id: 'food', color: '#EF4444', labelKey: 'roomProperties.labelIconFood' },
  { id: 'exit', color: '#DC2626', labelKey: 'roomProperties.labelIconExit' },
  { id: 'general', color: '#64748B', labelKey: 'roomProperties.labelIconGeneral' },
];

const ICON_BY_ID = new Map(ROOM_LABEL_ICONS.map((item) => [item.id, item]));

export function resolveRoomLabelStyle(style?: string | null): RoomLabelStyle {
  if (style === 'mapPoi' || style === 'mapPoiSoft' || style === 'hidden' || style === 'stroke') return style;
  return 'stroke';
}

export function resolveRoomLabelIcon(icon?: string | null): RoomLabelIcon {
  if (icon && ICON_BY_ID.has(icon as RoomLabelIcon)) return icon as RoomLabelIcon;
  return 'general';
}

export function roomLabelIconColor(icon?: string | null, override?: string | null): string {
  if (override && /^#[0-9A-Fa-f]{6}$/.test(override)) return override;
  return ICON_BY_ID.get(resolveRoomLabelIcon(icon))?.color ?? '#64748B';
}

/** Pull per-room label settings from saved floor rooms when face-id merge misses. */
export function lookupRoomLabelFields(
  floorRooms: Array<{
    id?: string;
    name?: string;
    labelStyle?: string | null;
    labelIcon?: string | null;
    labelIconColor?: string | null;
    labelColor?: string | null;
    labelSize?: number | null;
    floorPolygon?: { x: number; y: number }[];
  }> | undefined,
  room: {
    id?: string;
    name?: string;
    labelStyle?: string | null;
    labelIcon?: string | null;
    labelIconColor?: string | null;
    labelColor?: string | null;
    labelSize?: number | null;
  },
  centroid?: { x: number; y: number } | null,
): {
  labelStyle?: string | null;
  labelIcon?: string | null;
  labelIconColor?: string | null;
  labelColor?: string | null;
  labelSize?: number | null;
  name?: string;
} {
  const list = floorRooms ?? [];
  const byId = room.id ? list.find((item) => item.id === room.id) : undefined;
  if (byId) return byId;
  if (room.labelStyle || room.labelIcon) return room;
  const byName = room.name ? list.find((item) => item.name === room.name) : undefined;
  if (byName) return byName;
  if (centroid) {
    for (const item of list) {
      const poly = item.floorPolygon;
      if (!poly || poly.length < 3) continue;
      if (pointInPoly(centroid, poly)) return item;
    }
    // Nearest saved room that carries label settings (wall-key merge may have missed).
    let best: (typeof list)[number] | null = null;
    let bestDist = Infinity;
    for (const item of list) {
      if (!item.labelStyle && !item.labelIcon) continue;
      const poly = item.floorPolygon;
      if (!poly || poly.length < 3) continue;
      let sx = 0, sy = 0;
      for (const pt of poly) { sx += pt.x; sy += pt.y; }
      const cx = sx / poly.length, cy = sy / poly.length;
      const d = (cx - centroid.x) ** 2 + (cy - centroid.y) ** 2;
      if (d < bestDist) { bestDist = d; best = item; }
    }
    if (best && bestDist < 250000) return best; // within ~5m
  }
  return room;
}

function pointInPoly(point: { x: number; y: number }, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const intersect =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || Number.EPSILON) + a.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

const CJK_FONT =
  '"Noto Sans SC", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", system-ui, sans-serif';

function drawGlyph(
  ctx: CanvasRenderingContext2D,
  icon: RoomLabelIcon,
  cx: number,
  cy: number,
  radius: number,
) {
  const s = radius * 0.55;
  ctx.save();
  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = '#ffffff';
  ctx.lineWidth = Math.max(1.2, radius * 0.12);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  switch (icon) {
    case 'elevator': {
      // Cabin
      ctx.strokeRect(cx - s * 0.55, cy - s * 0.7, s * 1.1, s * 1.4);
      // Up / down chevrons
      ctx.beginPath();
      ctx.moveTo(cx, cy - s * 0.35);
      ctx.lineTo(cx - s * 0.28, cy - s * 0.05);
      ctx.lineTo(cx + s * 0.28, cy - s * 0.05);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx, cy + s * 0.4);
      ctx.lineTo(cx - s * 0.28, cy + s * 0.1);
      ctx.lineTo(cx + s * 0.28, cy + s * 0.1);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'stairs': {
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.7, cy + s * 0.55);
      ctx.lineTo(cx - s * 0.7, cy + s * 0.15);
      ctx.lineTo(cx - s * 0.25, cy + s * 0.15);
      ctx.lineTo(cx - s * 0.25, cy - s * 0.2);
      ctx.lineTo(cx + s * 0.2, cy - s * 0.2);
      ctx.lineTo(cx + s * 0.2, cy - s * 0.55);
      ctx.lineTo(cx + s * 0.7, cy - s * 0.55);
      ctx.stroke();
      break;
    }
    case 'restroom': {
      // Person silhouette (simplified)
      ctx.beginPath();
      ctx.arc(cx, cy - s * 0.45, s * 0.28, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx, cy - s * 0.15);
      ctx.lineTo(cx, cy + s * 0.35);
      ctx.moveTo(cx - s * 0.45, cy + s * 0.05);
      ctx.lineTo(cx + s * 0.45, cy + s * 0.05);
      ctx.moveTo(cx, cy + s * 0.35);
      ctx.lineTo(cx - s * 0.35, cy + s * 0.75);
      ctx.moveTo(cx, cy + s * 0.35);
      ctx.lineTo(cx + s * 0.35, cy + s * 0.75);
      ctx.stroke();
      break;
    }
    case 'clinic': {
      const arm = s * 0.22;
      const len = s * 0.7;
      ctx.fillRect(cx - arm, cy - len, arm * 2, len * 2);
      ctx.fillRect(cx - len, cy - arm, len * 2, arm * 2);
      break;
    }
    case 'service': {
      ctx.beginPath();
      ctx.arc(cx, cy - s * 0.15, s * 0.55, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy - s * 0.35, s * 0.14, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx, cy - s * 0.05);
      ctx.lineTo(cx, cy + s * 0.35);
      ctx.stroke();
      break;
    }
    case 'food': {
      // Fork + knife
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.35, cy - s * 0.65);
      ctx.lineTo(cx - s * 0.35, cy + s * 0.65);
      ctx.moveTo(cx - s * 0.55, cy - s * 0.65);
      ctx.lineTo(cx - s * 0.55, cy - s * 0.15);
      ctx.moveTo(cx - s * 0.15, cy - s * 0.65);
      ctx.lineTo(cx - s * 0.15, cy - s * 0.15);
      ctx.moveTo(cx + s * 0.35, cy - s * 0.65);
      ctx.lineTo(cx + s * 0.35, cy + s * 0.65);
      ctx.moveTo(cx + s * 0.15, cy - s * 0.35);
      ctx.quadraticCurveTo(cx + s * 0.55, cy - s * 0.1, cx + s * 0.35, cy + s * 0.1);
      ctx.stroke();
      break;
    }
    case 'exit': {
      ctx.strokeRect(cx - s * 0.55, cy - s * 0.55, s * 0.7, s * 1.1);
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.05, cy);
      ctx.lineTo(cx + s * 0.65, cy);
      ctx.moveTo(cx + s * 0.3, cy - s * 0.3);
      ctx.lineTo(cx + s * 0.65, cy);
      ctx.lineTo(cx + s * 0.3, cy + s * 0.3);
      ctx.stroke();
      break;
    }
    default: {
      // Pin / place mark
      ctx.beginPath();
      ctx.arc(cx, cy - s * 0.15, s * 0.45, Math.PI * 0.85, Math.PI * 0.15, true);
      ctx.lineTo(cx, cy + s * 0.7);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy - s * 0.2, s * 0.16, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
  }
  ctx.restore();
}

export interface DrawMapRoomLabelOptions {
  name: string;
  style: RoomLabelStyle;
  icon?: string | null;
  iconColor?: string | null;
  /** Text fill colour (defaults to dark). */
  textColor?: string;
  fontSize: number;
  /** Stroke width for name outline (nav 3D≈5, 2D≈2). */
  strokeWidth: number;
  /** Icon circle radius in canvas pixels. */
  iconRadius?: number;
  /** Anchor: left of icon+text block center, or left of whole label. */
  align?: 'center' | 'left';
  x: number;
  y: number;
}

/** Draw a map-POI or stroke room name at (x,y). Returns false when hidden. */
export function drawMapRoomLabel(ctx: CanvasRenderingContext2D, opts: DrawMapRoomLabelOptions): boolean {
  const style = resolveRoomLabelStyle(opts.style);
  if (style === 'hidden') return false;

  const name = (opts.name || '').trim();
  if (!name) return false;

  const fontSize = Math.max(8, opts.fontSize);
  const font = `bold ${fontSize}px ${CJK_FONT}`;
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  if (style === 'stroke') {
    ctx.textAlign = opts.align === 'left' ? 'left' : 'center';
    ctx.lineWidth = opts.strokeWidth;
    ctx.strokeStyle = '#ffffff';
    ctx.strokeText(name, opts.x, opts.y);
    ctx.fillStyle = opts.textColor || '#222222';
    ctx.fillText(name, opts.x, opts.y);
    return true;
  }

  const icon = resolveRoomLabelIcon(opts.icon);
  const color = roomLabelIconColor(icon, opts.iconColor);
  const radius = opts.iconRadius ?? Math.max(8, fontSize * 0.72);
  const gap = Math.max(4, fontSize * 0.28);
  const textW = ctx.measureText(name).width;
  const blockW = radius * 2 + gap + textW;

  let left = opts.align === 'left' ? opts.x : opts.x - blockW / 2;
  const cy = opts.y;
  const iconCx = left + radius;
  const textX = left + radius * 2 + gap;

  // mapPoi / mapPoiSoft: colored icon circle + dark stroked name only.
  // Never wrap the name in a light chip / rounded bar (soft used to).

  // Colored circle + white glyph
  ctx.beginPath();
  ctx.arc(iconCx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = Math.max(1, radius * 0.08);
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.stroke();
  drawGlyph(ctx, icon, iconCx, cy, radius);

  // Name: dark fill + white stroke for contrast on the floor (no text backdrop)
  ctx.textAlign = 'left';
  ctx.lineWidth = opts.strokeWidth;
  ctx.strokeStyle = '#ffffff';
  ctx.strokeText(name, textX, cy);
  ctx.fillStyle = opts.textColor || '#1f2937';
  ctx.fillText(name, textX, cy);
  return true;
}

export interface BakeNavLabelSpriteResult {
  canvas: HTMLCanvasElement;
  /** World-scale width/height multipliers relative to default stroke sprite. */
  scaleX: number;
  scaleY: number;
}

/**
 * Bake a nav 3D sprite canvas for one room label.
 * Draws at `pixelScale`× logical size so top-down far views stay sharp when
 * the sprite is downscaled; world scale stays near the historical 300×60.
 */
export function bakeNavRoomLabelSprite(opts: {
  name: string;
  style?: string | null;
  icon?: string | null;
  iconColor?: string | null;
  labelColor?: string | null;
  /** Logical font size in px (nav default 44); multiplied by pixelScale on canvas. */
  fontSize?: number;
  strokeWidth?: number;
  /** Canvas supersampling (≥1). Default 3 for crisp CJK at overview distance. */
  pixelScale?: number;
}): BakeNavLabelSpriteResult | null {
  const style = resolveRoomLabelStyle(opts.style);
  if (style === 'hidden') return null;

  const name = (opts.name || '').trim();
  if (!name) return null;

  const pixelScale = Math.max(1, opts.pixelScale ?? 3);
  const fontSize = (opts.fontSize ?? 44) * pixelScale;
  const strokeWidth = (opts.strokeWidth ?? 5) * pixelScale;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  // Prefer crisp glyph edges when the GPU later mipmaps the texture down.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  if (style === 'stroke') {
    ctx.font = `bold ${fontSize}px ${CJK_FONT}`;
    const textW = ctx.measureText(name).width;
    const padX = Math.ceil(strokeWidth + 12 * pixelScale);
    const padY = Math.ceil(strokeWidth + 10 * pixelScale);
    const width = Math.max(64, Math.ceil(textW + padX * 2));
    const height = Math.max(32, Math.ceil(fontSize + padY * 2));
    canvas.width = width;
    canvas.height = height;
    ctx.clearRect(0, 0, width, height);
    drawMapRoomLabel(ctx, {
      name,
      style: 'stroke',
      textColor: opts.labelColor || '#222222',
      fontSize,
      strokeWidth,
      align: 'center',
      x: width / 2,
      y: height / 2,
    });
    // Slightly tighter than old 300×60 so overview distance packs more texels/px.
    return { canvas, scaleX: 260, scaleY: 52 };
  }

  // Measure for map styles (icon + name, no chip padding)
  ctx.font = `bold ${fontSize}px ${CJK_FONT}`;
  const textW = ctx.measureText(name).width;
  const iconR = Math.max(18 * pixelScale, fontSize * 0.72);
  const gap = Math.max(8 * pixelScale, fontSize * 0.28);
  const padX = Math.max(12 * pixelScale, strokeWidth + 4 * pixelScale);
  const padY = Math.max(10 * pixelScale, strokeWidth + 4 * pixelScale);
  const contentW = iconR * 2 + gap + textW;
  const width = Math.ceil(contentW + padX * 2);
  const height = Math.ceil(Math.max(iconR * 2, fontSize) + padY * 2);
  canvas.width = width;
  canvas.height = height;
  ctx.clearRect(0, 0, width, height);
  drawMapRoomLabel(ctx, {
    name,
    // Soft historically drew a chip; bake as mapPoi (icon + stroked name).
    style: style === 'mapPoiSoft' ? 'mapPoi' : style,
    icon: opts.icon,
    iconColor: opts.iconColor,
    textColor: opts.labelColor || '#1f2937',
    fontSize,
    strokeWidth,
    iconRadius: iconR,
    align: 'center',
    x: width / 2,
    y: height / 2,
  });

  // World size tracks aspect vs the legacy 512×96 stroke atlas, then tightens a bit.
  const scaleX = 260 * (width / (512 * pixelScale));
  const scaleY = 52 * (height / (96 * pixelScale));
  return { canvas, scaleX, scaleY };
}

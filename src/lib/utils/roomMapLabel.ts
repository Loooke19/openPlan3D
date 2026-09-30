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

  if (style === 'mapPoiSoft') {
    const padX = Math.max(6, fontSize * 0.35);
    const padY = Math.max(4, fontSize * 0.28);
    const chipH = Math.max(radius * 2, fontSize) + padY * 2;
    const chipW = blockW + padX * 2;
    const chipX = left - padX;
    const chipY = cy - chipH / 2;
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.strokeStyle = 'rgba(15,23,42,0.08)';
    ctx.lineWidth = 1;
    const r = chipH / 2;
    ctx.beginPath();
    ctx.moveTo(chipX + r, chipY);
    ctx.arcTo(chipX + chipW, chipY, chipX + chipW, chipY + chipH, r);
    ctx.arcTo(chipX + chipW, chipY + chipH, chipX, chipY + chipH, r);
    ctx.arcTo(chipX, chipY + chipH, chipX, chipY, r);
    ctx.arcTo(chipX, chipY, chipX + chipW, chipY, r);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // Colored circle + white glyph
  ctx.beginPath();
  ctx.arc(iconCx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = Math.max(1, radius * 0.08);
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.stroke();
  drawGlyph(ctx, icon, iconCx, cy, radius);

  // Name: dark, optional white stroke (mapPoi); soft chip already provides contrast
  ctx.textAlign = 'left';
  if (style === 'mapPoi') {
    ctx.lineWidth = opts.strokeWidth;
    ctx.strokeStyle = '#ffffff';
    ctx.strokeText(name, textX, cy);
  }
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

/** Bake a nav 3D sprite canvas for one room label. */
export function bakeNavRoomLabelSprite(opts: {
  name: string;
  style?: string | null;
  icon?: string | null;
  iconColor?: string | null;
  labelColor?: string | null;
  /** Font size in px on the canvas (nav default 44). */
  fontSize?: number;
  strokeWidth?: number;
}): BakeNavLabelSpriteResult | null {
  const style = resolveRoomLabelStyle(opts.style);
  if (style === 'hidden') return null;

  const name = (opts.name || '').trim();
  if (!name) return null;

  const fontSize = opts.fontSize ?? 44;
  const strokeWidth = opts.strokeWidth ?? 5;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;

  if (style === 'stroke') {
    canvas.width = 512;
    canvas.height = 96;
    ctx.clearRect(0, 0, 512, 96);
    drawMapRoomLabel(ctx, {
      name,
      style: 'stroke',
      textColor: opts.labelColor || '#222222',
      fontSize,
      strokeWidth,
      align: 'center',
      x: 256,
      y: 48,
    });
    return { canvas, scaleX: 300, scaleY: 60 };
  }

  // Measure for map styles
  ctx.font = `bold ${fontSize}px ${CJK_FONT}`;
  const textW = ctx.measureText(name).width;
  const iconR = Math.max(18, fontSize * 0.72);
  const gap = Math.max(8, fontSize * 0.28);
  const padX = style === 'mapPoiSoft' ? Math.max(14, fontSize * 0.4) : 16;
  const padY = style === 'mapPoiSoft' ? Math.max(10, fontSize * 0.3) : 12;
  const contentW = iconR * 2 + gap + textW;
  const width = Math.ceil(contentW + padX * 2);
  const height = Math.ceil(Math.max(iconR * 2, fontSize) + padY * 2);
  canvas.width = width;
  canvas.height = height;
  ctx.clearRect(0, 0, width, height);
  drawMapRoomLabel(ctx, {
    name,
    style,
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

  // Keep roughly same physical size as stroke sprites for the name portion
  const scaleX = 300 * (width / 512);
  const scaleY = 60 * (height / 96);
  return { canvas, scaleX, scaleY };
}

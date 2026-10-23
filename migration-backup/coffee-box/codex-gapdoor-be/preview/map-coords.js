// Coordinate helpers for MapDocument and MapDraft.
// All map geometry stays normalized to the ORIGINAL full PDF page (top-left origin,
 // legend included). Crop and rotation change only the working raster / display frame.

export const DEFAULT_PDF_SIZE = Object.freeze([800, 1210]);

export function pageSizeOf(sourceOrDoc) {
  const size = sourceOrDoc?.pdfSize || sourceOrDoc?.source?.pdfSize || DEFAULT_PDF_SIZE;
  const width = Number(size?.[0]), height = Number(size?.[1]);
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error('pdfSize must be a positive [width, height]');
  }
  return [width, height];
}

export function toPageUnits(normalized, pageSize = DEFAULT_PDF_SIZE) {
  const [w, h] = pageSizeOf({ pdfSize: pageSize });
  return [normalized[0] * w, normalized[1] * h];
}

export function toNormalized(pageUnits, pageSize = DEFAULT_PDF_SIZE) {
  const [w, h] = pageSizeOf({ pdfSize: pageSize });
  return [pageUnits[0] / w, pageUnits[1] / h];
}

/** Map-unit exponent for labels/icons. On-screen size scales as zoom^(1 - power)
 *  until the readable floor: enlarge the map (smaller viewBox / larger camera.zoom)
 *  → shrink text relative to rooms so names do not cover the floor. */
export const LABEL_MAP_ZOOM_POWER = 1.35;

/** On-screen size vs the home view. 1 = never smaller than home when zoomed in. */
export const LABEL_MIN_SCREEN_RATIO = 1;

/** Room-name font in map units at unit=1. Height-limited Gifu home view (1440×900
 *  preview canvas) uses meet-scale ≈ 0.727, so 25×unit ≈ 18 CSS px. */
export const LABEL_FONT_SIZE = 25;

/** Minimum on-screen glyph size for 2D room names at overview and when zoomed in. */
export const LABEL_MIN_SCREEN_PX = 18;

/** Line-height factor for overview collision stagger (map units × LABEL_FONT_SIZE × unit).
 *  2.4 × 18px home glyphs ≈ 43px, enough to fully separate 26px text bboxes. */
export const LABEL_STAGGER_LINE = 2.4;

/** Axis-aligned [left, top, right, bottom] overlap with padding in map units. */
export function rectsOverlap(a, b, padX = 3, padY = 2) {
  return a[0] < b[2] + padX && a[2] > b[0] - padX && a[1] < b[3] + padY && a[3] > b[1] - padY;
}

/** Candidate (dx, dy) offsets. Prefer north first so south-lobby names stay readable. */
export function labelStaggerOffsets(unit, force = false) {
  if (!force) return [[0, 0]];
  const dy = LABEL_FONT_SIZE * LABEL_STAGGER_LINE * unit;
  const dx = LABEL_FONT_SIZE * 2.6 * unit;
  return [
    [0, 0],
    [0, -dy], [0, dy],
    [dx, 0], [-dx, 0],
    [0, -2 * dy], [0, 2 * dy],
    [dx, -dy], [-dx, -dy], [dx, dy], [-dx, dy],
  ];
}

/** Label/icon size in map units. Inverse of map zoom, applied on every zoom (not on a later click).
 *  Room names use LABEL_FONT_SIZE×unit (≥ LABEL_MIN_SCREEN_PX on the Gifu home canvas).
 *  Zooming in keeps that on-screen size (map units shrink with the viewBox);
 *  zooming out still grows map units so overview text stays readable. */
export function mapLabelUnit(pageSize = DEFAULT_PDF_SIZE, viewWidth) {
  const [w, h] = pageSizeOf({ pdfSize: pageSize });
  const base = Math.max(0.35, Math.min(w, h) / 800);
  const homeWidth = homeViewFor(pageSize)[2];
  const current = Number(viewWidth);
  const width = current > 0 && Number.isFinite(current) ? current : homeWidth;
  const ratio = width / homeWidth;
  const inverse = base * Math.pow(ratio, LABEL_MAP_ZOOM_POWER);
  const minReadable = base * ratio * LABEL_MIN_SCREEN_RATIO;
  return Math.min(base * 2.4, Math.max(minReadable, inverse));
}

/** CSS overlay scale for 3D labels. cameraZoom > 1 is zoomed in.
 *  Matches 2D on-screen size: ~ zoom^(1 - LABEL_MAP_ZOOM_POWER), clamped to a readable floor. */
export function overlayLabelScale(cameraZoom = 1) {
  const z = Number(cameraZoom);
  const zoom = Number.isFinite(z) && z > 0 ? z : 1;
  return Math.max(LABEL_MIN_SCREEN_RATIO, Math.min(1.6, Math.pow(zoom, 1 - LABEL_MAP_ZOOM_POWER)));
}

/** Same relative margins as the Gifu demo home view on 800×1210. */
export function homeViewFor(pageSize = DEFAULT_PDF_SIZE) {
  const [w, h] = pageSizeOf({ pdfSize: pageSize });
  return [w * (38 / 800), h * (12 / 1210), w * (776 / 800), h * (835 / 1210)];
}

/** Fit the working crop / building outline; used for generated floors. */
export function homeViewForBoundary(boundary, pageSize = DEFAULT_PDF_SIZE) {
  const size = pageSizeOf({ pdfSize: pageSize });
  if (!Array.isArray(boundary) || boundary.length < 3) return homeViewFor(size);
  const xs = boundary.map(p => p[0] * size[0]);
  const ys = boundary.map(p => p[1] * size[1]);
  const x = Math.min(...xs), y = Math.min(...ys), X = Math.max(...xs), Y = Math.max(...ys);
  if (!(X > x) || !(Y > y)) return homeViewFor(size);
  const padX = Math.max(8, (X - x) * 0.06), padY = Math.max(8, (Y - y) * 0.06);
  return [x - padX, y - padY, (X - x) + 2 * padX, (Y - y) + 2 * padY];
}

/** True when buildingBoundary is the manual crop/page rectangle, not a PDF vector outline. */
export function isManualCropBoundary(boundary, pageSize = DEFAULT_PDF_SIZE, cropSize = null, tol = 2.5) {
  const size = pageSizeOf({ pdfSize: pageSize });
  if (!Array.isArray(boundary) || boundary.length < 4 || boundary.length > 5) return false;
  const points = boundary.map(p => [p[0] * size[0], p[1] * size[1]]);
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const minx = Math.min(...xs), maxx = Math.max(...xs);
  const miny = Math.min(...ys), maxy = Math.max(...ys);
  const axis = points.every(p => Math.min(Math.abs(p[0] - minx), Math.abs(p[0] - maxx)) <= tol
    && Math.min(Math.abs(p[1] - miny), Math.abs(p[1] - maxy)) <= tol);
  if (!axis) return false;
  const width = maxx - minx, height = maxy - miny;
  if (minx <= tol && miny <= tol && Math.abs(maxx - size[0]) <= tol && Math.abs(maxy - size[1]) <= tol) {
    return true;
  }
  if (cropSize && cropSize.length >= 2) {
    return Math.abs(width - cropSize[0]) <= 4 && Math.abs(height - cropSize[1]) <= 4;
  }
  return false;
}

export function normalizeCrop(crop, pageSize = DEFAULT_PDF_SIZE) {
  const [w, h] = pageSizeOf({ pdfSize: pageSize });
  if (!crop) return { x: 0, y: 0, width: w, height: h };
  const x = Number(crop.x), y = Number(crop.y), width = Number(crop.width), height = Number(crop.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    throw new Error('crop must use finite x/y/width/height with positive size');
  }
  if (x < -1e-6 || y < -1e-6 || x + width > w + 1e-6 || y + height > h + 1e-6) {
    throw new Error('crop must lie inside the original page');
  }
  return { x, y, width, height };
}

export function normalizeRotation(rotation = 0) {
  const turns = ((Number(rotation) % 360) + 360) % 360;
  if (![0, 90, 180, 270].includes(turns)) throw new Error('rotation must be 0, 90, 180, or 270');
  return turns;
}

/** Size of the axis-aligned raster after cropping, then rotating clockwise. */
export function rasterSizeFor(pageSize, crop = null, rotation = 0) {
  const box = normalizeCrop(crop, pageSize);
  const turns = normalizeRotation(rotation);
  return turns === 90 || turns === 270 ? [box.height, box.width] : [box.width, box.height];
}

// Clockwise rotation of a point inside a w×h rectangle around the page/crop content.
function rotateCW(x, y, w, h, turns) {
  switch (turns) {
    case 0: return [x, y];
    case 90: return [h - y, x];
    case 180: return [w - x, h - y];
    case 270: return [y, w - x];
    default: throw new Error('rotation must be 0, 90, 180, or 270');
  }
}

function unrotateCW(x, y, w, h, turns) {
  // Inverse of rotateCW for the same content width/height before rotation.
  switch (turns) {
    case 0: return [x, y];
    case 90: return [y, h - x];
    case 180: return [w - x, h - y];
    case 270: return [w - y, x];
    default: throw new Error('rotation must be 0, 90, 180, or 270');
  }
}

/**
 * Pixel on the working raster (crop applied, then clockwise rotation) →
 * normalized point on the original full page.
 */
export function renderPixelToNormalized(pixel, draftPage) {
  const pageSize = pageSizeOf({ pdfSize: draftPage.originalSize });
  const crop = normalizeCrop(draftPage.crop, pageSize);
  const turns = normalizeRotation(draftPage.rotation ?? 0);
  const [rw, rh] = draftPage.pixelSize || rasterSizeFor(pageSize, crop, turns);
  if (!(rw > 0) || !(rh > 0)) throw new Error('pixelSize required');

  const [rasterW, rasterH] = rasterSizeFor(pageSize, crop, turns);
  const xRot = (pixel[0] / rw) * rasterW;
  const yRot = (pixel[1] / rh) * rasterH;
  const [xLocal, yLocal] = unrotateCW(xRot, yRot, crop.width, crop.height, turns);
  return toNormalized([crop.x + xLocal, crop.y + yLocal], pageSize);
}

/** Normalized original-page point → pixel on the working raster. */
export function normalizedToRenderPixel(normalized, draftPage) {
  const pageSize = pageSizeOf({ pdfSize: draftPage.originalSize });
  const crop = normalizeCrop(draftPage.crop, pageSize);
  const turns = normalizeRotation(draftPage.rotation ?? 0);
  const [rw, rh] = draftPage.pixelSize || rasterSizeFor(pageSize, crop, turns);
  if (!(rw > 0) || !(rh > 0)) throw new Error('pixelSize required');

  const [pageX, pageY] = toPageUnits(normalized, pageSize);
  const xLocal = pageX - crop.x;
  const yLocal = pageY - crop.y;
  const [xRot, yRot] = rotateCW(xLocal, yLocal, crop.width, crop.height, turns);
  const [rasterW, rasterH] = rasterSizeFor(pageSize, crop, turns);
  return [(xRot / rasterW) * rw, (yRot / rasterH) * rh];
}

export function createMapDraft({
  id,
  fileName,
  sha256,
  byteLength,
  pageIndex = 1,
  originalSize,
  rotation = 0,
  crop = null,
  pixelSize = null,
} = {}) {
  const size = pageSizeOf({ pdfSize: originalSize });
  const turns = normalizeRotation(rotation);
  const box = crop ? normalizeCrop(crop, size) : null;
  return {
    schemaVersion: 'draft-1.0.0',
    id,
    revision: 1,
    sourceFile: { sha256, fileName, byteLength },
    page: {
      index: pageIndex,
      originalSize: size,
      rotation: turns,
      crop: box,
      pixelSize: pixelSize || rasterSizeFor(size, box, turns),
    },
    candidates: { rooms: [], corridors: [], labels: [], doors: [] },
    edits: { renamedPois: {}, renamedRooms: {}, facilityIcons: [], polygonOverrides: {}, maskStrokes: [], confirmedIds: [] },
    pending: [],
    mapDocument: null,
  };
}

/**
 * Attach draft provenance onto a compatible MapDocument without changing
 * the normalized original-page coordinate basis.
 */
export function draftToMapDocument(draft, partialDocument) {
  if (!draft || draft.schemaVersion !== 'draft-1.0.0') {
    throw new Error('draft schemaVersion must be draft-1.0.0');
  }
  if (!partialDocument) throw new Error('partial MapDocument content is required');
  const originalSize = pageSizeOf({ pdfSize: draft.page.originalSize });
  return {
    ...partialDocument,
    schemaVersion: '1.0.0',
    source: {
      ...partialDocument.source,
      pdfSha256: draft.sourceFile.sha256,
      page: draft.page.index,
      pdfSize: originalSize,
    },
  };
}

export function assertCompatibleMapDocument(doc) {
  if (doc?.schemaVersion !== '1.0.0') throw new Error('MapDocument schemaVersion must be 1.0.0');
  pageSizeOf(doc);
  const system = doc.graph?.coordinateSystem;
  if (system && system !== 'normalized-top-left') {
    throw new Error('coordinateSystem must remain normalized-top-left');
  }
  return doc;
}

// Tabler Icons 3.31.0 outline subset, MIT. Source copies live in assets/vendor/tabler-icons/.
import { LABEL_FONT_SIZE } from './map-coords.js';

const NS = 'http://www.w3.org/2000/svg';
const PATHS = {
  entrance: ['M13 12v.01', 'M3 21h18', 'M5 21v-16a2 2 0 0 1 2 -2h6m4 10.5v7.5', 'M21 7h-7m3 -3l-3 3l3 3'],
  restroom: ['M3 5m0 2a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2z', 'M6.5 9l.5 6l2 -4l2 4l.5 -6', 'M17 10.5a1.5 1.5 0 0 0 -3 0v3a1.5 1.5 0 0 0 3 0'],
  'accessible-restroom': ['M8 16m-5 0a5 5 0 1 0 10 0a5 5 0 1 0 -10 0', 'M19 19m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M19 17a3 3 0 0 0 -3 -3h-3.4', 'M3 3h1a2 2 0 0 1 2 2v6', 'M6 8h11', 'M15 8v6'],
  elevator: ['M5 4m0 1a1 1 0 0 1 1 -1h12a1 1 0 0 1 1 1v14a1 1 0 0 1 -1 1h-12a1 1 0 0 1 -1 -1z', 'M10 10l2 -2l2 2', 'M10 14l2 2l2 -2'],
  stairs: ['M22 5h-5v5h-5v5h-5v5h-5'],
  escalator: ['M19.5 5h-2.672a2 2 0 0 0 -1.414 .586l-8.414 8.414h-2.5a2.5 2.5 0 1 0 0 5h3.672a2 2 0 0 0 1.414 -.586l8.414 -8.414h1.5a2.5 2.5 0 0 0 0 -5z'],
  pharmacy: ['M8 8v-2a2 2 0 0 1 2 -2h4a2 2 0 0 1 2 2v2', 'M4 8m0 2a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z', 'M10 14h4', 'M12 12v4'],
  shop: ['M6.331 8h11.339a2 2 0 0 1 1.977 2.304l-1.255 8.152a3 3 0 0 1 -2.966 2.544h-6.852a3 3 0 0 1 -2.965 -2.544l-1.255 -8.152a2 2 0 0 1 1.977 -2.304z', 'M9 11v-5a3 3 0 0 1 6 0v5'],
  reception: ['M3 6h18', 'M4 6v13', 'M20 19v-13', 'M4 10h16', 'M15 6v8a2 2 0 0 0 2 2h3'],
  service: ['M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0', 'M12 9h.01', 'M11 12h1v4h1'],
};

export const FACILITY_ICON_SET = 'Tabler Icons';
export const FACILITY_ICON_LICENSE = 'MIT';

/** Map-unit sizes at unit=1. Badge is large enough for a readable Tabler glyph. */
export const FACILITY_BADGE_RADIUS = 12;
export const FACILITY_ICON_SIZE = 18;
export const FACILITY_LABEL_GAP = 10;
export const FACILITY_LABEL_HEIGHT = LABEL_FONT_SIZE;

/** Overlay CSS px for 3D HTML facility markers. */
export const FACILITY_SCENE_BADGE = 28;
export const FACILITY_SCENE_ICON = 20;
export const FACILITY_SCENE_GAP = 8;

function chipTextWidth(name, unit) {
  return Math.min(LABEL_FONT_SIZE * 17, Math.max(LABEL_FONT_SIZE * 2, [...String(name)].length * LABEL_FONT_SIZE)) * unit;
}

export function facilityIconKey(category) {
  if (category === 'accessible-restroom') return 'accessible-restroom';
  return PATHS[category] ? category : 'service';
}

export function createFacilityIconSvg(category, attrs = {}) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', attrs.className || 'facility-icon-svg');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', attrs.stroke || 'currentColor');
  svg.setAttribute('stroke-width', attrs.strokeWidth || '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  if (attrs.width) svg.setAttribute('width', attrs.width);
  if (attrs.height) svg.setAttribute('height', attrs.height);
  for (const d of PATHS[facilityIconKey(category)] || PATHS.service) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

export function drawFacilityIcon(parent, category, { x, y, size = 16, stroke = '#fff', strokeWidth = 2.2 } = {}) {
  const group = document.createElementNS(NS, 'g');
  group.setAttribute('class', 'facility-mark');
  group.setAttribute('transform', `translate(${x - size / 2} ${y - size / 2}) scale(${size / 24})`);
  group.setAttribute('fill', 'none');
  group.setAttribute('stroke', stroke);
  group.setAttribute('stroke-width', String(strokeWidth));
  group.setAttribute('stroke-linecap', 'round');
  group.setAttribute('stroke-linejoin', 'round');
  for (const d of PATHS[facilityIconKey(category)] || PATHS.service) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    group.append(path);
  }
  parent.append(group);
  return group;
}

export function decorateFacilityButtons(root = document) {
  root.querySelectorAll('[data-category]').forEach(button => {
    const slot = button.querySelector('[data-facility-icon], span[aria-hidden="true"], .icon-wc');
    if (!slot) return;
    slot.replaceChildren(createFacilityIconSvg(button.dataset.category));
  });
}

export function isFacilityPoi(poi) {
  return !!poi && !['department', 'room', 'office'].includes(poi.category);
}

export function facilityChipBox(x, y, unit, name, showText) {
  const r = FACILITY_BADGE_RADIUS * unit;
  const halfH = Math.max(r, FACILITY_LABEL_HEIGHT * unit / 2);
  if (!showText) return { left: x - r, right: x + r, top: y - r, bottom: y + r };
  const textWidth = chipTextWidth(name, unit);
  const gap = FACILITY_LABEL_GAP * unit;
  return { left: x - r, right: x + r + gap + textWidth, top: y - halfH, bottom: y + halfH };
}

/** Circle + Tabler mark; name sits to the right with a gap so it never covers the glyph. */
export function drawFacilityChip(parent, {
  x, y, unit = 1, category, name = '', color = '#6a9295', selected = false, showText = false,
} = {}) {
  const r = FACILITY_BADGE_RADIUS * unit;
  const circle = document.createElementNS(NS, 'circle');
  circle.setAttribute('cx', String(x));
  circle.setAttribute('cy', String(y));
  circle.setAttribute('r', String(r));
  circle.setAttribute('fill', color);
  circle.setAttribute('stroke', selected ? '#24634b' : '#fff');
  circle.setAttribute('stroke-width', selected ? '1.8' : '1.5');
  parent.append(circle);
  drawFacilityIcon(parent, category, { x, y, size: FACILITY_ICON_SIZE * unit, stroke: '#fff', strokeWidth: 1.9 });
  if (!showText) return facilityChipBox(x, y, unit, name, false);
  const textWidth = chipTextWidth(name, unit);
  const gap = FACILITY_LABEL_GAP * unit;
  const tx = x + r + gap;
  const text = document.createElementNS(NS, 'text');
  text.setAttribute('x', String(tx + textWidth / 2));
  text.setAttribute('y', String(y + LABEL_FONT_SIZE * 0.32 * unit));
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('font-size', String(LABEL_FONT_SIZE * unit));
  text.setAttribute('fill', selected ? '#24634b' : '#3e4d53');
  text.setAttribute('font-weight', selected ? '700' : '500');
  text.setAttribute('class', 'facility-chip-label');
  text.textContent = name;
  parent.append(text);
  return facilityChipBox(x, y, unit, name, true);
}

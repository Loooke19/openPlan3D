// Shared semantic palette and label catalog for both map renderers.
import { facilityChipBox, isFacilityPoi } from './facility-icons.js';
import {
  LABEL_FONT_SIZE, LABEL_STAGGER_LINE, labelStaggerOffsets, mapLabelUnit,
  pageSizeOf, rectsOverlap, toPageUnits,
} from './map-coords.js';
const colors={'curve-3':'#dce7ee','curve-5':'#dce7ee','curve-1':'#e7e3ee','curve-9':'#dce8df','curve-11':'#e6e4ea','curve-13':'#e7e2ef','curve-14':'#e4dfee','curve-17':'#eee5d5','curve-18':'#dfe5ef','curve-19':'#f0e4d3','curve-21':'#eee3ce','curve-23':'#eee3ce','rect-13':'#e7dfea','rect-29':'#dfe8ec','rect-9':'#ede3cf'};
/** Soft hospital-map presets for the editor color desk. */
export const ROOM_COLOR_PRESETS=[
  {id:'sage',hex:'#dce8df',label:'浅绿'},
  {id:'sky',hex:'#dce7ee',label:'浅蓝'},
  {id:'lilac',hex:'#e7e3ee',label:'浅紫'},
  {id:'sand',hex:'#eee5d5',label:'浅沙'},
  {id:'peach',hex:'#f0e4d3',label:'浅杏'},
  {id:'mint',hex:'#cbdedc',label:'薄荷'},
  {id:'court',hex:'#dbe7d4',label:'庭院绿'},
  {id:'stone',hex:'#e9e7e4',label:'石色'},
];
export function normalizeHexColor(value){
  let text=String(value||'').trim();
  if(!text)return '';
  if(text[0]==='#')text=text.slice(1);
  if(/^[0-9a-fA-F]{3}$/.test(text))text=[...text].map(ch=>ch+ch).join('');
  if(!/^[0-9a-fA-F]{6}$/.test(text))return '';
  return `#${text.toLowerCase()}`;
}
export function roomColor(o,_doc){
  const override=normalizeHexColor(o?.fillColor);
  if(override)return override;
  if(o.kind==='courtyard')return '#dbe7d4';
  if(['elevator','escalator','stairs'].includes(o.kind))return '#d2e4eb';
  if(colors[o.id])return colors[o.id];
  if(Array.isArray(o.color)&&o.color.length>=3){
    const luma=0.2126*(Number(o.color[0])||0)+0.7152*(Number(o.color[1])||0)+0.0722*(Number(o.color[2])||0);
    if(luma<=0.35)return '#e9e7e4';
    const to=v=>Math.round(Math.min(1,Math.max(0,Number(v)||0))*255).toString(16).padStart(2,'0');
    return `#${to(o.color[0])}${to(o.color[1])}${to(o.color[2])}`;
  }
  if(o.kind==='counter'||o.color?.[0]===0)return '#cbdedc';
  return '#e9e7e4';
}
export function facilityCategory(p){
  if(p.category==='accessible-restroom')return 'restroom';
  return ['entrance','restroom','stairs','elevator','escalator'].includes(p.category)?p.category:'service';
}
export const facilitySymbol=c=>({entrance:'→',restroom:'WC',stairs:'↗',elevator:'↕',escalator:'↗',service:'i'})[c]||'i';
export const facilityColor=c=>({entrance:'#ec9d42',restroom:'#5299c8',stairs:'#d58479',elevator:'#67adbb',escalator:'#a996bf',service:'#d86d4f'})[c]||'#6a9295';
const shortNames={'department-endoscopy':'内窥镜检查中心','department-radiology':'放射线部','department-mri':'核磁共振','shop-convenience':'便利店','shop-cafe':'咖啡店','service-registration-payment':'挂号 · 缴费','service-patient-consultation':'患者咨询窗口','pharmacy-day-counter':'取药窗口','pharmacy-after-hours':'夜间药房','entrance-main':'主入口','entrance-south':'南侧入口'};
export function displayPois(doc){return doc.pois.map(p=>({...p,displayName:shortNames[p.id]||p.name,displayPosition:p.category==='entrance'?p.position:(p.labelPosition||p.position),major:['department','room','office','shop'].includes(p.category)||['admission-center','service-registration-payment','service-information','service-patient-consultation'].includes(p.id)}));}
export function poiForRoom(doc, roomId){
  const pois=doc?.pois||[];
  if(!roomId)return null;
  return pois.find(p=>p.roomId===roomId&&p.nodeId)
    ||pois.find(p=>p.id===`room-${roomId}`&&p.nodeId)
    ||pois.find(p=>p.roomId===roomId)
    ||pois.find(p=>p.id===`room-${roomId}`)
    ||null;
}
export function matchesFilter(p,category,term=''){return(category==='all'||facilityCategory(p)===category)&&p.name.toLowerCase().includes(term.toLowerCase());}

export function mapPoiLabelRect(poi, x, y, unit, showText) {
  const name = poi.displayName || poi.name;
  if (isFacilityPoi(poi)) {
    const box = facilityChipBox(x, y, unit, name, showText);
    return [box.left, box.top, box.right, box.bottom];
  }
  const halfW = (Math.min(LABEL_FONT_SIZE * 17, [...String(name)].length * LABEL_FONT_SIZE) * unit) / 2;
  const halfH = LABEL_FONT_SIZE * 0.55 * unit;
  return [x - halfW, y - halfH, x + halfW, y + halfH];
}

/** Place 2D map names. Majors stagger instead of stacking when boxes collide. */
export function layoutMapLabels(pois, {
  pageSize,
  viewWidth,
  category = 'all',
  term = '',
  selectedIds = [],
} = {}) {
  const size = pageSizeOf({ pdfSize: pageSize });
  const unit = mapLabelUnit(size, viewWidth);
  const selected = id => selectedIds.has?.(id) || (Array.isArray(selectedIds) && selectedIds.includes(id));
  const visible = pois.filter(p => matchesFilter(p, category, term)
    && (category !== 'all' || term || selected(p.id) || p.major || facilityCategory(p) !== 'service' || p.category === 'pharmacy'))
    .sort((a, b) => Number(selected(b.id)) - Number(selected(a.id)) || Number(b.major) - Number(a.major));
  const occupied = [];
  const placed = [];
  for (const poi of visible) {
    const [bx, by] = toPageUnits(poi.displayPosition, size);
    const textLabel = poi.major || !!term || selected(poi.id);
    const force = selected(poi.id) || poi.major;
    const offsets = labelStaggerOffsets(unit, force);
    const padY = Math.max(4, LABEL_FONT_SIZE * 0.16 * unit);
    let chosen = null;
    for (const [ox, oy] of offsets) {
      const rect = mapPoiLabelRect(poi, bx + ox, by + oy, unit, textLabel);
      if (!occupied.some(r => rectsOverlap(rect, r, 3, padY))) {
        chosen = { ox, oy, rect };
        break;
      }
    }
    if (!chosen) {
      if (!force) continue;
      const [ox, oy] = offsets[1] || [0, -LABEL_FONT_SIZE * LABEL_STAGGER_LINE * unit];
      chosen = { ox, oy, rect: mapPoiLabelRect(poi, bx + ox, by + oy, unit, textLabel) };
    }
    occupied.push(chosen.rect);
    placed.push({
      poi, x: bx + chosen.ox, y: by + chosen.oy, ox: chosen.ox, oy: chosen.oy,
      rect: chosen.rect, facility: isFacilityPoi(poi), textLabel, unit,
    });
  }
  return placed;
}

/** Room polygon to tint in 2D edit when a place or unnamed room is selected. */
export function obstacleForSelection(selectedId, place, obstacles=[]){
  if(!selectedId)return null;
  const rooms=obstacles||[];
  if(place?.roomId)return rooms.find(item=>item.id===place.roomId)||null;
  if(String(selectedId).startsWith('room-')){
    return rooms.find(item=>item.id===String(selectedId).slice(5))||null;
  }
  return null;
}

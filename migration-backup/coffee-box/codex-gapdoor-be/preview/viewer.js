import {findRoute,findRouteVia,routePolyline,routeArrows,ROUTE_ARROW_SPACING,ROUTE_ARROW_SPEED,MAX_WAYPOINTS,buildVerticalLinks,buildMultiFloorGraph,findCrossFloorRoute,splitRouteByFloor,FLOOR_SEP,splitPolylineNearPoint} from './routing.js';
import {createNavMarkerController,formatNavEta} from './nav-marker.js';
import {roomColor,displayPois,facilityCategory,facilityColor,matchesFilter,layoutMapLabels,poiForRoom} from './map-art.js';
import {createFacilityIconSvg,decorateFacilityButtons,drawFacilityChip,facilityIconKey} from './facility-icons.js';
import {APPEARANCE_DEFAULTS,APPEARANCE_SLIDERS,sanitizeAppearance} from './appearance.js';
import {pageSizeOf,homeViewFor,homeViewForBoundary,toNormalized,mapLabelUnit,DEFAULT_PDF_SIZE,LABEL_FONT_SIZE} from './map-coords.js';
import {createNotifier} from './status.js';
export {findRoute,findRouteVia,MAX_WAYPOINTS,buildVerticalLinks,buildMultiFloorGraph,findCrossFloorRoute,splitRouteByFloor} from './routing.js';
export {pageSizeOf,homeViewFor,homeViewForBoundary,toNormalized,mapLabelUnit,createMapDraft,draftToMapDocument,renderPixelToNormalized,normalizedToRenderPixel} from './map-coords.js';
const $=id=>document.getElementById(id),svg=$('map'),NS='http://www.w3.org/2000/svg';
const BUILTIN_FLOOR={key:'gifu-1f',id:'1F',code:'01',name:'一楼',description:'门诊与公共服务',url:'../data/map.json',builtin:true};
const BUILTIN_FLOOR_2F={key:'gifu-2f-demo',id:'2F',code:'02',name:'二楼（演示）',description:'跨楼层导航演示层',url:null,builtin:true,synthetic:true};
let pageSize=[...DEFAULT_PDF_SIZE];
let doc,edges,poiIndex,labels,scene,scenePending,view=homeViewFor(pageSize),mode='3d',category='all';
let blocked=new Set(),scale=null,scalePoints=[],choosingScale=false,drag=null,moved=false,route=null,walking=false,waypoints=[];
let focusId=null;
let mapGeneration=0,activeFloorKey=BUILTIN_FLOOR.key,projectFloors=[],activeInstitutionName='';
let floorDocCache=new Map();
let multiGraph=null,verticalLinks=[],floorSegments=[],routeIsCrossFloor=false;
/** True while a real institution is selected but has no ready floor map yet. */
let institutionMapPending=false;
let navSimulating=false,markerPoint=null,markerEta=null;
let routeArrowPhase=0,routeArrowRaf=0,routeArrowLast=0;
const navMarker=createNavMarkerController({
  onUpdate:point=>{
    markerPoint=point;
    if(point?.floorId&&point.floorId!==floorMeta().id){
      const target=floorCatalog().find(f=>f.id===point.floorId);
      if(target)switchFloor(target,{fromNav:true});
    }else{
      updateNavMarkerVisual();
    }
  },
  onFloorChange:()=>{},
  onTip:tip=>{if(tip)$('route-message').textContent=tip;},
  onProgress:(p,_point,meta)=>{
    $('walk-progress').textContent=`${Math.round(p*100)}%`;
    if($('walk-seek'))$('walk-seek').value=p*100;
    const rem=meta?.remainingMapUnits??navMarker.remainingMapUnits();
    markerEta=formatNavEta(rem,scale?.metersPerMapUnit);
  },
  onComplete:()=>{navSimulating=false;walkControls();$('walk-progress').textContent='已到达';markerPoint=null;markerEta=null;scene?.setRouteTravel?.([], [], false);paintRouteLines();paintRouteArrows();updateNavMarkerVisual();notify('已到达目的地');},
});
let appearance=sanitizeAppearance();
try{appearance=sanitizeAppearance(JSON.parse(localStorage.getItem('hospital-appearance-v1')));}catch{}
function applyAppearance(persist=false){
  document.documentElement.style.setProperty('--accent',appearance.accent);
  const rgb=appearance.accent.slice(1).match(/../g).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
  document.documentElement.style.setProperty('--accent-text',rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722>.179?'#18251e':'#ffffff');
  scene?.setAppearance(appearance);
  if(persist)try{localStorage.setItem('hospital-appearance-v1',JSON.stringify(appearance));}catch{notify('外观已应用，但无法保存到浏览器。');}
}
function buildAppearanceControls(){
  const host=$('appearance-controls');host.replaceChildren();
  for(const [key,title,min,max,step] of [['accent','主色（界面与路线）'],['wall','墙面底色'],['floor','走廊地面底色'],...APPEARANCE_SLIDERS]){
    const label=document.createElement('label');label.htmlFor=`appearance-${key}`;label.textContent=title;
    const output=document.createElement('output');output.textContent=appearance[key];label.append(output);
    const input=document.createElement('input');input.id=label.htmlFor;input.type=min===undefined?'color':'range';
    if(min!==undefined){input.min=min;input.max=max;input.step=step;}input.value=appearance[key];
    input.oninput=()=>{appearance=sanitizeAppearance({...appearance,[key]:input.type==='color'?input.value:Number(input.value)});output.textContent=appearance[key];applyAppearance(true);};
    host.append(label,input);
  }
}
buildAppearanceControls();applyAppearance();
$('appearance-reset').onclick=()=>{appearance={...APPEARANCE_DEFAULTS};buildAppearanceControls();applyAppearance(true);};
const key=()=>`hospital-map:${doc?.id||doc?.source?.pdfSha256||'unknown'}`;
const notify=createNotifier($('status'));
function dismissLoading(){
  const el=$('loading');
  if(!el||el.hidden)return;
  el.classList.add('is-done');
  setTimeout(()=>{el.hidden=true;},260);
}
function escapeHtml(text){
  return String(text??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
function isBuiltin(data=doc){return data?.id==='gifu-1f';}
function floorMeta(data=doc){
  if(!data)return {id:'',code:'—',name:'待导入图纸',description:'请先上传 PDF 并生成 3D'};
  if(data?.floor?.id)return data.floor;
  if(isBuiltin(data))return {id:'1F',code:'01',name:'一楼',description:'门诊与公共服务'};
  return {id:data?.floorId||'1F',code:String(data?.source?.page||1).padStart(2,'0'),name:data?.name||'本层',description:''};
}
function viewForDoc(data){
  const size=pageSizeOf(data);
  return isBuiltin(data)?homeViewFor(size):homeViewForBoundary(data.geometry?.buildingBoundary,size);
}
function defaultStartId(){
  const entrance=doc.pois.find(p=>p.category==='entrance'&&p.nodeId);
  if(entrance)return entrance.id;
  if(poiIndex.has('entrance-main'))return 'entrance-main';
  return doc.pois.find(p=>p.nodeId)?.id||'';
}
function floorCatalog(){
  // Empty / draft institutions: never fall back to the Gifu demo floors.
  if(institutionMapPending)return [...projectFloors];
  // Institution maps are isolated: never mix Gifu demo 1F / synthetic 2F into them.
  if(projectFloors.length)return [...projectFloors];
  const builtin2=floorDocCache.has(BUILTIN_FLOOR_2F.key)?[BUILTIN_FLOOR_2F]:[];
  return [BUILTIN_FLOOR,...builtin2];
}
function purgeBuiltinFloorCache(){
  floorDocCache.delete(BUILTIN_FLOOR.key);
  floorDocCache.delete(BUILTIN_FLOOR_2F.key);
}
function floorKeyFor(data){
  if(data?.id==='gifu-2f-demo'||data?.floorId==='2F'&&data?.id?.includes?.('gifu-2f'))return BUILTIN_FLOOR_2F.key;
  if(isBuiltin(data))return BUILTIN_FLOOR.key;
  const projectId=data.source?.projectId;
  const floorId=data.floor?.id||data.floorId;
  return projectId&&floorId?`${projectId}:${floorId}`:data.id;
}
function poiRef(floorId,poiId){return `${floorId}${FLOOR_SEP}${poiId}`;}
function parsePoiRef(ref){
  if(!ref||typeof ref!=='string')return null;
  const i=ref.indexOf(FLOOR_SEP);
  if(i<=0)return {floorId:floorMeta().id,poiId:ref};
  return {floorId:ref.slice(0,i),poiId:ref.slice(i+FLOOR_SEP.length)};
}
function cloneAsDemoFloor2(source){
  const clone=structuredClone(source);
  clone.id='gifu-2f-demo';
  clone.floorId='2F';
  clone.floor={id:'2F',code:'02',name:'二楼（演示）',description:'跨楼层导航演示 · 与一楼竖向设施对齐'};
  clone.name='岐阜大学医院 · 二楼（演示）';
  for(const poi of clone.pois||[]){
    poi.floorId='2F';
    if(poi.category==='entrance'&&/入口|大门/.test(poi.name||''))poi.name=`${poi.name.replace(/一楼|1楼|1F/g,'').trim()||poi.name}（2F）`;
  }
  clone.notes=[...(clone.notes||[]),'演示用二楼：几何克隆自一楼，电梯/楼梯与一楼对齐以验证跨层路由。'];
  return clone;
}
function cacheFloorDoc(data){
  const key=floorKeyFor(data);
  const floorId=data.floor?.id||data.floorId||(isBuiltin(data)?'1F':'1F');
  floorDocCache.set(key,{key,floorId,doc:data});
  return key;
}
function rebuildMultiGraph(){
  const floors=[...floorDocCache.values()].map(entry=>({
    floorId:entry.floorId,
    pois:entry.doc.pois,
    graph:entry.doc.graph,
  }));
  verticalLinks=buildVerticalLinks(floors);
  multiGraph=floors.length>1?buildMultiFloorGraph(floors,verticalLinks):null;
}
function resolveEndpoint(ref){
  const parsed=parsePoiRef(ref);
  if(!parsed?.poiId)return null;
  for(const entry of floorDocCache.values()){
    if(entry.floorId!==parsed.floorId)continue;
    const poi=entry.doc.pois.find(p=>p.id===parsed.poiId);
    if(poi)return {floorId:entry.floorId,floorKey:entry.key,poi,doc:entry.doc};
  }
  // Fallback: current floor bare id
  const local=poiIndex.get(parsed.poiId);
  if(local)return {floorId:floorMeta().id,floorKey:activeFloorKey,poi:local,doc};
  return null;
}
function allNavigablePois(){
  const list=[];
  for(const entry of floorDocCache.values()){
    const code=entry.doc.floor?.code||entry.floorId;
    for(const p of entry.doc.pois){
      if(!p.nodeId)continue;
      list.push({
        ref:poiRef(entry.floorId,p.id),
        floorId:entry.floorId,
        label:floorDocCache.size>1?`[${code}] ${p.name}`:p.name,
        poi:p,
      });
    }
  }
  return list;
}
function multiClosed(){
  const closed=new Set();
  for(const entry of floorDocCache.values()){
    for(const id of blocked)closed.add(`${entry.floorId}${FLOOR_SEP}${id}`);
  }
  return closed;
}
function currentFloorPolyline(){
  if(!route)return [];
  if(!routeIsCrossFloor||!floorSegments.length)return routePolyline(route);
  const floorId=floorMeta().id;
  const seg=floorSegments.find(s=>s.floorId===floorId);
  return seg?.polyline||[];
}
/** Split current-floor route into traveled (gray) vs remaining (accent) while simulating. */
function currentRouteTravelSplit(){
  const poly=currentFloorPolyline();
  if(poly.length<2)return {traveled:[],remaining:poly};
  if(!navSimulating||!markerPoint)return {traveled:[],remaining:poly};
  const floorId=floorMeta().id;
  if(markerPoint.floorId!==floorId){
    if(routeIsCrossFloor&&floorSegments.length){
      const order=[];
      for(const seg of floorSegments){
        if(order.at(-1)!==seg.floorId)order.push(seg.floorId);
      }
      const mi=order.indexOf(markerPoint.floorId);
      const vi=order.indexOf(floorId);
      if(mi>=0&&vi>=0){
        if(vi<mi)return {traveled:poly,remaining:[]};
        if(vi>mi)return {traveled:[],remaining:poly};
      }
    }
    return {traveled:[],remaining:poly};
  }
  return splitPolylineNearPoint(poly,[markerPoint.x,markerPoint.y]);
}
function paintRouteLines(){
  svg.querySelector('#route-path')?.remove();
  if(!route)return;
  const g=element('g',{id:'route-path','pointer-events':'none'});
  const {traveled,remaining}=currentRouteTravelSplit();
  if(traveled.length>=2){
    element('polyline',{points:points(traveled),class:'route-traveled-halo'},g);
    element('polyline',{points:points(traveled),class:'route-traveled'},g);
  }
  if(remaining.length>=2){
    element('polyline',{points:points(remaining),class:'route-halo'},g);
    element('polyline',{points:points(remaining),class:'route-line'},g);
  }
}
function updateRouteTravelVisual(){
  if(mode==='2d'){
    paintRouteLines();
    paintRouteArrows();
  }
  if(mode==='3d'&&scene){
    const {traveled,remaining}=currentRouteTravelSplit();
    scene.setRouteTravel?.(traveled,remaining,navSimulating);
  }
}
function ensureNavEtaBubble(){
  let el=$('nav-eta-bubble');
  if(el)return el;
  const wrap=document.querySelector('.canvas-wrap');
  if(!wrap)return null;
  el=document.createElement('div');
  el.id='nav-eta-bubble';
  el.className='nav-eta-bubble';
  el.hidden=true;
  el.setAttribute('aria-live','polite');
  el.innerHTML='<div class="nav-eta-dist"></div><div class="nav-eta-time"></div>';
  wrap.append(el);
  return el;
}
function hideNavEtaBubble(){
  const el=$('nav-eta-bubble');
  if(el)el.hidden=true;
}
function updateNavEtaBubbleContent(el,eta){
  if(!el||!eta)return;
  el.querySelector('.nav-eta-dist').textContent=eta.distanceText;
  el.querySelector('.nav-eta-time').textContent=eta.durationText;
}
function updateNavMarkerVisual(){
  const unit=mapLabelUnit(pageSize, view[2]);
  svg.querySelector('#nav-marker-dot')?.remove();
  const onFloor=!!(markerPoint&&markerPoint.floorId===floorMeta().id);
  const eta=(navSimulating||onFloor)
    ? formatNavEta(navMarker.remainingMapUnits(),scale?.metersPerMapUnit)
    : null;
  if(onFloor&&mode==='2d'){
    const [x,y]=xy([markerPoint.x,markerPoint.y]);
    const heading=Number.isFinite(markerPoint.heading)?markerPoint.heading:0;
    const deg=heading*180/Math.PI;
    const g=element('g',{id:'nav-marker-dot','pointer-events':'none'});
    const body=element('g',{transform:`translate(${x} ${y}) rotate(${deg})`},g);
    element('circle',{cx:0,cy:0,r:11*unit,fill:'#2f7d5b',stroke:'#fff','stroke-width':2.5*unit,class:'nav-marker-core'},body);
    element('circle',{cx:0,cy:0,r:16*unit,fill:'none',stroke:'#379e7b','stroke-width':2*unit,opacity:.55,class:'nav-marker-ring'},body);
    const tip=8.5*unit,half=5*unit,back=3.5*unit;
    element('polygon',{
      points:`${tip},0 ${-back},${half} ${-back*.2},0 ${-back},${-half}`,
      fill:'#ffffff',
      class:'nav-marker-arrow',
    },body);
    if(eta){
      const bx=x+18*unit,by=y-36*unit;
      const bw=Math.max(118,eta.distanceText.length*7.4)*unit;
      const bh=36*unit;
      const bubble=element('g',{class:'nav-marker-bubble',transform:`translate(${bx} ${by})`},g);
      element('rect',{x:0,y:0,width:bw,height:bh,rx:5*unit,ry:5*unit,fill:'#242a30','fill-opacity':'0.88',class:'nav-marker-bubble-bg'},bubble);
      const t1=element('text',{x:8*unit,y:14*unit,fill:'#fff','font-size':11*unit,'font-family':'ui-sans-serif,system-ui,sans-serif'},bubble);
      t1.textContent=eta.distanceText;
      const t2=element('text',{x:8*unit,y:28*unit,fill:'#fff','font-size':11*unit,'font-family':'ui-sans-serif,system-ui,sans-serif'},bubble);
      t2.textContent=eta.durationText;
    }
    hideNavEtaBubble();
  }
  if(mode==='3d'&&scene){
    if(onFloor){
      const heading=Number.isFinite(markerPoint.heading)?markerPoint.heading:0;
      scene.setNavMarker([markerPoint.x,markerPoint.y],true,heading);
      const bubble=ensureNavEtaBubble();
      if(bubble&&eta){
        updateNavEtaBubbleContent(bubble,eta);
        const screen=scene.projectNavMarker?.();
        if(screen?.visible){
          bubble.hidden=false;
          bubble.style.transform=`translate(${screen.x+14}px,${screen.y-52}px)`;
        }else bubble.hidden=true;
      }else if(bubble)bubble.hidden=true;
    }else{
      scene.clearNavMarker?.();
      hideNavEtaBubble();
    }
  }else if(mode!=='2d'){
    hideNavEtaBubble();
  }
  if(navSimulating)updateRouteTravelVisual();
}
function updateFloorHeading(){
  const floor=floorMeta();
  if($('floor-number'))$('floor-number').textContent=floor.code||floor.id||'01';
  if($('floor-description'))$('floor-description').innerHTML=`${escapeHtml(floor.name||'本层')}<br>${escapeHtml(floor.description||(isBuiltin()?'门诊与公共服务':'自动生成 · 请核对'))}`;
  if($('hospital-subtitle')){
    if(institutionMapPending&&activeInstitutionName){
      $('hospital-subtitle').textContent=`${activeInstitutionName} · 待导入图纸`;
    }else if(isBuiltin())$('hospital-subtitle').textContent='岐阜大学医院 · 一楼导览';
    else if(activeInstitutionName)$('hospital-subtitle').textContent=`${activeInstitutionName} · ${floor.name||'导入楼层'} · 导览`;
    else $('hospital-subtitle').textContent=`${floor.name||'导入楼层'} · 导览`;
  }
  renderFloorSwitcher();
}
function renderFloorSwitcher(){
  const host=$('floor-switcher');
  if(!host)return;
  const floors=floorCatalog();
  host.replaceChildren();
  host.hidden=floors.length<2;
  for(const floor of floors){
    const button=document.createElement('button');
    button.type='button';
    button.className=floor.key===activeFloorKey?'is-active':'';
    button.dataset.floorKey=floor.key;
    button.setAttribute('aria-pressed',floor.key===activeFloorKey);
    button.innerHTML=`${escapeHtml(floor.code||floor.id)}<span>${escapeHtml(floor.name||'')}</span>`;
    button.onclick=()=>switchFloor(floor);
    host.append(button);
  }
}
export function setProjectFloors(project){
  activeInstitutionName=project
    ?(String(project.name||'').trim()
      ||String(project.sourceFile?.fileName||project.draft?.sourceFile?.fileName||'').replace(/\.pdf$/i,'').trim()
      ||'')
    :'';
  projectFloors=Object.values(project?.floors||{})
    .filter(floor=>floor?.status==='ready'&&floor.id)
    .sort((a,b)=>(a.pageIndex||0)-(b.pageIndex||0))
    .map(floor=>({
      key:`${project.id}:${floor.id}`,
      id:floor.id,
      code:floor.code||floor.id,
      name:floor.name||floor.id,
      description:floor.description||'',
      url:`/api/projects/${project.id}/map?floor=${encodeURIComponent(floor.id)}`,
      builtin:false,
    }));
  if(project){
    purgeBuiltinFloorCache();
    // Drop stale docs from other institutions so cross-floor routing stays local.
    const keep=new Set(projectFloors.map(floor=>floor.key));
    if(doc&&!isBuiltin(doc))keep.add(floorKeyFor(doc));
    for(const key of [...floorDocCache.keys()]){
      if(!keep.has(key))floorDocCache.delete(key);
    }
    rebuildMultiGraph();
    if(!projectFloors.length)institutionMapPending=true;
  }else{
    institutionMapPending=false;
  }
  renderFloorSwitcher();
  updateFloorHeading();
}

function ensureMapEmptyBanner(){
  let el=$('map-empty');
  if(el)return el;
  const area=document.querySelector('.map-area');
  if(!area)return null;
  el=document.createElement('div');
  el.id='map-empty';
  el.className='map-empty';
  el.hidden=true;
  el.innerHTML=`<strong class="map-empty-title">待导入图纸</strong><p class="map-empty-copy">该机构还没有地图。点右上角「导入图纸」上传 PDF，生成 3D 后再预览。</p>`;
  area.append(el);
  return el;
}

function setMapEmptyBanner(visible, title, copy){
  const el=ensureMapEmptyBanner();
  if(!el)return;
  el.hidden=!visible;
  document.querySelector('.map-area')?.classList.toggle('is-empty-institution', !!visible);
  if(title){
    const t=el.querySelector('.map-empty-title');
    if(t)t.textContent=title;
  }
  if(copy){
    const p=el.querySelector('.map-empty-copy');
    if(p)p.textContent=copy;
  }
}

/** Clear demo / previous map when an institution has no ready floors. */
export function showEmptyInstitutionView(message='待导入图纸'){
  mapGeneration+=1;
  institutionMapPending=true;
  try{stopNavSim();}catch{}
  try{stopWalk();}catch{}
  scene?.dispose?.();
  scene=null;
  scenePending=null;
  doc=null;
  labels=[];
  edges=new Map();
  poiIndex=new Map();
  floorDocCache.clear();
  rebuildMultiGraph();
  route=null;
  focusId=null;
  blocked=new Set();
  scale=null;
  waypoints=[];
  activeFloorKey='';
  if(svg)svg.replaceChildren();
  if($('scene3d'))$('scene3d').replaceChildren();
  if($('map'))$('map').classList.add('hidden');
  setMapEmptyBanner(true, message, '该机构还没有地图。点右上角「导入图纸」上传 PDF，生成 3D 后再预览。');
  if($('summary'))$('summary').textContent=`${activeInstitutionName||'当前机构'} · ${message}`;
  if($('poi-list'))$('poi-list').replaceChildren();
  if($('distance'))$('distance').textContent='';
  if($('route-message'))$('route-message').textContent='';
  if($('details'))$('details').textContent='';
  if($('selected-place-meta'))$('selected-place-meta').textContent='导入并生成地图后，可在此选择地点。';
  for(const id of ['start','end']){
    if(!$(id))continue;
    $(id).replaceChildren();
    if(id==='end')$(id).append(new Option('请选择目的地',''));
  }
  if($('simulate'))$('simulate').disabled=true;
  if($('walk-fp'))$('walk-fp').disabled=true;
  updateFloorHeading();
  dismissLoading();
}

/** Restore the built-in demo map (no institution selected). */
export async function restoreDemoMap(){
  institutionMapPending=false;
  activeInstitutionName='';
  projectFloors=[];
  setMapEmptyBanner(false);
  const generation=++mapGeneration;
  const response=await fetch('../data/map.json');
  if(!response.ok)throw Error(`地图读取失败：${response.status}`);
  if(mapGeneration!==generation)return;
  const data=await response.json();
  if(mapGeneration!==generation)return;
  await loadMapDocument(data);
}
let switchingFloor=false;
let preserveNavDuringFloorSwitch=false;
async function switchFloor(floor,{fromNav=false}={}){
  if(!floor||floor.key===activeFloorKey||switchingFloor)return;
  switchingFloor=true;
  preserveNavDuringFloorSwitch=fromNav;
  const host=$('floor-switcher'),area=document.querySelector('.map-area');
  const button=[...(host?.children||[])].find(item=>item.dataset.floorKey===floor.key);
  host?.classList.add('is-busy');
  area?.classList.add('is-loading');
  button?.setAttribute('aria-busy','true');
  if(!fromNav)notify('');
  try{
    const cached=floorDocCache.get(floor.key);
    if(cached?.doc){
      await loadMapDocument(cached.doc);
    }else if(floor.url){
      const data=await fetch(floor.url).then(async response=>{
        if(!response.ok)throw Error(`无法读取 ${floor.name}`);
        return response.json();
      });
      await loadMapDocument(data);
    }else{
      throw Error(`楼层 ${floor.name||floor.id} 未就绪`);
    }
    if(fromNav)updateNavMarkerVisual();
  }catch(error){notify(error.message,{sticky:true});}
  finally{
    switchingFloor=false;
    preserveNavDuringFloorSwitch=false;
    host?.classList.remove('is-busy');
    area?.classList.remove('is-loading');
    button?.removeAttribute('aria-busy');
  }
}
const xy=p=>[p[0]*pageSize[0],p[1]*pageSize[1]];
const points=ps=>ps.map(p=>xy(p).join(',')).join(' ');
function element(tag,attrs={},parent=svg){const el=document.createElementNS(NS,tag);for(const [k,v]of Object.entries(attrs))el.setAttribute(k,v);parent.append(el);return el;}
const term=()=>$('search').value.trim();
const selected=p=>{
  const refs=[$('start').value,$('end').value,...waypoints].filter(Boolean);
  return refs.some(ref=>{
    const parsed=parsePoiRef(ref);
    return parsed&&parsed.poiId===p.id&&parsed.floorId===floorMeta().id;
  });
};

function populate(){
  if(!doc)return;
  const old=[$('start').value,$('end').value];
  const options=allNavigablePois();
  for(const id of ['start','end']){
    $(id).replaceChildren();
    if(id==='end')$(id).append(new Option('请选择目的地',''));
    for(const item of options)$(id).append(new Option(item.label,item.ref));
  }
  const defaultStart=(()=>{
    const local=defaultStartId();
    return local?poiRef(floorMeta().id,local):options[0]?.ref||'';
  })();
  $('start').value=options.some(o=>o.ref===old[0])?old[0]:defaultStart;
  $('end').value=options.some(o=>o.ref===old[1])?old[1]:'';
  waypoints=waypoints.filter(id=>options.some(o=>o.ref===id)).slice(0,MAX_WAYPOINTS);
  const floor=floorMeta();
  const cross=floorDocCache.size>1?` · ${floorDocCache.size} 层可跨层`:'';
  $('summary').textContent=`${floor.name||'本层'} · ${doc.pois.length} 个地点 · ${isBuiltin()?'演示地图':'生成地图'}${cross}`;
}
function waypointPois(){return waypoints.map(ref=>resolveEndpoint(ref)).filter(Boolean);}
function fillPoiSelect(select, selectedId, {allowEmpty=false, emptyLabel='请选择途径点'}={}){
  select.replaceChildren();
  if(allowEmpty)select.append(new Option(emptyLabel,''));
  for(const item of allNavigablePois())select.append(new Option(item.label,item.ref));
  if(selectedId&&[...select.options].some(o=>o.value===selectedId))select.value=selectedId;
  else select.value=allowEmpty?'':'';
}
function renderWaypoints(){
  const host=$('waypoints');if(!host)return;
  host.replaceChildren();
  waypoints.forEach((id,index)=>{
    const row=document.createElement('div');row.className='waypoint-row';
    const label=document.createElement('label');label.htmlFor=`waypoint-${index}`;
    label.innerHTML=`<span class="dot waypoint-dot"></span>经${index+1}`;
    const select=document.createElement('select');select.id=`waypoint-${index}`;select.setAttribute('aria-label',`途径点${index+1}`);
    fillPoiSelect(select,id,{allowEmpty:true});
    select.onchange=()=>{waypoints[index]=select.value;if(!select.value){waypoints.splice(index,1);}stopWalk();notify('');render();};
    const remove=document.createElement('button');remove.type='button';remove.className='remove-waypoint';remove.setAttribute('aria-label',`移除途径点${index+1}`);remove.textContent='×';
    remove.onclick=()=>{waypoints.splice(index,1);stopWalk();notify('');render();};
    row.append(label,select,remove);host.append(row);
  });
  const add=$('add-waypoint');
  if(add){add.disabled=waypoints.length>=MAX_WAYPOINTS;add.title=waypoints.length>=MAX_WAYPOINTS?'最多 6 个途径点':'添加途径点';}
}
function syncSelection(){
  const meta=$('selected-place-meta');
  const setStart=$('set-start');
  const setEnd=$('set-end');
  const place=focusId?poiIndex.get(focusId):null;
  const navigable=!!place?.nodeId;
  if(setStart)setStart.disabled=!navigable;
  if(setEnd)setEnd.disabled=!navigable;
  if(!meta)return;
  if(!place){
    meta.textContent='点地图或列表选择地点。';
    return;
  }
  if(navigable)meta.textContent=`${place.name} · 可设为起点或终点`;
  else meta.textContent=`${place.name} · 尚未接到走廊，暂不能导航`;
}
function renderList(){
  const list=$('poi-list');list.replaceChildren();
  const found=labels.filter(p=>matchesFilter(p,category,term()));
  found.sort((a,b)=>Number(b.major)-Number(a.major));
  for(const p of found){
    const focused=p.id===focusId||p.id===$('end').value||p.id===$('start').value;
    const button=document.createElement('button');button.type='button';button.className=`poi-list-item${focused?' is-selected':''}`;
    button.setAttribute('aria-label',`选择${p.name}`);button.setAttribute('aria-pressed',p.id===focusId);
    const icon=document.createElement('span');icon.className='place-icon';icon.style.setProperty('--facility-color',facilityColor(facilityCategory(p)));
    icon.append(createFacilityIconSvg(facilityIconKey(p.category)));
    const name=document.createElement('span');name.className='place-name';name.textContent=p.name;
    const arrow=document.createElement('span');arrow.className='place-arrow';arrow.textContent='›';
    button.append(icon,name,arrow);button.onclick=()=>selectPoi(p.id);list.append(button);
  }
  if(!found.length){const empty=document.createElement('p');empty.className='empty-list';empty.textContent='没有找到相关地点';list.append(empty);}
  $('active-category').textContent=category==='all'?'科室与设施':({entrance:'出入口',restroom:'卫生间',stairs:'楼梯',elevator:'电梯',service:'便民服务',escalator:'扶梯'})[category];
}
function setNavEndpoint(id, asStart){
  const place=poiIndex.get(id);
  if(!place?.nodeId)return;
  stopNavSim();
  if(walking)stopWalk();
  notify('');
  const ref=poiRef(floorMeta().id,id);
  if(asStart)$('start').value=ref;
  else $('end').value=ref;
  focusId=id;
  render();
}
function selectPoi(id, asStart=false){
  stopNavSim();
  if(walking)stopWalk();
  notify('');
  focusId=id;
  const ref=poiRef(floorMeta().id,id);
  if(asStart)$('start').value=ref;
  else $('end').value=ref;
  render();
}

function paintRouteArrows(){
  svg.querySelector('#route-arrows')?.remove();
  if(!route)return;
  const {remaining}=currentRouteTravelSplit();
  const poly=(navSimulating?remaining:currentFloorPolyline()).map(xy);
  if(poly.length<2)return;
  const layer=element('g',{id:'route-arrows','pointer-events':'none'});
  for(const arrow of routeArrows(poly,ROUTE_ARROW_SPACING,routeArrowPhase)){
    element('path',{d:'M -2 -1.1 L 0 0 L -2 1.1',transform:`translate(${arrow.x} ${arrow.y}) rotate(${arrow.angle*180/Math.PI})`,fill:'none',stroke:'#fff','stroke-width':.8,'stroke-linecap':'round','stroke-linejoin':'round',class:'route-arrow'},layer);
  }
  svg.append(layer);
}
function stopRouteArrowFlow(){
  if(routeArrowRaf){cancelAnimationFrame(routeArrowRaf);routeArrowRaf=0;}
}
function ensureRouteArrowFlow(){
  if(routeArrowRaf)return;
  routeArrowLast=performance.now();
  const tick=now=>{
    if(!route||!route.length){routeArrowRaf=0;return;}
    routeArrowRaf=requestAnimationFrame(tick);
    const dt=Math.min((now-routeArrowLast)/1000||0,.05);
    routeArrowLast=now;
    routeArrowPhase=(routeArrowPhase+dt*ROUTE_ARROW_SPEED)%ROUTE_ARROW_SPACING;
    if(mode==='2d')paintRouteArrows();
    scene?.setRouteArrowPhase?.(routeArrowPhase);
  };
  routeArrowRaf=requestAnimationFrame(tick);
}
function syncRouteArrowFlow(){
  if(route&&route.length>0)ensureRouteArrowFlow();
  else stopRouteArrowFlow();
}
function render2D(){
  svg.replaceChildren();svg.setAttribute('viewBox',view.join(' '));
  const unit=mapLabelUnit(pageSize, view[2]);
  // Pure semantic vector map: no printed page or blue legend is rendered.
  const defs=element('defs');const shadow=element('filter',{id:'floor-shadow',x:'-20%',y:'-20%',width:'140%',height:'140%'},defs);
  element('feDropShadow',{dx:0,dy:5,stdDeviation:5,'flood-color':'#485660','flood-opacity':'.10'},shadow);
  element('polygon',{points:points(doc.geometry.buildingBoundary),fill:'#fff',stroke:'#b7bec0','stroke-width':2,filter:'url(#floor-shadow)'});
  for(const o of doc.geometry.obstacles){
    const poly=element('polygon',{points:points(o.polygon),fill:roomColor(o),stroke:o.kind==='courtyard'?'#c2d0bc':'#b6bdc0','stroke-width':o.kind==='counter'?1:1.6,'stroke-linejoin':'round'});
    const roomPoi=poiForRoom(doc, o.id);
    if(roomPoi?.nodeId){
      poly.style.cursor='pointer';
      poly.onclick=ev=>{if(choosingScale)return;ev.stopPropagation();if(!moved)selectPoi(roomPoi.id, ev.shiftKey);};
    }
    if(o.kind==='courtyard'){
      const ps=o.polygon.map(xy),x=Math.min(...ps.map(p=>p[0])),y=Math.min(...ps.map(p=>p[1])),w=Math.max(...ps.map(p=>p[0]))-x,h=Math.max(...ps.map(p=>p[1]))-y;
      for(let n=0;n<3;n++)element('circle',{cx:x+w*.5,cy:y+h*(n+1)/4,r:Math.min(w*.22,h*.08),fill:n%2?'#b9cdb0':'#c5d7bc',opacity:.85});
    }
  }
  for(const segment of doc.geometry.wallSegments)element('polyline',{points:points(segment),fill:'none',stroke:'#b4b9ba','stroke-width':1.5});
  for(const door of doc.doors||[]){const [x,y]=xy(door.position);element('circle',{cx:x,cy:y,r:3.5,fill:'#fff',stroke:'#c0cec9','stroke-width':.7});}
  if($('show-mask').checked){
    const href=doc.geometry.walkableOverlayUrl||doc.geometry.walkableMaskUrl||'../data/walkable-overlay.png';
    element('image',{href,x:0,y:0,width:pageSize[0],height:pageSize[1],opacity:.6});
  }
  const editing=$('edit-closures').checked;
  if($('show-graph').checked||editing)for(const e of edges.values()){
    const line=element('polyline',{points:points(e.polyline),class:`graph-edge${editing?' editable':''}${blocked.has(e.id)?' blocked':''}`});
    if(editing)line.onclick=ev=>{ev.stopPropagation();if(moved)return;blocked.has(e.id)?blocked.delete(e.id):blocked.add(e.id);save();notify(blocked.size?`已关闭 ${blocked.size} 条通道`:'通道已全部恢复');render();};
  }
  paintRouteLines();
  paintRouteArrows();
  if($('show-pois').checked){
    const placed=layoutMapLabels(labels,{
      pageSize,viewWidth:view[2],category,term:term(),
      selectedIds:[$('start').value,$('end').value,...waypoints].map(ref=>parsePoiRef(ref)?.poiId).filter(Boolean),
    });
    for(const item of placed){
      const p=item.poi,{x,y,facility,textLabel}=item,cat=facilityCategory(p),name=p.displayName;
      const group=element('g',{class:`map-poi${facility?' is-facility':''}${selected(p)?' is-selected':''}`,tabindex:0,role:'button','aria-label':`导航到${p.name}`});
      element('title',{},group).textContent=p.name;
      if(facility){
        drawFacilityChip(group,{x,y,unit,category:p.category,name,color:facilityColor(cat),selected:!!selected(p),showText:textLabel});
      }else{
        element('text',{x,y:y+LABEL_FONT_SIZE*.32*unit,'text-anchor':'middle','font-size':LABEL_FONT_SIZE*unit,fill:'#3e4d53','font-weight':selected(p)?650:500,class:'room-label-text'},group).textContent=name;
      }
      group.onclick=ev=>{if(choosingScale)return;ev.stopPropagation();if(!moved)selectPoi(p.id, ev.shiftKey);};
      group.onkeydown=ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();selectPoi(p.id);}};
      group.addEventListener('contextmenu',ev=>ev.preventDefault());
    }
  }
  if(route){
    const markers=[];
    const startEp=resolveEndpoint($('start').value);
    const endEp=resolveEndpoint($('end').value);
    if(startEp&&startEp.floorId===floorMeta().id)markers.push([startEp.poi.id,'marker-start','起']);
    waypoints.forEach((ref,i)=>{
      const ep=resolveEndpoint(ref);
      if(ep&&ep.floorId===floorMeta().id)markers.push([ep.poi.id,'marker-via',`经${i+1}`]);
    });
    if(endEp&&endEp.floorId===floorMeta().id)markers.push([endEp.poi.id,'marker-end','终']);
    for(const [id,cls,text]of markers){
      const p=poiIndex.get(id);if(!p)continue;const [x,y]=xy(p.position),g=element('g',{'pointer-events':'none'});
      element('circle',{cx:x,cy:y,r:9*unit,class:cls,stroke:'#fff','stroke-width':2},g);
      element('text',{x,y:y+3.5*unit,'text-anchor':'middle',fill:'white','font-size':10*unit,'font-weight':650},g).textContent=text;
    }
    for(const seg of floorSegments){
      if(seg.floorId!==floorMeta().id||!seg.transfer)continue;
      const last=seg.polyline?.at(-1);if(!last)continue;
      const [x,y]=xy(last),g=element('g',{'pointer-events':'none',class:'transfer-marker'});
      element('circle',{cx:x,cy:y,r:8*unit,fill:'#4d7eb8',stroke:'#fff','stroke-width':2},g);
      element('text',{x,y:y+3.2*unit,'text-anchor':'middle',fill:'white','font-size':9*unit,'font-weight':650},g).textContent='换';
    }
  }
  updateNavMarkerVisual();
  for(const p of scalePoints)element('circle',{cx:p[0],cy:p[1],r:4,class:'calibration-dot'});
  if(scalePoints.length===2)element('line',{x1:scalePoints[0][0],y1:scalePoints[0][1],x2:scalePoints[1][0],y2:scalePoints[1][1],stroke:'#a94bc6','stroke-width':2,'stroke-dasharray':'4 3'});
}
function render(){
  if(!doc||institutionMapPending){
    renderWaypoints();
    return;
  }
  if(walking&&!preserveNavDuringFloorSwitch)stopWalk();
  if(navSimulating&&!preserveNavDuringFloorSwitch){
    // View/floor redraws may call render; only tear down marker sim on explicit stop.
  }
  renderWaypoints();
  if(focusId&&!poiIndex.has(focusId))focusId=null;
  const startEp=resolveEndpoint($('start').value);
  const endEp=resolveEndpoint($('end').value);
  const viaEps=waypointPois();
  const sameTerminal=startEp&&endEp&&startEp.poi.id===endEp.poi.id&&startEp.floorId===endEp.floorId&&!viaEps.length;
  const keepRoute=preserveNavDuringFloorSwitch&&route;
  if(!keepRoute){
    routeIsCrossFloor=false;
    floorSegments=[];
    route=null;
    if(startEp?.poi.nodeId&&endEp?.poi.nodeId){
      const crossNeeded=startEp.floorId!==endEp.floorId||viaEps.some(v=>v.floorId!==startEp.floorId);
      if(crossNeeded&&multiGraph){
        const closed=multiClosed();
        if(viaEps.length){
          const stops=[{floorId:startEp.floorId,nodeId:startEp.poi.nodeId},...viaEps.map(v=>({floorId:v.floorId,nodeId:v.poi.nodeId})),{floorId:endEp.floorId,nodeId:endEp.poi.nodeId}];
          const steps=[];let length=0;let ok=true;
          for(let i=1;i<stops.length;i++){
            const leg=findCrossFloorRoute(multiGraph,stops[i-1].floorId,stops[i-1].nodeId,stops[i].floorId,stops[i].nodeId,closed);
            if(!leg){ok=false;break;}
            length+=leg.length;steps.push(...leg.steps);
          }
          route=ok?{length,steps}:null;
        }else{
          route=findCrossFloorRoute(multiGraph,startEp.floorId,startEp.poi.nodeId,endEp.floorId,endEp.poi.nodeId,closed);
        }
        if(route){
          routeIsCrossFloor=true;
          floorSegments=splitRouteByFloor(route);
        }
      }else if(!crossNeeded){
        const graph=startEp.doc.graph;
        const vias=viaEps.map(v=>v.poi.nodeId);
        route=vias.length?findRouteVia(graph,[startEp.poi.nodeId,...vias,endEp.poi.nodeId],blocked):findRoute(graph,startEp.poi.nodeId,endEp.poi.nodeId,blocked);
        if(route)floorSegments=[{floorId:startEp.floorId,steps:route.steps,polyline:routePolyline(route),length:route.length}];
      }
    }
  }
  const start=startEp?.floorId===floorMeta().id?startEp.poi:null;
  const end=endEp?.floorId===floorMeta().id?endEp.poi:null;
  const vias=viaEps.filter(v=>v.floorId===floorMeta().id).map(v=>v.poi);
  $('result').classList.toggle('no-route',!!endEp&&!route);
  const transferNote=floorSegments.filter(s=>s.transfer).map(s=>s.transfer.tip).join(' · ');
  $('distance').textContent=!endEp?'选择目的地，开始导航':!route?'暂无可用路线':sameTerminal?'已在目的地':scale?`${(route.length*scale.metersPerMapUnit).toFixed(1)} 米`:`${Math.round(route.length)} 图纸单位`;
  const viaNote=viaEps.length?` · 经 ${viaEps.length} 个途径点`:'';
  const crossNote=routeIsCrossFloor?` · 跨 ${new Set(floorSegments.map(s=>s.floorId)).size} 层`:'';
  $('route-message').textContent=!endEp?'点地图上的名称，或搜索目的地':!route?'通道受阻，请换起终点或途径点':transferNote||(scale?`按标定比例换算${viaNote}${crossNote}`:`沿走廊规划 · 距离待标定${viaNote}${crossNote}`);
  $('details').textContent=endEp?`${endEp.floorId} · ${endEp.poi.name} · ${endEp.poi.anchorStatus==='demo'?'演示门位':'图示到达点'}`:'';
  $('simulate').disabled=!route||route.length===0;
  if($('walk-fp'))$('walk-fp').disabled=!route||route.length===0||mode!=='3d';
  $('scale-status').textContent=scale?`1 图纸单位 = ${scale.metersPerMapUnit.toFixed(4)} 米`:'未标定';
  syncSelection();
  render2D();renderList();
  scene?.setRoute(currentFloorPolyline(),route?start:null,route?end:null,route?vias:[]);
  syncRouteArrowFlow();
  scene?.setFilter(category,term(),$('show-pois').checked, focusId||end?.id);
  updateNavMarkerVisual();
}
function sceneContextLost(){
  try{return !!scene?.renderer?.getContext()?.isContextLost();}catch{return false;}
}
async function setMode(next){
  if(!doc||institutionMapPending){
    mode=next;
    svg?.classList.toggle('hidden',next!=='2d');
    $('scene3d')?.classList.toggle('hidden',next!=='3d');
    return;
  }
  if(next==='2d'&&walking)stopWalk();
  const keepNav=navSimulating;
  mode=next;
  svg.classList.toggle('hidden',next!=='2d');$('scene3d').classList.toggle('hidden',next!=='3d');
  for(const [id,value]of [['toggle-2d','2d'],['toggle-3d','3d']]){$(id).classList.toggle('is-active',next===value);for(const cls of ['ambient','amb-surface','amb-chamfer','amb-elevation-1'])$(id).classList.toggle(cls,next===value);$(id).setAttribute('aria-pressed',next===value);}
  $('view-hint').textContent=next==='3d'?'拖动旋转 · 右键平移 · 滚轮缩放':'拖动平移 · 滚轮缩放 · 点击地点导航';
  if(next==='3d'&&scene&&sceneContextLost()){try{scene.dispose();}catch{}scene=null;scenePending=null;}
  if(next==='3d'&&!scene){
    const generation=mapGeneration;
    try{
      scenePending=import('./scene3d.js').then(({HospitalScene})=>{
        if(generation!==mapGeneration)return null;
        scene=new HospitalScene($('scene3d'),doc,{onSelect:selectPoi,onProgress:p=>{$('walk-progress').textContent=`${Math.round(p*100)}%`;$('walk-seek').value=p*100;},onComplete:()=>{walking=false;walkControls();$('walk-progress').textContent='已到达';}});return scene;
      });
      const created=await scenePending;
      if(generation!==mapGeneration)return;
      if(!created)throw Error('三维场景未能创建');
      created.setAppearance(appearance);
      if(keepNav)preserveNavDuringFloorSwitch=true;
      try{render();}finally{if(keepNav)preserveNavDuringFloorSwitch=false;}
      if(keepNav)updateNavMarkerVisual();
    }catch(error){
      if(generation!==mapGeneration)return;
      scenePending=null;
      try{scene?.dispose();}catch{}
      scene=null;
      notify(`3D 不可用，已切换 2D：${error.message}`,{sticky:true});
      await setMode('2d');
      return;
    }
  }
  scene?.setVisible(mode==='3d');
  if(next==='2d')render2D();
  if(keepNav)updateNavMarkerVisual();
  walkControls();
}
function save(){try{localStorage.setItem(key(),JSON.stringify({scale,blocked:[...blocked]}));}catch{notify('无法保存到浏览器，可导出 JSON。');}}
function walkControls(){
  const active=walking||navSimulating;
  for(const id of ['pause-walk','stop-walk','walk-playback'])$(id).hidden=!active;
  $('pause-walk').textContent=(walking?scene?.paused:navMarker.paused)?'继续':'暂停';
  $('simulate').hidden=active;
  if($('walk-fp'))$('walk-fp').hidden=active||mode!=='3d';
  $('view-hint').textContent=walking?'按住拖拽环顾 · 松开回正':navSimulating?'圆标沿路线移动 · 跨层自动切换':mode==='3d'?'拖动旋转 · 右键平移 · 滚轮缩放':'拖动平移 · 滚轮缩放 · 点击地点导航';
}
function stopNavSim(){
  navMarker.stop();
  navSimulating=false;
  markerPoint=null;
  markerEta=null;
  scene?.clearNavMarker?.();
  scene?.setRouteTravel?.([], [], false);
  svg.querySelector('#nav-marker-dot')?.remove();
  hideNavEtaBubble();
  paintRouteLines();
  paintRouteArrows();
  walkControls();
  $('walk-progress').textContent='';
}
function stopWalk(){scene?.stopWalk();walking=false;if(!navSimulating)walkControls();$('walk-progress').textContent='';}
function activate(data){
  if(data.schemaVersion!=='1.0.0'||!Array.isArray(data.pois)||!Array.isArray(data.graph?.nodes)||!Array.isArray(data.graph?.edges)||!data.geometry?.obstacles)throw Error('地图格式不兼容');
  const ids=new Set(data.graph.nodes.map(n=>n.id)),validPoint=p=>Array.isArray(p)&&p.length===2&&p.every(v=>Number.isFinite(v)&&v>=0&&v<=1);
  if(data.graph.nodes.some(n=>!validPoint(n.position))||data.pois.some(p=>!validPoint(p.position)||!validPoint(p.labelPosition)||p.nodeId&&!ids.has(p.nodeId))||data.graph.edges.some(e=>!ids.has(e.source)||!ids.has(e.target)||!Number.isFinite(e.lengthMapUnits)||e.lengthMapUnits<0||!e.polyline?.every(validPoint))||!data.geometry.buildingBoundary?.every(validPoint)||data.geometry.obstacles.some(o=>!o.polygon?.every(validPoint)))throw Error('地图包含无效坐标或路径连接');
  if(data.calibration&&(!Number.isFinite(data.calibration.metersPerMapUnit)||data.calibration.metersPerMapUnit<=0))throw Error('距离比例无效');
  mapGeneration+=1;
  pageSize=pageSizeOf(data);
  view=viewForDoc(data);
  if(!preserveNavDuringFloorSwitch){stopNavSim();stopWalk();}
  scene?.dispose();scene=null;scenePending=null;doc=data;labels=displayPois(doc);edges=new Map(doc.graph.edges.map(e=>[e.id,e]));poiIndex=new Map(doc.pois.map(p=>[p.id,p]));
  focusId=null;
  activeFloorKey=floorKeyFor(data);
  if(!data.floor&&isBuiltin(data))data.floor={id:'1F',code:'01',name:'一楼',description:'门诊与公共服务'};
  if(!data.floorId)data.floorId=data.floor?.id||'1F';
  cacheFloorDoc(data);
  // Demo 2F clone is only for the built-in Gifu map — never seed it onto institutions.
  if(!projectFloors.length&&isBuiltin(data)&&data.id==='gifu-1f'&&!floorDocCache.has(BUILTIN_FLOOR_2F.key)){
    cacheFloorDoc(cloneAsDemoFloor2(data));
  }
  rebuildMultiGraph();
  scale=data.calibration;blocked=new Set(doc.graph.edges.filter(e=>!e.enabled).map(e=>e.id));for(const e of edges.values())e.enabled=true;populate();updateFloorHeading();render();
}
export async function loadMapDocument(data,message){
  institutionMapPending=false;
  setMapEmptyBanner(false);
  activate(data);
  try{const saved=JSON.parse(localStorage.getItem(key()));if(saved){scale=saved.scale&&Number.isFinite(saved.scale.metersPerMapUnit)&&saved.scale.metersPerMapUnit>0?saved.scale:null;blocked=new Set((saved.blocked||[]).filter(id=>edges.has(id)));}}catch{}
  save();
  dismissLoading();
  await setMode(mode||'3d');
  if(message)notify(message);
}
for(const id of ['start','end','show-mask','show-pois','show-graph','edit-closures'])$(id).addEventListener('change',()=>{stopWalk();if(['start','end'].includes(id)){notify('');focusId=$(id).value||focusId;}if(['show-mask','show-graph','edit-closures'].includes(id)&&$(id).checked)setMode('2d');render();});
$('set-start')?.addEventListener('click',()=>setNavEndpoint(focusId, true));
$('set-end')?.addEventListener('click',()=>setNavEndpoint(focusId, false));
$('add-waypoint').onclick=()=>{if(waypoints.length>=MAX_WAYPOINTS)return;stopWalk();waypoints.push('');render();};
$('swap').onclick=()=>{if(!$('end').value)return;stopWalk();const a=$('start').value;$('start').value=$('end').value;$('end').value=a;waypoints=waypoints.slice().reverse();render();};
$('search').oninput=()=>{renderList();render2D();scene?.setFilter(category,term(),$('show-pois').checked, $('end').value);};
$('clear-search').onclick=()=>{$('search').value='';$('search').dispatchEvent(new Event('input'));$('search').focus();};
document.querySelectorAll('[data-category]').forEach(button=>{button.onclick=()=>{category=button.dataset.category;for(const b of document.querySelectorAll('[data-category]')){const active=b.dataset.category===category;b.classList.toggle('is-active',active);b.setAttribute('aria-pressed',active);}renderList();render2D();scene?.setFilter(category,term(),$('show-pois').checked, $('end').value);};});
$('toggle-2d').onclick=()=>setMode('2d');$('toggle-3d').onclick=()=>setMode('3d');
$('fit').onclick=()=>{stopWalk();view=viewForDoc(doc);render2D();scene?.fit();};
function zoom(factor){if(mode==='3d'){scene?.zoom(factor);return;}const [x,y,w,h]=view,W=Math.max(100,Math.min(1500,w*factor)),H=h*W/w;view=[x+(w-W)/2,y+(h-H)/2,W,H];render2D();}
$('zoom-in').onclick=()=>zoom(.8);$('zoom-out').onclick=()=>zoom(1.25);svg.addEventListener('wheel',ev=>{ev.preventDefault();zoom(ev.deltaY>0?1.1:.9);},{passive:false});
svg.addEventListener('contextmenu',ev=>ev.preventDefault());
$('scene3d').addEventListener('contextmenu',ev=>ev.preventDefault());
const svgPoint=ev=>{const p=new DOMPoint(ev.clientX,ev.clientY),q=p.matrixTransform(svg.getScreenCTM().inverse());return [q.x,q.y];};
svg.onpointerdown=ev=>{drag={point:svgPoint(ev),client:[ev.clientX,ev.clientY]};moved=false;};
svg.onpointermove=ev=>{if(!drag||choosingScale)return;if(Math.hypot(ev.clientX-drag.client[0],ev.clientY-drag.client[1])>5)moved=true;if(!moved)return;const p=svgPoint(ev);view=[view[0]-(p[0]-drag.point[0]),view[1]-(p[1]-drag.point[1]),view[2],view[3]];svg.setAttribute('viewBox',view.join(' '));};
window.addEventListener('pointerup',()=>{drag=null;});svg.onpointercancel=()=>{drag=null;};
svg.onclick=ev=>{if(!choosingScale||moved)return;scalePoints.push(svgPoint(ev));if(scalePoints.length===2){choosingScale=false;notify('已选两点，填写米数后保存',{sticky:true});$('meters').focus();}render2D();};
$('pick-scale').onclick=()=>{setMode('2d');choosingScale=true;scalePoints=[];notify('在图上点两个已知距离的点',{sticky:true});render2D();};
$('apply-scale').onclick=()=>{const meters=Number($('meters').value);if(scalePoints.length!==2||!(meters>0&&Number.isFinite(meters)))return notify('先选两点，再填大于 0 的米数');const len=Math.hypot(scalePoints[0][0]-scalePoints[1][0],scalePoints[0][1]-scalePoints[1][1]);if(len<1)return notify('两点太近，请重选');scale={metersPerMapUnit:meters/len,referencePoints:scalePoints.map(p=>toNormalized(p,pageSize)),referenceMeters:meters,source:'user-entered'};save();notify('标定已保存');render();};
$('clear-scale').onclick=()=>{scale=null;scalePoints=[];choosingScale=false;$('meters').value='';save();notify('已清除标定');render();};
$('reset-closures').onclick=()=>{blocked.clear();save();notify('通道已全部恢复');render();};
function closeMakerPanel(){
  if(!$('maker-panel')||$('maker-panel').hidden)return;
  $('maker-panel').hidden=true;
  $('maker-toggle')?.setAttribute('aria-expanded','false');
}
$('tools-toggle').onclick=()=>{
  const open=$('tools-panel').hidden;
  $('tools-panel').hidden=!open;
  $('tools-toggle').setAttribute('aria-expanded',open);
  if(open)closeMakerPanel();
};
$('tools-close').onclick=()=>{$('tools-panel').hidden=true;$('tools-toggle').setAttribute('aria-expanded',false);$('tools-toggle').focus();};
document.addEventListener('keydown',ev=>{
  if(ev.key!=='Escape')return;
  if($('maker-panel')&&!$('maker-panel').hidden)return;
  if(!$('tools-panel').hidden)$('tools-close').click();
});
$('route-tab').onclick=()=>{$('end').scrollIntoView({block:'center'});$('end').focus();};
$('simulate').onclick=async()=>{
  if(!route?.length)return;
  stopWalk();
  if(!navMarker.setPath(route, floorSegments[0]?.floorId||floorMeta().id))return notify('无法沿该路线模拟');
  navSimulating=true;walkControls();
  navMarker.setSpeed(Number($('walk-speed').value)||1);
  const startFloor=floorSegments[0]?.floorId||floorMeta().id;
  if(startFloor!==floorMeta().id){
    const target=floorCatalog().find(f=>f.id===startFloor);
    if(target)await switchFloor(target,{fromNav:true});
  }
  navMarker.start();
  notify(routeIsCrossFloor?'跨楼层模拟导航已开始':'模拟导航已开始');
};
$('walk-fp').onclick=async()=>{
  await setMode('3d');if(!scene||!route?.length)return;
  stopNavSim();walking=true;walkControls();scene.setWalkSpeed(Number($('walk-speed').value));scene.startWalk();
};
$('walk-speed').onchange=()=>{scene?.setWalkSpeed(Number($('walk-speed').value));navMarker.setSpeed(Number($('walk-speed').value));};
$('walk-seek').oninput=()=>{
  const p=Number($('walk-seek').value)/100;
  if(navSimulating){navMarker.seek(p);$('pause-walk').textContent=navMarker.paused?'继续':'暂停';}
  else{scene?.seekWalk(p);$('pause-walk').textContent=scene?.paused?'继续':'暂停';}
};
$('pause-walk').onclick=()=>{
  if(navSimulating)$('pause-walk').textContent=navMarker.pause()?'继续':'暂停';
  else $('pause-walk').textContent=scene?.pauseWalk()?'继续':'暂停';
};
$('stop-walk').onclick=()=>{stopWalk();stopNavSim();};
$('export').onclick=()=>{const data=structuredClone(doc);data.calibration=scale;for(const e of data.graph.edges)e.enabled=!blocked.has(e.id);const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=`${doc.id||'hospital'}-map.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
$('import').onclick=()=>$('file').click();$('file').onchange=async()=>{try{const file=$('file').files[0];if(!file)return;activate(JSON.parse(await file.text()));save();await setMode(mode);notify('已导入');}catch(e){notify(e.message,{sticky:true});}$('file').value='';};
function updateClock(){const now=new Date();if($('clock'))$('clock').textContent=now.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});if($('date'))$('date').textContent=now.toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'long'});}
decorateFacilityButtons(document);
updateClock();setInterval(updateClock,30000);
try{
  const generation=mapGeneration;
  const response=await fetch('../data/map.json');if(!response.ok)throw Error(`地图读取失败：${response.status}`);
  // Skip demo load if an institution empty-state already claimed the canvas.
  if(mapGeneration===generation&&!institutionMapPending){
    activate(await response.json());
    try{const saved=JSON.parse(localStorage.getItem(key()));if(saved){scale=saved.scale&&Number.isFinite(saved.scale.metersPerMapUnit)&&saved.scale.metersPerMapUnit>0?saved.scale:null;blocked=new Set((saved.blocked||[]).filter(id=>edges.has(id)));render();}}catch{}
  }
  dismissLoading();walkControls();
  if(!institutionMapPending)await setMode('3d');
}catch(e){$('loading').textContent=`${e.message}，请用 HTTP 服务打开预览`;}

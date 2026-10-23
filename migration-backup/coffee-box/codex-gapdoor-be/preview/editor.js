import {findRoute,routePolyline,routeArrows} from './routing.js';
import {roomColor,displayPois,facilityCategory,facilityColor,obstacleForSelection,poiForRoom,ROOM_COLOR_PRESETS,normalizeHexColor} from './map-art.js';
import {createFacilityIconSvg,drawFacilityChip,facilityIconKey,isFacilityPoi} from './facility-icons.js';
import {containsPoint,closestPointOnPolygon} from './wall-signs.js';
import {pageSizeOf,homeViewForBoundary,mapLabelUnit,LABEL_FONT_SIZE} from './map-coords.js';
import {createNotifier} from './status.js';
import {institutionName, mountInstitutionSwitcher} from './institutions.js';

const $=id=>document.getElementById(id);
const svg=$('map');
const NS='http://www.w3.org/2000/svg';
const ICONS=[
  {category:'restroom',name:'卫生间'},
  {category:'accessible-restroom',name:'无障碍卫生间'},
  {category:'elevator',name:'电梯'},
  {category:'stairs',name:'楼梯'},
  {category:'escalator',name:'扶梯'},
  {category:'entrance',name:'出入口'},
  {category:'pharmacy',name:'药房'},
  {category:'shop',name:'商店'},
  {category:'reception',name:'服务台'},
];
const params=new URLSearchParams(location.search);
let projectId=params.get('project');
const requestedFloor=params.get('floor');
const STORAGE_KEY='hospital-maker-v1';

let project=null,doc=null,pageSize=[800,1210],view=[0,0,800,1210],mode='2d';
let selectedId=null,placing=null,scene=null,scenePending=null,saving=false,saveQueued=false,term='';
let startId='',endId='',route=null;
let drag=null,mapPan=null,skipClick=false;

const notify=createNotifier($('status'),{duration:2500});
function escapeHtml(text){return String(text??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));}
function apiError(payload, fallback){
  if(!payload)return fallback;
  if(typeof payload.detail==='string')return payload.detail;
  if(Array.isArray(payload.detail))return payload.detail.map(item=>item.msg||item).join('；');
  return fallback;
}
async function api(path, options={}){
  const response=await fetch(path, options);
  const text=await response.text();
  let payload=null;
  try{payload=text?JSON.parse(text):null;}catch{payload={detail:text};}
  if(!response.ok)throw Error(apiError(payload, `请求失败（${response.status}）`));
  return payload;
}
function floorMeta(){
  return doc?.floor||{id:doc?.floorId||'1F',code:'01',name:'本层',description:''};
}
function previewHref(floorId){
  const params=new URLSearchParams();
  if(projectId)params.set('project',projectId);
  const floor=arguments.length?floorId:floorMeta().id;
  if(floor)params.set('floor',floor);
  const query=params.toString();
  return query?`./?${query}`:'./';
}
function previewMakerHref(){
  const params=new URLSearchParams();
  if(projectId)params.set('project',projectId);
  params.set('maker','1');
  return `./?${params}`;
}
function editorHref(id, floorId){
  return `./edit.html?project=${encodeURIComponent(id||'')}&floor=${encodeURIComponent(floorId||'')}`;
}
function xy(p){return [p[0]*pageSize[0], p[1]*pageSize[1]];}
function points(list){return list.map(p=>xy(p).join(',')).join(' ');}
function element(name, attrs={}, parent=svg){
  const node=document.createElementNS(NS,name);
  for(const [key,value] of Object.entries(attrs))node.setAttribute(key,value);
  parent.append(node);
  return node;
}
function svgPoint(ev){
  const p=new DOMPoint(ev.clientX,ev.clientY);
  const q=p.matrixTransform(svg.getScreenCTM().inverse());
  return [q.x,q.y];
}
function toNorm(point){return [point[0]/pageSize[0], point[1]/pageSize[1]];}
function labels(){return displayPois(doc);}
function defaultStartId(){
  const pois=doc?.pois||[];
  return pois.find(p=>p.category==='entrance'&&p.nodeId)?.id||pois.find(p=>p.nodeId)?.id||'';
}
function isFacility(p){return isFacilityPoi(p);}
function edits(){
  const floorId=floorMeta().id;
  return {renamedPois:{},renamedRooms:{},facilityIcons:[],movedPois:{},roomColors:{},...((project?.editsByFloor||{})[floorId]||project?.draft?.edits||{})};
}
function currentIcons(){
  return (edits().facilityIcons||[]).map(icon=>({...icon}));
}
function roomAt(norm){
  return (doc?.geometry?.obstacles||[]).find(item=>containsPoint(item.polygon, norm[0], norm[1]))||null;
}
function owningRoom(poi){
  const byId=poi?.roomId&&doc.geometry.obstacles.find(item=>item.id===poi.roomId);
  if(byId)return byId;
  return roomAt(poi?.displayPosition||poi?.labelPosition||poi?.position||[0.5,0.5]);
}
function placeablePolygon(poi){
  return owningRoom(poi)?.polygon||doc.geometry.buildingBoundary||[];
}
function freezeDragBounds(poi){
  const room=owningRoom(poi);
  const poly=room?.polygon||doc.geometry.buildingBoundary||[];
  return {polygon:poly.map(pt=>[pt[0],pt[1]]), roomId:room?.id||null};
}
function clampNorm(point, poi, polygon){
  const poly=polygon||placeablePolygon(poi);
  if(!poly.length)return [Math.max(0,Math.min(1,point[0])), Math.max(0,Math.min(1,point[1]))];
  const bounded=closestPointOnPolygon(poly, point[0], point[1]);
  return [Math.max(0,Math.min(1,bounded[0])), Math.max(0,Math.min(1,bounded[1]))];
}

function renderPalette(){
  const host=$('icon-palette');
  if(!host)return;
  host.replaceChildren();
  for(const icon of ICONS){
    const button=document.createElement('button');
    button.type='button';
    button.className=`icon-chip${placing===icon.category?' is-placing':''}`;
    const mark=document.createElement('span');
    mark.append(createFacilityIconSvg(icon.category));
    button.append(mark, document.createTextNode(icon.name));
    button.onclick=()=>{
      placing=placing===icon.category?null:icon.category;
      $('cancel-place').hidden=!placing;
      notify(placing?`点击地图放置「${icon.name}」`:'',{sticky:true});
      renderPalette();
      svg.classList.toggle('is-placing',!!placing);
    };
    host.append(button);
  }
}

function renderLists(){
  const query=term.trim().toLowerCase();
  const found=labels().filter(p=>!query||p.name.toLowerCase().includes(query)||(p.displayName||'').toLowerCase().includes(query));
  const fill=(hostId, items)=>{
    const host=$(hostId);host.replaceChildren();
    for(const p of items){
      const button=document.createElement('button');
      button.type='button';
      button.className=`poi-list-item${p.id===selectedId?' is-selected':''}`;
      const icon=document.createElement('span');icon.className='place-icon';
      icon.style.setProperty('--facility-color',facilityColor(facilityCategory(p)));
      icon.append(createFacilityIconSvg(facilityIconKey(p.category)));
      const name=document.createElement('span');name.className='place-name';name.textContent=p.displayName||p.name;
      button.append(icon,name);
      button.onclick=()=>selectPlace(p.id);
      host.append(button);
    }
    if(!items.length){
      const empty=document.createElement('p');empty.className='empty-list';empty.textContent='暂无';host.append(empty);
    }
  };
  fill('dept-list', found.filter(p=>!isFacility(p)));
  fill('facility-list', found.filter(p=>isFacility(p)));
}

function selectedPlace(){
  return labels().find(p=>p.id===selectedId)||null;
}
function selectedObstacle(){
  const place=selectedPlace();
  return obstacleForSelection(selectedId, place, doc?.geometry?.obstacles)||(place?owningRoom(place):null);
}

function syncRename(){
  const place=selectedPlace();
  const input=$('place-name');
  const meta=$('selected-meta');
  const remove=$('remove-icon');
  const setStart=$('set-start');
  const setEnd=$('set-end');
  const roomOnly=(!place&&selectedId?.startsWith('room-'))?selectedObstacle():null;
  const navigable=!!place?.nodeId;
  if(setStart)setStart.disabled=!navigable;
  if(setEnd)setEnd.disabled=!navigable;
  if(!place&&!roomOnly){
    input.value='';input.disabled=true;
    meta.textContent='点击房间或名称开始改名。';
    remove.hidden=true;
    syncRoomColor(null);
    return;
  }
  if(!place&&roomOnly){
    input.disabled=false;
    if(document.activeElement!==input)input.value=roomOnly.name||'';
    meta.textContent=roomOnly.name?'已命名房间 · 回车保存后可导航':'未命名房间 · 输入名称后回车';
    remove.hidden=true;
    syncRoomColor(roomOnly);
    return;
  }
  input.disabled=false;
  if(document.activeElement!==input)input.value=place.name;
  if(place.id.startsWith('icon-'))meta.textContent='设施图标 · 可在房间内拖动';
  else if(navigable)meta.textContent='改好后按回车保存 · 可设为起点或终点';
  else meta.textContent='已命名 · 尚未接到走廊，暂不能导航';
  remove.hidden=!place.id.startsWith('icon-');
  syncRoomColor(selectedObstacle());
}

function colorTargetRoom(){
  const room=selectedObstacle();
  if(room?.id)return room;
  return null;
}

function syncRoomColor(room){
  const desk=$('room-color-desk');
  const picker=$('room-color-picker');
  const hex=$('room-color-hex');
  const reset=$('room-color-reset');
  const presets=$('room-color-presets');
  if(!desk||!picker||!hex||!reset||!presets)return;
  const target=room||null;
  const enabled=!!target?.id;
  desk.hidden=!enabled;
  picker.disabled=!enabled;
  hex.disabled=!enabled;
  reset.disabled=!enabled;
  if(!presets.dataset.ready){
    presets.replaceChildren();
    for(const item of ROOM_COLOR_PRESETS){
      const button=document.createElement('button');
      button.type='button';
      button.className='room-color-swatch';
      button.dataset.hex=item.hex;
      button.title=item.label;
      button.setAttribute('aria-label',item.label);
      button.style.background=item.hex;
      button.addEventListener('click',()=>applyRoomColor(item.hex));
      presets.append(button);
    }
    presets.dataset.ready='1';
  }
  const current=enabled?normalizeHexColor(target.fillColor)||roomColor(target):'';
  const activeHex=normalizeHexColor(target?.fillColor)||'';
  if(document.activeElement!==hex)hex.value=activeHex||current||'';
  if(document.activeElement!==picker)picker.value=current||'#e9e7e4';
  for(const button of presets.querySelectorAll('.room-color-swatch')){
    button.disabled=!enabled;
    button.classList.toggle('is-active',!!activeHex&&button.dataset.hex===activeHex);
  }
}

async function applyRoomColor(raw){
  const room=colorTargetRoom();
  if(!room?.id)return;
  const hex=raw===''||raw==null?'':normalizeHexColor(raw);
  if(raw!==''&&raw!=null&&!hex){
    notify('颜色格式无效，请用 #RRGGBB',{sticky:true});
    syncRoomColor(room);
    return;
  }
  // Optimistic fill so 2D updates before the round-trip.
  if(hex)room.fillColor=hex;
  else delete room.fillColor;
  if(mode==='2d')render2D();
  else syncRoomColor(room);
  await persist({roomColors:{[room.id]:hex||''}});
}

function drawMarker(p, unit){
  const [x,y]=xy(p.displayPosition||p.labelPosition||p.position);
  const cat=facilityCategory(p),name=p.displayName||p.name,selected=p.id===selectedId;
  const facility=isFacility(p);
  const group=element('g',{class:`map-poi editor-label${facility?' is-facility':''}${selected?' is-selected':''}${drag?.id===p.id?' is-dragging':''}`,role:'button','aria-label':name});
  if(facility){
    drawFacilityChip(group,{x,y,unit,category:p.category,name,color:facilityColor(cat),selected,showText:selected});
  }else{
    element('text',{x,y:y+LABEL_FONT_SIZE*.32*unit,'text-anchor':'middle','font-size':LABEL_FONT_SIZE*unit,fill:selected?'#24634b':'#3e4d53','font-weight':selected?700:500,class:'editor-label-text'},group).textContent=name;
  }
  group.addEventListener('pointerdown',ev=>{
    ev.stopPropagation();
    if(placing){placeIcon(toNorm(svgPoint(ev)));return;}
    if(facility&&mode==='2d'){
      const bounds=freezeDragBounds(p);
      drag={id:p.id, pointerId:ev.pointerId, moved:false, polygon:bounds.polygon, roomId:bounds.roomId};
      try{svg.setPointerCapture(ev.pointerId);}catch{}
    }
    selectPlace(p.id);
  });
  group.addEventListener('click',ev=>{
    ev.stopPropagation();
    if(skipClick){skipClick=false;return;}
    if(placing){placeIcon(toNorm(svgPoint(ev)));return;}
    if(drag?.moved)return;
    selectPlace(p.id);
  });
}

function render2D(){
  svg.replaceChildren();
  svg.setAttribute('viewBox',view.join(' '));
  const unit=mapLabelUnit(pageSize, view[2]);
  element('polygon',{points:points(doc.geometry.buildingBoundary),fill:'#fff',stroke:'#b7bec0','stroke-width':2});
  const selected=selectedObstacle();
  for(const o of doc.geometry.obstacles){
    const poly=element('polygon',{
      points:points(o.polygon),
      fill:roomColor(o),
      stroke:'#b6bdc0',
      'stroke-width':'1.4',
      'stroke-linejoin':'round',
      class:`editor-room${selected&&o.id===selected.id?' is-selected':''}`,
    });
    poly.addEventListener('click',ev=>{
      ev.stopPropagation();
      if(skipClick){skipClick=false;return;}
      if(placing){placeIcon(toNorm(svgPoint(ev)));return;}
      const poi=poiForRoom(doc, o.id);
      selectPlace(poi?.id||`room-${o.id}`, o);
    });
  }
  if(selected?.polygon?.length){
    // Blue selection ring only — no green fill overlay that hides room colors.
    element('polygon',{
      points:points(selected.polygon),
      class:'editor-room-outline',
      fill:'none',
      stroke:'#2f6fed',
      'stroke-width':'2.8',
      'stroke-linejoin':'round',
      'pointer-events':'none',
    });
  }
  for(const p of labels())drawMarker(p, unit);
  drawRoute(unit);
}

function fillNavSelect(select, selected, {allowEmpty=false, emptyLabel='请选择目的地'}={}){
  if(!select)return;
  select.replaceChildren();
  if(allowEmpty)select.append(new Option(emptyLabel,''));
  for(const p of doc?.pois||[]){
    const option=new Option(p.name,p.id);
    option.disabled=!p.nodeId;
    select.append(option);
  }
  if(selected&&findPoi(selected)?.nodeId)select.value=selected;
  else select.value=allowEmpty?'':defaultStartId();
}

function renderNav(){
  const startEl=$('start'), endEl=$('end');
  if(!startEl||!endEl||!doc)return;
  if(startId&&!findPoi(startId)?.nodeId)startId='';
  if(endId&&!findPoi(endId)?.nodeId)endId='';
  if(!startId)startId=defaultStartId();
  fillNavSelect(startEl, startId);
  fillNavSelect(endEl, endId, {allowEmpty:true});
  startId=startEl.value;
  endId=endEl.value;
  const start=findPoi(startId), end=findPoi(endId);
  const same=start&&end&&start.id===end.id;
  route=start?.nodeId&&end?.nodeId?findRoute(doc.graph,start.nodeId,end.nodeId):null;
  if($('result'))$('result').classList.toggle('no-route',!!end&&!route);
  if($('distance'))$('distance').textContent=!end?'选择目的地，开始导航':!route?'暂无可用路线':same?'已在目的地':`${Math.round(route.length)} 图纸单位`;
  if($('route-message'))$('route-message').textContent=!end?'命名房间后，可设为起点或终点':!route?'尚未接到走廊，请换起终点':'沿走廊规划 · 可在预览页模拟行走';
}

function drawRoute(unit){
  if(!route)return;
  for(const cls of ['route-halo','route-line'])element('polyline',{points:points(routePolyline(route)),class:cls});
  for(const arrow of routeArrows(routePolyline(route).map(xy)))element('path',{d:'M -2 -1.1 L 0 0 L -2 1.1',transform:`translate(${arrow.x} ${arrow.y}) rotate(${arrow.angle*180/Math.PI})`,fill:'none',stroke:'#fff','stroke-width':.8,'stroke-linecap':'round','stroke-linejoin':'round','pointer-events':'none',class:'route-arrow'});
  for(const [id,cls,text]of [[startId,'marker-start','起'],[endId,'marker-end','终']]){
    const p=findPoi(id);if(!p)continue;const [x,y]=xy(p.position||p.labelPosition);
    const g=element('g',{'pointer-events':'none'});
    element('circle',{cx:x,cy:y,r:9*unit,class:cls,stroke:'#fff','stroke-width':2},g);
    element('text',{x,y:y+3.5*unit,'text-anchor':'middle',fill:'white','font-size':10*unit,'font-weight':650},g).textContent=text;
  }
}

function setNavEndpoint(id, asStart){
  const place=findPoi(id);
  if(!place?.nodeId)return;
  if(asStart)startId=id;
  else endId=id;
  render();
}

function render(){
  renderLists();
  syncRename();
  renderNav();
  if(mode==='2d')render2D();
  const start=findPoi(startId), end=findPoi(endId);
  scene?.setFilter('all','',true, selectedId);
  scene?.setRoute(routePolyline(route),route?start:null,route?end:null,[]);
}

function selectPlace(id, room){
  selectedId=id;
  const place=selectedPlace();
  if(!place&&room){
    $('place-name').disabled=false;
    $('place-name').value=room.name||'';
    $('selected-meta').textContent='未命名房间 · 输入名称后回车';
  }
  render();
  if(!drag)$('place-name').focus();
}

function findPoi(id){
  return (doc?.pois||[]).find(item=>item.id===id)||null;
}

function applyLocalPosition(id, position){
  const poi=findPoi(id);
  if(!poi)return;
  poi.position=position;
  poi.labelPosition=position;
  poi.displayPosition=position;
}

/** Every edit funnels through here, so this is the one place that confirms or reports a save. */
async function persist(patch){
  if(!project)return;
  if(saving){saveQueued=patch;return;}
  saving=true;
  try{
    do{
      const body=saveQueued||patch;
      saveQueued=false;
      const result=await api(`/api/projects/${project.id}/edits`,{
        method:'PATCH',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({revision:project.draft.revision,floorId:floorMeta().id,...body}),
      });
      project=result;
      if(result.map){
        doc=result.map;
        if(scene){
          try{scene.dispose();}catch{}
          scene=null;scenePending=null;
        }
      }
    }while(saveQueued);
    render();
    if(mode==='3d')await setMode('3d');
    notify('已保存');
  }catch(error){
    notify(error.message,{sticky:true});
  }finally{
    saving=false;
  }
}

async function persistPosition(id, position, roomId){
  if(id.startsWith('icon-')){
    const icons=currentIcons();
    const index=icons.findIndex(icon=>icon.id===id);
    const poi=findPoi(id);
    const next={id,category:poi?.category||'service',name:poi?.name||'设施',position,roomId:roomId||poi?.roomId||null};
    if(index>=0)icons[index]={...icons[index],...next};
    else icons.push(next);
    if(poi)poi.roomId=next.roomId;
    await persist({facilityIcons:icons});
    return;
  }
  await persist({movedPois:{[id]:position}});
}

async function renameCurrent(){
  const input=$('place-name');
  const name=input.value.trim();
  if(!name)return;
  const place=selectedPlace();
  const renamedPois={};
  const renamedRooms={};
  let expectId=place?.id||null;
  if(place){
    renamedPois[place.id]=name;
    if(place.roomId)renamedRooms[place.roomId]=name;
  }else if(selectedId?.startsWith('room-')){
    renamedRooms[selectedId.slice(5)]=name;
    expectId=selectedId;
  }
  await persist({renamedPois,renamedRooms});
  if(expectId&&findPoi(expectId))selectedId=expectId;
  const named=findPoi(selectedId);
  if(named?.nodeId&&!endId)endId=named.id;
  render();
}

async function placeIcon(position){
  if(!placing)return;
  const spec=ICONS.find(item=>item.category===placing);
  const room=roomAt(position);
  const icon={
    id:`icon-${Date.now().toString(36)}`,
    category:placing,
    name:spec?.name||'设施',
    position:clampNorm(position, {roomId:room?.id||null}),
    roomId:room?.id||null,
  };
  placing=null;
  $('cancel-place').hidden=true;
  svg.classList.remove('is-placing');
  renderPalette();
  selectedId=icon.id;
  await persist({facilityIcons:[...currentIcons(),icon]});
}

async function removeIcon(){
  const place=selectedPlace();
  if(!place?.id.startsWith('icon-'))return;
  selectedId=null;
  await persist({facilityIcons:currentIcons().filter(icon=>icon.id!==place.id)});
}

async function setMode(next){
  mode=next;
  svg.classList.toggle('hidden',next!=='2d');
  $('scene3d').classList.toggle('hidden',next!=='3d');
  for(const [id,value] of [['toggle-2d','2d'],['toggle-3d','3d']]){
    $(id).classList.toggle('is-active',next===value);
    for(const cls of ['ambient','amb-surface','amb-chamfer','amb-elevation-1'])$(id).classList.toggle(cls,next===value);
    $(id).setAttribute('aria-pressed',next===value);
  }
  $('view-hint').textContent=next==='3d'?'点击名称改字 · 滚轮缩放 · 拖动旋转':'滚轮缩放 · 拖动平移 · 拖拽图标';
  let lost=false;
  try{lost=!!scene?.renderer?.getContext()?.isContextLost();}catch{}
  if(next==='3d'&&scene&&lost){try{scene.dispose();}catch{}scene=null;scenePending=null;}
  if(next==='3d'&&!scene){
    try{
      scenePending=import('./scene3d.js').then(({HospitalScene})=>{
        scene=new HospitalScene($('scene3d'),doc,{onSelect:id=>selectPlace(id)});
        return scene;
      });
      const created=await scenePending;
      if(!created)throw Error('三维场景未能创建');
      render();
    }catch(error){
      scenePending=null;
      try{scene?.dispose();}catch{}
      scene=null;
      notify(`3D 不可用：${error.message}`,{sticky:true});
      await setMode('2d');
      return;
    }
  }
  scene?.setVisible(mode==='3d');
  if(next==='2d')render2D();
}

function zoomMap(factor, origin){
  const [x,y,w,h]=view;
  const limit=Math.max(pageSize[0], pageSize[1])*2.5;
  const W=Math.max(70, Math.min(limit, w*factor));
  const H=h*W/w;
  if(origin){
    const nx=(origin[0]-x)/w, ny=(origin[1]-y)/h;
    view=[origin[0]-nx*W, origin[1]-ny*H, W, H];
  }else{
    view=[x+(w-W)/2, y+(h-H)/2, W, H];
  }
  render2D();
}

function bindDrag(){
  if(!svg)return;
  svg.addEventListener('wheel',ev=>{
    if(mode!=='2d')return;
    ev.preventDefault();
    zoomMap(ev.deltaY>0?1.1:.9, svgPoint(ev));
  },{passive:false});
  svg.addEventListener('pointerdown',ev=>{
    if(placing||drag||mode!=='2d')return;
    if(ev.target.closest?.('.map-poi'))return;
    mapPan={point:svgPoint(ev), client:[ev.clientX,ev.clientY], pointerId:ev.pointerId, moved:false};
    try{svg.setPointerCapture(ev.pointerId);}catch{}
  });
  svg.addEventListener('pointermove',ev=>{
    if(drag&&ev.pointerId===drag.pointerId){
      const poi=findPoi(drag.id);
      if(!poi)return;
      const next=clampNorm(toNorm(svgPoint(ev)), poi, drag.polygon);
      drag.moved=true;
      applyLocalPosition(drag.id, next);
      if(drag.roomId)poi.roomId=drag.roomId;
      render2D();
      return;
    }
    if(!mapPan||ev.pointerId!==mapPan.pointerId)return;
    if(Math.hypot(ev.clientX-mapPan.client[0],ev.clientY-mapPan.client[1])>4)mapPan.moved=true;
    if(!mapPan.moved)return;
    const p=svgPoint(ev);
    view=[view[0]-(p[0]-mapPan.point[0]), view[1]-(p[1]-mapPan.point[1]), view[2], view[3]];
    svg.setAttribute('viewBox', view.join(' '));
  });
  const endDrag=async ev=>{
    if(mapPan&&(!ev||ev.pointerId===mapPan.pointerId)){
      skipClick=!!mapPan.moved;
      mapPan=null;
    }
    if(!drag||(ev&&ev.pointerId!==drag.pointerId))return;
    const id=drag.id;
    const poi=findPoi(id);
    const moved=drag.moved;
    const roomId=drag.roomId;
    drag=null;
    if(moved&&poi)await persistPosition(id, poi.labelPosition||poi.position, roomId);
  };
  svg.addEventListener('pointerup',endDrag);
  svg.addEventListener('pointercancel',endDrag);
}

function setLoadingMessage(message){
  const text=$('loading-message');
  if(text)text.textContent=message||'';
  else if($('loading')&&message)$('loading').textContent=message;
}
function showLoading(message){
  const el=$('loading');
  if(!el)return;
  if(message)setLoadingMessage(message);
  if($('loading-actions'))$('loading-actions').hidden=true;
  el.classList.remove('is-done','is-empty');
  el.hidden=false;
}
function showEmptyState(message){
  const el=$('loading');
  if(!el)return;
  setLoadingMessage(message||'还没有可编辑的楼层');
  const home=previewHref(null);
  const maker=previewMakerHref();
  if($('loading-back'))$('loading-back').href=home;
  if($('loading-generate'))$('loading-generate').href=maker;
  if($('back-preview'))$('back-preview').href=home;
  if($('loading-actions'))$('loading-actions').hidden=false;
  el.classList.remove('is-done');
  el.classList.add('is-empty');
  el.hidden=false;
}
function hideLoading(){
  const el=$('loading');
  if(!el||el.hidden)return;
  el.classList.add('is-done');
  setTimeout(()=>{if(el.classList.contains('is-done'))el.hidden=true;},260);
}

function readyFloors(record){
  return Object.values(record?.floors||{}).filter(item=>item.status==='ready'&&item.id);
}
function pickReadyFloor(record, requested, exclude){
  const ready=readyFloors(record).filter(item=>item.id!==exclude);
  if(requested&&ready.some(item=>item.id===requested))return requested;
  if(record?.activeFloor&&ready.some(item=>item.id===record.activeFloor))return record.activeFloor;
  return ready[0]?.id||null;
}
function canDeleteFloor(record){
  return readyFloors(record===undefined?project:record).length>1;
}
function syncDeleteButton(){
  const button=$('delete-floor');
  if(!button)return;
  const allow=canDeleteFloor();
  button.hidden=!allow;
  button.disabled=!allow;
  button.title=allow?'':'至少保留一层';
}
async function deleteFloor(){
  const floor=floorMeta();
  if(!canDeleteFloor()){
    syncDeleteButton();
    notify('至少保留一层三维地图，不能删除最后一层。',{sticky:true});
    return;
  }
  const label=floor.name||floor.id;
  if(!confirm(`删除「${label}」的地图？PDF 会保留。`))return;
  const button=$('delete-floor');
  if(button)button.disabled=true;
  showLoading(`正在删除「${label}」…`);
  try{
    const updated=await api(`/api/projects/${project.id}/floors/${encodeURIComponent(floor.id)}`,{method:'DELETE'});
    project=updated;
    const next=pickReadyFloor(updated, updated.activeFloor, floor.id);
    if(next){
      setLoadingMessage('正在切换楼层…');
      location.replace(editorHref(project.id, next));
      return;
    }
    showEmptyState('没有其他楼层可编辑');
  }catch(error){
    hideLoading();
    notify(error.message,{sticky:true});
    syncDeleteButton();
  }
}

async function loadFloorMap(id, floor){
  const query=floor?`?floor=${encodeURIComponent(floor)}`:'';
  return api(`/api/projects/${id}/map${query}`);
}

async function resolveFloorMap(requested){
  const order=[];
  const first=pickReadyFloor(project, requested);
  if(first)order.push(first);
  for(const floor of readyFloors(project)){
    if(!order.includes(floor.id))order.push(floor.id);
  }
  for(const floorId of order){
    try{
      doc=await loadFloorMap(projectId, floorId);
      if(floorId!==requested){
        history.replaceState(null,'',editorHref(projectId, floorId));
      }
      return floorId;
    }catch{
      continue;
    }
  }
  return null;
}

function applyFloorChrome(){
  const floorInfo=floorMeta();
  if($('floor-number'))$('floor-number').textContent=floorInfo.code||floorInfo.id||'01';
  if($('floor-description'))$('floor-description').innerHTML=`${escapeHtml(floorInfo.name||'本层')}<br>${escapeHtml(floorInfo.description||'编辑中')}`;
  if($('editor-floor-title'))$('editor-floor-title').textContent=floorInfo.name||floorInfo.id;
  if($('hospital-subtitle')){
    const org=project?institutionName(project):'';
    $('hospital-subtitle').textContent=org
      ?`${org} · ${floorInfo.name||'本层'} · 编辑`
      :`${floorInfo.name||'本层'} · 编辑`;
  }
  if($('back-preview'))$('back-preview').href=previewHref();
  syncDeleteButton();
}

function bindUi(){
  const on= (id, event, handler) => { const el=$(id); if(el) el[event]=handler; };
  on('search','oninput',()=>{term=$('search').value;renderLists();});
  on('clear-search','onclick',()=>{$('search').value='';term='';renderLists();$('search').focus();});
  $('place-name')?.addEventListener('change',renameCurrent);
  on('remove-icon','onclick',removeIcon);
  on('set-start','onclick',()=>setNavEndpoint(selectedPlace()?.id, true));
  on('set-end','onclick',()=>setNavEndpoint(selectedPlace()?.id, false));
  $('room-color-picker')?.addEventListener('change',ev=>applyRoomColor(ev.target.value));
  $('room-color-hex')?.addEventListener('change',ev=>applyRoomColor(ev.target.value));
  on('room-color-reset','onclick',()=>applyRoomColor(''));
  on('start','onchange',()=>{startId=$('start').value;render();});
  on('end','onchange',()=>{endId=$('end').value;render();});
  on('swap','onclick',()=>{if(!endId)return;const a=startId;startId=endId;endId=a;render();});
  on('cancel-place','onclick',()=>{placing=null;$('cancel-place').hidden=true;svg.classList.remove('is-placing');renderPalette();notify('');});
  on('toggle-2d','onclick',()=>setMode('2d'));
  on('toggle-3d','onclick',()=>setMode('3d'));
  on('delete-floor','onclick',deleteFloor);
  svg?.addEventListener('click',ev=>{
    if(skipClick){skipClick=false;return;}
    if(!placing)return;
    placeIcon(toNorm(svgPoint(ev)));
  });
}

async function boot(){
  try{
    renderPalette();
    bindDrag();
    bindUi();
    mountInstitutionSwitcher($('institution-switcher'),{
      getCurrentId:()=>projectId||project?.id||null,
      allowCreate:true,
      onStatus:text=>notify(text,{sticky:true}),
      onRenamed:async record=>{
        if(project&&project.id===record.id){
          project={...project,...record,name:record.name};
          applyFloorChrome();
        }
      },
      onSwitch:async item=>{
        try{localStorage.setItem(STORAGE_KEY, item.id);}catch{}
        const readyFloor=item.activeFloor||'';
        location.href=readyFloor
          ?editorHref(item.id, readyFloor)
          :`./?project=${encodeURIComponent(item.id)}&maker=1`;
      },
      onCleared:async()=>{
        try{localStorage.removeItem(STORAGE_KEY);}catch{}
        location.href='./?maker=1';
      },
      onCreated:async record=>{
        try{localStorage.setItem(STORAGE_KEY, record.id);}catch{}
        location.href=`./?project=${encodeURIComponent(record.id)}`;
      },
    });
    if(!projectId){
      try{projectId=localStorage.getItem(STORAGE_KEY)||'';}catch{projectId='';}
    }
    if(!projectId){
      showEmptyState('还没有工程，先导入图纸并生成 3D');
      return;
    }
    project=await api(`/api/projects/${projectId}`);
    try{localStorage.setItem(STORAGE_KEY, project.id);}catch{}
    const chosen=await resolveFloorMap(requestedFloor);
    if(!chosen){
      showEmptyState('还没有生成好的楼层');
      return;
    }
    pageSize=pageSizeOf(doc);
    view=homeViewForBoundary(doc.geometry?.buildingBoundary, pageSize);
    applyFloorChrome();
    hideLoading();
    render();
    await setMode('2d');
  }catch(error){
    showEmptyState(String(error.message||'加载失败').replace(/。+$/,''));
  }
}

boot();

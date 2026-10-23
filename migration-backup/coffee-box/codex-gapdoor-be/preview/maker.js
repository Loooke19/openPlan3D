import * as pdfjs from '../assets/vendor/pdfjs/pdf.min.mjs';
import {normalizeCrop} from './map-coords.js';
import {loadMapDocument, setProjectFloors, showEmptyInstitutionView, restoreDemoMap} from './viewer.js';
import {createNotifier} from './status.js';
import {institutionName, mountInstitutionSwitcher} from './institutions.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../assets/vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).toString();

const STORAGE_KEY = 'hospital-maker-v1';
const $=id=>document.getElementById(id);
const CN_FLOOR={1:'一',2:'二',3:'三',4:'四',5:'五',6:'六',7:'七',8:'八',9:'九',10:'十'};
let project=null, pdfDoc=null, cropRect=null, drag=null, saving=false, saveQueued=false, building=false, draftPdfLoaded=false;
let createNewInstitution=false;
let institutionUi=null;
let cropZoom=1, cropRenderToken=0, cropFsOpen=false;
const CROP_ZOOM_MIN=0.5, CROP_ZOOM_MAX=4, CROP_ZOOM_STEP=0.25;

function hasReadyFloors(record=project){
  return Object.values(record?.floors||{}).some(floor=>floor?.status==='ready'&&floor?.id);
}

function hasSourcePdf(record=project){
  return !!(record?.draft?.sourceFile?.sha256||record?.sourceFile?.sha256);
}

function awaitingNewFloorPdf(record=project){
  return !!record&&hasReadyFloors(record)&&!draftPdfLoaded;
}

function needsFirstPdf(record=project){
  return !!record&&!hasSourcePdf(record);
}

const status=createNotifier($('maker-status'),{duration:2500});
/** Instructions, progress, and errors stay put; `flash` is for quick confirmations. */
const say=text=>status(text,{sticky:true});
const flash=text=>status(text);

function defaultFloor(pageIndex){
  const n=Number(pageIndex)||1;
  return {id:`${n}F`, name:`${CN_FLOOR[n]||n}楼`, description:''};
}

function cropPayload(){
  if(!cropRect)return null;
  const crop=currentCrop();
  const round=value=>Math.round(value*1000)/1000;
  return {x:round(crop.x),y:round(crop.y),width:round(crop.width),height:round(crop.height)};
}

function selectedSourceKind(){
  return document.querySelector('input[name="maker-source-kind"]:checked')?.value||'';
}

function isCadKind(kind=selectedSourceKind()||project?.draft?.sourceKind){
  return kind==='cad';
}

function setSourceKind(kind){
  for(const input of document.querySelectorAll('input[name="maker-source-kind"]')){
    input.checked=input.value===kind;
  }
  applySourceKindUi();
}

function makerHealthOk(){
  return !!$('maker-offline')?.hidden;
}

function applySourceKindUi(){
  const kind=selectedSourceKind()||project?.draft?.sourceKind||'';
  const cad=kind==='cad';
  $('maker-stage')?.classList.toggle('is-cad', cad);
  const page=$('maker-page');
  if(page){
    page.setAttribute('aria-label', cad?'在 CAD 图纸上拖拽框选有效范围':'在页面上拖拽框选地图范围');
  }
  const hint=$('maker-source-hint');
  if(hint){
    hint.textContent=cad
      ? 'CAD：可框选有效区域后再生成；不框则整页。标尺只用于标定，地图只保留房间名和通道。'
      : kind==='floorplan'
        ? '平面地图：框选楼层范围，排除图例后再生成。'
        : '请先选择图纸类型，再上传 PDF。不要让系统猜测。';
  }
  if($('maker-existing-hint')){
    $('maker-existing-hint').textContent=cad
      ? '选页、填写楼层、框选有效区域（可选），再生成 3D。'
      : '选页、填写楼层、框选地图，再生成 3D。';
  }
  if($('maker-full-page'))$('maker-full-page').hidden=false;
  syncUploadEnabled();
}

function syncUploadEnabled(){
  const upload=$('maker-upload');
  if(!upload)return;
  const showUpload=!project||awaitingNewFloorPdf();
  upload.disabled=!makerHealthOk()||(showUpload&&!selectedSourceKind());
}

function readFloorForm(){
  return {
    id:($('maker-floor-id')?.value||'').trim(),
    name:($('maker-floor-name')?.value||'').trim(),
    description:($('maker-floor-desc')?.value||'').trim(),
  };
}

function fillFloorForm(floor, pageIndex){
  const fallback=defaultFloor(pageIndex||project?.draft?.page?.index||1);
  const value=floor||fallback;
  if($('maker-floor-id'))$('maker-floor-id').value=value.id||fallback.id;
  if($('maker-floor-name'))$('maker-floor-name').value=value.name||fallback.name;
  if($('maker-floor-desc'))$('maker-floor-desc').value=value.description||'';
}

function pageFloor(index){
  const stored=project?.floors?.[String(index)];
  if(stored?.id)return stored;
  if(Number(project?.draft?.page?.index)===Number(index)&&project?.draft?.floor?.id){
    return project.draft.floor;
  }
  return defaultFloor(index);
}

function readyFloorIds(record=project){
  return new Set(
    Object.values(record?.floors||{})
      .filter(floor=>floor?.status==='ready'&&floor?.id)
      .map(floor=>String(floor.id).toUpperCase())
  );
}

/** 「重新生成」仅当表单楼层编号已有 ready 地图；同 PDF 新楼层仍是「生成 3D」。 */
function isRegeneratingReadyFloor(){
  const floorId=(readFloorForm().id||project?.draft?.floor?.id||'').trim().toUpperCase();
  return !!floorId&&readyFloorIds().has(floorId);
}

function editorHref(record, floorId){
  const projectId=record?.id;
  if(!projectId)return '';
  const ready=Object.values(record?.floors||{})
    .filter(floor=>floor?.status==='ready'&&floor.id);
  const chosen=(floorId&&ready.some(floor=>floor.id===floorId)&&floorId)
    ||(record?.activeFloor&&ready.some(floor=>floor.id===record.activeFloor)&&record.activeFloor)
    ||ready[0]?.id;
  if(!chosen)return '';
  return `./edit.html?project=${encodeURIComponent(projectId)}&floor=${encodeURIComponent(chosen)}`;
}

function syncImportMode(){
  const has=!!project;
  const emptyInst=needsFirstPdf();
  const uploadLabel=$('maker-upload-label')||document.querySelector('.maker-upload-label');
  const showUpload=!has||emptyInst||awaitingNewFloorPdf()||createNewInstitution;
  if(uploadLabel)uploadLabel.hidden=!showUpload;
  if($('maker-intro')){
    $('maker-intro').hidden=has&&!emptyInst&&!createNewInstitution;
    if(emptyInst){
      $('maker-intro').textContent='机构已创建。选择图纸类型后上传 PDF，再框选与生成。';
    }else if(!has||createNewInstitution){
      $('maker-intro').textContent='先选择图纸类型，再上传 PDF。平面地图与 CAD 都可框选有效范围；CAD 不框则整页，标尺用于标定、不画进地图。';
    }
  }
  if($('maker-existing-hint'))$('maker-existing-hint').hidden=!has||emptyInst||awaitingNewFloorPdf()||createNewInstitution;
  if($('maker-add-floor-hint'))$('maker-add-floor-hint').hidden=!awaitingNewFloorPdf()||createNewInstitution||emptyInst;
  if($('maker-toggle'))$('maker-toggle').textContent=has&&!emptyInst&&!createNewInstitution?'新增楼层':'导入图纸';
  if($('maker-heading'))$('maker-heading').textContent=has&&!emptyInst&&!createNewInstitution?'新增楼层':'导入图纸';
  if($('maker-institution-name')){
    $('maker-institution-name').textContent=project
      ?(emptyInst?`${institutionName(project)} · 待导入图纸`:institutionName(project))
      :(createNewInstitution?'请先在机构菜单起名创建':'未选择机构');
  }
  applySourceKindUi();
  const href=editorHref(project);
  for(const id of ['edit-map','maker-open-edit']){
    const link=$(id);
    if(!link)continue;
    link.hidden=!href||createNewInstitution||emptyInst;
    if(href)link.href=href;
  }
  institutionUi?.syncCurrent?.();
}

function updateBuildButton(){
  const button=$('maker-build');
  if(!button)return;
  button.classList.toggle('is-busy',building);
  button.setAttribute('aria-busy',building);
  if(building){
    button.textContent='正在生成…';
    button.disabled=true;
    syncImportMode();
    return;
  }
  button.textContent=isRegeneratingReadyFloor()?'重新生成 3D':'生成 3D';
  button.disabled=!project||awaitingNewFloorPdf()||needsFirstPdf();
  syncImportMode();
}

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

function currentCrop(){
  const size=project.draft.page.originalSize;
  return cropRect?normalizeCrop(cropRect, size):null;
}

function setMakerOpen(open){
  if(!open)closeCropFullscreen();
  $('maker-panel').hidden=!open;
  $('maker-toggle').setAttribute('aria-expanded', open);
  if(!open)return;
  $('tools-panel').hidden=true;
  $('tools-toggle').setAttribute('aria-expanded','false');
  if(awaitingNewFloorPdf()){
    $('maker-workspace').hidden=true;
    return;
  }
  if(project&&draftPdfLoaded&&pdfDoc){
    renderPage();
  }
}

async function renderThumbnails(){
  const host=$('maker-thumbs');
  host.replaceChildren();
  if(!pdfDoc)return;
  for(let index=1;index<=pdfDoc.numPages;index++){
    const button=document.createElement('button');
    button.type='button';
    button.className=`maker-thumb${index===project.draft.page.index?' is-active':''}`;
    const floor=project.floors?.[String(index)];
    button.setAttribute('aria-label', floor?.id?`选择第 ${index} 页，${floor.id} ${floor.name||''}`:`选择第 ${index} 页`);
    const canvas=document.createElement('canvas');
    const page=await pdfDoc.getPage(index);
    const viewport=page.getViewport({scale:.18, rotation:0});
    canvas.width=viewport.width;canvas.height=viewport.height;
    await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
    const label=document.createElement('span');
    label.textContent=`第 ${index} 页`;
    button.append(canvas,label);
    if(floor?.id){
      const badge=document.createElement('span');
      badge.className='maker-thumb-floor';
      badge.textContent=floor.name?`${floor.id} ${floor.name}`:floor.id;
      button.append(badge);
    }
    button.onclick=()=>selectPage(index);
    host.append(button);
  }
}

function pagePoint(event, canvas){
  const box=canvas.getBoundingClientRect();
  const size=project.draft.page.originalSize;
  const x=((event.clientX-box.left)/box.width)*size[0];
  const y=((event.clientY-box.top)/box.height)*size[1];
  return [Math.max(0, Math.min(size[0], x)), Math.max(0, Math.min(size[1], y))];
}

function placeCropOverlay(overlay, canvas){
  if(!overlay||!canvas||!project)return;
  const size=project.draft.page.originalSize;
  const crop=currentCrop();
  if(!crop){overlay.style.display='none';return;}
  overlay.style.display='block';
  overlay.style.left=`${(crop.x/size[0])*canvas.clientWidth}px`;
  overlay.style.top=`${(crop.y/size[1])*canvas.clientHeight}px`;
  overlay.style.width=`${(crop.width/size[0])*canvas.clientWidth}px`;
  overlay.style.height=`${(crop.height/size[1])*canvas.clientHeight}px`;
}

function drawCrop(){
  placeCropOverlay($('maker-crop'), $('maker-page'));
  if(cropFsOpen)placeCropOverlay($('maker-crop-fs'), $('maker-page-fs'));
}

function updateCropZoomLabel(){
  const label=$('maker-crop-zoom-label');
  if(label)label.textContent=`${Math.round(cropZoom*100)}%`;
}

function clampCropZoom(value){
  return Math.min(CROP_ZOOM_MAX, Math.max(CROP_ZOOM_MIN, Math.round(value/CROP_ZOOM_STEP)*CROP_ZOOM_STEP));
}

async function renderPage(){
  if(!pdfDoc||!project)return;
  const page=await pdfDoc.getPage(project.draft.page.index);
  const canvas=$('maker-page');
  const maxWidth=Math.max(220, ($('maker-stage')?.clientWidth||260)-16);
  const unscaled=page.getViewport({scale:1, rotation:0});
  const viewport=page.getViewport({scale:maxWidth/unscaled.width, rotation:0});
  canvas.width=viewport.width;canvas.height=viewport.height;
  await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
  drawCrop();
  const floor=pageFloor(project.draft.page.index);
  const floorNote=floor?.id?` · ${floor.id} ${floor.name||''}`:'';
  $('maker-page-label').textContent=`第 ${project.draft.page.index} 页${floorNote} · ${Math.round(project.draft.page.originalSize[0])}×${Math.round(project.draft.page.originalSize[1])}`;
  if(cropFsOpen)await renderFullscreenPage();
}

async function renderFullscreenPage(){
  if(!pdfDoc||!project||!cropFsOpen)return;
  const token=++cropRenderToken;
  const page=await pdfDoc.getPage(project.draft.page.index);
  const canvas=$('maker-page-fs');
  const host=$('maker-crop-viewport');
  if(!canvas||!host)return;
  const unscaled=page.getViewport({scale:1, rotation:0});
  const dpr=Math.min(window.devicePixelRatio||1, 2.5);
  const availW=Math.max(280, host.clientWidth-32);
  const availH=Math.max(200, host.clientHeight-32);
  const fit=Math.min(availW/unscaled.width, availH/unscaled.height);
  const cssScale=fit*cropZoom;
  const viewport=page.getViewport({scale:cssScale*dpr, rotation:0});
  if(token!==cropRenderToken)return;
  canvas.width=Math.max(1, Math.round(viewport.width));
  canvas.height=Math.max(1, Math.round(viewport.height));
  canvas.style.width=`${Math.round(viewport.width/dpr)}px`;
  canvas.style.height=`${Math.round(viewport.height/dpr)}px`;
  await page.render({canvasContext:canvas.getContext('2d',{alpha:false}),viewport}).promise;
  if(token!==cropRenderToken)return;
  placeCropOverlay($('maker-crop-fs'), canvas);
  updateCropZoomLabel();
}

async function setCropZoom(next, {anchorX, anchorY}={}){
  const host=$('maker-crop-viewport');
  const before=cropZoom;
  cropZoom=clampCropZoom(next);
  if(cropZoom===before&&$('maker-page-fs')?.width){
    updateCropZoomLabel();
    return;
  }
  const prevLeft=host?.scrollLeft||0;
  const prevTop=host?.scrollTop||0;
  const relX=host&&Number.isFinite(anchorX)?(anchorX+prevLeft)/Math.max(1, host.scrollWidth):0.5;
  const relY=host&&Number.isFinite(anchorY)?(anchorY+prevTop)/Math.max(1, host.scrollHeight):0.5;
  await renderFullscreenPage();
  if(!host)return;
  host.scrollLeft=Math.max(0, relX*host.scrollWidth-host.clientWidth/2);
  host.scrollTop=Math.max(0, relY*host.scrollHeight-host.clientHeight/2);
}

async function openCropFullscreen(){
  if(!project||!pdfDoc||!$('maker-crop-overlay'))return;
  cropFsOpen=true;
  cropZoom=1;
  $('maker-crop-overlay').hidden=false;
  document.body.style.overflow='hidden';
  updateCropZoomLabel();
  await renderFullscreenPage();
  $('maker-crop-fullscreen-close')?.focus();
}

function closeCropFullscreen(){
  if(!cropFsOpen)return;
  cropFsOpen=false;
  drag=null;
  cropRenderToken++;
  if($('maker-crop-overlay'))$('maker-crop-overlay').hidden=true;
  document.body.style.overflow='';
  drawCrop();
}

async function loadPdf(){
  const bytes=await fetch(project.fileUrl).then(response=>{
    if(!response.ok)throw Error('无法读取 PDF。');
    return response.arrayBuffer();
  });
  pdfDoc=await pdfjs.getDocument({
    data:bytes,
    disableAutoFetch:true,
    disableStream:true,
    isEvalSupported:false,
    isOffscreenCanvasSupported:false,
  }).promise;
  cropRect=project.draft.page.crop;
  await renderThumbnails();
  await renderPage();
}

async function selectPage(index){
  if(!project||index===project.draft.page.index)return;
  const page=project.pages.find(item=>item.index===index);
  project.draft.page.index=index;
  project.draft.page.originalSize=page.originalSize;
  cropRect=null;
  fillFloorForm(pageFloor(index), index);
  await renderThumbnails();
  await renderPage();
  try{await saveDraft();}catch(error){say(error.message);}
}

async function saveDraft(){
  if(!project)return;
  if(needsFirstPdf(project)){
    say('请先导入 PDF，再保存草稿。');
    return;
  }
  // Coalesce concurrent saves (crop mouseup + 生成) so callers always await
  // the latest revision before POST /build.
  if(saving){
    saveQueued=true;
    while(saving) await new Promise(resolve=>setTimeout(resolve,16));
    return;
  }
  saving=true;
  try{
    do{
      saveQueued=false;
      const body={
        revision:project.draft.revision,
        pageIndex:project.draft.page.index,
        rotation:Number($('maker-rotation').value)||0,
        crop:cropPayload(),
        floor:readFloorForm(),
        sourceKind:selectedSourceKind()||project.draft?.sourceKind||'floorplan',
      };
      project=await api(`/api/projects/${project.id}/draft`,{
        method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
      });
      localStorage.setItem(STORAGE_KEY, project.id);
      cropRect=project.draft.page.crop;
      $('maker-rotation').value=String(project.draft.page.rotation||0);
      fillFloorForm(project.draft.floor, project.draft.page.index);
      if(project.draft.sourceKind)setSourceKind(project.draft.sourceKind);
      drawCrop();
      updateBuildButton();
      setProjectFloors(project);
      await renderThumbnails();
      flash('已保存');
    }while(saveQueued);
  }finally{
    saving=false;
  }
}

function readyFloorList(record=project){
  return Object.values(record?.floors||{}).filter(floor=>floor?.status==='ready'&&floor?.id);
}

function pickPreviewFloor(record){
  const ready=readyFloorList(record);
  const requested=new URLSearchParams(location.search).get('floor');
  if(requested&&ready.some(floor=>floor.id===requested))return requested;
  if(record?.activeFloor&&ready.some(floor=>floor.id===record.activeFloor))return record.activeFloor;
  return ready[0]?.id||null;
}

async function openReadyFloorMap(record){
  const floorId=pickPreviewFloor(record);
  if(!floorId)return;
  const map=await api(`/api/projects/${record.id}/map?floor=${encodeURIComponent(floorId)}`);
  await loadMapDocument(map, `${map.floor?.name||floorId} · ${map.pois.length} 个地点`);
}

async function openProject(record){
  project=record;
  createNewInstitution=false;
  localStorage.setItem(STORAGE_KEY, project.id);
  if(project.draft?.sourceKind)setSourceKind(project.draft.sourceKind);
  else setSourceKind('');
  updateBuildButton();
  setProjectFloors(project);
  syncImportMode();
  institutionUi?.refresh?.();
  if(!hasReadyFloors(record)){
    // Never keep the Gifu demo map under an empty / draft institution.
    showEmptyInstitutionView(hasSourcePdf(record)?'草稿 · 生成 3D 后可预览':'待导入图纸');
  }
  if(!hasSourcePdf(record)){
    draftPdfLoaded=false;
    pdfDoc=null;
    cropRect=null;
    $('maker-workspace').hidden=true;
    $('maker-thumbs').replaceChildren();
    fillFloorForm(defaultFloor(1),1);
    return;
  }
  $('maker-rotation').value=String(project.draft?.page?.rotation||0);
  if(hasReadyFloors(record)){
    draftPdfLoaded=false;
    pdfDoc=null;
    cropRect=null;
    $('maker-workspace').hidden=true;
    $('maker-thumbs').replaceChildren();
    await openReadyFloorMap(record);
    return;
  }
  draftPdfLoaded=true;
  $('maker-workspace').hidden=false;
  $('maker-file-name').textContent=project.draft?.sourceFile?.fileName||project.sourceFile?.fileName||'';
  fillFloorForm(project.draft.floor||pageFloor(project.draft.page.index), project.draft.page.index);
  await loadPdf();
}

function clearLocalProject(message){
  localStorage.removeItem(STORAGE_KEY);
  project=null;pdfDoc=null;cropRect=null;draftPdfLoaded=false;
  createNewInstitution=false;
  $('maker-workspace').hidden=true;
  $('maker-thumbs').replaceChildren();
  fillFloorForm(defaultFloor(1),1);
  updateBuildButton();
  setProjectFloors(null);
  syncImportMode();
  institutionUi?.refresh?.();
  restoreDemoMap().catch(error=>say(error.message));
  if(message)flash(message);
}

async function uploadFile(file){
  const kind=selectedSourceKind();
  if(!kind){
    say('请先选择图纸类型：平面地图或 CAD。');
    return;
  }
  if(!project){
    say('请先在右上角「机构」菜单新建并命名机构，再导入图纸。');
    institutionUi?.beginCreate?.();
    return;
  }
  if(needsFirstPdf(project)||createNewInstitution){
    const data=new FormData();
    data.append('file', file, file.name);
    data.append('sourceKind', kind);
    say('正在上传…');
    const record=await api(`/api/projects/${project.id}/source`,{method:'POST',body:data});
    say('正在读取页面…');
    await openProject(record);
    flash(`已导入「${institutionName(record)}」，共 ${record.pages.length} 页`);
    return;
  }
  if(!hasReadyFloors()){
    say('要换文件，请先清除本机记录，或新建机构。');
    return;
  }
  const data=new FormData();
  data.append('file', file, file.name);
  data.append('sourceKind', kind);
  say('正在上传…');
  const record=await api(`/api/projects/${project.id}/floor-pdf`,{method:'POST',body:data});
  say('正在读取页面…');
  project=record;
  draftPdfLoaded=true;
  localStorage.setItem(STORAGE_KEY, project.id);
  $('maker-workspace').hidden=false;
  $('maker-file-name').textContent=record.draft?.sourceFile?.fileName||record.sourceFile.fileName;
  $('maker-rotation').value=String(project.draft.page.rotation||0);
  fillFloorForm(project.draft.floor, project.draft.page.index);
  updateBuildButton();
  setProjectFloors(project);
  syncImportMode();
  await loadPdf();
  flash(`已上传，共 ${record.pages.length} 页`);
}

function buildSuccessMessage(result){
  const map=result?.map||{};
  const report=result?.report||{};
  const parts=[
    `已生成 ${map.floor?.name||map.floorId||''}`.trim(),
    `${map.pois?.length||0} 个地点`,
    `${map.geometry?.obstacles?.length||0} 个房间`,
  ];
  const cal=report.cadCalibration||map.calibration;
  if(cal?.metersPerMapUnit||cal?.ratio){
    parts.push(cal.ratio?`已标定 ${cal.ratio}`:'已标定');
  }
  if(report.rulersHidden){
    parts.push('已隐藏标尺带');
  }
  return parts.filter(Boolean).join(' · ');
}

async function generateMap(){
  if(!project||building)return;
  const floor=readFloorForm();
  if(!floor.id||!floor.name){
    say('请填写楼层编号和名称。');
    $(floor.id?'maker-floor-name':'maker-floor-id')?.focus();
    return;
  }
  building=true;
  updateBuildButton();
  try{
    await saveDraft();
    say(`正在生成 ${project.draft.floor.name}…`);
    let result;
    try{
      result=await api(`/api/projects/${project.id}/build`,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({revision:project.draft.revision}),
      });
    }catch(error){
      // One retry after reload if a racing draft bump beat this build.
      if(!/草稿已被更新/.test(String(error?.message||''))) throw error;
      project=await api(`/api/projects/${project.id}`);
      await saveDraft();
      say(`正在生成 ${project.draft.floor.name}…`);
      result=await api(`/api/projects/${project.id}/build`,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({revision:project.draft.revision}),
      });
    }
    project=result.project;
    localStorage.setItem(STORAGE_KEY, project.id);
    setProjectFloors(project);
    updateBuildButton();
    await loadMapDocument(result.map, buildSuccessMessage(result));
    draftPdfLoaded=false;
    pdfDoc=null;
    cropRect=null;
    closeCropFullscreen();
    $('maker-workspace').hidden=true;
    $('maker-thumbs').replaceChildren();
    syncImportMode();
    setMakerOpen(false);
  }catch(error){
    say(error.message);
  }finally{
    building=false;
    updateBuildButton();
  }
}

function bindCropOn(canvas){
  if(!canvas)return;
  canvas.onpointerdown=event=>{
    if(!project)return;
    canvas.setPointerCapture(event.pointerId);
    const [x,y]=pagePoint(event, canvas);
    drag={x,y,canvas};
    cropRect={x,y,width:1,height:1};
    drawCrop();
  };
  canvas.onpointermove=event=>{
    if(!drag||drag.canvas!==canvas)return;
    const [x,y]=pagePoint(event, canvas);
    cropRect=normalizeCrop({
      x:Math.min(drag.x,x),
      y:Math.min(drag.y,y),
      width:Math.abs(x-drag.x)||1,
      height:Math.abs(y-drag.y)||1,
    }, project.draft.page.originalSize);
    drawCrop();
  };
  canvas.onpointerup=async()=>{
    if(!drag||drag.canvas!==canvas)return;
    drag=null;
    const size=project.draft.page.originalSize;
    const crop=currentCrop();
    if(crop&&(crop.width<size[0]*0.02||crop.height<size[1]*0.02)){
      cropRect=project.draft.page.crop;
      drawCrop();
      return;
    }
    try{await saveDraft();}catch(error){say(error.message);}
  };
  canvas.onpointercancel=()=>{if(drag?.canvas===canvas)drag=null;};
}

function bindCrop(){
  bindCropOn($('maker-page'));
  bindCropOn($('maker-page-fs'));
  const panelCrop=$('maker-crop');
  if(panelCrop){
    const openFs=event=>{
      event.preventDefault();
      event.stopPropagation();
      openCropFullscreen().catch(error=>say(error.message));
    };
    panelCrop.onclick=openFs;
    panelCrop.onkeydown=event=>{
      if(event.key==='Enter'||event.key===' ')openFs(event);
    };
  }
  $('maker-crop-fullscreen-open')?.addEventListener('click',()=>{
    openCropFullscreen().catch(error=>say(error.message));
  });
  $('maker-crop-fullscreen-close')?.addEventListener('click',closeCropFullscreen);
  $('maker-crop-zoom-in')?.addEventListener('click',()=>{
    setCropZoom(cropZoom+CROP_ZOOM_STEP).catch(error=>say(error.message));
  });
  $('maker-crop-zoom-out')?.addEventListener('click',()=>{
    setCropZoom(cropZoom-CROP_ZOOM_STEP).catch(error=>say(error.message));
  });
  $('maker-crop-zoom-reset')?.addEventListener('click',()=>{
    setCropZoom(1).catch(error=>say(error.message));
  });
  const viewport=$('maker-crop-viewport');
  viewport?.addEventListener('wheel',event=>{
    if(!cropFsOpen)return;
    event.preventDefault();
    const delta=event.deltaY>0?-CROP_ZOOM_STEP:CROP_ZOOM_STEP;
    const box=viewport.getBoundingClientRect();
    setCropZoom(cropZoom+delta,{
      anchorX:event.clientX-box.left,
      anchorY:event.clientY-box.top,
    }).catch(error=>say(error.message));
  },{passive:false});
  window.addEventListener('resize',()=>{
    if(cropFsOpen)renderFullscreenPage().catch(()=>{});
  });
}

async function boot(){
  if(!$('maker-panel'))return;
  $('maker-toggle').onclick=()=>setMakerOpen($('maker-panel').hidden);
  $('maker-close').onclick=()=>{setMakerOpen(false);$('maker-toggle').focus();};
  document.addEventListener('keydown',ev=>{
    if(ev.key!=='Escape')return;
    if(cropFsOpen){
      closeCropFullscreen();
      $('maker-crop-fullscreen-open')?.focus();
      return;
    }
    if(!$('maker-panel').hidden){
      setMakerOpen(false);
      $('maker-toggle').focus();
    }
  });
  const health=await fetch('/api/health').then(r=>r.ok?r.json():null).catch(()=>null);
  $('maker-offline').hidden=!!health;
  if($('maker-build'))$('maker-build').disabled=!health;
  applySourceKindUi();
  if(!health){
    if($('maker-upload'))$('maker-upload').disabled=true;
    return;
  }
  bindCrop();
  for(const input of document.querySelectorAll('input[name="maker-source-kind"]')){
    input.addEventListener('change', async()=>{
      applySourceKindUi();
      if(!project)return;
      try{await saveDraft();}catch(error){say(error.message);}
    });
  }
  $('maker-upload').onchange=async event=>{
    const file=event.target.files?.[0];
    event.target.value='';
    if(!file)return;
    try{await uploadFile(file);}catch(error){say(error.message);}
  };
  $('maker-save').onclick=async()=>{try{await saveDraft();}catch(error){say(error.message);}};
  $('maker-build').onclick=generateMap;
  $('maker-full-page').onclick=async()=>{
    cropRect=null;
    drawCrop();
    try{await saveDraft();}catch(error){say(error.message);}
  };
  $('maker-rotation').onchange=async()=>{try{await saveDraft();}catch(error){say(error.message);}};
  for(const id of ['maker-floor-id','maker-floor-name','maker-floor-desc']){
    $(id)?.addEventListener('input',()=>updateBuildButton());
    $(id)?.addEventListener('change',async()=>{try{await saveDraft();}catch(error){say(error.message);}});
  }
  $('maker-forget').onclick=()=>{
    clearLocalProject('已清除本机记录');
  };
  institutionUi=mountInstitutionSwitcher($('institution-switcher'),{
    getCurrentId:()=>project?.id||localStorage.getItem(STORAGE_KEY),
    onStatus:text=>say(text),
    onRenamed:async record=>{
      if(project&&project.id===record.id){
        project={...project,...record,name:record.name};
        syncImportMode();
      }
    },
    onSwitch:async item=>{
      const record=await api(`/api/projects/${item.id}`);
      await openProject(record);
      flash(`已切换到「${institutionName(record)}」`);
    },
    onCleared:async()=>{
      clearLocalProject();
    },
    onCreated:async record=>{
      createNewInstitution=false;
      await openProject(record);
      // Do not open the maker panel or file picker — user imports PDF manually later.
      setMakerOpen(false);
      flash(`已创建「${institutionName(record)}」`);
    },
  });
  const params=new URLSearchParams(location.search);
  if(params.get('newInstitution')==='1'){
    createNewInstitution=false;
    project=null;
    pdfDoc=null;
    cropRect=null;
    draftPdfLoaded=false;
    localStorage.removeItem(STORAGE_KEY);
    closeCropFullscreen();
    $('maker-workspace').hidden=true;
    $('maker-thumbs').replaceChildren();
    fillFloorForm(defaultFloor(1),1);
    setSourceKind('');
    updateBuildButton();
    setProjectFloors(null);
    syncImportMode();
    setMakerOpen(false);
    institutionUi?.beginCreate?.();
    say('请填写机构名称后创建；图纸稍后导入。');
  }else{
    const fromQuery=params.get('project');
    const saved=fromQuery||localStorage.getItem(STORAGE_KEY);
    if(saved){
      try{
        await openProject(await api(`/api/projects/${saved}`));
      }catch(error){
        localStorage.removeItem(STORAGE_KEY);
        say(error.message);
      }
    }
    if(params.get('maker')==='1')setMakerOpen(true);
  }
}

boot();

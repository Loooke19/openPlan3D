/** Institution (project) switcher shared by preview maker and editor. */

export const INSTITUTION_STORAGE_KEY = 'hospital-maker-v1';

function escapeHtml(text){
  return String(text??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
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

export function institutionName(record){
  if(!record)return '未选择机构';
  const name=String(record.name||'').trim();
  if(name)return name;
  const file=record.sourceFileName||record.sourceFile?.fileName||record.draft?.sourceFile?.fileName||'';
  const stem=String(file).replace(/\.pdf$/i,'').trim();
  return stem||'未命名机构';
}

export function mountInstitutionSwitcher(root, options={}){
  if(!root)return null;
  const {
    getCurrentId=()=>null,
    onSwitch=async()=>{},
    onCleared=async()=>{},
    onCreateNew=null,
    onCreated=null,
    onStatus=()=>{},
    allowCreate=true,
    compact=false,
  }=options;

  root.classList.add('institution-switcher');
  root.innerHTML=`
    <button type="button" class="institution-trigger ambient amb-surface amb-chamfer amb-elevation-1" aria-expanded="false" aria-controls="${root.id||'institution-panel'}-menu">
      <span class="institution-trigger-label">机构</span>
      <strong class="institution-current-name">未选择机构</strong>
      <span class="institution-caret" aria-hidden="true">▾</span>
    </button>
    <div class="institution-menu" id="${root.id||'institution-panel'}-menu" hidden>
      <p class="institution-menu-title">切换机构</p>
      <p class="muted institution-menu-hint">每个机构的地图与工程相互隔离。</p>
      <div class="institution-list" role="listbox" aria-label="机构列表"></div>
      <div class="institution-create" hidden>
        <p class="institution-create-title">新建机构</p>
        <p class="muted institution-create-hint">先起名保存；图纸稍后在「导入图纸」里上传，不会自动弹出文件选择。</p>
        <label class="institution-name-label">机构名称<input class="institution-create-input" type="text" maxlength="40" autocomplete="organization" placeholder="例如 岐阜大学医院"></label>
        <div class="institution-edit-row">
          <button type="button" class="institution-create-cancel">取消</button>
          <button type="button" class="institution-create-save">创建</button>
        </div>
      </div>
      <div class="institution-edit" hidden>
        <label class="institution-name-label">机构名称<input class="institution-name-input" type="text" maxlength="40" autocomplete="off" placeholder="例如 岐阜大学医院"></label>
        <div class="institution-edit-row">
          <button type="button" class="institution-rename">保存名称</button>
          <button type="button" class="institution-delete danger-text">删除机构</button>
        </div>
        <div class="institution-delete-confirm" hidden>
          <p class="institution-delete-copy">删除后无法恢复，确认删除该机构及其全部地图？</p>
          <div class="institution-edit-row">
            <button type="button" class="institution-delete-cancel">取消</button>
            <button type="button" class="institution-delete-confirm-btn danger-text">确认删除</button>
          </div>
        </div>
      </div>
      <div class="institution-actions">
        ${allowCreate?'<button type="button" class="institution-new">新建机构</button>':''}
        <button type="button" class="institution-refresh">刷新列表</button>
      </div>
    </div>
  `;
  if(compact)root.classList.add('is-compact');

  const trigger=root.querySelector('.institution-trigger');
  const menu=root.querySelector('.institution-menu');
  const list=root.querySelector('.institution-list');
  const createPanel=root.querySelector('.institution-create');
  const createInput=root.querySelector('.institution-create-input');
  const createCancel=root.querySelector('.institution-create-cancel');
  const createSave=root.querySelector('.institution-create-save');
  const edit=root.querySelector('.institution-edit');
  const nameInput=root.querySelector('.institution-name-input');
  const renameBtn=root.querySelector('.institution-rename');
  const deleteBtn=root.querySelector('.institution-delete');
  const deleteConfirm=root.querySelector('.institution-delete-confirm');
  const deleteCancel=root.querySelector('.institution-delete-cancel');
  const deleteConfirmBtn=root.querySelector('.institution-delete-confirm-btn');
  const deleteCopy=root.querySelector('.institution-delete-copy');
  const nameEl=root.querySelector('.institution-current-name');
  const newBtn=root.querySelector('.institution-new');
  const refreshBtn=root.querySelector('.institution-refresh');
  const actions=root.querySelector('.institution-actions');

  let items=[];
  let busy=false;
  let pendingDeleteId=null;
  let creating=false;

  function setOpen(open){
    menu.hidden=!open;
    trigger.setAttribute('aria-expanded', open?'true':'false');
    root.classList.toggle('is-open', open);
    if(!open){
      hideDeleteConfirm();
      setCreating(false);
    }else{
      hideDeleteConfirm();
    }
  }

  function setCreating(on){
    creating=!!on;
    if(createPanel)createPanel.hidden=!creating;
    if(list)list.hidden=creating;
    if(edit)edit.hidden=creating||!getCurrentId()||!items.find(item=>item.id===getCurrentId());
    if(actions)actions.hidden=creating;
    if(creating){
      hideDeleteConfirm();
      if(createInput){
        createInput.value='';
        queueMicrotask(()=>createInput.focus());
      }
    }
  }

  function hideDeleteConfirm(){
    pendingDeleteId=null;
    if(deleteConfirm)deleteConfirm.hidden=true;
    if(deleteBtn)deleteBtn.hidden=false;
  }

  function showDeleteConfirm(item){
    pendingDeleteId=item.id;
    if(deleteCopy){
      deleteCopy.textContent=`删除「${institutionName(item)}」后无法恢复，将清除该机构下全部地图与工程。请再次确认。`;
    }
    if(deleteConfirm)deleteConfirm.hidden=false;
    if(deleteBtn)deleteBtn.hidden=true;
  }

  function statusLabel(item){
    const floors=Number(item.floorCount||0);
    if(item.status==='ready')return `${floors} 层地图`;
    if(item.status==='failed')return '生成失败';
    if(item.status==='empty'||(!item.sourceFileName&&floors===0))return '空机构 · 待导入图纸';
    return '草稿';
  }

  function syncCurrent(){
    const currentId=getCurrentId();
    const current=items.find(item=>item.id===currentId)||null;
    nameEl.textContent=current?institutionName(current):(currentId?'当前机构':'演示地图 / 未选择');
    if(!creating){
      edit.hidden=!current;
      if(current){
        nameInput.value=institutionName(current);
        nameInput.dataset.projectId=current.id;
      }else{
        nameInput.value='';
        delete nameInput.dataset.projectId;
      }
    }
    hideDeleteConfirm();
    for(const button of list.querySelectorAll('button[data-id]')){
      const active=button.dataset.id===currentId;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', active?'true':'false');
    }
  }

  function renderList(){
    list.replaceChildren();
    if(!items.length){
      const empty=document.createElement('p');
      empty.className='muted institution-empty';
      empty.textContent='还没有机构。点「新建机构」起名创建；图纸稍后导入。';
      list.append(empty);
      syncCurrent();
      return;
    }
    for(const item of items){
      const button=document.createElement('button');
      button.type='button';
      button.dataset.id=item.id;
      button.setAttribute('role','option');
      button.innerHTML=`<strong>${escapeHtml(institutionName(item))}</strong><span>${escapeHtml(statusLabel(item))}</span>`;
      button.onclick=async()=>{
        if(busy||item.id===getCurrentId()){setOpen(false);return;}
        busy=true;
        try{
          await onSwitch(item);
          setOpen(false);
          await refresh();
        }catch(error){
          onStatus(error.message||String(error));
        }finally{
          busy=false;
        }
      };
      list.append(button);
    }
    syncCurrent();
  }

  async function refresh(){
    try{
      const payload=await api('/api/projects');
      items=payload.projects||[];
      renderList();
    }catch(error){
      items=[];
      renderList();
      onStatus(error.message||String(error));
    }
  }

  function beginCreate(){
    setOpen(true);
    setCreating(true);
  }

  trigger.addEventListener('click',async ev=>{
    ev.stopPropagation();
    const willOpen=menu.hidden;
    setOpen(willOpen);
    if(willOpen)await refresh();
  });

  document.addEventListener('click',ev=>{
    if(!root.contains(ev.target))setOpen(false);
  });

  document.addEventListener('keydown',ev=>{
    if(ev.key==='Escape'&&!menu.hidden)setOpen(false);
  });

  renameBtn.addEventListener('click',async()=>{
    const id=nameInput.dataset.projectId||getCurrentId();
    const name=nameInput.value.trim();
    if(!id||!name||busy)return;
    busy=true;
    try{
      const record=await api(`/api/projects/${id}`,{
        method:'PATCH',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({name}),
      });
      onStatus(`已更新机构名称：${institutionName(record)}`);
      await refresh();
      if(typeof options.onRenamed==='function')await options.onRenamed(record);
    }catch(error){
      onStatus(error.message||String(error));
    }finally{
      busy=false;
    }
  });

  deleteBtn.addEventListener('click',()=>{
    const id=nameInput.dataset.projectId||getCurrentId();
    const item=items.find(entry=>entry.id===id);
    if(!item)return;
    showDeleteConfirm(item);
  });

  deleteCancel.addEventListener('click',()=>hideDeleteConfirm());

  deleteConfirmBtn.addEventListener('click',async()=>{
    const id=pendingDeleteId||nameInput.dataset.projectId||getCurrentId();
    if(!id||busy)return;
    busy=true;
    try{
      const removed=await api(`/api/projects/${id}`,{method:'DELETE'});
      onStatus(`已删除机构「${institutionName(removed)}」`);
      hideDeleteConfirm();
      if(getCurrentId()===id)await onCleared(removed);
      await refresh();
      setOpen(false);
    }catch(error){
      onStatus(error.message||String(error));
    }finally{
      busy=false;
    }
  });

  refreshBtn.addEventListener('click',()=>refresh());

  createCancel?.addEventListener('click',()=>setCreating(false));

  createSave?.addEventListener('click',async()=>{
    const name=(createInput?.value||'').trim();
    if(!name){
      onStatus('请填写机构名称。');
      createInput?.focus();
      return;
    }
    if(busy)return;
    busy=true;
    try{
      const record=await api('/api/projects/empty',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({name}),
      });
      setCreating(false);
      await refresh();
      if(typeof onCreated==='function')await onCreated(record);
      else await onSwitch(record);
      onStatus(`已创建机构「${institutionName(record)}」。需要时再点「导入图纸」上传 PDF。`);
      setOpen(false);
    }catch(error){
      onStatus(error.message||String(error));
    }finally{
      busy=false;
    }
  });

  createInput?.addEventListener('keydown',ev=>{
    if(ev.key==='Enter'){
      ev.preventDefault();
      createSave?.click();
    }
  });

  if(newBtn){
    newBtn.addEventListener('click',()=>{
      // Always collect a name in-menu. Do not open the OS file picker here.
      setCreating(true);
    });
  }

  refresh();
  return {
    refresh,
    syncCurrent,
    setOpen,
    beginCreate,
    root,
  };
}

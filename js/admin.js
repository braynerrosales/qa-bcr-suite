// QA BCR Suite — Administración: pestañas, personas y reglas del Daily, proyectos y plantillas, respaldo.
/* ============ ADMIN: TABS ============ */
function selectAdminTab(tab){
  document.querySelectorAll('.admin-tab-btn').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.admin-section').forEach(s=>s.classList.remove('active'));
  const tb=document.getElementById('atab-'+tab);tb.classList.add('active');
  if(tb.offsetParent)tb.scrollIntoView({block:'nearest',inline:'nearest'});
  document.getElementById('asec-'+tab).classList.add('active');
  if(tab==='users')renderUsersAdmin();
  if(tab==='feedback')loadFeedbackAdmin();
}
function renderAdmin(){renderPeopleAdmin();renderRulesAdmin();renderTaskProjectList();}

/* ============ ADMIN: PERSONAS (CRUD) ============ */
// Color de proyecto para style="": solo #rrggbb (la base también lo exige), nunca otro CSS.
function projColor(c){return /^#[0-9a-f]{6}$/i.test(c||'')?c:'#888888';}
function escapeHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
function renderPeopleAdmin(){
  ['daily1','daily2'].forEach(dk=>{
    const list=DB.people[dk],box=document.getElementById('list-people-'+dk);
    box.innerHTML=list.length?list.map(name=>`<div class="crud-item"><span class="crud-item-name">${escapeHtml(name)}</span><button class="crud-btn-del crud-btn-edit" data-daily="${dk}" data-name="${escapeHtml(name)}" data-click="renamePerson" title="Editar">Editar</button><button class="crud-btn-del" data-daily="${dk}" data-name="${escapeHtml(name)}" data-click="removePerson" title="Eliminar">Quitar</button></div>`).join(''):`<div class="crud-empty">Sin personas aún.</div>`;
  });
}
async function renamePerson(dk,oldName){
  const newName=await uiPrompt('Nombre',oldName,{title:'Editar persona'});
  if(newName===null)return;
  const trimmed=newName.trim();
  if(!trimmed||trimmed===oldName)return;
  if(DB.people[dk].includes(trimmed)){uiAlert('Ya existe una persona con ese nombre en esta lista.');return;}
  const id=REFS.members[memberKey(dk,oldName)];
  if(!id)return;
  await persist(async()=>check(await supabaseClient.from('daily_members').update({name:trimmed}).eq('id',id).select('id'),true));
}
async function addPerson(dk){
  const input=document.getElementById('newp-'+dk),name=input.value.trim();
  if(!name)return;
  if(DB.people[dk].includes(name)){input.value='';return;}
  const groupId=REFS.groups[dk];
  if(!groupId){uiError(`No existe el grupo ${dk} en Supabase. Cargá los datos iniciales (seed.sql).`);return;}
  const existing=REFS.members[memberKey(dk,name)];
  const ok=await persist(async()=>{
    if(existing)check(await supabaseClient.from('daily_members').update({active:true}).eq('id',existing).select('id'),true);
    else check(await supabaseClient.from('daily_members').insert({daily_group_id:groupId,name}));
  });
  if(ok)input.value='';
}
async function removePerson(dk,name){
  if(!await uiConfirm('Deja de salir en el sorteo. El historial del Daily conserva su nombre.',{title:`¿Quitar a "${name}" de ${dk==='daily1'?'Daily 1':'Daily 2'}?`,ok:'Quitar',danger:true}))return;
  const id=REFS.members[memberKey(dk,name)];
  if(!id)return;
  // Se borra la persona y sus reglas; el histórico del Daily conserva el nombre.
  await persist(async()=>check(await supabaseClient.from('daily_members').delete().eq('id',id).select('id'),true));
}

/* ============ ADMIN: REGLA DE PRIMEROS (CRUD + rango) ============ */
function renderRulesAdmin(){
  ['daily1','daily2'].forEach(dk=>{
    const rule=DB.rules[dk],people=DB.people[dk];
    document.getElementById('range-'+dk).value=rule.range;
    document.getElementById('range-'+dk).max=people.length;
    const box=document.getElementById('list-rules-'+dk);
    box.innerHTML=people.length?people.map(name=>{
      const inFirst=rule.firstGroup.includes(name),inLast=rule.lastFixed.includes(name);
      return `<div class="crud-item">
        <span class="crud-item-name">${escapeHtml(name)}</span>
        <label class="crud-label-small"><input type="checkbox" class="crud-checkbox" data-daily="${dk}" data-name="${escapeHtml(name)}" ${inFirst?'checked':''} data-change="toggleFirstRule"> En regla de primeros</label>
        <label class="crud-label-small"><input type="checkbox" class="crud-checkbox" data-daily="${dk}" data-name="${escapeHtml(name)}" ${inLast?'checked':''} data-change="toggleLastFixed"> Fijo al final</label>
      </div>`;
    }).join(''):`<div class="crud-empty">Agregá personas primero.</div>`;
  });
}
// Una persona tiene como máximo una regla (unique en daily_rule_members):
// marcar una reemplaza la otra con un upsert.
async function setRule(dk,name,ruleType,checked){
  const id=REFS.members[memberKey(dk,name)];
  if(!id)return;
  await persist(async()=>{
    if(checked)check(await supabaseClient.from('daily_rule_members').upsert({daily_member_id:id,rule_type:ruleType},{onConflict:'daily_member_id'}));
    else check(await supabaseClient.from('daily_rule_members').delete().eq('daily_member_id',id).eq('rule_type',ruleType));
  });
}
function toggleFirstRule(dk,name,checked){return setRule(dk,name,'FIRST_GROUP',checked);}
function toggleLastFixed(dk,name,checked){return setRule(dk,name,'LAST_FIXED',checked);}
async function setRange(dk,value){
  const n=parseInt(value,10),range=isNaN(n)||n<1?1:n;
  const groupId=REFS.groups[dk];
  if(!groupId){renderRulesAdmin();return;}
  await persist(async()=>check(await supabaseClient.from('daily_rules').upsert({daily_group_id:groupId,first_range:range},{onConflict:'daily_group_id'})));
}

/* ============ ADMIN: TAREAS / PROYECTOS (CRUD) ============ */
let selectedAdminProject=null,selectedAdminVariant='';
function renderTaskProjectList(){
  const box=document.getElementById('task-project-list');
  const keys=Object.keys(DB.projects);
  box.innerHTML=keys.map(k=>`<button class="proj-btn ${k===selectedAdminProject?'active':''}" data-code="${escapeHtml(k)}" data-click="selectAdminProject"><span class="proj-dot" style="background:${projColor(DB.projects[k].color)}"></span> ${escapeHtml(k)}</button>`).join('');
  if(selectedAdminProject&&!DB.projects[selectedAdminProject]){selectedAdminProject=null;document.getElementById('task-editor-wrap').style.display='none';}
  else if(selectedAdminProject)fillVariantSelect(selectedAdminVariant);
}
function fillVariantSelect(preferred){
  const variants=DB.projects[selectedAdminProject].variants,vsel=document.getElementById('task-variant-select');
  vsel.innerHTML=variants.length?variants.map(v=>`<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join(''):`<option value="">(sin variante)</option>`;
  if(preferred&&variants.includes(preferred))vsel.value=preferred;
  renderTaskEditor();
}
function selectAdminProject(key){
  selectedAdminProject=key;selectedAdminVariant='';
  renderTaskProjectList();
  document.getElementById('task-editor-wrap').style.display='block';
}
function renderTaskEditor(){
  if(!selectedAdminProject)return;
  const vsel=document.getElementById('task-variant-select');
  selectedAdminVariant=vsel.value;
  const tasks=DB.projects[selectedAdminProject].templates[selectedAdminVariant]||[];
  document.getElementById('task-textarea').value=tasks.join('\n');
}
async function saveTaskEditor(btn){
  if(!selectedAdminProject)return;
  const lines=document.getElementById('task-textarea').value.split('\n').map(l=>l.trim()).filter(Boolean);
  const projectId=REFS.projects[selectedAdminProject];
  const variantId=selectedAdminVariant?REFS.variants[variantKey(selectedAdminProject,selectedAdminVariant)]:null;
  if(!projectId||(selectedAdminVariant&&!variantId))return;
  const ok=await persist(async()=>check(await supabaseClient.rpc('save_template',{p_project_id:projectId,p_variant_id:variantId,p_tasks:lines})));
  if(ok&&btn){const old=btn.textContent;btn.textContent='Guardada';setTimeout(()=>btn.textContent=old,1500);}
}
async function addProject(){
  const input=document.getElementById('new-project'),name=input.value.trim().toUpperCase();
  if(!name)return;
  if(DB.projects[name]){input.value='';selectAdminProject(name);return;}
  const usedColors=Object.values(DB.projects).map(p=>p.color),color=PALETTE.find(c=>!usedColors.includes(c))||PALETTE[Object.keys(DB.projects).length%PALETTE.length];
  const existing=REFS.projects[name];
  const ok=await persist(async()=>{
    if(existing)check(await supabaseClient.from('projects').update({active:true}).eq('id',existing).select('id'),true);
    else check(await supabaseClient.from('projects').insert({code:name,name,color}));
  });
  if(ok){input.value='';if(DB.projects[name])selectAdminProject(name);}
}
async function removeProject(){
  if(!selectedAdminProject)return;
  if(!await uiConfirm('Se borran también todas sus variantes y plantillas.',{title:`¿Eliminar el proyecto "${selectedAdminProject}"?`,ok:'Eliminar',danger:true}))return;
  const id=REFS.projects[selectedAdminProject];
  if(!id)return;
  // El historial del QA Generator conserva el nombre del proyecto.
  await persist(async()=>check(await supabaseClient.from('projects').delete().eq('id',id).select('id'),true));
}
async function addVariant(){
  if(!selectedAdminProject)return;
  const input=document.getElementById('new-variant'),name=input.value.trim();
  if(!name)return;
  const proj=DB.projects[selectedAdminProject];
  if(proj.variants.includes(name)){input.value='';fillVariantSelect(name);return;}
  const projectId=REFS.projects[selectedAdminProject],existing=REFS.variants[variantKey(selectedAdminProject,name)];
  if(!projectId)return;
  selectedAdminVariant=name;
  const ok=await persist(async()=>{
    if(existing)check(await supabaseClient.from('project_variants').update({active:true}).eq('id',existing).select('id'),true);
    else check(await supabaseClient.from('project_variants').insert({project_id:projectId,name}));
  });
  if(ok)input.value='';
}
async function removeVariant(){
  if(!selectedAdminProject)return;
  const variant=document.getElementById('task-variant-select').value;
  if(!variant){uiAlert('Este proyecto no tiene variante seleccionada para eliminar.');return;}
  if(!await uiConfirm('Se borra también su plantilla.',{title:`¿Eliminar la variante "${variant}"?`,ok:'Eliminar',danger:true}))return;
  const id=REFS.variants[variantKey(selectedAdminProject,variant)];
  if(!id)return;
  selectedAdminVariant='';
  await persist(async()=>check(await supabaseClient.from('project_variants').delete().eq('id',id).select('id'),true));
}

/* ============ ADMIN: RESPALDO ============ */
function exportData(){
  const blob=new Blob([JSON.stringify(DB,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download='qa-bcr-suite-config.json';document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(url);
  setBackupStatus('Configuración exportada como qa-bcr-suite-config.json');
}

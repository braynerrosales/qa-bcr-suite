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
function renderAdmin(){renderPeopleAdmin();renderRulesAdmin();}

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

/* ============ ADMIN: RESPALDO ============ */
function exportData(){
  const blob=new Blob([JSON.stringify(DB,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download='qa-bcr-suite-config.json';document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(url);
  setBackupStatus('Configuración exportada como qa-bcr-suite-config.json');
}

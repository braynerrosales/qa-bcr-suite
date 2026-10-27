// QA BCR Suite — Solicitudes (QA Lead y Admin) e informes semanales.
/* ============ SOLICITUDES (solo QA Lead y Admin; el RLS lo hace cumplir) ============ */
let SOL=[];
const SOL_CHECKS=[['informe_semanal','Informe semanal'],['pend_plan','Pendiente de plan'],['pend_actualizar','Pendiente de actualizar'],['plan_enviado','Plan enviado'],['cierre_enviado','Cierre enviado']];
function setSolStatus(kind,text){const st=document.getElementById('sol-status');st.className=kind?'status-msg '+kind:'status-msg';st.textContent=text||'';}
let SOL_NAMES=new Map(),solChannel=null,solLiveOnce=false;
// idle: es una recarga automática; si mientras tanto alguien empezó a editar, no pisa lo que escribe.
async function loadSolicitudes(idle=false){
  if(!canViewSolicitudes())return;
  const [{data,error},people]=await Promise.all([
    supabaseClient.from('solicitudes').select('*').order('id'),
    supabaseClient.from('profiles').select('id,full_name')
  ]);
  if(idle&&solEditing())return;
  if(error){setSolStatus('error','No se pudieron cargar las solicitudes'+errorDetail(error)+'.');return;}
  if(!people.error)SOL_NAMES=new Map((people.data||[]).map(p=>[p.id,p.full_name]));
  SOL=data||[];setSolStatus('');renderSolicitudes();
  solSubscribe();
  return true;
}
// Tiempo real: los cambios de otros leads llegan solos (Supabase Realtime, con el
// mismo RLS que la tabla). Si la conexión se corta, al volver se recarga la lista
// para no perder lo que cambió mientras tanto.
function solSubscribe(){
  if(solChannel||!canViewSolicitudes())return;
  solChannel=supabaseClient.channel('solicitudes')
    .on('postgres_changes',{event:'*',schema:'public',table:'solicitudes'},solOnChange)
    .subscribe(solOnStatus);
}
function solOnStatus(status){
  const live=status==='SUBSCRIBED';
  document.getElementById('sol-live').hidden=!live;
  // Al reconectar se trae lo que no llegó en vivo, sin pisar una edición en curso.
  if(live){if(solLiveOnce){loadSolicitudes(true);solBadgeSoon();}solLiveOnce=true;}
}
// Por si un cambio no llegó en vivo (conexión caída, pestaña dormida): se vuelve a pedir
// al volver a la pestaña y cada 2 minutos. La tabla no se recarga mientras se edita.
function solEditing(){return !!document.querySelector('#sol-body :focus, dialog[open]');}
function solRefresh(){
  if(document.hidden||!currentUser||!canViewSolicitudes())return;
  if(avisosOpen())refreshAvisosOpen();
  else if(solPageOpen()){if(!solEditing())loadSolicitudes(true);}
  else solBadgeSoon();
}
document.addEventListener('visibilitychange',solRefresh);
setInterval(solRefresh,120000);
// Avisos: cuántas solicitudes creó o pasó a "Plan enviado" otra persona desde tu última visita.
// Cada usuario tiene su propio visto (solicitudes_novedades / solicitudes_marcar_visto).
let solBadgeTimer=null,solBadgeGen=0;
function solPageOpen(){return document.getElementById('page-solicitudes').classList.contains('active');}
function setSolBadge(n){
  // El número va en el nombre del botón: el lector de pantalla no lee un aria-label en un span.
  [['nav-solicitudes','sol-badge'],['mnav-solicitudes','msol-badge']].forEach(([btn,id])=>{
    const b=document.getElementById(id);
    b.hidden=!n;b.textContent=n||'';
    if(n)document.getElementById(btn).setAttribute('aria-label','Solicitudes, '+(n===1?'1 novedad':n+' novedades'));
    else document.getElementById(btn).removeAttribute('aria-label');
  });
  // La campana lleva el mismo número.
  ['avisos-btn','mavisos-btn'].forEach(id=>{
    const btn=document.getElementById(id),c=btn.querySelector('.nav-count');
    c.hidden=!n;c.textContent=n||'';
    btn.setAttribute('aria-label',n?`Avisos, ${n} sin ver`:'Avisos');
  });
}
async function refreshSolBadge(){
  if(!canViewSolicitudes()){setSolBadge(0);return;}
  const gen=++solBadgeGen;
  const {data,error}=await supabaseClient.rpc('solicitudes_novedades');
  // Una respuesta vieja (ya se marcó visto o llegó otra después) no pisa el contador.
  if(gen!==solBadgeGen||solPageOpen())return;
  setSolBadge(error?0:data);
}
// Una ráfaga de cambios en vivo se junta en una sola consulta.
function solBadgeSoon(){clearTimeout(solBadgeTimer);solBadgeTimer=setTimeout(refreshSolBadge,300);}
// Al abrir Solicitudes: guarda el visto anterior (para etiquetar las filas) y pone el contador en cero.
// keepPrev: lo que llega en vivo con la pantalla abierta se marca visto sin cambiar las etiquetas.
let SOL_SEEN_PREV=null,SOL_LOADING=Promise.resolve();
async function solMarkSeen({keepPrev=false}={}){
  const {data,error}=await supabaseClient.rpc('solicitudes_marcar_visto');
  if(error){if(!keepPrev)SOL_SEEN_PREV=null;return null;}
  if(!keepPrev)SOL_SEEN_PREV=data;
  solBadgeGen++;clearTimeout(solBadgeTimer);
  setSolBadge(0);
  return data;
}
function solNovedad(r){
  if(!SOL_SEEN_PREV)return null;
  const prev=new Date(SOL_SEEN_PREV),mine=currentUser.id;
  if(r.created_by&&r.created_by!==mine&&new Date(r.created_at)>prev)return 'nueva';
  if(r.plan_enviado_by&&r.plan_enviado_by!==mine&&new Date(r.plan_enviado_at)>prev)return 'plan';
  return null;
}
function solEditing(){return document.getElementById('sol-body').contains(document.activeElement);}
function solOnChange(p){
  // Con la campana abierta (en cualquier pantalla) se recarga su lista y se marca visto.
  if(avisosOpen())refreshAvisosOpen();
  else if(solPageOpen()){if(p.new&&solNovedad(p.new))solMarkSeen({keepPrev:true});}
  else solBadgeSoon();
  const body=document.getElementById('sol-body');
  if(p.eventType==='DELETE'){
    const id=p.old&&p.old.id;
    SOL=SOL.filter(r=>r.id!==id);
    body.querySelector(`tr[data-id="${CSS.escape(String(id))}"]`)?.remove();
    document.getElementById('sol-empty').hidden=body.rows.length>0;
    renderSolStats();
    return;
  }
  const n=p.new;if(!n||n.id==null)return;
  const r=SOL.find(x=>x.id===n.id);
  if(!r){SOL.push(n);if(!solEditing())renderSolicitudes();else renderSolStats();return;}
  Object.assign(r,n);
  const tr=body.querySelector(`tr[data-id="${CSS.escape(String(n.id))}"]`);
  // Otro lead la cerró o la reabrió: sale del filtro (o entra) y se rehace la lista, salvo si estás editando.
  if(!!tr!==solInFilter(r)&&!solEditing()){renderSolicitudes();return;}
  // En la fila que estás editando solo se actualiza el estado, para no pisar lo que escribís.
  if(tr){if(tr.contains(document.activeElement))updateSolRow(tr,r);else tr.replaceWith(solRow(r));}
  renderSolStats();
}
// "Modificado por Laura · hace 2 h" (updated_by y updated_at los pone la base).
function solAgo(iso){
  const m=Math.round((Date.now()-new Date(iso))/60000);
  if(m<1)return 'recién';
  if(m<60)return 'hace '+m+' min';
  if(m<1440)return 'hace '+Math.round(m/60)+' h';
  if(m<10080)return 'hace '+Math.round(m/1440)+' d';
  return new Date(iso).toLocaleDateString('es-CR',{day:'2-digit',month:'2-digit',year:'numeric'});
}
setInterval(()=>{
  if(!document.getElementById('page-solicitudes').classList.contains('active'))return;
  document.querySelectorAll('#sol-body tr').forEach(tr=>{const r=SOL.find(x=>String(x.id)===tr.dataset.id);if(r)solModified(tr.querySelector('.sol-mod'),r);});
},60000);
function solModified(el,r){
  const who=r.updated_by&&(r.updated_by===currentUser?.id?'vos':(SOL_NAMES.get(r.updated_by)||'').trim().split(/\s+/)[0]);
  if(!r.updated_at||!who){el.textContent='';el.title='';return;}
  el.textContent=who+' · '+solAgo(r.updated_at);
  el.title='Último cambio: '+(SOL_NAMES.get(r.updated_by)||who)+', '+fmtDateTime(r.updated_at);
}
async function reloadSolicitudes(){
  const btn=document.getElementById('sol-reload');btn.disabled=true;
  const done=await loadSolicitudes();
  btn.disabled=false;
  if(done)setSolStatus('ok','Lista actualizada a las '+new Date().toLocaleTimeString('es-CR',{hour:'2-digit',minute:'2-digit'})+'.');
}
// Días desde la fecha de cierre (positivo = ya pasó), o null sin fecha.
function solDaysSince(date){
  if(!date)return null;
  const t=new Date();t.setHours(0,0,0,0);
  const d=new Date(date+'T00:00:00');
  return isNaN(d)?null:Math.round((t-d)/86400000);
}
function solDot(r){
  if(r.cerrada)return null;
  const d=solDaysSince(r.cierra);
  if(d===null)return {color:'blue',title:'Sin fecha de cierre'};
  if(d===0)return {color:'red',title:'Cierra hoy'};
  if(d===1)return {color:'yellow',title:'El cierre fue ayer'};
  if(d>1)return {color:'green',blink:true,title:'Fecha de cierre vencida'};
  return {color:'green',title:'Sin urgencia'};
}
function solLate(r){const d=solDaysSince(r.cierra);return !r.cerrada&&d!==null&&d>=1;}
// Abiertas primero; luego P2_/P3_ por número, las sueltas y al final OPC.
function solSortKey(r){
  const n=r.nombre||'',p=n.match(/P\d+_\s?(\d+)/i),o=n.match(/OPC_?(\d+)/i);
  return [r.cerrada?1:0,p?0:o?2:1,p?+p[1]:o?+o[1]:0,r.id];
}
function solCompare(a,b){const x=solSortKey(a),y=solSortKey(b);for(let i=0;i<x.length;i++)if(x[i]!==y[i])return x[i]-y[i];return 0;}
function solPeople(){return [...new Set([...DB.people.daily1,...DB.people.daily2])].sort((a,b)=>a.localeCompare(b,'es'));}
function renderSolStats(){
  const open=SOL.filter(r=>!r.cerrada).length;
  const items=[['',SOL.length,'Total'],['is-open',open,'Abiertas'],['is-done',SOL.length-open,'Cerradas'],['is-late',SOL.filter(solLate).length,'Vencidas']];
  const box=document.getElementById('sol-stats');box.replaceChildren();
  items.forEach(([cls,n,label])=>{const d=document.createElement('div');d.className='sol-stat '+cls;const b=document.createElement('b');b.textContent=n;d.append(b,label);box.appendChild(d);});
}
function solInFilter(r){const f=document.getElementById('sol-filter').value;return f==='all'||(f==='open')===!r.cerrada;}
function renderSolicitudes(){
  const q=document.getElementById('sol-search').value.trim().toLowerCase();
  const rows=SOL.filter(r=>(!q||r.nombre.toLowerCase().includes(q))&&solInFilter(r)).sort(solCompare);
  const body=document.getElementById('sol-body');body.replaceChildren(...rows.map(solRow));
  document.getElementById('sol-empty').hidden=rows.length>0;
  renderSolStats();
  solScrollHint();
}
// Sombra a la derecha mientras haya columnas ocultas (la tabla se desplaza de lado).
function solScrollHint(){
  const w=document.getElementById('sol-table-wrap');
  document.getElementById('sol-table-outer').classList.toggle('more-right',w.scrollWidth-w.clientWidth-w.scrollLeft>4);
}
document.getElementById('sol-table-wrap').addEventListener('scroll',solScrollHint,{passive:true});
window.addEventListener('resize',()=>{if(document.getElementById('page-solicitudes').classList.contains('active'))solScrollHint();});
function solCell(label,cls,...children){const td=document.createElement('td');if(label)td.dataset.label=label;if(cls)td.className=cls;td.append(...children);return td;}
function solRow(r){
  const tr=document.createElement('tr');tr.dataset.id=r.id;
  // textarea para que el nombre completo se lea en varias líneas (Enter no agrega saltos).
  const name=Object.assign(document.createElement('textarea'),{rows:2,value:r.nombre,maxLength:300,className:'sol-name',title:r.nombre});
  name.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();name.blur();}});
  name.setAttribute('aria-label','Nombre de la solicitud');
  name.addEventListener('change',()=>{
    const v=name.value.replace(/\s+/g,' ').trim();
    if(!v){name.value=r.nombre;uiAlert('El nombre no puede quedar vacío.');return;}
    name.value=v;name.title=v;
    saveSolicitud(r.id,{nombre:v});
  });
  const tag=document.createElement('span');tag.className='sol-new';tag.hidden=true;
  const checks={};
  SOL_CHECKS.forEach(([field,label])=>{
    const c=Object.assign(document.createElement('input'),{type:'checkbox',checked:!!r[field]});
    c.setAttribute('aria-label',label);
    // Marcar "Cierre enviado" cierra la solicitud (igual que el tracker anterior)
    // y la saca del informe semanal; la base hace lo mismo con un trigger.
    c.addEventListener('change',()=>field==='cierre_enviado'?solSetCierre(r.id,c.checked):saveSolicitud(r.id,{[field]:c.checked}));
    checks[field]=c;
  });
  const horas=Object.assign(document.createElement('input'),{type:'number',min:'0',step:'0.5',placeholder:'0',value:r.horas??''});
  horas.setAttribute('aria-label','Horas aproximadas');
  horas.addEventListener('change',()=>{
    const v=horas.value===''?null:Number(horas.value);
    if(v!==null&&!(v>=0)){horas.value=r.horas??'';return;}
    saveSolicitud(r.id,{horas:v});
  });
  const dot=document.createElement('span');
  const cierra=Object.assign(document.createElement('input'),{type:'date',value:r.cierra||''});
  cierra.setAttribute('aria-label','Fecha de cierre');
  cierra.addEventListener('change',()=>saveSolicitud(r.id,{cierra:cierra.value||null}));
  const wrapCierra=document.createElement('div');wrapCierra.className='sol-cierra';wrapCierra.append(dot,cierra);
  const obs=Object.assign(document.createElement('textarea'),{rows:1,maxLength:2000,placeholder:'Notas…',value:r.observaciones||''});
  obs.setAttribute('aria-label','Observaciones');
  obs.addEventListener('change',()=>saveSolicitud(r.id,{observaciones:obs.value}));
  const badge=document.createElement('span');
  const mod=document.createElement('small');mod.className='sol-mod';
  const del=Object.assign(document.createElement('button'),{type:'button',className:'sol-del',textContent:'✕',title:'Eliminar'});
  del.setAttribute('aria-label','Eliminar solicitud');
  del.addEventListener('click',()=>deleteSolicitud(r.id));
  const enc=document.createElement('div');enc.className='sol-enc';
  tr.append(solCell('','',name,tag),solCell('Informe semanal','',checks.informe_semanal),solCell('Encargado','sol-wide',enc),solCell('Horas','',horas),
    solCell('Pend. plan','',checks.pend_plan),solCell('Pend. actualizar','',checks.pend_actualizar),solCell('Plan enviado','',checks.plan_enviado),
    solCell('Cierre enviado','',checks.cierre_enviado),solCell('Cierra','sol-wide',wrapCierra),solCell('Observaciones','sol-wide',obs),
    solCell('','sol-plain',badge,mod),solCell('','sol-plain',del));
  renderSolEncargados(enc,r);
  updateSolRow(tr,r);
  // QA Boss: la misma fila, solo para leer (la base igual le rechaza cualquier cambio).
  if(!canManageConfig()){
    name.readOnly=true;
    [horas,cierra,obs,...Object.values(checks)].forEach(el=>el.disabled=true);
    // Sin textos de ayuda para completar: lo vacío queda vacío.
    horas.placeholder='';obs.placeholder='';
    if(!r.cierra)cierra.hidden=true;
    del.hidden=true;
  }
  return tr;
}
// Actualiza lo que depende del estado sin rehacer la fila (no se pierde el foco).
function updateSolRow(tr,r){
  const d=solDot(r),dot=tr.querySelector('.sol-cierra span');
  dot.className=d?`sol-dot sol-dot-${d.color}${d.blink?' blink':''}`:'';
  dot.title=d?d.title:'';
  tr.classList.toggle('sol-done',!!r.cerrada);
  tr.classList.toggle('sol-late',solLate(r));
  tr.querySelector('.sol-name').classList.toggle('urgent',!!d&&d.color==='red');
  const nov=solNovedad(r),tag=tr.querySelector('.sol-new');
  tag.hidden=!nov;tag.textContent=nov==='nueva'?'Nueva':nov==='plan'?'Plan enviado':'';
  const badge=tr.querySelector('td:nth-last-child(2) span');
  badge.className='sol-badge'+(r.cerrada?' done':'');badge.textContent=r.cerrada?'Cerrada':'Abierta';
  solModified(tr.querySelector('.sol-mod'),r);
  tr.querySelector('input[aria-label="Cierre enviado"]').checked=!!r.cierre_enviado;
  const inf=tr.querySelector('input[aria-label="Informe semanal"]');
  inf.checked=!!r.informe_semanal;inf.disabled=!!r.cerrada;
  inf.title=r.cerrada?'Cerrada: ya no va en el informe semanal':'';
  const enc=tr.querySelector('.sol-enc');
  if(enc.dataset.n!==solEncKey(r))renderSolEncargados(enc,r);
}
// Qué encargados hay (no solo cuántos): si otro lead cambia uno por otro, la fila se vuelve a dibujar.
function solEncKey(r){return JSON.stringify(r.encargados||[])+(r.cerrada?'c':'');}
function renderSolEncargados(box,r){
  box.replaceChildren();
  box.dataset.n=solEncKey(r);
  const lead=canManageConfig();
  (r.encargados||[]).forEach(n=>{
    const chip=document.createElement('span');chip.className='sol-chip';chip.append(n);
    if(!lead){chip.classList.add('sol-chip-ro');box.appendChild(chip);return;}
    const x=Object.assign(document.createElement('button'),{type:'button',textContent:'×'});
    x.setAttribute('aria-label','Quitar a '+n);
    x.addEventListener('click',()=>saveSolicitud(r.id,{encargados:r.encargados.filter(e=>e!==n)},()=>renderSolEncargados(box,r)));
    chip.appendChild(x);box.appendChild(chip);
  });
  const free=solPeople().filter(n=>!(r.encargados||[]).includes(n));
  if(!lead||r.cerrada||!free.length||(r.encargados||[]).length>=10)return;
  const sel=document.createElement('select');sel.setAttribute('aria-label','Agregar encargado del informe');
  sel.appendChild(new Option('+ Encargado',''));
  free.forEach(n=>sel.appendChild(new Option(n,n)));
  sel.addEventListener('change',()=>{if(sel.value)saveSolicitud(r.id,{encargados:[...(r.encargados||[]),sel.value]},()=>renderSolEncargados(box,r));});
  box.appendChild(sel);
}
async function saveSolicitud(id,patch,after){
  const r=SOL.find(x=>x.id===id);if(!r)return;
  Object.assign(r,patch,{updated_by:currentUser.id,updated_at:new Date().toISOString()});
  const tr=document.querySelector(`#sol-body tr[data-id="${CSS.escape(String(id))}"]`);
  if(tr)updateSolRow(tr,r);
  if(after)after();
  renderSolStats();
  const {data,error}=await supabaseClient.from('solicitudes').update(patch).eq('id',id).select('id');
  if(error||!data||!data.length){uiError(writeErrorMessage(error||{code:'42501'}));await loadSolicitudes();}
}
// Si al cerrarla (o reabrirla) ya no entra en el filtro, la fila se va y queda "Deshacer"
// unos segundos, que le devuelve lo que tenía (cerrarla quita el informe y los encargados).
let solUndoTimer=null;
function solSetCierre(id,cerrar){
  const r=SOL.find(x=>x.id===id);if(!r)return;
  const patch=cerrar?{cierre_enviado:true,cerrada:true,informe_semanal:false,encargados:[]}:{cierre_enviado:false,cerrada:false};
  const prev=Object.fromEntries(Object.keys(patch).map(k=>[k,r[k]]));
  saveSolicitud(id,patch);
  if(solInFilter(r))return;
  const body=document.getElementById('sol-body');
  body.querySelector(`tr[data-id="${CSS.escape(String(id))}"]`)?.remove();
  document.getElementById('sol-empty').hidden=body.rows.length>0;
  setSolStatus('ok',cerrar?'Solicitud cerrada.':'Solicitud reabierta.');
  const undo=Object.assign(document.createElement('button'),{type:'button',className:'sol-undo',textContent:'Deshacer'});
  undo.addEventListener('click',()=>{
    clearTimeout(solUndoTimer);setSolStatus('');
    saveSolicitud(id,prev);renderSolicitudes();
    body.querySelector(`tr[data-id="${CSS.escape(String(id))}"] input[aria-label="Cierre enviado"]`)?.focus();
  });
  document.getElementById('sol-status').append(undo);
  // La casilla con el foco se fue con la fila: el foco pasa a Deshacer.
  undo.focus({preventScroll:true});
  clearTimeout(solUndoTimer);
  solUndoTimer=setTimeout(()=>{if(!undo.isConnected)return;const had=document.activeElement===undo;setSolStatus('');if(had)document.getElementById('sol-filter').focus();},8000);
}
/* ── Nueva solicitud: popup con lo que se sabe al crearla (solo el nombre es obligatorio) ── */
// El estado se elige en un combo; en la base siguen siendo las casillas de la tabla.
const SOL_NEW_ESTADOS=['pend_plan','plan_enviado','pend_actualizar'];
let solNewEnc=[];
function openNuevaSolicitud(){
  const d=document.getElementById('sol-new-dialog');
  d.querySelector('form').reset();
  solNewEnc=[];renderNuevaEncargados();
  setSolNewStatus('');
  document.getElementById('sol-new-btn').disabled=false;
  d.showModal();
  document.getElementById('sol-new-name').focus();
}
// El aviso de error se va apenas se corrige el campo.
document.addEventListener('input',e=>{if(e.target.closest?.('#sol-new-dialog')&&document.getElementById('sol-new-status').classList.contains('error'))setSolNewStatus('');});
// field: el campo con el error (queda marcado con aria-invalid hasta que se corrige).
function setSolNewStatus(kind,text,field){
  const st=document.getElementById('sol-new-status');st.className=kind?'status-msg '+kind:'status-msg';st.textContent=text||'';
  document.querySelectorAll('#sol-new-dialog [aria-invalid]').forEach(el=>el.removeAttribute('aria-invalid'));
  if(field){field.setAttribute('aria-invalid','true');field.focus();}
}
// Mismos chips que la columna Encargado de la tabla, pero sobre la lista del popup.
function renderNuevaEncargados(){
  const on=document.getElementById('sol-new-informe').checked,box=document.getElementById('sol-new-enc');
  document.getElementById('sol-new-enc-field').hidden=!on;
  box.replaceChildren();
  if(!on)return;
  solNewEnc.forEach(n=>{
    const chip=document.createElement('span');chip.className='sol-chip';chip.append(n);
    const x=Object.assign(document.createElement('button'),{type:'button',textContent:'×'});
    x.setAttribute('aria-label','Quitar a '+n);
    x.addEventListener('click',()=>{solNewEnc=solNewEnc.filter(e=>e!==n);renderNuevaEncargados();document.querySelector('#sol-new-enc select')?.focus();});
    chip.appendChild(x);box.appendChild(chip);
  });
  const free=solPeople().filter(n=>!solNewEnc.includes(n));
  if(!free.length||solNewEnc.length>=10)return;
  const sel=document.createElement('select');sel.setAttribute('aria-label','Agregar encargado del informe');
  sel.appendChild(new Option('+ Encargado',''));
  free.forEach(n=>sel.appendChild(new Option(n,n)));
  sel.addEventListener('change',()=>{if(!sel.value)return;solNewEnc.push(sel.value);renderNuevaEncargados();document.querySelector('#sol-new-enc select')?.focus();});
  box.appendChild(sel);
}
// "P3_081", "P2_191", "OPC_47": el código que identifica la solicitud dentro del nombre
// (sin ceros a la izquierda, para que P3_081 y P3_81 cuenten como la misma).
// "P3_1XX" (código a medio escribir) no es P3_1: el número no puede seguir con letras.
function solCodigo(nombre){const m=(nombre||'').match(/(P\d+|OPC)_?\s?(\d+)(?![\dA-Z])/i);return m?m[1].toUpperCase()+'_'+Number(m[2]):null;}
async function addSolicitud(event){
  event.preventDefault();
  const nameEl=document.getElementById('sol-new-name'),btn=document.getElementById('sol-new-btn');
  const nombre=nameEl.value.replace(/\s+/g,' ').trim();
  if(!nombre){setSolNewStatus('error','Escribí el nombre de la solicitud.',nameEl);return;}
  const horasEl=document.getElementById('sol-new-horas');
  const horas=horasEl.value===''?null:Number(horasEl.value);
  if(horasEl.validity.badInput||(horas!==null&&!(horas>=0&&horas<=9999))){setSolNewStatus('error','Las horas tienen que ser un número entre 0 y 9999.',horasEl);return;}
  const cod=solCodigo(nombre),same=cod?SOL.filter(r=>solCodigo(r.nombre)===cod):[],dup=same.find(r=>!r.cerrada)||same[0];
  if(dup&&!await uiConfirm(dup.nombre+(dup.cerrada?' (cerrada)':''),{title:'Ya hay una solicitud con ese código',ok:'Agregar igual'})){nameEl.focus();return;}
  const estado=document.getElementById('sol-new-estado').value,informe=document.getElementById('sol-new-informe').checked;
  const row={nombre,horas,cierra:document.getElementById('sol-new-cierra').value||null,
    observaciones:document.getElementById('sol-new-obs').value.trim(),
    informe_semanal:informe,encargados:informe?[...solNewEnc]:[]};
  SOL_NEW_ESTADOS.forEach(k=>{row[k]=k===estado;});
  btn.disabled=true;setSolNewStatus('info','Guardando…');
  const {error}=await supabaseClient.from('solicitudes').insert(row);
  btn.disabled=false;
  if(error){setSolNewStatus('error',writeErrorMessage(error));return;}
  document.getElementById('sol-new-dialog').close();
  document.getElementById('sol-search').value='';
  if(document.getElementById('sol-filter').value==='done')document.getElementById('sol-filter').value='open';
  await loadSolicitudes();
  setSolStatus('ok','Solicitud agregada.');
}
async function deleteSolicitud(id){
  const r=SOL.find(x=>x.id===id);if(!r)return;
  if(!await uiConfirm(r.nombre+'\n\nNo se puede deshacer.',{title:'¿Eliminar esta solicitud?',ok:'Eliminar',danger:true}))return;
  const {data,error}=await supabaseClient.from('solicitudes').delete().eq('id',id).select('id');
  if(error||!data||!data.length)uiError(writeErrorMessage(error||{code:'42501'}));
  await loadSolicitudes();
}
/* ── Informes semanales: lista de las abiertas para copiar o imprimir ── */
function informesRows(){
  return SOL.filter(r=>!r.cerrada).sort(solCompare).map(r=>({
    nombre:r.nombre,
    informe:r.informe_semanal?'Sí':'N/A',
    encargados:r.informe_semanal?((r.encargados||[]).join(', ')||'Sin asignar'):'N/A'
  }));
}
// Mensaje de Teams: solo cambian las horas (se recuerdan en este navegador).
function infHora(v){const [h,m]=(v||'').split(':').map(Number);if(isNaN(h))return '';return (h%12||12)+':'+String(m||0).padStart(2,'0')+(h<12?' am':' pm');}
function infMsgText(){
  const h1=infHora(document.getElementById('inf-h1').value),h2=infHora(document.getElementById('inf-h2').value);
  return ['Hola Todos buenas tardes,','Informes de esta semana:','',
    `Los que nos envían el informe a Gi y a mí solamente pueden enviarlo a las ${h1}`,
    `Los que se lo envían al cliente (CJ-OPC-Data-Bus-Gobierno) lo envían a las ${h2}`,
    'Si alguno me falta o no debería de ir me dicen porfa'];
}
function renderInfMsg(){
  document.getElementById('inf-msg').textContent=infMsgText().join('\n');
  try{localStorage.setItem('qabcr-inf-horas',JSON.stringify([document.getElementById('inf-h1').value,document.getElementById('inf-h2').value]));}catch(e){}
}
function openInformes(){
  try{const h=JSON.parse(localStorage.getItem('qabcr-inf-horas')||'null');if(Array.isArray(h)){if(h[0])document.getElementById('inf-h1').value=h[0];if(h[1])document.getElementById('inf-h2').value=h[1];}}catch(e){}
  renderInfMsg();
  const rows=informesRows(),t=document.getElementById('inf-table');
  const hoy=new Date().toLocaleDateString('es-CR',{day:'numeric',month:'long',year:'numeric'});
  const n=rows.filter(r=>r.informe==='Sí').length;
  document.getElementById('inf-sub').textContent=`Solicitudes abiertas al ${hoy}: ${rows.length}, ${n} con informe semanal.`;
  t.replaceChildren();
  const hr=t.createTHead().insertRow();
  ['Solicitud','Informe semanal','Encargados'].forEach(x=>{const th=document.createElement('th');th.scope='col';th.textContent=x;hr.appendChild(th);});
  const b=t.createTBody();
  rows.forEach(r=>{const tr=b.insertRow();[r.nombre,r.informe,r.encargados].forEach((v,i)=>{const td=tr.insertCell();td.textContent=v;if(i&&v==='N/A')td.classList.add('inf-na');if(v==='Sin asignar')td.classList.add('inf-falta');});});
  if(!rows.length){const td=b.insertRow().insertCell();td.colSpan=3;td.textContent='No hay solicitudes abiertas.';}
  const st=document.getElementById('inf-status');st.className='status-msg';st.textContent='';
  document.getElementById('inf-dialog').showModal();
}
function copyInformes(){
  const rows=informesRows(),cols=['Solicitud','Informe semanal','Encargados'];
  const msg=infMsgText();
  const text=[...msg,'',cols.join('\t'),...rows.map(r=>[r.nombre,r.informe,r.encargados].join('\t'))].join('\n');
  const esc=v=>String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;');
  const html=msg.map(l=>l?'<div>'+esc(l)+'</div>':'<br>').join('')+'<br><table border="1" cellpadding="4" style="border-collapse:collapse"><tr>'+cols.map(c=>'<th>'+c+'</th>').join('')+'</tr>'+rows.map(r=>'<tr><td>'+esc(r.nombre)+'</td><td>'+r.informe+'</td><td>'+esc(r.encargados)+'</td></tr>').join('')+'</table>';
  const st=document.getElementById('inf-status');
  const done=()=>{st.className='status-msg ok';st.textContent='Copiado: pegalo en Teams o en un correo. En Teams volvé a escribir @Todos para que avise a todos.';};
  const fail=()=>{st.className='status-msg error';st.textContent='No se pudo copiar. Probá con Imprimir.';};
  if(window.ClipboardItem&&navigator.clipboard?.write)navigator.clipboard.write([new ClipboardItem({'text/plain':new Blob([text],{type:'text/plain'}),'text/html':new Blob([html],{type:'text/html'})})]).then(done).catch(()=>legacyCopy(text)?done():fail());
  else if(navigator.clipboard?.writeText)navigator.clipboard.writeText(text).then(done).catch(()=>legacyCopy(text)?done():fail());
  else legacyCopy(text)?done():fail();
}
function printInformes(){
  document.body.classList.add('print-inf');
  window.addEventListener('afterprint',()=>document.body.classList.remove('print-inf'),{once:true});
  window.print();
}

function exportSolicitudes(){
  const blob=new Blob([JSON.stringify(SOL,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download='solicitudes.json';document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(url);
}

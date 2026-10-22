// QA BCR Suite — Daily: sorteo del día e historial.
/* ============ DAILY SCRUM ============ */
let activeDaily=1,runCount=0,lastRestEnd={daily1:null,daily2:null};
function shuffle(arr){const a=[...arr];for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
function getInitials(name){return name.split(' ').slice(0,2).map(w=>w[0]).join('').toUpperCase();}
function participantsLabel(n){return n===1?'1 participante':`${n} participantes`;}
function updateDailyCounts(){
  document.querySelector('#dtab1 .dt-count').textContent=participantsLabel(DB.people.daily1.length);
  document.querySelector('#dtab2 .dt-count').textContent=participantsLabel(DB.people.daily2.length);
}
function selectDaily(num){
  activeDaily=num;
  document.querySelectorAll('.daily-tab-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById(`dtab${num}`).classList.add('active');
  document.getElementById('rollBtn').className=`roll-btn d${num}`;
  document.getElementById('rollLabel').textContent=`Sortear el orden del Daily ${num}`;
  closeMotivoMenu();
  runCount=0;document.getElementById('runBadge').textContent='—';
  document.getElementById('dly-save').hidden=true;
  if(dlyTab==='hist')loadDailyHistory();
  document.getElementById('listBody').innerHTML=`<div class="list-empty"><div class="list-empty-text">Tocá <strong>Sortear</strong> para ver quién habla primero en el Daily ${num}.</div></div>`;
}
function generateOrder(dailyKey){
  const people=DB.people[dailyKey].slice();
  const rule=DB.rules[dailyKey];
  const lastFixed=(rule.lastFixed||[]).filter(n=>people.includes(n));
  const firstGroup=(rule.firstGroup||[]).filter(n=>people.includes(n)&&!lastFixed.includes(n));
  const remainingPool=people.filter(n=>!firstGroup.includes(n)&&!lastFixed.includes(n));
  const maxRange=Math.max(firstGroup.length,people.length-lastFixed.length);
  const range=Math.min(Math.max(rule.range||firstGroup.length||1,firstGroup.length),maxRange);
  const fillCount=Math.max(0,range-firstGroup.length);
  const pool=shuffle(remainingPool);
  const filler=pool.slice(0,fillCount);
  const rest=pool.slice(fillCount);
  const frontBlock=shuffle([...firstGroup,...filler]);
  let restShuffled=shuffle(rest),attempts=0;
  while(restShuffled.length>1&&restShuffled[restShuffled.length-1]===lastRestEnd[dailyKey]&&attempts++<15)restShuffled=shuffle(rest);
  lastRestEnd[dailyKey]=restShuffled.length?restShuffled[restShuffled.length-1]:null;
  return [...frontBlock,...restShuffled,...shuffle(lastFixed)];
}
function roll(){
  runCount++;
  closeMotivoMenu();
  document.getElementById('doneBody').innerHTML=DONE_EMPTY;
  document.getElementById('doneCount').textContent='0';
  clearAbsent();
  const dice=document.getElementById('diceIcon');dice.classList.remove('spinning');void dice.offsetWidth;dice.classList.add('spinning');
  const dailyKey=`daily${activeDaily}`,order=generateOrder(dailyKey),color=activeDaily===1?'d1':'d2',n=order.length;
  document.getElementById('dly-save').hidden=!n||!canSaveDaily();
  const sst=document.getElementById('dly-save-status');sst.className='status-msg';sst.textContent='';
  document.getElementById('runBadge').textContent=`Sorteo ${runCount}`;
  document.getElementById('rollLabel').textContent=`Volver a sortear el Daily ${activeDaily}`;
  document.getElementById('listBody').innerHTML=order.map((name,i)=>{
    const pos=i+1,isFirst=pos===1,isLast=pos===n,short=name.split(' ').slice(0,2).join(' ');
    const tag=isFirst?'<span class="p-tag tag-first">Empieza</span>':isLast?'<span class="p-tag tag-last">Cierra</span>':'';
    return `<div class="participant-item" style="animation-delay:${i*40}ms" data-name="${escapeHtml(name)}" data-short="${escapeHtml(short)}" data-color="${color}" data-click="toggleDone"><span class="pos-num ${isFirst?'pos-first':''}">${pos}</span><div class="p-avatar ${color}">${escapeHtml(getInitials(name))}</div><button type="button" class="p-name ${isLast?'name-last':''}" aria-pressed="false" title="Marcar que ya habló">${escapeHtml(short)}</button>${tag}<button type="button" class="p-absent-btn" data-click="openMotivoMenu" aria-haspopup="menu" aria-expanded="false">No asistió ▾</button></div>`;
  }).join('');
}
function toggleDone(el){
  if(el.classList.contains('absent'))return;
  el.querySelector('.p-name')?.setAttribute('aria-pressed',String(!el.classList.contains('done')));
  const name=el.dataset.name, short=el.dataset.short, color=el.dataset.color;
  const doneBody=document.getElementById('doneBody');
  const existingEmpty=doneBody.querySelector('.done-empty');
  if(el.classList.contains('done')){
    el.classList.remove('done');
    const doneItem=doneBody.querySelector(`[data-done="${CSS.escape(name)}"]`);
    if(doneItem)doneItem.remove();
  } else {
    el.classList.add('done');
    if(existingEmpty)existingEmpty.remove();
    const div=document.createElement('div');
    div.className='done-item';
    div.dataset.done=name;
    div.innerHTML=`<div class="done-avatar">${escapeHtml(getInitials(name))}</div><span class="done-name">${escapeHtml(short)}</span><span class="done-check">✓</span>`;
    div.onclick=()=>{ el.classList.remove('done'); el.querySelector('.p-name')?.setAttribute('aria-pressed','false'); div.remove(); updateDoneCount(); };
    doneBody.appendChild(div);
  }
  updateDoneCount();
}
function updateDoneCount(){
  const n=document.querySelectorAll('#doneBody .done-item').length;
  document.getElementById('doneCount').textContent=n;
  if(n===0&&!document.querySelector('#doneBody .done-empty')){
    document.getElementById('doneBody').innerHTML=DONE_EMPTY;
  }
}

const ABSENT_EMPTY='<div class="done-empty">Usá <strong>No asistió</strong> en el orden para registrar ausencias.</div>';
const DONE_EMPTY='<div class="done-empty">Tocá a una persona en el orden cuando termine de hablar.</div>';
function clearAbsent(){document.getElementById('absentBody').innerHTML=ABSENT_EMPTY;document.getElementById('absentCount').textContent='0';}
// Motivo de la ausencia: sin justificar baja el % de asistencia; justificada y vacaciones no cuentan.
const MOTIVOS=[['sin_justificar','Sin justificar'],['justificada','Justificada'],['vacaciones','Vacaciones']];
const MOTIVO_LABEL=Object.fromEntries(MOTIVOS);
// Ausente: no cuenta como completado y pasa a "No asistieron" con su motivo (motivo null = asistió).
// Se deshace eligiendo "Asistió" en el menú o tocando su fila en la lista de ausentes.
function setAbsent(el,motivo){
  const name=el.dataset.name, short=el.dataset.short;
  const body=document.getElementById('absentBody'), btn=el.querySelector('.p-absent-btn');
  body.querySelector(`[data-absent="${CSS.escape(name)}"]`)?.remove();
  if(!motivo){
    el.classList.remove('absent');delete el.dataset.motivo;btn.textContent='No asistió ▾';
  }else{
    if(el.classList.contains('done'))toggleDone(el);
    el.classList.add('absent');el.dataset.motivo=motivo;btn.textContent=MOTIVO_LABEL[motivo]+' ▾';
    body.querySelector('.done-empty')?.remove();
    const div=document.createElement('div');
    div.className='done-item';div.dataset.absent=name;div.title='Deshacer ausencia';
    const av=document.createElement('div');av.className='done-avatar';av.textContent=getInitials(name);
    const nm=document.createElement('span');nm.className='done-name';
    nm.textContent=short+(motivo==='sin_justificar'?'':` (${MOTIVO_LABEL[motivo].toLowerCase()})`);
    const x=document.createElement('span');x.className='done-check';x.textContent='✕';
    div.append(av,nm,x);
    div.onclick=()=>setAbsent(el,null);
    body.appendChild(div);
  }
  const n=body.querySelectorAll('.done-item').length;
  document.getElementById('absentCount').textContent=n;
  if(!n)body.innerHTML=ABSENT_EMPTY;
}

// Menú del motivo (uno solo para todas las filas): flechas, Enter, Esc y clic afuera.
let motivoBtn=null;
function motivoMenu(){return document.getElementById('dly-motivo-menu');}
function openMotivoMenu(btn){
  const menu=motivoMenu(),again=motivoBtn===btn;
  closeMotivoMenu(again);
  if(again)return;
  const item=btn.closest('.participant-item');
  const opts=item.dataset.motivo?[...MOTIVOS,['','Asistió']]:MOTIVOS;
  menu.replaceChildren(...opts.map(([v,t])=>{
    const b=Object.assign(document.createElement('button'),{type:'button',textContent:t,tabIndex:-1});
    b.setAttribute('role','menuitem');b.dataset.motivo=v;
    if(v===item.dataset.motivo)b.setAttribute('aria-current','true');
    b.addEventListener('click',()=>{setAbsent(item,v||null);closeMotivoMenu(true);});
    return b;
  }));
  menu.hidden=false;motivoBtn=btn;btn.setAttribute('aria-expanded','true');
  // Debajo del botón; si no entra, arriba. Nunca fuera de la pantalla.
  const r=btn.getBoundingClientRect(),w=menu.offsetWidth,h=menu.offsetHeight;
  menu.style.left=Math.max(8,Math.min(r.right-w,window.innerWidth-w-8))+'px';
  menu.style.top=(r.bottom+4+h>window.innerHeight-8?Math.max(8,r.top-h-4):r.bottom+4)+'px';
  menu.querySelector('button').focus();
}
function closeMotivoMenu(returnFocus=false){
  const menu=motivoMenu();
  if(!menu||menu.hidden)return;
  menu.hidden=true;
  if(motivoBtn){motivoBtn.setAttribute('aria-expanded','false');if(returnFocus&&motivoBtn.isConnected)motivoBtn.focus();}
  motivoBtn=null;
}
document.addEventListener('keydown',e=>{
  const menu=motivoMenu();
  if(!menu||menu.hidden)return;
  const bs=[...menu.querySelectorAll('button')],i=bs.indexOf(document.activeElement);
  const go=j=>{e.preventDefault();bs[(j+bs.length)%bs.length].focus();};
  if(e.key==='ArrowDown')go(i+1);
  else if(e.key==='ArrowUp')go(i-1);
  else if(e.key==='Home')go(0);
  else if(e.key==='End')go(bs.length-1);
  else if(e.key==='Escape'){e.preventDefault();closeMotivoMenu(true);}
  else if(e.key==='Tab')closeMotivoMenu();
});
document.addEventListener('click',e=>{
  const menu=motivoMenu();
  if(menu&&!menu.hidden&&!menu.contains(e.target)&&!e.target.closest('.p-absent-btn'))closeMotivoMenu();
});
window.addEventListener('resize',()=>closeMotivoMenu());

// Los dos leads van una semana en cada Daily, siempre al final (regla "fijo al final"):
// QA Lead o Admin los cambia de Daily con un botón (daily_intercambiar_leads).
function lastFixedOf(dk){return (DB.rules[dk]?.lastFixed||[]).filter(n=>(DB.people[dk]||[]).includes(n));}
async function swapLeads(){
  const st=document.getElementById('dly-swap-status'),f1=lastFixedOf('daily1'),f2=lastFixedOf('daily2');
  st.className='status-msg';st.textContent='';
  if(f1.length!==1||f2.length!==1){
    uiAlert('Para intercambiar, cada Daily tiene que tener exactamente una persona fija al final. Revisalo en Administración → Reglas del Daily.','No se puede intercambiar');
    return;
  }
  if(!await uiConfirm('Cada uno queda fijo al final en su Daily nuevo.',{title:`¿Pasar a ${f1[0]} al Daily 2 y a ${f2[0]} al Daily 1?`,ok:'Intercambiar'}))return;
  const btn=document.getElementById('dly-swap-btn');btn.disabled=true;
  const {error}=await supabaseClient.rpc('daily_intercambiar_leads');
  btn.disabled=false;
  try{await loadConfig();}catch(e){console.error(e);}
  if(error){uiAlert(error.code==='42501'?'No tenés permiso para intercambiar a los leads.':(error.message||'No se pudo intercambiar'+errorDetail(error)+'.'),'No se pudo intercambiar');return;}
  selectDaily(activeDaily);
  st.className='status-msg ok';st.textContent=`Listo: ${f2[0]} pasó al Daily 1 y ${f1[0]} al Daily 2.`;
}

/* ============ DAILY: HISTORIAL ============ */
// Un registro por daily por día (daily_guardar reemplaza si ya se guardó ese día).
// Pestaña y período se recuerdan en este navegador (si se puede).
let dlyRef=null,dlySeq=0,dlyTab='hoy',dlyMode='month';
try{const v=JSON.parse(localStorage.getItem('qabcr-daily-vista')||'{}');if(v.tab==='hist')dlyTab='hist';if(v.mode==='week')dlyMode='week';}catch(e){}
function dlyRemember(){try{localStorage.setItem('qabcr-daily-vista',JSON.stringify({tab:dlyTab,mode:dlyMode}));}catch(e){}}
function dlyStart(){
  if(!dlyRef){const t=new Date();dlyRef=dlyMode==='month'?new Date(t.getFullYear(),t.getMonth(),1):hrsMonday(t);}
  return dlyRef;
}
function dlyShowTab(t){
  closeMotivoMenu();
  dlyTab=t;dlyRemember();
  ['hoy','hist'].forEach(k=>{
    document.getElementById('dly-tab-'+k).setAttribute('aria-selected',String(k===t));
    document.getElementById('dly-'+k).hidden=k!==t;
  });
  if(t==='hist')loadDailyHistory();
}
function dlySetMode(m){dlyMode=m;dlyRef=null;dlyRemember();loadDailyHistory();}
function fmtDay(iso){const [y,m,d]=iso.split('-').map(Number);return ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'][new Date(y,m-1,d).getDay()]+' '+d+'/'+m+'/'+y;}
async function saveDailyRun(){
  const dk=`daily${activeDaily}`,grupo=REFS.groups?.[dk],st=document.getElementById('dly-save-status'),btn=document.getElementById('dly-save-btn');
  const items=[...document.querySelectorAll('#listBody .participant-item')];
  if(!items.length)return;
  if(!grupo){st.className='status-msg error';st.textContent='No se pudo guardar: falta la configuración del daily. Recargá la página.';return;}
  const fecha=calcToISO(new Date());
  btn.disabled=true;st.className='status-msg info';st.textContent='Guardando…';
  // Si ya se guardó hoy, se pregunta antes de reemplazar.
  const prev=await supabaseClient.rpc('daily_historial',{p_grupo:grupo,desde:fecha,hasta:fecha});
  if(!prev.error&&prev.data?.length&&!await uiConfirm(`El Daily ${activeDaily} de hoy ya lo guardó ${prev.data[0].guardado_por||'alguien'}. ¿Reemplazarlo con este?`,{title:'Ya se guardó hoy',ok:'Reemplazar'})){
    btn.disabled=false;st.className='status-msg';st.textContent='';return;
  }
  // Sin justificar se guarda sin motivo (como siempre); justificada y vacaciones, con su motivo.
  const miembros=items.map((el,i)=>({daily_member_id:REFS.members[memberKey(dk,el.dataset.name)]||null,name:el.dataset.name,position:i+1,completed:el.classList.contains('done'),absent:el.classList.contains('absent'),
    motivo:['justificada','vacaciones'].includes(el.dataset.motivo)?el.dataset.motivo:null}));
  const {error}=await supabaseClient.rpc('daily_guardar',{p_grupo:grupo,p_fecha:fecha,p_miembros:miembros});
  btn.disabled=false;
  if(error){st.className='status-msg error';st.textContent='No se pudo guardar'+errorDetail(error)+'.';return;}
  const absent=miembros.filter(m=>m.absent).length;
  const verb=n=>n===1?'asistió':'asistieron',came=miembros.length-absent;
  const vac=miembros.filter(m=>m.motivo==='vacaciones').length,jus=miembros.filter(m=>m.motivo==='justificada').length;
  const det=[vac&&`${vac} de vacaciones`,jus&&`${jus} ${jus===1?'justificada':'justificadas'}`].filter(Boolean).join(', ');
  st.className='status-msg ok';st.textContent=`Guardado el Daily ${activeDaily} de hoy: ${came} ${verb(came)}`+(absent?`, ${absent} no ${verb(absent)}${det?` (${det})`:''}.`:'.');
  const link=Object.assign(document.createElement('button'),{type:'button',className:'status-link',textContent:'Ver en el historial'});
  link.onclick=()=>dlyShowTab('hist');
  st.append(' ',link);
  dlyRef=null;
}
function shiftDailyHistory(n){const a=dlyStart();dlyRef=dlyMode==='month'?new Date(a.getFullYear(),a.getMonth()+n,1):hrsAddDays(a,7*n);loadDailyHistory();}
async function loadDailyHistory(){
  const seq=++dlySeq,dk=`daily${activeDaily}`,grupo=REFS.groups?.[dk];
  const month=dlyMode==='month',a=dlyStart(),b=month?new Date(a.getFullYear(),a.getMonth()+1,0):hrsAddDays(a,6);
  const m=HRS_MONTHS[a.getMonth()],unit=month?'Mes':'Semana';
  document.getElementById('dly-mode').value=dlyMode;
  document.getElementById('dly-prev').setAttribute('aria-label',unit+' anterior');
  document.getElementById('dly-next').setAttribute('aria-label',unit+' siguiente');
  document.getElementById('dly-hist-title').textContent=`Historial del Daily ${activeDaily}`;
  document.getElementById('dly-hist-month').textContent=month?m.charAt(0).toUpperCase()+m.slice(1)+' '+a.getFullYear():'Semana del '+hrsRangeLabel(a,hrsAddDays(a,4));
  const box=document.getElementById('dly-hist-body'),st=document.getElementById('dly-hist-status');
  if(!grupo||!supabaseClient){box.replaceChildren();return;}
  const {data,error}=await supabaseClient.rpc('daily_historial',{p_grupo:grupo,desde:calcToISO(a),hasta:calcToISO(b)});
  if(seq!==dlySeq)return;
  if(error){st.className='status-msg error';st.textContent='No se pudo cargar el historial'+errorDetail(error)+'.';box.replaceChildren();return;}
  st.className='status-msg';st.textContent='';
  const rows=data||[];
  if(!rows.length){box.innerHTML=`<div class="sol-empty">No hay dailies guardados ${month?'este mes':'esta semana'}. Al terminar el daily, tocá <strong>Guardar daily de hoy</strong> en la pestaña Daily de hoy.</div>`;return;}
  // Días (más reciente primero) y resumen por persona.
  const days=new Map(),people=new Map();
  rows.forEach(r=>{
    if(!days.has(r.run_date))days.set(r.run_date,{by:r.guardado_por,members:[]});
    days.get(r.run_date).members.push(r);
    const p=people.get(r.member_name)||{name:r.member_name,total:0,absent:0,justificada:0,vacaciones:0,first:0};
    // Sin motivo = sin justificar (también lo guardado antes de que existieran los motivos).
    p.total++;if(r.absent)p[r.motivo==='justificada'||r.motivo==='vacaciones'?r.motivo:'absent']++;if(r.position===1)p.first++;
    people.set(r.member_name,p);
  });
  const table=document.createElement('table');table.className='hrs-table';
  table.createCaption().textContent=`Asistencia: ${days.size} ${days.size===1?'daily guardado':'dailies guardados'}`;
  const hr=table.createTHead().insertRow();
  ['Persona','Asistió','Faltó','Justificada','Vacaciones','% asistencia','Empezó'].forEach(t=>{const th=document.createElement('th');th.scope='col';th.textContent=t;hr.appendChild(th);});
  const body=table.createTBody();
  [...people.values()].sort((x,y)=>y.absent-x.absent||x.name.localeCompare(y.name)).forEach(p=>{
    // % de asistencia sin contar los días justificados ni de vacaciones; si son todos, «—».
    const tr=body.insertRow(),base=p.total-p.justificada-p.vacaciones,came=base-p.absent,pct=base?Math.round(came*100/base):null;
    [p.name,came,p.absent,p.justificada,p.vacaciones,pct===null?'—':pct+'%',p.first].forEach((v,i)=>{const td=tr.insertCell();td.textContent=v;if(i===5&&pct!==null&&pct<80)td.classList.add('dly-low');});
  });
  const wrap=document.createElement('div');wrap.className='hrs-table-wrap';wrap.appendChild(table);
  const list=document.createElement('div');list.className='dly-days';
  days.forEach((d,iso)=>{
    const ms=d.members.sort((x,y)=>x.position-y.position),abs=ms.filter(x=>x.absent);
    const item=document.createElement('div');item.className='dly-day';
    const head=document.createElement('div');head.className='dly-day-head';
    const strong=document.createElement('strong');strong.textContent=fmtDay(iso);
    const info=document.createElement('span');info.textContent=`${ms.length-abs.length} de ${ms.length} asistieron · empezó ${ms[0]?.member_name||'—'}`+(d.by?` · guardó ${d.by}`:'');
    head.append(strong,info);item.append(head);
    if(abs.length){const p=document.createElement('div');p.className='dly-day-absent';p.textContent='No asistieron: '+abs.map(x=>x.member_name+(x.motivo?` (${MOTIVO_LABEL[x.motivo].toLowerCase()})`:'')).join(', ');item.append(p);}
    const ord=document.createElement('div');ord.className='dly-day-order';ord.textContent='Orden: '+ms.map(x=>x.member_name).join(' → ');item.append(ord);
    list.append(item);
  });
  if(month)box.replaceChildren(wrap,list);else box.replaceChildren(list);
}

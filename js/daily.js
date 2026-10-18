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
  document.getElementById('doneBody').innerHTML=DONE_EMPTY;
  document.getElementById('doneCount').textContent='0';
  clearAbsent();
  const dice=document.getElementById('diceIcon');dice.classList.remove('spinning');void dice.offsetWidth;dice.classList.add('spinning');
  const dailyKey=`daily${activeDaily}`,order=generateOrder(dailyKey),color=activeDaily===1?'d1':'d2',n=order.length;
  document.getElementById('dly-save').hidden=!n;
  const sst=document.getElementById('dly-save-status');sst.className='status-msg';sst.textContent='';
  document.getElementById('runBadge').textContent=`Sorteo ${runCount}`;
  document.getElementById('rollLabel').textContent=`Volver a sortear el Daily ${activeDaily}`;
  document.getElementById('listBody').innerHTML=order.map((name,i)=>{
    const pos=i+1,isFirst=pos===1,isLast=pos===n,short=name.split(' ').slice(0,2).join(' ');
    const tag=isFirst?'<span class="p-tag tag-first">Empieza</span>':isLast?'<span class="p-tag tag-last">Cierra</span>':'';
    return `<div class="participant-item" style="animation-delay:${i*40}ms" data-name="${escapeHtml(name)}" data-short="${escapeHtml(short)}" data-color="${color}" data-click="toggleDone"><span class="pos-num ${isFirst?'pos-first':''}">${pos}</span><div class="p-avatar ${color}">${escapeHtml(getInitials(name))}</div><button type="button" class="p-name ${isLast?'name-last':''}" aria-pressed="false" title="Marcar que ya habló">${escapeHtml(short)}</button>${tag}<button type="button" class="p-absent-btn" data-click="toggleAbsent">No asistió</button></div>`;
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
// Ausente: no cuenta como completado y pasa a "No asistieron". Se deshace con el mismo botón o tocando su fila en la lista de ausentes.
function toggleAbsent(el){
  const name=el.dataset.name, short=el.dataset.short;
  const body=document.getElementById('absentBody'), btn=el.querySelector('.p-absent-btn');
  if(el.classList.contains('absent')){
    el.classList.remove('absent');btn.textContent='No asistió';
    body.querySelector(`[data-absent="${CSS.escape(name)}"]`)?.remove();
  }else{
    if(el.classList.contains('done'))toggleDone(el);
    el.classList.add('absent');btn.textContent='Asistió';
    body.querySelector('.done-empty')?.remove();
    const div=document.createElement('div');
    div.className='done-item';div.dataset.absent=name;div.title='Deshacer ausencia';
    div.innerHTML=`<div class="done-avatar">${escapeHtml(getInitials(name))}</div><span class="done-name">${escapeHtml(short)}</span><span class="done-check">✕</span>`;
    div.onclick=()=>toggleAbsent(el);
    body.appendChild(div);
  }
  const n=body.querySelectorAll('.done-item').length;
  document.getElementById('absentCount').textContent=n;
  if(!n)body.innerHTML=ABSENT_EMPTY;
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
  if(!prev.error&&prev.data?.length&&!confirm(`El Daily ${activeDaily} de hoy ya lo guardó ${prev.data[0].guardado_por||'alguien'}. ¿Reemplazarlo con este?`)){
    btn.disabled=false;st.className='status-msg';st.textContent='';return;
  }
  const miembros=items.map((el,i)=>({daily_member_id:REFS.members[memberKey(dk,el.dataset.name)]||null,name:el.dataset.name,position:i+1,completed:el.classList.contains('done'),absent:el.classList.contains('absent')}));
  const {error}=await supabaseClient.rpc('daily_guardar',{p_grupo:grupo,p_fecha:fecha,p_miembros:miembros});
  btn.disabled=false;
  if(error){st.className='status-msg error';st.textContent='No se pudo guardar'+errorDetail(error)+'.';return;}
  const absent=miembros.filter(m=>m.absent).length;
  const verb=n=>n===1?'asistió':'asistieron',came=miembros.length-absent;
  st.className='status-msg ok';st.textContent=`Guardado el Daily ${activeDaily} de hoy: ${came} ${verb(came)}`+(absent?`, ${absent} no ${verb(absent)}.`:'.');
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
    const p=people.get(r.member_name)||{name:r.member_name,total:0,absent:0,first:0};
    p.total++;if(r.absent)p.absent++;if(r.position===1)p.first++;
    people.set(r.member_name,p);
  });
  const table=document.createElement('table');table.className='hrs-table';
  table.createCaption().textContent=`Asistencia: ${days.size} ${days.size===1?'daily guardado':'dailies guardados'}`;
  const hr=table.createTHead().insertRow();
  ['Persona','Asistió','Faltó','% asistencia','Empezó'].forEach(t=>{const th=document.createElement('th');th.scope='col';th.textContent=t;hr.appendChild(th);});
  const body=table.createTBody();
  [...people.values()].sort((x,y)=>y.absent-x.absent||x.name.localeCompare(y.name)).forEach(p=>{
    const tr=body.insertRow(),pct=Math.round((p.total-p.absent)*100/p.total);
    [p.name,p.total-p.absent,p.absent,pct+'%',p.first].forEach((v,i)=>{const td=tr.insertCell();td.textContent=v;if(i===3&&pct<80)td.classList.add('dly-low');});
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
    if(abs.length){const p=document.createElement('div');p.className='dly-day-absent';p.textContent='No asistieron: '+abs.map(x=>x.member_name).join(', ');item.append(p);}
    const ord=document.createElement('div');ord.className='dly-day-order';ord.textContent='Orden: '+ms.map(x=>x.member_name).join(' → ');item.append(ord);
    list.append(item);
  });
  if(month)box.replaceChildren(wrap,list);else box.replaceChildren(list);
}

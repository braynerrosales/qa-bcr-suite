// QA BCR Suite — Horas: mis horas y consolidado.
/* ============ HORAS ============ */
// Cada QA carga sus líneas (RLS: solo las suyas); QA_LEAD y ADMIN ven y corrigen
// las de todos. El consolidado sale de horas_resumen(): solo totales por persona.
const HRS_TIPOS=[['TRABAJO','Trabajo'],['FERIADO','Feriado'],['LICENCIA','Licencia / incapacidad / citas'],['VACACIONES','Vacaciones / permisos']];
const HRS_DAY_CAP=8;
const HRS_DAYS=['Lunes','Martes','Miércoles','Jueves','Viernes'];
const HRS_MONTHS=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
let HRS=[],hrsWeek=null,hrsUser=null,hrsPeople=null,hrsTab='mine',hrsMode='week',hrsRef=null,hrsSeq=0,hrsReport=[],hrsAdj=[],hrsAdjCtx=null;
function setHrsStatus(kind,text){const st=document.getElementById('hrs-status');st.className=kind?'status-msg '+kind:'status-msg';st.textContent=text||'';}
function hrsMonday(d){const x=new Date(d.getFullYear(),d.getMonth(),d.getDate());x.setDate(x.getDate()-(x.getDay()+6)%7);return x;}
function hrsAddDays(d,n){const x=new Date(d);x.setDate(x.getDate()+n);return x;}
// Un QA solo cambia la semana actual y las dos anteriores; la base lo exige igual (trigger horas_cierre).
function hrsOpenFrom(){return hrsAddDays(hrsMonday(new Date()),-14);}
function hrsWeekClosed(){return !canManageConfig()&&hrsWeek<hrsOpenFrom();}
function hrsNum(n){return Math.round((Number(n)||0)*100)/100;}
function hrsFmt(n){return String(hrsNum(n));}
function hrsRangeLabel(a,b){
  return a.getMonth()===b.getMonth()
    ?`${a.getDate()} al ${b.getDate()} de ${HRS_MONTHS[b.getMonth()]} de ${b.getFullYear()}`
    :`${a.getDate()} de ${HRS_MONTHS[a.getMonth()]} al ${b.getDate()} de ${HRS_MONTHS[b.getMonth()]} de ${b.getFullYear()}`;
}
function hrsName(id){return (hrsPeople||[]).find(p=>p.id===id)?.full_name||'';}
async function hrsLoadPeople(){
  if(hrsPeople)return;
  const {data,error}=await supabaseClient.from('profiles').select('id,full_name,active,role').order('full_name');
  if(!error)hrsPeople=(data||[]).filter(p=>p.role!=='BETA');
}
function openHoras(){
  if(!hrsWeek)hrsWeek=hrsMonday(new Date());
  if(!hrsUser)hrsUser=currentUser.id;
  hrsShowTab(hrsTab);
}
function hrsShowTab(t){
  hrsTab=t;
  ['mine','report'].forEach(k=>{
    document.getElementById('hrs-tab-'+k).setAttribute('aria-selected',String(k===t));
    document.getElementById('hrs-'+k).hidden=k!==t;
  });
  setHrsStatus('');
  if(t==='mine')loadMyHours();
  else{hrsRef=new Date(hrsWeek);loadHrsReport();}
}

/* ── Mis horas ── */
async function loadMyHours(){
  const seq=++hrsSeq;
  await hrsLoadPeople();
  const lead=canManageConfig(),wrap=document.getElementById('hrs-person-wrap');
  wrap.hidden=!lead;
  if(lead){
    const sel=document.getElementById('hrs-person');
    sel.replaceChildren(...(hrsPeople||[]).filter(p=>p.active||p.id===hrsUser).map(p=>new Option(p.full_name+(p.id===currentUser.id?' (vos)':''),p.id)));
    sel.value=hrsUser;
  }
  const from=hrsWeek,to=hrsAddDays(hrsWeek,4);
  document.getElementById('hrs-week-label').textContent='Semana del '+hrsRangeLabel(from,to);
  const {data,error}=await supabaseClient.from('horas').select('*').eq('user_id',hrsUser)
    .gte('fecha',calcToISO(from)).lte('fecha',calcToISO(to)).order('fecha').order('id');
  if(seq!==hrsSeq)return false;   // ya se pidió otra semana
  if(error){HRS=[];renderMyHours();setHrsStatus('error','No se pudieron cargar las horas'+errorDetail(error)+'.');return false;}
  HRS=data||[];renderMyHours();
  return true;
}
function hrsShiftWeek(n){hrsWeek=hrsAddDays(hrsWeek,7*n);setHrsStatus('');loadMyHours();}
function hrsThisWeek(){hrsWeek=hrsMonday(new Date());setHrsStatus('');loadMyHours();}
function hrsPickPerson(id){hrsUser=id;setHrsStatus('');loadMyHours();}
function renderMyHours(){
  const box=document.getElementById('hrs-days');box.replaceChildren();
  const closed=hrsWeekClosed();
  if(closed){const f=hrsOpenFrom();setHrsStatus('info',`Semana cerrada: solo podés cambiar horas desde el lunes ${String(f.getDate()).padStart(2,'0')}/${String(f.getMonth()+1).padStart(2,'0')}. Para corregir esta semana, pedíselo a un QA Lead.`);}
  for(let i=0;i<5;i++){
    const d=hrsAddDays(hrsWeek,i),iso=calcToISO(d),hol=HOLIDAYS_CR.find(h=>h.date===iso);
    const day=document.createElement('section');day.className='hrs-day';day.dataset.date=iso;
    const head=document.createElement('div');head.className='hrs-day-head';
    const title=document.createElement('h3');
    title.textContent=`${HRS_DAYS[i]} ${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`;
    if(hol){const s=document.createElement('span');s.className='hrs-hol';s.textContent='Feriado: '+hol.name;title.appendChild(s);}
    const tot=document.createElement('span');tot.className='hrs-day-tot';
    head.append(title,tot);
    const lines=document.createElement('div');lines.className='hrs-lines';
    HRS.filter(r=>r.fecha===iso).forEach(r=>lines.appendChild(hrsLine(r,closed)));
    const actions=document.createElement('div');actions.className='hrs-day-actions';
    const add=Object.assign(document.createElement('button'),{type:'button',className:'btn-secondary',textContent:'+ Agregar línea'});
    add.setAttribute('aria-label','Agregar línea el '+HRS_DAYS[i].toLowerCase());
    add.addEventListener('click',()=>{const el=hrsNewLine(lines,{fecha:iso});el.querySelector('input').focus();});
    if(!closed)actions.appendChild(add);
    if(hol&&!closed){
      const fer=Object.assign(document.createElement('button'),{type:'button',className:'btn-secondary',textContent:'Cargar feriado ('+HRS_DAY_CAP+' h)'});
      fer.addEventListener('click',()=>{fer.remove();hrsSaveLine(hrsNewLine(lines,{fecha:iso,tipo:'FERIADO',tarea:hol.name,horas:HRS_DAY_CAP}));});
      if(!HRS.some(r=>r.fecha===iso))actions.appendChild(fer);
    }
    day.append(head,lines,actions);
    box.appendChild(day);
  }
  hrsTotals();
}
function hrsNewLine(lines,init){
  const r={id:null,user_id:hrsUser,tipo:'TRABAJO',soli:'',tarea:'',horas:null,facturable:null,...init};
  HRS.push(r);
  const el=hrsLine(r);lines.appendChild(el);return el;
}
function hrsLine(r,closed){
  const row=document.createElement('div');row.className='hrs-line';row._r=r;
  const field=(label,area,el)=>{const l=document.createElement('label');l.className='hrs-f hrs-'+area;const s=document.createElement('span');s.textContent=label;l.append(s,el);return l;};
  const soli=Object.assign(document.createElement('input'),{type:'text',className:'crud-input',maxLength:60,placeholder:'Ej: P3_141',value:r.soli||''});
  soli.dataset.f='soli';
  const tarea=Object.assign(document.createElement('input'),{type:'text',className:'crud-input',maxLength:300,placeholder:'Ej: Ejecución 2317552',value:r.tarea||''});
  tarea.dataset.f='tarea';
  const tipo=document.createElement('select');tipo.className='crud-input';tipo.dataset.f='tipo';
  HRS_TIPOS.forEach(([v,l])=>tipo.appendChild(new Option(l,v)));tipo.value=r.tipo;
  const horas=Object.assign(document.createElement('input'),{type:'number',className:'crud-input',min:'0.25',max:'24',step:'0.25',inputMode:'decimal',value:r.horas??''});
  horas.dataset.f='horas';
  const fact=Object.assign(document.createElement('input'),{type:'number',className:'crud-input',min:'0',max:'24',step:'0.25',inputMode:'decimal',value:r.facturable??''});
  fact.dataset.f='facturable';
  const del=Object.assign(document.createElement('button'),{type:'button',className:'sol-del',textContent:'✕',title:'Eliminar línea'});
  del.setAttribute('aria-label','Eliminar línea');
  const mod=document.createElement('small');mod.className='hrs-edited';
  row.append(field('Soli / PBI','soli',soli),field('Tarea / actividad','tarea',tarea),field('Tipo','tipo',tipo),field('Horas','horas',horas),field('Facturables','fact',fact),del,mod);
  // Por defecto se factura todo lo trabajado; si ya se cambió a mano, se respeta.
  horas.addEventListener('change',()=>{
    if(tipo.value==='TRABAJO'&&(fact.value===''||Number(fact.value)===Number(r.horas)))fact.value=horas.value;
    hrsSaveLine(row);
  });
  tipo.addEventListener('change',()=>{
    if(tipo.value!=='TRABAJO')fact.value='0';
    else if(fact.value===''||Number(fact.value)===0)fact.value=horas.value;
    hrsSaveLine(row);
  });
  [soli,tarea,fact].forEach(el=>el.addEventListener('change',()=>hrsSaveLine(row)));
  del.addEventListener('click',()=>hrsDeleteLine(row));
  hrsSyncLine(row);
  if(closed){row.querySelectorAll('input,select').forEach(el=>el.disabled=true);del.hidden=true;}
  return row;
}
function hrsSyncLine(row){
  const r=row._r,fact=row.querySelector('[data-f=facturable]');
  fact.disabled=r.tipo!=='TRABAJO';
  fact.title=fact.disabled?'Solo el trabajo se factura':'';
  // Vacaciones, feriado o licencia no llevan Soli ni tarea: no se muestran los ejemplos.
  row.querySelector('[data-f=soli]').placeholder=fact.disabled?'Sin Soli':'Ej: P3_141';
  row.querySelector('[data-f=tarea]').placeholder=fact.disabled?'No lleva tarea':'Ej: Ejecución 2317552';
  const mod=row.querySelector('.hrs-edited');
  // Si un lead corrigió la línea de otra persona, queda a la vista.
  if(r.id!=null&&r.updated_by&&r.updated_by!==r.user_id){
    const who=r.updated_by===currentUser.id?'vos':(hrsName(r.updated_by)||'un lead');
    mod.textContent='Corregido por '+who+(r.updated_at?' · '+solAgo(r.updated_at):'');
  }else mod.textContent='';
}
function hrsSaveLine(row){
  const r=row._r,get=f=>row.querySelector(`[data-f=${f}]`);
  row.querySelectorAll('.bad').forEach(el=>el.classList.remove('bad'));
  const tipo=get('tipo').value,hv=get('horas').value.trim(),fv=get('facturable').value.trim();
  const horas=hv===''?null:hrsNum(hv),facturable=tipo==='TRABAJO'?(fv===''?0:hrsNum(fv)):0;
  const bad=(f,msg)=>{get(f).classList.add('bad');setHrsStatus('error',msg);};
  if(horas===null){if(r.id!=null)bad('horas','Las horas no pueden quedar vacías. Para quitar la línea usá ✕.');return;}
  if(!(horas>0&&horas<=24))return bad('horas','Las horas de una línea van de 0.25 a 24.');
  if(!(facturable>=0)||facturable>horas)return bad('facturable','Las horas facturables no pueden ser más que las trabajadas.');
  setHrsStatus('');
  Object.assign(r,{tipo,soli:get('soli').value.trim(),tarea:get('tarea').value.trim(),horas,facturable});
  hrsSyncLine(row);hrsTotals();
  // Una escritura a la vez por línea: la segunda espera el id de la primera.
  r._p=(r._p||Promise.resolve()).then(()=>hrsWrite(row));
}
async function hrsWrite(row){
  const r=row._r,v={fecha:r.fecha,tipo:r.tipo,soli:r.soli,tarea:r.tarea,horas:r.horas,facturable:r.facturable};
  const res=r.id==null
    ?await supabaseClient.from('horas').insert({...v,user_id:r.user_id}).select('*')
    :await supabaseClient.from('horas').update(v).eq('id',r.id).select('*');
  if(res.error||!res.data||!res.data.length){
    uiError(writeErrorMessage(res.error||{code:'42501'}));
    await loadMyHours();
    return;
  }
  Object.assign(r,res.data[0]);
  if(row.isConnected)hrsSyncLine(row);
}
async function hrsDeleteLine(row){
  const r=row._r;
  if(r.id!=null&&!await uiConfirm((r.tarea?`«${r.tarea}», `:'')+`${r.horas||0} h.`,{title:'¿Eliminar esta línea?',ok:'Eliminar',danger:true}))return;
  await r._p;
  if(r.id!=null){
    const {data,error}=await supabaseClient.from('horas').delete().eq('id',r.id).select('id');
    if(error||!data||!data.length){uiError(writeErrorMessage(error||{code:'42501'}));await loadMyHours();return;}
  }
  HRS=HRS.filter(x=>x!==r);row.remove();hrsTotals();
}
function hrsSum(rows){
  const s={total:0,fact:0,nofact:0,aus:0};
  rows.forEach(r=>{if(!(r.horas>0))return;s.total+=+r.horas;if(r.tipo==='TRABAJO'){s.fact+=+r.facturable;s.nofact+=r.horas-r.facturable;}else s.aus+=+r.horas;});
  Object.keys(s).forEach(k=>s[k]=hrsNum(s[k]));
  return s;
}
function hrsTotals(){
  document.querySelectorAll('#hrs-days .hrs-day').forEach(day=>{
    const t=hrsSum(HRS.filter(r=>r.fecha===day.dataset.date)).total,el=day.querySelector('.hrs-day-tot');
    el.textContent=hrsFmt(t)+' / '+HRS_DAY_CAP+' h';
    el.classList.toggle('off',t!==HRS_DAY_CAP);
    el.title=t<HRS_DAY_CAP?'Faltan '+hrsFmt(HRS_DAY_CAP-t)+' h':t>HRS_DAY_CAP?'Sobran '+hrsFmt(t-HRS_DAY_CAP)+' h':'';
  });
  const s=hrsSum(HRS),box=document.getElementById('hrs-week-stats');box.replaceChildren();
  [['',hrsFmt(s.total)+' / '+(5*HRS_DAY_CAP),'Total semana'],['is-done',hrsFmt(s.fact),'Facturable'],['is-open',hrsFmt(s.nofact),'No facturable'],['is-late',hrsFmt(s.aus),'Feriados y ausencias']]
    .forEach(([cls,n,label])=>{const d=document.createElement('div');d.className='sol-stat '+cls;const b=document.createElement('b');b.textContent=n;d.append(b,label);box.appendChild(d);});
}

/* ── Consolidado ── */
function hrsSetMode(m){hrsMode=m;loadHrsReport();}
function hrsShiftReport(n){
  hrsRef=hrsMode==='month'?new Date(hrsRef.getFullYear(),hrsRef.getMonth()+n,1):hrsAddDays(hrsRef,7*n);
  loadHrsReport();
}
// Igual que el Excel: una semana que cruza de mes se parte en dos tablas.
function hrsRanges(){
  if(hrsMode==='month'){
    const a=new Date(hrsRef.getFullYear(),hrsRef.getMonth(),1);
    return [[a,new Date(a.getFullYear(),a.getMonth()+1,0)]];
  }
  const a=hrsMonday(hrsRef),b=hrsAddDays(a,4);
  if(a.getMonth()===b.getMonth())return [[a,b]];
  return [[a,new Date(a.getFullYear(),a.getMonth()+1,0)],[new Date(b.getFullYear(),b.getMonth(),1),b]];
}
function hrsWorkdays(a,b){let n=0;for(let d=new Date(a);d<=b;d=hrsAddDays(d,1)){const w=d.getDay();if(w>0&&w<6)n++;}return n;}
function hrsCaption(a,b){
  if(hrsMode==='month'){const m=HRS_MONTHS[a.getMonth()];return m.charAt(0).toUpperCase()+m.slice(1)+' '+a.getFullYear();}
  return 'Semana '+hrsRangeLabel(a,b);
}
const HRS_COLS=[['feriado','Feriado'],['facturable','Facturable'],['no_facturable','No facturable'],['licencia','Licencia / incapacidad / citas'],['vacaciones','Vacaciones / permisos'],['total','Total'],['cap','Capacidad']];
async function loadHrsReport(){
  const seq=++hrsSeq,ranges=hrsRanges();
  document.getElementById('hrs-pick-btn').hidden=!isAdmin();
  if(!isAdmin())hrsTogglePicker(false);
  document.getElementById('hrs-mode').value=hrsMode;
  const first=ranges[0][0],last=ranges[ranges.length-1][1];
  document.getElementById('hrs-report-label').textContent=hrsMode==='month'?hrsCaption(first,last):'Semana del '+hrsRangeLabel(first,last);
  await hrsLoadPeople();
  const lead=canManageConfig();
  const [res,adj]=await Promise.all([
    Promise.all(ranges.map(([a,b])=>supabaseClient.rpc('horas_resumen',{desde:calcToISO(a),hasta:calcToISO(b)}))),
    // El detalle de los ajustes solo lo leen QA_LEAD y ADMIN. Sin la migración de ajustes, el consolidado se ve igual pero no se puede ajustar.
    lead?supabaseClient.from('horas_ajustes').select('*').gte('fecha',calcToISO(first)).lte('fecha',calcToISO(last)):Promise.resolve({data:[]})
  ]);
  if(seq!==hrsSeq)return false;
  hrsAdj=adj.error?[]:adj.data||[];
  const canAdjust=lead&&!adj.error&&hrsMode==='week';
  const box=document.getElementById('hrs-report-tables');box.replaceChildren();hrsReport=[];
  const err=res.find(r=>r.error);
  if(err){setHrsStatus('error','No se pudo cargar el consolidado'+errorDetail(err.error)+'.');return false;}
  setHrsStatus('');
  document.getElementById('hrs-report-note').textContent=!lead
    ?'En naranja: el total no llega o se pasa de la capacidad.'
    :canAdjust
      ?'Tocá un nombre para ver y corregir sus líneas, o un número para ajustarlo. Con raya azul: número ajustado. En naranja: el total no llega o se pasa de la capacidad.'
      :'Tocá un nombre para ver y corregir sus líneas. Con raya azul: incluye ajustes de alguna semana (se ajusta en la vista Semana). En naranja: el total no llega o se pasa de la capacidad.';
  ranges.forEach(([a,b],i)=>{
    const cap=hrsWorkdays(a,b)*HRS_DAY_CAP,caption=hrsCaption(a,b);
    const rows=(res[i].data||[]).map(r=>({...r,cap}));
    hrsReport.push({caption,rows});
    const table=document.createElement('table');table.className='hrs-table';
    table.createCaption().textContent=caption;
    const hr=table.createTHead().insertRow();
    ['Persona',...HRS_COLS.map(c=>c[1])].forEach(t=>{const th=document.createElement('th');th.scope='col';th.textContent=t;hr.appendChild(th);});
    const body=table.createTBody();
    rows.forEach(r=>{
      const tr=body.insertRow(),name=tr.insertCell();
      if(canManageConfig()||r.user_id===currentUser.id){
        const btn=Object.assign(document.createElement('button'),{type:'button',className:'hrs-who',textContent:r.full_name});
        btn.addEventListener('click',()=>{hrsUser=r.user_id;hrsWeek=hrsMonday(a);hrsShowTab('mine');});
        name.appendChild(btn);
      }else name.textContent=r.full_name;
      HRS_COLS.forEach(([k,label])=>{
        const td=tr.insertCell();td.textContent=hrsFmt(r[k]);
        if(HRS_ADJ_COLS.includes(k)&&lead){
          const list=hrsAdj.filter(x=>x.user_id===r.user_id&&x.columna===k&&x.fecha>=calcToISO(a)&&x.fecha<=calcToISO(b));
          const delta=hrsNum(list.reduce((s,x)=>s+(+x.delta||0),0));
          if(list.length){
            td.classList.add('adj');
            td.title=list.length===1&&hrsMode==='week'
              ?`Ajustado por ${hrsName(list[0].updated_by)||'—'}: ${hrsFmt(r[k]-delta)} → ${hrsFmt(r[k])} · ${list[0].motivo}`
              :`Incluye ajustes por ${delta>0?'+':''}${hrsFmt(delta)} h (sin ajustes: ${hrsFmt(r[k]-delta)})`;
          }
          if(canAdjust){
            const btn=Object.assign(document.createElement('button'),{type:'button',className:'hrs-adj-btn',textContent:hrsFmt(r[k])});
            btn.setAttribute('aria-label',`Ajustar ${label} de ${r.full_name}: ${hrsFmt(r[k])}`);
            btn.addEventListener('click',()=>hrsOpenAdjust({r,k,label,fecha:calcToISO(a),caption,existing:list[0]||null}));
            td.replaceChildren(btn);
          }
        }
        if(k==='total'&&hrsNum(r.total)!==cap){td.classList.add('off');td.title=r.total<cap?'Faltan '+hrsFmt(cap-r.total)+' h':'Sobran '+hrsFmt(r.total-cap)+' h';}
      });
    });
    const fr=table.createTFoot().insertRow();
    fr.insertCell().textContent='Total horas';
    HRS_COLS.forEach(([k])=>{fr.insertCell().textContent=hrsFmt(rows.reduce((s,r)=>s+(+r[k]||0),0));});
    const wrap=document.createElement('div');wrap.className='hrs-table-wrap';wrap.appendChild(table);
    box.appendChild(wrap);
  });
  return true;
}
// QA_LEAD y ADMIN ajustan un número de la semana: se guarda la diferencia con lo calculado
// de las líneas (horas_ajustes), así las líneas del QA no cambian y el mes suma los ajustes.
const HRS_ADJ_COLS=['feriado','facturable','no_facturable','licencia','vacaciones'];
function hrsOpenAdjust(ctx){
  hrsAdjCtx={...ctx,raw:hrsNum(ctx.r[ctx.k]-(ctx.existing?+ctx.existing.delta:0))};
  const d=document.getElementById('adj-dialog');
  d.querySelector('form').reset();
  document.getElementById('adj-what').textContent=`${ctx.r.full_name} · ${ctx.label} · ${ctx.caption}`;
  document.getElementById('adj-raw').textContent=`Calculado de sus líneas: ${hrsFmt(hrsAdjCtx.raw)} h`+(ctx.existing?` · Ajustado por ${hrsName(ctx.existing.updated_by)||'—'}`:'');
  document.getElementById('adj-value').value=hrsFmt(ctx.r[ctx.k]);
  document.getElementById('adj-motivo').value=ctx.existing?.motivo||'';
  document.getElementById('adj-remove').hidden=!ctx.existing;
  const st=document.getElementById('adj-status');st.className='status-msg';st.textContent='';
  d.showModal();
  document.getElementById('adj-value').select();
}
async function hrsAdjustWrite(run){
  const st=document.getElementById('adj-status'),btn=document.getElementById('adj-save');
  btn.disabled=true;st.className='status-msg info';st.textContent='Guardando…';
  const {data,error}=await run();
  btn.disabled=false;
  if(error?.code==='23505'){st.className='status-msg error';st.textContent='Otra persona ajustó este número recién. Cerrá y volvé a abrirlo.';loadHrsReport();return;}
  if(error||!data?.length){st.className='status-msg error';st.textContent=(error?writeErrorMessage(error):'No tenés permiso para este cambio.');return;}
  document.getElementById('adj-dialog').close();
  loadHrsReport();
}
function hrsSaveAdjust(e){
  e.preventDefault();
  const c=hrsAdjCtx;if(!c)return;
  const value=hrsNum(document.getElementById('adj-value').value),motivo=document.getElementById('adj-motivo').value.trim();
  const delta=hrsNum(value-c.raw);
  if(!motivo&&delta!==0){document.getElementById('adj-motivo').focus();return;}
  if(delta===0){
    if(c.existing)return hrsRemoveAdjust();
    document.getElementById('adj-dialog').close();return;
  }
  const t=supabaseClient.from('horas_ajustes');
  hrsAdjustWrite(()=>c.existing
    ?t.update({delta,motivo}).eq('id',c.existing.id).select('id')
    :t.insert({user_id:c.r.user_id,fecha:c.fecha,columna:c.k,delta,motivo}).select('id'));
}
function hrsRemoveAdjust(){
  const c=hrsAdjCtx;if(!c?.existing)return;
  hrsAdjustWrite(()=>supabaseClient.from('horas_ajustes').delete().eq('id',c.existing.id).select('id'));
}

// ADMIN: elige quién sale en el consolidado (profiles.en_informe).
async function hrsTogglePicker(open){
  const box=document.getElementById('hrs-picker'),btn=document.getElementById('hrs-pick-btn');
  if(open===undefined)open=box.hidden;
  box.hidden=!open;btn.setAttribute('aria-expanded',String(open));
  if(!open)return;
  const list=document.getElementById('hrs-picker-list');
  list.textContent='Cargando…';
  const {data,error}=await supabaseClient.from('profiles').select('id,full_name,active,en_informe,role').order('full_name');
  if(error){list.textContent='';setHrsStatus('error','No se pudo cargar la lista de personas'+errorDetail(error)+'.');return;}
  list.replaceChildren(...(data||[]).filter(p=>p.role!=='BETA').map(p=>{
    const label=document.createElement('label'),cb=document.createElement('input');
    cb.type='checkbox';cb.checked=p.en_informe!==false;
    cb.addEventListener('change',()=>hrsSetEnInforme(p.id,cb));
    label.append(cb,document.createTextNode(p.full_name||'(sin nombre)'));
    if(!p.active){const s=document.createElement('small');s.textContent='inactivo';label.append(s);}
    return label;
  }));
}
async function hrsSetEnInforme(id,cb){
  cb.disabled=true;
  const {data,error}=await supabaseClient.from('profiles').update({en_informe:cb.checked}).eq('id',id).select('id');
  cb.disabled=false;
  if(error||!data?.length){
    cb.checked=!cb.checked;
    setHrsStatus('error','No se pudo guardar'+(error?errorDetail(error):': solo un ADMIN puede elegir quién sale en el informe')+'.');
    return;
  }
  setHrsStatus('');
  loadHrsReport();
}
// Texto separado por tabulaciones: se pega directo en Excel.
function hrsCopyReport(){
  const head=['Equipo',...HRS_COLS.map(c=>c[1])].join('\t');
  const text=hrsReport.map(t=>[t.caption,head,...t.rows.map(r=>[r.full_name,...HRS_COLS.map(([k])=>hrsFmt(r[k]))].join('\t')),
    ['Total horas',...HRS_COLS.map(([k])=>hrsFmt(t.rows.reduce((s,r)=>s+(+r[k]||0),0)))].join('\t')].join('\n')).join('\n\n');
  const btn=document.getElementById('hrs-copy');
  const done=()=>{btn.textContent='✓ Copiado';setTimeout(()=>btn.textContent='Copiar para Excel',2000);};
  const fail=()=>{btn.textContent='⚠ No se pudo copiar';setTimeout(()=>btn.textContent='Copiar para Excel',2500);};
  if(!text)return;
  if(navigator.clipboard?.writeText)navigator.clipboard.writeText(text).then(done).catch(()=>legacyCopy(text)?done():fail());
  else legacyCopy(text)?done():fail();
}

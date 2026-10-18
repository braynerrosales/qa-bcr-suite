// QA BCR Suite — Días hábiles.
/* ============ CALC DÍAS HÁBILES ============ */
const HOLIDAYS_CR=[
  {date:'2026-01-01',name:'Año Nuevo'},{date:'2026-04-02',name:'Jueves Santo'},{date:'2026-04-03',name:'Viernes Santo'},{date:'2026-04-11',name:'Día de Juan Santamaría'},{date:'2026-05-01',name:'Día del Trabajo'},{date:'2026-07-25',name:'Anexión de Guanacaste'},{date:'2026-08-02',name:'Virgen de los Ángeles'},{date:'2026-08-15',name:'Día de la Madre'},{date:'2026-08-31',name:'Día de la Persona Negra'},{date:'2026-09-15',name:'Día de la Independencia'},{date:'2026-12-01',name:'Abolición del Ejército'},{date:'2026-12-25',name:'Navidad'},
  {date:'2027-01-01',name:'Año Nuevo'},{date:'2027-03-25',name:'Jueves Santo'},{date:'2027-03-26',name:'Viernes Santo'},{date:'2027-04-11',name:'Día de Juan Santamaría'},{date:'2027-05-01',name:'Día del Trabajo'},{date:'2027-07-25',name:'Anexión de Guanacaste'},{date:'2027-08-02',name:'Virgen de los Ángeles'},{date:'2027-08-15',name:'Día de la Madre'},{date:'2027-08-31',name:'Día de la Persona Negra'},{date:'2027-09-15',name:'Día de la Independencia'},{date:'2027-12-01',name:'Abolición del Ejército'},{date:'2027-12-25',name:'Navidad'},
  {date:'2028-01-01',name:'Año Nuevo'},{date:'2028-04-11',name:'Día de Juan Santamaría'},{date:'2028-04-13',name:'Jueves Santo'},{date:'2028-04-14',name:'Viernes Santo'},{date:'2028-05-01',name:'Día del Trabajo'},{date:'2028-07-25',name:'Anexión de Guanacaste'},{date:'2028-08-02',name:'Virgen de los Ángeles'},{date:'2028-08-15',name:'Día de la Madre'},{date:'2028-08-31',name:'Día de la Persona Negra'},{date:'2028-09-15',name:'Día de la Independencia'},{date:'2028-12-01',name:'Abolición del Ejército'},{date:'2028-12-25',name:'Navidad'}
];
const calcHolidaySet=new Set(HOLIDAYS_CR.map(h=>h.date));
let calcOffCounter=0;

function calcAddOff(){
  calcOffCounter++;
  const id=calcOffCounter,c=document.getElementById('calcOffContainer'),d=document.createElement('div');
  d.className='calc-off-entry';d.id='calcOff-'+id;
  d.innerHTML=`<div class="calc-field"><label for="calcOffS-${id}">Desde</label><input type="date" id="calcOffS-${id}" min="2026-01-01" max="2028-12-31"></div><div class="calc-field"><label for="calcOffE-${id}">Hasta</label><input type="date" id="calcOffE-${id}" min="2026-01-01" max="2028-12-31"></div><button type="button" class="crud-btn-del" aria-label="Quitar este período" data-click="removeCalcOff">✕</button>`;
  c.appendChild(d);
}

function calcParseDate(s){const[y,m,d]=s.split('-').map(Number);return new Date(y,m-1,d);}
function calcToISO(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function calcFmtDate(d){const days=['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'],months=['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];return days[d.getDay()]+' '+d.getDate()+' '+months[d.getMonth()]+' '+d.getFullYear();}

function calcGetOffDays(){
  const off=new Set();
  document.querySelectorAll('[id^="calcOff-"]').forEach(entry=>{
    const id=entry.id.replace('calcOff-',''),sEl=document.getElementById('calcOffS-'+id),eEl=document.getElementById('calcOffE-'+id);
    if(!sEl||!eEl||!sEl.value||!eEl.value)return;
    const s=calcParseDate(sEl.value),e=calcParseDate(eEl.value),cur=new Date(s);
    while(cur<=e){off.add(calcToISO(cur));cur.setDate(cur.getDate()+1);}
  });
  return off;
}

function calcRun(){
  const sv=document.getElementById('calcWorkStart').value,ev=document.getElementById('calcWorkEnd').value;
  if(!sv||!ev){document.getElementById('calcResults').innerHTML='<div class="calc-msg">Elegí las fechas de inicio y fin.</div>';return;}
  const start=calcParseDate(sv),end=calcParseDate(ev);
  if(start>end){document.getElementById('calcResults').innerHTML='<div class="calc-msg is-error">La fecha de inicio tiene que ser anterior a la final.</div>';return;}
  const offDays=calcGetOffDays();
  let totalCal=0,weekends=0,holidaysIn=0,offIn=0,workDays=0;const hitsArr=[];
  const cur=new Date(start);
  while(cur<=end){
    totalCal++;const iso=calcToISO(cur),wk=cur.getDay()===0||cur.getDay()===6,hol=calcHolidaySet.has(iso),off=offDays.has(iso);
    if(wk){weekends++;}
    else if(off){offIn++;if(hol)hitsArr.push({...HOLIDAYS_CR.find(h=>h.date===iso),note:'off'});}
    else if(hol){holidaysIn++;hitsArr.push({...HOLIDAYS_CR.find(h=>h.date===iso),note:'holiday'});}
    else{workDays++;}
    cur.setDate(cur.getDate()+1);
  }
  let html=`<div class="calc-result-card"><div class="calc-result-number">${workDays}</div><div class="calc-result-label">días hábiles</div><div class="calc-breakdown"><div class="calc-stat"><div class="calc-stat-num s-calendar">${totalCal}</div><div class="calc-stat-label">Días calendario</div></div><div class="calc-stat"><div class="calc-stat-num s-weekends">${weekends}</div><div class="calc-stat-label">Fines de semana</div></div><div class="calc-stat"><div class="calc-stat-num s-holidays">${holidaysIn}</div><div class="calc-stat-label">Feriados</div></div><div class="calc-stat"><div class="calc-stat-num s-off">${offIn}</div><div class="calc-stat-label">Días libres</div></div></div></div>`;
  if(hitsArr.length){
    html+='<div class="calc-section"><div class="calc-section-title">Feriados en el rango</div>';
    hitsArr.forEach(h=>{const d=calcParseDate(h.date);const tag=h.note==='off'?'<span class="calc-tag calc-tag-off">Día libre</span>':'<span class="calc-tag calc-tag-workday">Se resta</span>';html+=`<div class="calc-holiday-item ch-in-range"><span class="ch-date">${calcFmtDate(d)}</span><span class="ch-name">${h.name} ${tag}</span></div>`;});
    html+='</div>';
  }
  document.getElementById('calcResults').innerHTML=html;
}

function calcClear(){
  document.getElementById('calcWorkStart').value='';document.getElementById('calcWorkEnd').value='';
  document.getElementById('calcOffContainer').innerHTML='';document.getElementById('calcResults').innerHTML='';calcOffCounter=0;
}

function calcToggleHolidays(){
  const list=document.getElementById('calcHolidaysList');list.classList.toggle('open');if(list.innerHTML)return;
  let html='',cy='';
  HOLIDAYS_CR.forEach(h=>{const d=calcParseDate(h.date);const y=d.getFullYear().toString();if(y!==cy){cy=y;html+=`<div class="calc-year-header">${y}</div>`;}const wk=d.getDay()===0||d.getDay()===6;const tag=wk?`<span class="calc-tag calc-tag-weekend">${d.getDay()===0?'Domingo':'Sábado'}</span>`:'';html+=`<div class="calc-holiday-item"><span class="ch-date">${calcFmtDate(d)}</span><span class="ch-name">${h.name} ${tag}</span></div>`;});
  list.innerHTML=html;
}

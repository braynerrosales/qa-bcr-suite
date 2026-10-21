// QA BCR Suite — Generar tareas: PBIs/HUs/RTs → tareas con la plantilla del proyecto.
/* ============ QA GENERATOR ============ */
let selectedProject=null, selectedVariant=null;

function renderProjectButtons(){
  const grid=document.getElementById('project-grid');
  const keys=Object.keys(DB.projects);
  grid.innerHTML=keys.length?keys.map(key=>`<button class="proj-btn" data-type="${escapeHtml(key)}" data-click="selectProject"><span class="proj-dot" style="background:${projColor(DB.projects[key].color)}"></span> ${escapeHtml(key)}</button>`).join(''):'<div class="crud-empty">No hay proyectos configurados.</div>';
}
// Tras recargar los datos, mantiene el proyecto y la variante elegidos si siguen existiendo.
function refreshQaSelection(){
  if(!selectedProject)return;
  const btn=[...document.querySelectorAll('#project-grid .proj-btn')].find(b=>b.dataset.type===selectedProject);
  if(!btn){selectedProject=null;selectedVariant=null;document.getElementById('qa-variant-section').style.display='none';checkReady();return;}
  const prev=selectedVariant;
  selectProject(btn);
  const vsel=document.getElementById('variant-select');
  if(prev&&DB.projects[selectedProject].variants.includes(prev)){vsel.value=prev;selectedVariant=prev;checkReady();}
}

function selectProject(btn){
  document.querySelectorAll('.proj-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');
  selectedProject=btn.dataset.type;selectedVariant=null;
  const vs=document.getElementById('qa-variant-section'),vsel=document.getElementById('variant-select'),variants=DB.projects[selectedProject]?.variants||[];
  if(variants.length>0){vs.style.display='block';vsel.innerHTML='<option value="">Seleccionar variante…</option>'+variants.map(v=>`<option value="${escapeHtml(v)}">${escapeHtml(v.charAt(0).toUpperCase()+v.slice(1))}</option>`).join('');vsel.onchange=()=>{selectedVariant=vsel.value;checkReady();};}
  else{vs.style.display='none';selectedVariant=null;}
  checkReady();
}
function checkReady(){document.getElementById('btn-gen').disabled=!(!!selectedProject&&(!(DB.projects[selectedProject]?.variants?.length)||!!selectedVariant)&&!!document.getElementById('pbi-input').value.trim());}
document.getElementById('pbi-input').addEventListener('input',checkReady);
function parsePBIs(text){return text.split('\n').map(l=>l.trim()).filter(l=>l).map(line=>({raw:line,num:(line.match(/(\d+)/)||[])[1]||null}));}

async function generate(){
  const input=document.getElementById('pbi-input').value.trim();if(!input)return;
  const pbis=parsePBIs(input),btn=document.getElementById('btn-gen'),lb=document.getElementById('loading-bar'),sm=document.getElementById('status-msg'),os=document.getElementById('output-section');
  sm.className='status-msg';sm.textContent='';btn.disabled=true;lb.classList.add('active');os.classList.remove('visible');
  try{
    const variantKey=(DB.projects[selectedProject]?.variants?.length)?selectedVariant:'';
    const tasks=DB.projects[selectedProject]?.templates?.[variantKey];
    if(tasks&&tasks.length){const fn=(n)=>tasks.map(t=>t.split('{n}').join(n));renderTable(pbis,fn);}
    else throw new Error('Este proyecto no tiene plantilla de tareas'+(variantKey?` para la variante "${variantKey}"`:'')+'. Agregala en Administración → Proyectos y tareas.');
    os.classList.add('visible');os.scrollIntoView({behavior:'smooth',block:'start'});
  }catch(err){sm.className='status-msg error';sm.textContent=err.message;}
  finally{btn.disabled=false;lb.classList.remove('active');checkReady();}
}
function addRow(tbody,cls,text){const tr=document.createElement('tr'),td=document.createElement('td');tr.className=cls;td.textContent=String(text);tr.appendChild(td);tbody.appendChild(tr);}
function renderTable(pbis,fn){
  const tbody=document.getElementById('table-body');tbody.innerHTML='';
  pbis.forEach(({raw,num})=>{
    addRow(tbody,'pbi-row',raw);
    (num?fn(num):fn('####')).forEach(task=>addRow(tbody,'task-row',task));
  });
}
// Limpia los PBIs y las tareas generadas; el proyecto y la variante quedan elegidos.
function clearQa(){
  const input=document.getElementById('pbi-input'),sm=document.getElementById('status-msg');
  input.value='';
  document.getElementById('table-body').innerHTML='';
  document.getElementById('output-section').classList.remove('visible');
  sm.className='status-msg';sm.textContent='';
  checkReady();
  input.focus();
}
function copyTable(){
  const text=[...document.querySelectorAll('#table-body tr')].map(r=>r.querySelector('td')?.innerText?.trim()).filter(Boolean).join('\n');
  const btn=document.getElementById('btn-copy');
  if(navigator.clipboard?.writeText)navigator.clipboard.writeText(text).then(()=>showCopied(btn)).catch(()=>fallbackCopy(text,btn));else fallbackCopy(text,btn);
}
function fallbackCopy(text,btn){const ta=Object.assign(document.createElement('textarea'),{value:text,style:'position:fixed;top:0;left:0;opacity:0'});document.body.appendChild(ta);ta.focus();ta.select();try{document.execCommand('copy');showCopied(btn);}catch{btn.textContent='⚠ Error';setTimeout(()=>btn.textContent='Copiar',2000);}document.body.removeChild(ta);}
function showCopied(btn){btn.textContent='Copiadas';btn.classList.add('copied');setTimeout(()=>{btn.textContent='Copiar';btn.classList.remove('copied');},2000);}

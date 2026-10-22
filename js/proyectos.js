// QA BCR Suite — Proyectos, variantes y tareas (20261028000001_proyectos_qa.sql).
// QA, QA Lead y Admin agregan; cada uno borra lo suyo y los leads cualquier cosa.
// La base hace cumplir los permisos: acá solo se muestran los botones que sirven.
let PROY={projects:[],variants:[],templates:[],tasks:[],names:new Map()};
let proySel=null,proyVar='';
async function loadProyectos(){
  if(!canEditCatalog())return;
  const res=await Promise.all([
    supabaseClient.from('projects').select('id,code,color,active,created_by').order('id'),
    supabaseClient.from('project_variants').select('id,project_id,name,active,created_by').order('id'),
    supabaseClient.from('templates').select('id,project_id,variant_id'),
    supabaseClient.from('template_tasks').select('id,template_id,position,task,created_by').order('position'),
    supabaseClient.from('profiles').select('id,full_name')
  ]);
  const failed=res.find(r=>r.error);
  if(failed){uiError('No se pudieron cargar los proyectos'+errorDetail(failed.error)+'.');return;}
  const [projects,variants,templates,tasks,people]=res.map(r=>r.data||[]);
  PROY={projects:projects.filter(p=>p.active),variants:variants.filter(v=>v.active),templates,tasks,names:new Map(people.map(p=>[p.id,p.full_name]))};
  if(proySel&&!PROY.projects.some(p=>p.id===proySel))proySel=null;
  renderProyectos();
}
function proyPuedeBorrar(row){return canManageConfig()||(!!row.created_by&&row.created_by===currentUser?.id);}
function proyProyecto(){return PROY.projects.find(p=>p.id===proySel)||null;}
function proyVariantes(){return PROY.variants.filter(v=>v.project_id===proySel);}
function proyVarianteId(){const v=proyVariantes().find(x=>x.name===proyVar);return v?v.id:null;}
function proyTemplate(){const vid=proyVarianteId();return PROY.templates.find(t=>t.project_id===proySel&&t.variant_id===vid)||null;}
function proyTareas(){const t=proyTemplate();return t?PROY.tasks.filter(x=>x.template_id===t.id).sort((a,b)=>a.position-b.position):[];}
function proyAutor(row){
  if(!row.created_by)return '';
  return 'agregada por '+(row.created_by===currentUser?.id?'vos':(PROY.names.get(row.created_by)||'otra persona'));
}
function renderProyectos(){
  const list=document.getElementById('proy-list');
  list.replaceChildren(...PROY.projects.map(p=>{
    const b=Object.assign(document.createElement('button'),{type:'button',className:'proj-btn'+(p.id===proySel?' active':'')});
    b.dataset.code=p.code;b.dataset.click='selectProyecto';b.dataset.args=JSON.stringify([p.id]);
    const dot=document.createElement('span');dot.className='proj-dot';dot.style.background=projColor(p.color);
    b.append(dot,document.createTextNode(p.code));
    return b;
  }));
  const proj=proyProyecto();
  document.getElementById('proy-panel').hidden=!proj;
  if(!proj)return;
  document.getElementById('proy-titulo').textContent=proj.code;
  const vars=proyVariantes();
  if(!vars.some(v=>v.name===proyVar))proyVar=vars.length?vars[0].name:'';
  const sel=document.getElementById('proy-variante');
  sel.replaceChildren(...(vars.length?vars.map(v=>new Option(v.name,v.name)):[new Option('(sin variante)','')]));
  sel.value=proyVar;
  const tareas=proyTareas();
  document.getElementById('proy-tareas').replaceChildren(...tareas.map(t=>{
    const li=document.createElement('li');li.className='proy-tarea';li.dataset.id=t.id;
    const txt=document.createElement('span');txt.className='proy-tarea-txt';txt.textContent=t.task;
    const autor=document.createElement('span');autor.className='proy-tarea-autor';autor.textContent=proyAutor(t);
    li.append(txt,autor);
    return li;
  }));
  document.getElementById('proy-vacio').hidden=tareas.length>0;
}
function selectProyecto(id){proySel=id;proyVar='';renderProyectos();}
function changeVariante(){proyVar=document.getElementById('proy-variante').value;renderProyectos();}
// Guarda, recarga la configuración (Generar tareas) y la pantalla.
async function proyGuardar(action){
  const ok=await persist(action,canEditCatalog());
  await loadProyectos();
  return ok;
}
// Un proyecto o variante inactivos solo los reactiva un QA Lead o Admin.
function proyInactivo(tipo,nombre){
  uiAlert(`Ya existe ${tipo} "${nombre}" desactivad${tipo==='un proyecto'?'o':'a'}. Pedile a un QA Lead o Admin que lo reactive.`);
}
async function addProyecto(){
  const input=document.getElementById('proy-new'),code=input.value.trim().toUpperCase();
  if(!code)return;
  const actual=PROY.projects.find(p=>p.code===code);
  if(actual){input.value='';selectProyecto(actual.id);return;}
  const existing=REFS.projects[code];
  if(existing&&!canManageConfig()){proyInactivo('un proyecto',code);return;}
  const used=PROY.projects.map(p=>p.color),color=PALETTE.find(c=>!used.includes(c))||PALETTE[PROY.projects.length%PALETTE.length];
  const ok=await proyGuardar(async()=>{
    if(existing)check(await supabaseClient.from('projects').update({active:true}).eq('id',existing).select('id'),true);
    else check(await supabaseClient.from('projects').insert({code,name:code,color}));
  });
  if(ok){input.value='';const p=PROY.projects.find(x=>x.code===code);if(p)selectProyecto(p.id);}
}
async function addVariante(){
  const proj=proyProyecto();if(!proj)return;
  const input=document.getElementById('proy-new-var'),name=input.value.trim();
  if(!name)return;
  if(proyVariantes().some(v=>v.name===name)){input.value='';proyVar=name;renderProyectos();return;}
  const existing=REFS.variants[variantKey(proj.code,name)];
  if(existing&&!canManageConfig()){proyInactivo('una variante',name);return;}
  const ok=await proyGuardar(async()=>{
    if(existing)check(await supabaseClient.from('project_variants').update({active:true}).eq('id',existing).select('id'),true);
    else check(await supabaseClient.from('project_variants').insert({project_id:proj.id,name}));
  });
  if(ok){input.value='';proyVar=name;renderProyectos();}
}
async function addTarea(){
  const proj=proyProyecto();if(!proj)return;
  const input=document.getElementById('proy-new-task'),task=input.value.trim();
  if(!task)return;
  const ok=await proyGuardar(async()=>check(await supabaseClient.rpc('add_template_task',{p_project_id:proj.id,p_variant_id:proyVarianteId(),p_task:task})));
  if(ok){input.value='';input.focus();}
}

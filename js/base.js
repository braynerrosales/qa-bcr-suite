// QA BCR Suite — Modelo de datos (Supabase, copia en localStorage) y navegación entre páginas.
/* ============ DATA MODEL (Supabase; localStorage solo como copia de respaldo) ============ */
const CACHE_KEY='qaBcrSuiteCache_v3';
const PALETTE=['#0a4fa3','#17805a','#c98a0b','#3b8fd4','#6b8e23','#c2563b','#0f8a80','#4a5d7a','#9b3550','#e0b400'];
const DAILY_KEYS=['daily1','daily2'];

// Forma que usa toda la app (la misma que devuelve get_app_config()).
const EMPTY_DB={
  people:{daily1:[],daily2:[]},
  rules:{
    daily1:{firstGroup:[],range:1,lastFixed:[]},
    daily2:{firstGroup:[],range:1,lastFixed:[]}
  },
  projects:{}
};

function clone(o){return JSON.parse(JSON.stringify(o));}
function mergeDeep(base,loaded){
  if(Array.isArray(base))return Array.isArray(loaded)?loaded:base;
  if(base&&typeof base==='object'){
    const out={...base};
    if(loaded&&typeof loaded==='object'){for(const k in loaded){out[k]=mergeDeep(base[k]!==undefined?base[k]:loaded[k],loaded[k]);}for(const k in base){if(!(k in out))out[k]=base[k];}}
    return out;
  }
  return loaded!==undefined?loaded:base;
}
let DB=clone(EMPTY_DB);

// ids de Supabase por nombre, para poder guardar cambios.
// Incluye filas inactivas: agregar algo que existía lo reactiva.
let REFS={groups:{},members:{},projects:{},variants:{}};
const memberKey=(dk,name)=>dk+'\u0000'+name;
const variantKey=(code,name)=>code+'\u0000'+name;

function readCache(){
  try{
    const c=JSON.parse(localStorage.getItem(CACHE_KEY)||'null');
    return c&&currentUser&&c.userId===currentUser.id?c:null;
  }catch(e){return null;}
}
function writeCache(){
  try{localStorage.setItem(CACHE_KEY,JSON.stringify({userId:currentUser.id,savedAt:new Date().toISOString(),db:DB}));}
  catch(e){console.warn('No se pudo guardar la copia local',e);}
}
function clearCache(){try{localStorage.removeItem(CACHE_KEY);}catch(e){}}

async function fetchConfig(){
  const results=await Promise.all([
    supabaseClient.rpc('get_app_config'),
    supabaseClient.from('daily_groups').select('id,code'),
    supabaseClient.from('daily_members').select('id,daily_group_id,name'),
    supabaseClient.from('projects').select('id,code'),
    supabaseClient.from('project_variants').select('id,project_id,name')
  ]);
  const failed=results.find(r=>r.error);
  if(failed)throw failed.error;
  const [cfg,groups,members,projects,variants]=results.map(r=>r.data);
  const groupCode={},projectCode={},refs={groups:{},members:{},projects:{},variants:{}};
  groups.forEach(g=>{groupCode[g.id]=g.code;refs.groups[g.code]=g.id;});
  members.forEach(m=>{if(groupCode[m.daily_group_id])refs.members[memberKey(groupCode[m.daily_group_id],m.name)]=m.id;});
  projects.forEach(p=>{projectCode[p.id]=p.code;refs.projects[p.code]=p.id;});
  variants.forEach(v=>{if(projectCode[v.project_id])refs.variants[variantKey(projectCode[v.project_id],v.name)]=v.id;});
  REFS=refs;
  DB=mergeDeep(clone(EMPTY_DB),cfg||{});
  // Si hay un proyecto o una variante sin plantilla, se usa la IA (como en v2).
  Object.values(DB.projects).forEach(p=>{p.variants=p.variants||[];p.templates=p.templates||{};});
}

function renderData(){
  renderProjectButtons();
  updateDailyCounts();
  renderAdmin();
  refreshQaSelection();
}

async function loadConfig(){
  await fetchConfig();
  writeCache();
  renderData();
  const empty=!Object.keys(DB.projects).length&&DAILY_KEYS.every(dk=>!DB.people[dk].length);
  if(empty)showNotice('La base de Supabase todavía no tiene proyectos ni personas. Cargá los datos iniciales (seed.sql) o agregalos desde Administración.');
  else hideNotice();
}

async function retryLoadConfig(){
  showNotice('Cargando datos desde Supabase…');
  try{await loadConfig();setBackupStatus('Datos recargados desde Supabase.');}
  catch(e){console.error(e);showNotice('No se pudieron cargar los datos de Supabase'+errorDetail(e)+'.',true);}
}

function showNotice(text,retry){
  document.getElementById('data-banner-text').textContent=text;
  document.getElementById('data-banner-btn').hidden=!retry;
  document.getElementById('data-banner').classList.add('visible');
}
function hideNotice(){document.getElementById('data-banner').classList.remove('visible');}
function setBackupStatus(text){document.getElementById('backup-status').textContent=text;}

function errorDetail(e){return e&&(e.code||e.message)?` (${[e.code,e.message].filter(Boolean).join(': ')})`:'';}
function writeErrorMessage(e){
  if(e&&e.code==='23505')return 'Ya existe un registro con ese nombre.';
  if(e&&(e.code==='42501'||e.code==='PGRST116'))return 'No tenés permiso para este cambio.';
  // Mensajes propios de la base (raise exception sin código), por ejemplo una semana de horas cerrada.
  if(e&&e.code==='P0001'&&e.message)return e.message;
  return 'No se pudo guardar'+errorDetail(e)+'.';
}

// Ejecuta un cambio en Supabase y vuelve a cargar todo desde la base,
// así la pantalla siempre muestra lo guardado (también si el cambio falla).
let saving=false;
async function persist(action){
  if(!canManageConfig()){uiAlert('No tenés permiso para modificar la configuración.');return false;}
  if(saving)return false;
  saving=true;
  document.body.classList.add('saving');
  let ok=true;
  try{await action();}
  catch(e){console.error(e);ok=false;uiError(writeErrorMessage(e));}
  try{await loadConfig();}
  catch(e){console.error(e);showNotice('El cambio se envió, pero no se pudieron recargar los datos'+errorDetail(e)+'.',true);}
  finally{saving=false;document.body.classList.remove('saving');}
  return ok;
}
// supabase-js no lanza excepciones: devuelve {data,error}.
function check(res,needRows){
  if(res.error)throw res.error;
  if(needRows&&(!res.data||(Array.isArray(res.data)&&!res.data.length)))throw {code:'42501'};
  return res.data;
}

/* ============ NAVIGATION ============ */
function showPage(id) {
  if(((id==='admin'||id==='solicitudes')&&!canManageConfig())||(id==='horas'&&!canUseHoras()))id='home';
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('.mobile-nav-btn').forEach((b,i) => { b.classList.remove('active'); if(['home','qa','daily','horas','solicitudes','admin','calc'][i]===id){b.classList.add('active');if(b.offsetParent)b.scrollIntoView({block:'nearest',inline:'nearest'});} });
  document.getElementById('page-'+id).classList.add('active');
  document.getElementById('nav-'+id).classList.add('active');
  if(id==='admin')renderAdmin();
  if(id==='solicitudes')SOL_LOADING=solMarkSeen().then(loadSolicitudes);
  if(id==='horas')openHoras();
  if(id==='daily')dlyShowTab(dlyTab);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

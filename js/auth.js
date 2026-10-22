// QA BCR Suite — Sesión, permisos por rol, contraseña.
/* ============ AUTH (Supabase) ============ */
const ROLE_LABELS={ADMIN:'Admin',QA_LEAD:'QA Lead',QA:'QA',BETA:'Beta',BOSS:'QA Boss'};
let supabaseClient=null, currentUser=null;

function canManageConfig(){return !!currentUser&&(currentUser.role==='ADMIN'||currentUser.role==='QA_LEAD');}
function isAdmin(){return !!currentUser&&currentUser.role==='ADMIN';}
// BETA: solo Generar tareas, Daily y Días hábiles (la base también le bloquea Horas).
function canUseHoras(){return !!currentUser&&!['BETA','BOSS'].includes(currentUser.role);}
// QA Boss: lo de BETA más Solicitudes y la campana, solo para leer; mira el Daily sin guardarlo.
function canViewSolicitudes(){return canManageConfig()||currentUser?.role==='BOSS';}
function canSaveDaily(){return !!currentUser&&currentUser.role!=='BOSS';}
// Proyectos, variantes y tareas: QA, QA Lead y Admin (BETA y QA Boss no).
function canEditCatalog(){return !!currentUser&&['ADMIN','QA_LEAD','QA'].includes(currentUser.role);}

function showAuth(state,message){
  document.body.classList.add('auth-locked');
  document.getElementById('auth-loading').hidden=state!=='loading';
  document.getElementById('auth-form').hidden=state!=='login';
  document.getElementById('auth-blocked').hidden=state!=='blocked';
  if(state==='login'){
    const err=document.getElementById('auth-error');
    err.className=message?'status-msg error':'status-msg';
    err.textContent=message||'';
    document.getElementById(message?'auth-password':'auth-email').focus();
  }
  if(state==='blocked'){
    document.getElementById('auth-blocked-text').textContent=message;
    document.getElementById('auth-blocked-logout').hidden=!supabaseClient;
  }
}

function showApp(){
  document.body.classList.remove('auth-locked');
  renderUserInfo();
  applyPermissions();
}

async function initAuth(){
  if(!SUPABASE_URL||!SUPABASE_ANON_KEY){showAuth('blocked','Falta configurar SUPABASE_URL y SUPABASE_ANON_KEY en js/config.js.');return;}
  if(!window.supabase){showAuth('blocked','No se pudo cargar la librería de Supabase. Revisá la conexión y recargá la página.');return;}
  // La app solo entra con correo y contraseña: no toma una sesión que venga en el enlace (#access_token=…),
  // así nadie hace entrar a otra persona con su cuenta mandándole un link.
  supabaseClient=window.supabase.createClient(SUPABASE_URL,SUPABASE_ANON_KEY,{auth:{detectSessionInUrl:false}});
  // Solo UI aquí: supabase-js no permite llamar a otros métodos de auth dentro de este callback.
  supabaseClient.auth.onAuthStateChange(event=>{
    if(event==='SIGNED_OUT'){currentUser=null;clearCache();showAuth('login');}
  });
  const {data:{session}}=await supabaseClient.auth.getSession();
  if(!session){showAuth('login');return;}
  await enterWithSession();
}

async function loadCurrentProfile(){
  const {data:{user},error:userError}=await supabaseClient.auth.getUser();
  if(userError)throw userError;
  const {data,error}=await supabaseClient.from('profiles').select('id,full_name,email,role,active,must_change_password').eq('id',user.id).maybeSingle();
  if(error)throw error;
  return data;
}

async function enterWithSession(){
  showAuth('loading');
  try{
    currentUser=await loadCurrentProfile();
  }catch(e){
    console.error('No se pudo cargar el perfil',e);
    currentUser=null;
    if(e&&(e.status===401||e.status===403||e.name==='AuthSessionMissingError')){
      // Sesión vencida o usuario eliminado: se descarta la sesión guardada.
      await supabaseClient.auth.signOut({scope:'local'});
      showAuth('login','Tu sesión expiró. Iniciá sesión de nuevo.');
    }else{
      const detail=e&&(e.code||e.message)?` (${[e.code,e.message].filter(Boolean).join(': ')})`:'';
      showAuth('blocked','No se pudo cargar tu perfil. Revisá la conexión y recargá la página.'+detail);
    }
    return;
  }
  if(!currentUser){showAuth('blocked','Tu usuario no tiene perfil en QA BCR Suite. Pedile a un administrador que lo revise.');return;}
  if(!currentUser.active){showAuth('blocked','Tu usuario está desactivado. Pedile a un administrador que lo reactive.');return;}
  // Primer ingreso con la contraseña temporal: la base no da permisos hasta cambiarla,
  // así que se pide antes de cargar nada. Al cambiarla, changePassword vuelve a entrar.
  if(currentUser.must_change_password){showAuth('password');openPasswordDialog(true);return;}
  try{
    await loadConfig();
  }catch(e){
    console.error('No se pudieron cargar los datos',e);
    const cache=readCache();
    if(!cache){showAuth('blocked','No se pudieron cargar los datos de Supabase. Revisá la conexión y recargá la página.'+errorDetail(e));return;}
    // Sin conexión: se muestra la última copia de este usuario, solo para consultar.
    DB=mergeDeep(clone(EMPTY_DB),cache.db);REFS={groups:{},members:{},projects:{},variants:{}};
    renderData();
    showNotice(`Sin conexión con Supabase: se muestran los datos guardados el ${new Date(cache.savedAt).toLocaleString()}. Los cambios no se guardarán.`,true);
  }
  showApp();
}

function loginErrorMessage(error){
  if(error.code==='invalid_credentials'||/invalid login credentials/i.test(error.message||''))return 'Correo o contraseña incorrectos.';
  if(error.code==='email_not_confirmed')return 'El correo no está confirmado. Pedile a un administrador que lo confirme en Supabase.';
  if(error.status===429)return 'Demasiados intentos. Esperá un momento e intentá de nuevo.';
  if(error.name==='AuthRetryableFetchError'||!error.status)return 'No se pudo conectar con el servidor. Revisá la conexión.';
  return 'No se pudo iniciar sesión: '+error.message;
}

// Ojito: muestra u oculta la contraseña del campo de al lado.
function pwEye(btn,show){
  const input=btn.parentElement.querySelector('input');
  if(show===undefined)show=input.type==='password';
  input.type=show?'text':'password';
  btn.setAttribute('aria-pressed',String(show));
  const label=show?'Ocultar contraseña':'Mostrar contraseña';
  btn.setAttribute('aria-label',label);btn.title=label;
}
function pwHideAll(root){root.querySelectorAll('.pw-eye').forEach(b=>pwEye(b,false));}
async function onLoginSubmit(event){
  event.preventDefault();
  pwHideAll(document.getElementById('auth-form'));
  const btn=document.getElementById('auth-submit');
  const email=document.getElementById('auth-email').value.trim();
  const password=document.getElementById('auth-password').value;
  btn.disabled=true;btn.textContent='Ingresando…';
  let error=null;
  try{({error}=await supabaseClient.auth.signInWithPassword({email,password}));}
  catch(e){error=e;}
  btn.disabled=false;btn.textContent='Iniciar sesión';
  if(error){showAuth('login',loginErrorMessage(error));return;}
  document.getElementById('auth-password').value='';
  await enterWithSession();
}

async function logout(){
  closeInvite();
  clearCache();
  if(supabaseClient){
    try{const {error}=await supabaseClient.auth.signOut();if(error)throw error;}
    catch(e){await supabaseClient.auth.signOut({scope:'local'});}
  }
  location.reload();
}

function renderUserInfo(){
  const name=currentUser.full_name||currentUser.email||'';
  document.getElementById('sidebar-user-name').textContent=name;
  document.getElementById('sidebar-user-role').textContent=ROLE_LABELS[currentUser.role]||currentUser.role;
  document.getElementById('mobile-logout').title='Cerrar sesión ('+name+')';
  document.getElementById('home-greeting').textContent='Hola, '+(currentUser.full_name||'').trim().split(/\s+/)[0];
  const client=document.getElementById('home-client');if(!client.src)client.src='img/bcr-logo.png';client.hidden=false;
}

// Mejora la UI; la protección real está en el RLS de Supabase.
function applyPermissions(){
  const lead=canManageConfig();
  document.getElementById('nav-admin').hidden=!lead;
  document.getElementById('mnav-admin').hidden=!lead;
  ['nav-solicitudes','mnav-solicitudes','home-solicitudes'].forEach(id=>document.getElementById(id).hidden=!canViewSolicitudes());
  // QA Boss ve Solicitudes solo para leer: sin Nueva solicitud ni informes.
  ['sol-new-open','sol-inf-open'].forEach(id=>document.getElementById(id).hidden=!lead);
  document.getElementById('sol-subtitle').textContent=lead
    ?'Lista compartida entre QA Lead y Admin. Los cambios se guardan solos al salir de cada campo. Al cerrar una solicitud se quitan sus encargados del informe semanal.'
    :'Solo lectura: ves las solicitudes y sus avisos; los cambios los hacen QA Lead y Admin.';
  ['nav-horas','mnav-horas','home-horas'].forEach(id=>document.getElementById(id).hidden=!canUseHoras());
  ['nav-proyectos','mnav-proyectos'].forEach(id=>document.getElementById(id).hidden=!canEditCatalog());
  document.getElementById('dly-swap').hidden=!lead;
  document.getElementById('atab-users').hidden=!isAdmin();
  document.getElementById('atab-feedback').hidden=!isAdmin();
  if(!isAdmin()&&['asec-users','asec-feedback'].some(id=>document.getElementById(id).classList.contains('active')))selectAdminTab('people');
  if(isAdmin())refreshFeedbackBadge();
  ['avisos-btn','mavisos-btn'].forEach(id=>document.getElementById(id).hidden=!canViewSolicitudes());
  if(canViewSolicitudes()){refreshSolBadge();solSubscribe();}
  const en=id=>document.getElementById('page-'+id).classList.contains('active');
  if((!lead&&en('admin'))||(!canViewSolicitudes()&&en('solicitudes'))||(!canUseHoras()&&en('horas')))showPage('home');
}

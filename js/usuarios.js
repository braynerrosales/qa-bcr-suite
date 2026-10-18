// QA BCR Suite — Administración → Usuarios (solo ADMIN).
/* ============ ADMIN: USUARIOS ============ */
let USERS=[];
async function renderUsersAdmin(){
  const box=document.getElementById('list-users');
  if(!isAdmin()){box.innerHTML='';return;}
  box.innerHTML='<div class="crud-empty">Cargando usuarios…</div>';
  const [{data,error},access]=await Promise.all([
    supabaseClient.from('profiles').select('id,full_name,email,role,active').order('full_name'),
    supabaseClient.rpc('admin_user_access')
  ]);
  if(error){box.innerHTML='<div class="crud-empty">No se pudieron cargar los usuarios.</div>';return;}
  USERS=data;
  // Si falta la migración de accesos, la lista se muestra igual, sin el estado.
  const acc=new Map((access.error?[]:access.data||[]).map(a=>[a.id,a]));
  box.innerHTML=data.length?data.map(u=>{
    const self=u.id===currentUser.id;
    const lock=self?' disabled title="No podés cambiar tu propio usuario"':'';
    const options=Object.keys(ROLE_LABELS).map(r=>`<option value="${r}"${r===u.role?' selected':''}>${ROLE_LABELS[r]}</option>`).join('');
    return `<div class="crud-item">
      <span class="crud-item-name">${escapeHtml(u.full_name)}${self?' (vos)':''}<span class="user-email">${escapeHtml(u.email||'')}</span>${userAccessBadge(acc.get(u.id))}</span>
      <select class="user-role-select" aria-label="Rol de ${escapeHtml(u.full_name)}" data-id="${u.id}"${lock} data-change="setUserRole">${options}</select>
      <label class="crud-label-small"><input type="checkbox" class="crud-checkbox" data-id="${u.id}"${u.active?' checked':''}${lock} data-change="setUserActive"> Activo</label>
      <button type="button" class="btn-secondary user-rename" data-id="${u.id}" data-click="editUserName">Cambiar nombre</button>
      ${self?'':`<button type="button" class="btn-secondary user-reset" data-id="${u.id}" data-click="resetUserPassword">Nueva contraseña</button>`}
      ${self?'':`<button type="button" class="crud-btn-del user-delete" data-id="${u.id}" data-click="deleteUser">Eliminar</button>`}
    </div>`;
  }).join(''):'<div class="crud-empty">No hay usuarios.</div>';
}

function fmtDateTime(iso){return new Date(iso).toLocaleString('es-CR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});}
function userAccessBadge(a){
  if(!a)return '';
  let cls,text,title='';
  if(!a.last_sign_in_at){cls='is-pending';text='Nunca entró';}
  else if(a.must_change_password){cls='is-temp';text='Entró, falta cambiar la contraseña';title='Primer ingreso: '+fmtDateTime(a.first_sign_in_at||a.last_sign_in_at);}
  else{
    cls='is-ok';text='Último ingreso: '+fmtDateTime(a.last_sign_in_at);
    title=[a.first_sign_in_at&&'Primer ingreso: '+fmtDateTime(a.first_sign_in_at),a.password_changed_at&&'Contraseña cambiada: '+fmtDateTime(a.password_changed_at)].filter(Boolean).join(' · ');
  }
  return `<span class="user-access ${cls}"${title?` title="${escapeHtml(title)}"`:''}>${escapeHtml(text)}</span>`;
}

async function updateUser(id,changes,input){
  const st=document.getElementById('users-status');
  st.className='status-msg info';st.textContent='Guardando…';
  input.disabled=true;
  const {data,error}=await supabaseClient.from('profiles').update(changes).eq('id',id).select('id');
  input.disabled=false;
  if(error||!data||!data.length){
    // Supabase rechazó el cambio: se vuelve a mostrar lo que hay en la base.
    st.className='status-msg error';
    st.textContent='No se pudo guardar.'+(error?' '+error.message:' No tenés permiso para este cambio.');
    await renderUsersAdmin();
    return;
  }
  st.className='status-msg ok';st.textContent='Guardado';
  return true;
}

// El nombre se edita en la misma fila: Enter guarda, Esc cancela.
function editUserName(id,btn){
  const u=USERS.find(x=>x.id===id);if(!u||!isAdmin())return;
  const name=btn.closest('.crud-item').querySelector('.crud-item-name');
  const form=Object.assign(document.createElement('form'),{className:'user-name-form'});
  const input=Object.assign(document.createElement('input'),{type:'text',className:'crud-input',value:u.full_name,maxLength:120,required:true});
  input.setAttribute('aria-label','Nombre de '+u.full_name);
  const save=Object.assign(document.createElement('button'),{type:'submit',className:'btn-primary user-rename',textContent:'Guardar'});
  const cancel=Object.assign(document.createElement('button'),{type:'button',className:'btn-secondary user-rename',textContent:'Cancelar'});
  cancel.addEventListener('click',renderUsersAdmin);
  input.addEventListener('keydown',e=>{if(e.key==='Escape')renderUsersAdmin();});
  form.addEventListener('submit',async e=>{
    e.preventDefault();
    const v=input.value.trim().replace(/\s+/g,' ');
    if(!v){input.value='';input.focus();return;}
    if(v===u.full_name){renderUsersAdmin();return;}
    save.disabled=true;
    if(!await updateUser(id,{full_name:v},input))return;
    if(id===currentUser.id){currentUser.full_name=v;renderUserInfo();}
    hrsPeople=null;
    renderUsersAdmin();
  });
  form.append(input,save,cancel);
  name.replaceChildren(form);btn.hidden=true;
  input.focus();input.select();
}

// La contraseña temporal no queda a la vista (pantalla compartida, capturas): solo se muestra con "Ver".
function setPasswordVisible(show){
  document.getElementById('nu-password').type=show?'text':'password';
  const b=document.getElementById('nu-show');
  b.textContent=show?'Ocultar':'Ver';b.setAttribute('aria-pressed',String(show));
}
function togglePasswordVisible(){setPasswordVisible(document.getElementById('nu-password').type==='password');}
function randomPassword(){
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*';
  const bytes=crypto.getRandomValues(new Uint32Array(14));
  return [...bytes].map(b=>chars[b%chars.length]).join('');
}
function generatePassword(){document.getElementById('nu-password').value=randomPassword();}
// Mensaje legible para un error de la Edge Function.
async function functionErrorMessage(error){
  let msg=error.message;
  const res=error.context;
  // FunctionsFetchError: el navegador no recibió respuesta (función sin publicar, con "Verify JWT"
  // activado o caída al arrancar; en esos casos la respuesta llega sin CORS y el navegador la bloquea).
  if(error.name==='FunctionsFetchError')msg='No se pudo contactar la función admin-create-user. Revisá en Supabase → Edge Functions que esté publicada con ese nombre exacto y con "Verify JWT" desactivado (ver README).';
  if(res&&typeof res.json==='function'){
    // Un 404 sin {error} es de Supabase: la función no existe.
    let b=null;try{b=await res.json();}catch(e){}
    if(b&&b.error)msg=b.error;
    else if(res.status===404)msg='La función admin-create-user no está publicada en Supabase (ver README).';
  }
  return msg;
}

// Crear usuarios necesita la clave secreta de Supabase: lo hace la Edge Function
// admin-create-user (supabase/functions), que además comprueba que quien llama sea ADMIN.
async function createUser(event){
  event.preventDefault();
  const st=document.getElementById('user-create-status'),btn=document.getElementById('nu-submit');
  if(!isAdmin()){st.className='status-msg error';st.textContent='Solo un ADMIN puede crear usuarios.';return;}
  const body={
    full_name:document.getElementById('nu-name').value.trim(),
    email:document.getElementById('nu-email').value.trim(),
    role:document.getElementById('nu-role').value,
    password:document.getElementById('nu-password').value
  };
  closeInvite();
  st.className='status-msg info';st.textContent='Creando usuario…';btn.disabled=true;
  const {data,error}=await supabaseClient.functions.invoke('admin-create-user',{body});
  btn.disabled=false;
  if(error){st.className='status-msg error';st.textContent=await functionErrorMessage(error);return;}
  document.getElementById('user-create-form').reset();
  setPasswordVisible(false);
  st.className='status-msg ok';
  st.textContent=`Usuario creado: ${data.email} (${ROLE_LABELS[data.role]||data.role}). Copiá el mensaje de abajo y compartilo por un canal privado; la contraseña no se vuelve a mostrar.`;
  showInvite({name:body.full_name,email:data.email,role:ROLE_LABELS[data.role]||data.role,password:body.password});
  await renderUsersAdmin();
}
// Contraseña olvidada: el ADMIN genera una temporal nueva (la Edge Function la
// cambia en Auth y vuelve a pedir el cambio al entrar) y la comparte con el mensaje.
// Eliminar es definitivo y solo vale para quien no tiene horas (se conservan para los informes);
// para que alguien no entre más alcanza con desmarcar "Activo".
async function deleteUser(id,btn){
  const u=USERS.find(x=>x.id===id);if(!u||!isAdmin()||id===currentUser.id)return;
  if(!confirm(`¿Eliminar a ${u.full_name} (${u.email||'sin correo'})?\n\nSe borra su usuario y no se puede deshacer. Si tiene horas registradas no se elimina, para no cambiar los informes.\nSi solo querés que no entre más, cancelá y desmarcá "Activo".`))return;
  const st=document.getElementById('users-status');
  st.className='status-msg info';st.textContent='Eliminando…';btn.disabled=true;
  const {error}=await supabaseClient.functions.invoke('admin-create-user',{body:{action:'delete_user',id}});
  btn.disabled=false;
  if(error){st.className='status-msg error';st.textContent=await functionErrorMessage(error);return;}
  st.className='status-msg ok';st.textContent=`${u.full_name} fue eliminado.`;
  hrsPeople=null;
  await renderUsersAdmin();
}
async function resetUserPassword(id,btn){
  const u=USERS.find(x=>x.id===id);if(!u||!isAdmin())return;
  if(!confirm(`¿Generar una contraseña temporal nueva para ${u.full_name}? La contraseña actual deja de servir y se cierran sus sesiones abiertas.`))return;
  const st=document.getElementById('user-create-status'),password=randomPassword();
  closeInvite();
  st.className='status-msg info';st.textContent='Generando contraseña…';btn.disabled=true;
  const {error}=await supabaseClient.functions.invoke('admin-create-user',{body:{action:'reset_password',id,password}});
  btn.disabled=false;
  if(error){st.className='status-msg error';st.textContent=await functionErrorMessage(error);st.scrollIntoView({block:'nearest'});return;}
  st.className='status-msg ok';
  st.textContent=`Contraseña temporal nueva para ${u.email}. Copiá el mensaje y compartilo por un canal privado; no se vuelve a mostrar.`;
  showInvite({name:u.full_name,email:u.email,role:ROLE_LABELS[u.role]||u.role,password,reset:true});
  st.scrollIntoView({block:'nearest'});
  await renderUsersAdmin();
}
// Mensaje de bienvenida con los datos de acceso. La contraseña solo vive en
// inviteText (para copiarla) y en pantalla se ve oculta.
let inviteText='';
function inviteMessage(d,pw){
  const first=d.name.split(/\s+/)[0]||d.name;
  if(d.reset)return `Hola ${first}, te generé una contraseña temporal nueva para QA BCR Suite.

Enlace: ${location.origin}${location.pathname}
Usuario: ${d.email}
Contraseña temporal: ${pw}

Al entrar te va a pedir que elijas una contraseña nueva; la temporal deja de servir. No compartas tu contraseña con nadie.`;
  return `Hola ${first}, ya tenés acceso a QA BCR Suite.

Enlace: ${location.origin}${location.pathname}
Usuario: ${d.email}
Contraseña temporal: ${pw}
Rol: ${d.role}

Al entrar por primera vez te va a pedir que elijas una contraseña nueva; la temporal deja de servir. No compartas tu contraseña con nadie.`;
}
function showInvite(d){
  inviteText=inviteMessage(d,d.password);
  document.getElementById('user-invite-text').textContent=inviteMessage(d,'•'.repeat(10));
  document.getElementById('user-invite').hidden=false;
}
function closeInvite(){
  inviteText='';
  document.getElementById('user-invite-text').textContent='';
  document.getElementById('user-invite').hidden=true;
}
function copyInvite(){
  const btn=document.getElementById('user-invite-copy');
  const done=()=>{btn.textContent='✓ Copiado';setTimeout(()=>btn.textContent='Copiar mensaje',2000);};
  const fail=()=>{btn.textContent='⚠ No se pudo copiar';setTimeout(()=>btn.textContent='Copiar mensaje',2500);};
  if(!inviteText)return;
  if(navigator.clipboard?.writeText)navigator.clipboard.writeText(inviteText).then(done).catch(()=>legacyCopy(inviteText)?done():fail());
  else legacyCopy(inviteText)?done():fail();
}
function legacyCopy(text){
  const ta=Object.assign(document.createElement('textarea'),{value:text,style:'position:fixed;top:0;left:0;opacity:0'});
  document.body.appendChild(ta);ta.select();
  let ok=false;try{ok=document.execCommand('copy');}catch{}
  ta.remove();return ok;
}

function openPasswordDialog(forced=false){
  const d=document.getElementById('pw-dialog');
  d.querySelector('form').reset();
  pwHideAll(d);
  d.dataset.forced=forced?'1':'';
  document.getElementById('pw-title').textContent=forced?'Cambiá tu contraseña temporal':'Cambiar contraseña';
  document.getElementById('pw-forced-hint').hidden=!forced;
  document.getElementById('pw-cancel').hidden=forced;
  document.getElementById('pw-logout').hidden=!forced;
  document.getElementById('pw-status').className='status-msg';document.getElementById('pw-status').textContent='';
  d.showModal();
}
async function changePassword(event){
  event.preventDefault();
  const pw=document.getElementById('pw-new').value,st=document.getElementById('pw-status'),btn=document.getElementById('pw-submit');
  if(pw!==document.getElementById('pw-confirm').value){st.className='status-msg error';st.textContent='Las contraseñas no coinciden.';return;}
  btn.disabled=true;st.className='status-msg info';st.textContent='Guardando…';
  const {error}=await supabaseClient.auth.updateUser({password:pw});
  btn.disabled=false;
  if(error){
    st.className='status-msg error';
    st.textContent=error.code==='same_password'?'La contraseña nueva debe ser distinta de la actual.':error.code==='weak_password'?'La contraseña es demasiado débil.':'No se pudo cambiar: '+error.message;
    return;
  }
  st.className='status-msg ok';st.textContent='Contraseña actualizada.';
  if(currentUser)currentUser.must_change_password=false;
  const d=document.getElementById('pw-dialog');d.dataset.forced='';
  setTimeout(()=>d.close(),1200);
}
function closeForcedAndLogout(){const d=document.getElementById('pw-dialog');d.dataset.forced='';d.close();logout();}
// Con la contraseña temporal el diálogo no se cierra con Escape.
document.getElementById('pw-dialog').addEventListener('cancel',e=>{if(e.currentTarget.dataset.forced)e.preventDefault();});

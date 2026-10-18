// QA BCR Suite — Feedback.
/* ============ FEEDBACK ============ */
// Cualquier usuario envía; solo un ADMIN lee (RLS de public.feedback).
function openFeedback(){
  const d=document.getElementById('fb-dialog');
  d.querySelector('form').reset();
  document.getElementById('fb-count').textContent='0 / 2000';
  const st=document.getElementById('fb-status');st.className='status-msg';st.textContent='';
  document.getElementById('fb-send').disabled=false;
  d.showModal();
  document.getElementById('fb-text').focus();
}
document.addEventListener('input',e=>{if(e.target.id==='fb-text')document.getElementById('fb-count').textContent=e.target.value.length+' / 2000';});
async function sendFeedback(e){
  e.preventDefault();
  const text=document.getElementById('fb-text').value.trim(),st=document.getElementById('fb-status'),btn=document.getElementById('fb-send');
  if(!text){document.getElementById('fb-text').focus();return;}
  btn.disabled=true;st.className='status-msg info';st.textContent='Enviando…';
  // Sin .select(): quien envía no puede leer el feedback.
  const {error}=await supabaseClient.from('feedback').insert({mensaje:text});
  if(error){
    btn.disabled=false;st.className='status-msg error';
    st.textContent=(error.code==='54000'?'Llegaste al máximo de 20 mensajes por día. Probá mañana.':'No se pudo enviar'+errorDetail(error)+'.');
    return;
  }
  st.className='status-msg ok';st.textContent='¡Gracias! Lo recibieron los ADMIN.';
  document.getElementById('fb-text').value='';
  if(isAdmin())refreshFeedbackBadge();
  setTimeout(()=>document.getElementById('fb-dialog').close(),1400);
}
let FEEDBACK=[];
async function refreshFeedbackBadge(){
  const {count,error}=await supabaseClient.from('feedback').select('id',{count:'exact',head:true}).eq('leido',false);
  const b=document.getElementById('fb-badge');
  b.hidden=!!error||!count;b.textContent=count||'';
  b.setAttribute('aria-label',(count||0)+' sin leer');
}
async function loadFeedbackAdmin(){
  const box=document.getElementById('list-feedback');
  if(!isAdmin()){box.innerHTML='';return;}
  box.innerHTML='<div class="crud-empty">Cargando…</div>';
  const {data,error}=await supabaseClient.from('feedback').select('id,autor,mensaje,leido,created_at').order('created_at',{ascending:false}).limit(500);
  if(error){box.innerHTML='<div class="crud-empty">No se pudo cargar el feedback.</div>';return;}
  FEEDBACK=data||[];
  renderFeedbackAdmin();
}
function renderFeedbackAdmin(){
  const box=document.getElementById('list-feedback');
  const all=document.querySelector('input[name=fb-filter]:checked')?.value==='all';
  const list=FEEDBACK.filter(f=>all||!f.leido);
  const pending=FEEDBACK.filter(f=>!f.leido).length,b=document.getElementById('fb-badge');
  b.hidden=!pending;b.textContent=pending||'';b.setAttribute('aria-label',pending+' sin leer');
  box.innerHTML=list.length?list.map(f=>`<div class="fb-item${f.leido?'':' unread'}">
      <div class="fb-head"><strong>${escapeHtml(f.autor||'Usuario eliminado')}</strong><span>${fmtDateTime(f.created_at)}</span>${f.leido?'<span>Leído</span>':''}</div>
      <p class="fb-msg">${escapeHtml(f.mensaje)}</p>
      <div class="fb-actions">
        <button type="button" class="btn-secondary user-reset" data-id="${f.id}" data-click="setFeedbackRead" data-leido="${!f.leido}">${f.leido?'Marcar sin leer':'Marcar leído'}</button>
        <button type="button" class="crud-btn-del" data-id="${f.id}" data-click="deleteFeedback">Eliminar</button>
      </div>
    </div>`).join(''):`<div class="crud-empty">${all?'Todavía no hay feedback.':'No hay feedback sin leer.'}</div>`;
}
async function feedbackWrite(run,btn){
  const st=document.getElementById('fb-admin-status');
  btn.disabled=true;
  const {data,error}=await run();
  btn.disabled=false;
  if(error||!data?.length){st.className='status-msg error';st.textContent=(error?writeErrorMessage(error):'No tenés permiso para este cambio.');await loadFeedbackAdmin();return;}
  st.className='status-msg';st.textContent='';
  await loadFeedbackAdmin();
}
function setFeedbackRead(id,leido,btn){feedbackWrite(()=>supabaseClient.from('feedback').update({leido}).eq('id',id).select('id'),btn);}
function deleteFeedback(id,btn){
  if(!confirm('¿Eliminar este feedback? No se puede deshacer.'))return;
  feedbackWrite(()=>supabaseClient.from('feedback').delete().eq('id',id).select('id'),btn);
}

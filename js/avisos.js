// QA BCR Suite — Campana de avisos (QA Lead y Admin): qué solicitudes se agregaron o pasaron a
// "Plan enviado" en los últimos 7 días (solicitudes_avisos), también las propias. Abrirla marca
// visto, igual que entrar a Solicitudes; lo de otros posterior al visto anterior sale resaltado.
let AVISOS_PREV=null,avisosBtn=null,avisosTimer=null;
// Cada apertura y cada carga lleva su número: una respuesta vieja (de una apertura anterior
// o de una carga más lenta) no pisa a la más nueva.
let avisosOpenSeq=0,avisosLoadSeq=0;
function avisosPanel(){return document.getElementById('avisos-panel');}
function avisosOpen(){return avisosPanel().open;}
function setAvisosExpanded(v){['avisos-btn','mavisos-btn'].forEach(id=>document.getElementById(id).setAttribute('aria-expanded',String(v)));}
function toggleAvisos(btn){if(avisosOpen())closeAvisos(true);else openAvisos(btn);}
async function openAvisos(btn){
  const seq=++avisosOpenSeq;
  avisosBtn=btn;
  const panel=avisosPanel();
  // Abajo de la campana que se tocó (la del menú lateral o la de arriba en el celular).
  panel.style.setProperty('--avisos-top',Math.round(btn.getBoundingClientRect().bottom+8)+'px');
  document.getElementById('avisos-list').replaceChildren(avisosMsg('avisos-empty','Cargando…'));
  panel.show();setAvisosExpanded(true);
  const prev=await solMarkSeen();
  if(seq!==avisosOpenSeq)return;
  AVISOS_PREV=prev;
  await loadAvisos(true);
}
function closeAvisos(returnFocus=false){
  if(!avisosOpen())return;
  clearTimeout(avisosTimer);avisosOpenSeq++;avisosLoadSeq++;
  avisosPanel().close();setAvisosExpanded(false);
  if(returnFocus&&avisosBtn)avisosBtn.focus();
}
async function loadAvisos(focus=false){
  const seq=++avisosLoadSeq;
  const {data,error}=await supabaseClient.rpc('solicitudes_avisos');
  if(seq!==avisosLoadSeq||!avisosOpen())return;
  renderAvisos(error?null:(data||[]));
  if(focus)(document.querySelector('#avisos-list button')||avisosPanel()).focus();
}
function avisosMsg(cls,text){const li=document.createElement('li');li.className=cls;li.textContent=text;return li;}
function renderAvisos(rows){
  const list=document.getElementById('avisos-list');
  if(!rows){
    const li=document.createElement('li');li.className='avisos-error';
    const msg=document.createElement('span');msg.textContent='No se pudieron cargar los avisos.';
    const retry=Object.assign(document.createElement('button'),{type:'button',className:'btn-secondary',textContent:'Reintentar'});
    retry.addEventListener('click',()=>loadAvisos(true));
    li.append(msg,retry);list.replaceChildren(li);return;
  }
  if(!rows.length){list.replaceChildren(avisosMsg('avisos-empty','No hubo novedades en los últimos 7 días.'));return;}
  const prev=AVISOS_PREV?new Date(AVISOS_PREV):null;
  // Al rehacer la lista en vivo, el foco vuelve al mismo aviso (si sigue en la lista).
  const focused=document.activeElement?.closest?.('#avisos-list .aviso')?.dataset.key;
  list.replaceChildren(...rows.map(r=>{
    const li=document.createElement('li');
    const b=Object.assign(document.createElement('button'),{type:'button',className:'aviso'+(!r.propio&&prev&&new Date(r.fecha)>prev?' aviso-nuevo':'')});
    b.dataset.key=r.solicitud_id+':'+r.tipo;
    const txt=document.createElement('span');txt.className='aviso-txt';
    // Lo propio también se lista (sin resaltar), en segunda persona.
    txt.textContent=r.propio?(r.tipo==='plan'?`Pasaste ${r.nombre} a Plan enviado`:`Creaste ${r.nombre}`)
      :(r.autor||'Alguien')+(r.tipo==='plan'?` pasó ${r.nombre} a Plan enviado`:` creó ${r.nombre}`);
    const when=document.createElement('small');when.textContent=solAgo(r.fecha);
    b.append(txt,when);
    b.addEventListener('click',()=>goToSolicitud(r.solicitud_id));
    li.append(b);return li;
  }));
  if(focused)([...list.querySelectorAll('.aviso')].find(b=>b.dataset.key===focused)||list.querySelector('.aviso')||avisosPanel()).focus();
}
// Con el panel abierto, lo que llega en vivo se suma a la lista y queda visto.
function refreshAvisosOpen(){
  if(!avisosOpen())return;
  clearTimeout(avisosTimer);
  avisosTimer=setTimeout(async()=>{await solMarkSeen({keepPrev:true});await loadAvisos();},300);
}
async function goToSolicitud(id){
  closeAvisos();
  showPage('solicitudes');
  await SOL_LOADING;
  const row=()=>document.querySelector(`#sol-body tr[data-id="${CSS.escape(String(id))}"]`);
  // Si no se ve por la búsqueda o el filtro (por ejemplo, ya está cerrada), se muestran todas.
  if(!row()&&SOL.some(r=>r.id===id)){
    document.getElementById('sol-search').value='';
    document.getElementById('sol-filter').value='all';
    renderSolicitudes();
  }
  const tr=row();
  if(!tr){uiAlert('Esa solicitud ya no existe.');return;}
  tr.scrollIntoView({block:'center'});
  tr.classList.add('sol-flash');
  setTimeout(()=>tr.classList.remove('sol-flash'),2000);
}
// Esc cierra y devuelve el foco a la campana; un clic afuera cierra sin mover el foco.
// Esc en cualquier lado (el panel no es modal: el foco puede haber salido con Tab).
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&avisosOpen()){e.preventDefault();closeAvisos(true);}});
document.addEventListener('click',e=>{
  if(avisosOpen()&&!avisosPanel().contains(e.target)&&!e.target.closest('.avisos-btn'))closeAvisos();
});

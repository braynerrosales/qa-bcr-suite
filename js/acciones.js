// QA BCR Suite — qué hace cada botón y campo.
// El HTML no lleva onclick/onchange: así la CSP no necesita 'unsafe-inline' para scripts.
// Cada elemento dice qué función llama con data-click, data-change, data-input,
// data-submit o data-enter (Enter en un campo), y sus argumentos en data-args (JSON).
// Si la función necesita el elemento, su valor o sus data-*, está en ACCIONES.
const ACCIONES={
  toggleAvisos:el=>toggleAvisos(el),
  closeDialog:el=>document.getElementById(el.dataset.dialog).close(),
  toggleTheme:el=>toggleTheme(el),
  themeAuto:el=>themeAuto(el),
  pwEye:el=>pwEye(el),
  selectProject:el=>selectProject(el),
  toggleDone:el=>toggleDone(el),
  openMotivoMenu:el=>openMotivoMenu(el),
  dlySetMode:el=>dlySetMode(el.value),
  setRange:el=>setRange(el.dataset.daily,el.value),
  renamePerson:el=>renamePerson(el.dataset.daily,el.dataset.name),
  removePerson:el=>removePerson(el.dataset.daily,el.dataset.name),
  toggleFirstRule:el=>toggleFirstRule(el.dataset.daily,el.dataset.name,el.checked),
  toggleLastFixed:el=>toggleLastFixed(el.dataset.daily,el.dataset.name,el.checked),
  hrsPickPerson:el=>hrsPickPerson(el.value),
  hrsSetMode:el=>hrsSetMode(el.value),
  removeCalcOff:el=>el.closest('.calc-off-entry').remove(),
  setFeedbackRead:el=>setFeedbackRead(+el.dataset.id,el.dataset.leido==='true',el),
  deleteFeedback:el=>deleteFeedback(+el.dataset.id,el),
  setUserRole:el=>updateUser(el.dataset.id,{role:el.value},el),
  setUserActive:el=>updateUser(el.dataset.id,{active:el.checked},el),
  editUserName:el=>editUserName(el.dataset.id,el),
  resetUserPassword:el=>resetUserPassword(el.dataset.id,el),
  deleteUser:el=>deleteUser(el.dataset.id,el),
};
function runAction(name,el,ev){
  if(Object.hasOwn(ACCIONES,name))return ACCIONES[name](el,ev);
  const fn=window[name];
  if(typeof fn!=='function'){console.error('Acción desconocida: '+name);return;}
  // Los formularios reciben el evento (para evitar que la página se recargue).
  return ev.type==='submit'?fn(ev):fn(...(el.dataset.args?JSON.parse(el.dataset.args):[]));
}
// Gana el elemento más cercano al clic: "No asistió" no marca además que la persona habló.
function onAction(type,attr,when){
  document.addEventListener(type,ev=>{
    const el=ev.target.closest?.(`[data-${attr}]`);
    if(el&&(!when||when(ev)))runAction(el.dataset[attr],el,ev);
  });
}
onAction('click','click');
onAction('change','change');
onAction('input','input');
onAction('submit','submit');
onAction('keydown','enter',ev=>ev.key==='Enter');

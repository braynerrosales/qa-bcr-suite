// QA BCR Suite — avisos y preguntas con el diseño de la app, en lugar de alert/confirm/prompt
// del navegador (que no siguen el modo oscuro ni el estilo y en celular son incómodos).
// Devuelven una promesa: uiAlert → nada, uiConfirm → true/false, uiPrompt → el texto o null.
// Si se piden dos a la vez, el segundo espera a que se cierre el primero.
let uiQueue=Promise.resolve();
function uiDialog({title='',message,input=null,ok='Aceptar',cancel=null,danger=false}){
  const run=()=>new Promise(resolve=>{
    const d=document.getElementById('ui-dialog'),form=document.getElementById('ui-form'),
      titleEl=document.getElementById('ui-title'),inp=document.getElementById('ui-input'),
      okBtn=document.getElementById('ui-ok'),cancelBtn=document.getElementById('ui-cancel');
    titleEl.textContent=title;titleEl.hidden=!title;
    document.getElementById('ui-msg').textContent=message;
    inp.hidden=input===null;inp.value=input??'';
    okBtn.textContent=ok;okBtn.classList.toggle('ui-danger',danger);
    cancelBtn.hidden=!cancel;cancelBtn.textContent=cancel||'';
    const back=document.activeElement;
    // Cancelar, Escape o cerrar sin aceptar: false (confirmar) o null (pedir texto).
    let result=input===null?false:null;
    const onSubmit=e=>{e.preventDefault();result=input===null?true:inp.value;d.close();};
    const onCancel=()=>d.close();
    const onClose=()=>{
      form.removeEventListener('submit',onSubmit);cancelBtn.removeEventListener('click',onCancel);d.removeEventListener('close',onClose);
      if(back?.isConnected)back.focus();
      resolve(result);
    };
    form.addEventListener('submit',onSubmit);cancelBtn.addEventListener('click',onCancel);d.addEventListener('close',onClose);
    d.showModal();
    // Si la acción no se puede deshacer, el foco arranca en Cancelar: un Enter de más no borra nada.
    if(input!==null){inp.focus();inp.select();}else(danger&&cancel?cancelBtn:okBtn).focus();
  });
  const p=uiQueue.then(run);
  uiQueue=p.catch(()=>{});
  return p;
}
function uiAlert(message,title=''){return uiDialog({title,message,ok:'Entendido'}).then(()=>{});}
function uiError(message){return uiAlert(message,'No se pudo guardar');}
function uiConfirm(message,{title='',ok='Aceptar',danger=false}={}){return uiDialog({title,message,ok,cancel:'Cancelar',danger});}
function uiPrompt(message,value='',{title='',ok='Guardar'}={}){return uiDialog({title,message,input:value,ok,cancel:'Cancelar'});}

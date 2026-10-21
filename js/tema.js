// QA BCR Suite — tema día y noche.
// Se carga en <head>, antes de pintar la página, para que no parpadee el tema equivocado.
// Auto (por defecto) sigue al sistema con el CSS; el botón de sol y luna lo fija en este navegador.
const TEMA_KEY='qabcr-tema';
const temaMq=matchMedia('(prefers-color-scheme: dark)');
function temaLeer(){try{const v=localStorage.getItem(TEMA_KEY);return v==='light'||v==='dark'?v:'auto';}catch(e){return 'auto';}}
let temaModo=temaLeer();
function temaActual(){return temaModo==='auto'?(temaMq.matches?'dark':'light'):temaModo;}
function temaPintar(){
  const root=document.documentElement,t=temaActual();
  if(temaModo==='auto')delete root.dataset.theme;else root.dataset.theme=temaModo;
  document.querySelector('meta[name=theme-color]')?.setAttribute('content',t==='dark'?'#0a1830':'#0a3d7e');
  document.querySelectorAll('.theme-switch').forEach(b=>b.setAttribute('aria-checked',String(t==='dark')));
  document.querySelectorAll('.theme-auto').forEach(b=>b.setAttribute('aria-pressed',String(temaModo==='auto')));
  const label=document.getElementById('theme-label');
  if(label)label.textContent=temaModo==='auto'?'Automático · '+(t==='dark'?'noche':'día')+' (sistema)':'Fijado en '+(t==='dark'?'noche':'día');
}
// Cambia el modo; si cambia el color, la página nueva se abre en círculo desde el botón tocado.
function temaCambiar(from,modo){
  const antes=temaActual();
  temaModo=modo;
  try{if(modo==='auto')localStorage.removeItem(TEMA_KEY);else localStorage.setItem(TEMA_KEY,modo);}catch(e){}
  if(temaActual()===antes||!from||!document.startViewTransition||matchMedia('(prefers-reduced-motion: reduce)').matches){temaPintar();return;}
  const r=from.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
  const end=Math.hypot(Math.max(x,innerWidth-x),Math.max(y,innerHeight-y));
  document.startViewTransition(temaPintar).ready.then(()=>{
    document.documentElement.animate({clipPath:[`circle(0px at ${x}px ${y}px)`,`circle(${end}px at ${x}px ${y}px)`]},
      {duration:650,easing:'cubic-bezier(.4,0,.2,1)',pseudoElement:'::view-transition-new(root)'});
  }).catch(()=>{});
}
function toggleTheme(el){temaCambiar(el,temaActual()==='dark'?'light':'dark');}
// Auto encendido → se apaga dejando el tema que se ve; apagado → vuelve a seguir al sistema.
function themeAuto(el){temaCambiar(el,temaModo==='auto'?temaActual():'auto');}
temaMq.addEventListener('change',()=>{if(temaModo==='auto')temaPintar();});
// Otra pestaña cambió el tema: esta la sigue.
addEventListener('storage',e=>{if(e.key===TEMA_KEY||e.key===null){temaModo=temaLeer();temaPintar();}});
temaPintar();
document.addEventListener('DOMContentLoaded',temaPintar);

// QA BCR Suite — no se muestra dentro de un iframe de otro sitio (clickjacking).
// GitHub Pages no deja enviar frame-ancestors ni X-Frame-Options, y en un <meta> la CSP lo ignora.
if(window.top!==window.self){
  document.documentElement.style.display='none';
  try{window.top.location=window.location.href;}catch(e){}
}

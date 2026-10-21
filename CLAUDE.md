# QA BCR Suite

## UI

Al construir o modificar UI: aplica taste-skill, audita con web-design-guidelines, y verifica abriendo la página con Playwright CLI y tomando capturas antes de dar el trabajo por terminado.

## Cómo trabajar (inspirado en los consejos de Andrej Karpathy)

- **Pensar antes de programar.** Si el pedido es ambiguo, preguntar en vez de suponer. Si hay más de una forma razonable, decir cuál conviene y por qué antes de hacerla. Si piden análisis u opinión, responder primero y no avanzar sin aprobación.
- **Lo más simple que funcione.** Nada de funciones, opciones o abstracciones que nadie pidió. Si algo se puede hacer en menos código y queda claro, hacerlo así.
- **Cambios quirúrgicos.** Tocar solo lo necesario para el pedido. No reformatear, renombrar ni "mejorar" código vecino; si se ve otro problema, anotarlo como pendiente aparte.
- **Meta verificable.** Antes de empezar, definir cómo se sabe que quedó bien (una prueba que pasa, una captura, un caso reproducido). Reproducir el error antes de arreglarlo y comprobar el arreglo después.

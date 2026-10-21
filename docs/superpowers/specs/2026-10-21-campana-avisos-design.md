# Campana de avisos de solicitudes

Fecha: 2026-10-21 · Estado: borrador para revisión de Bray · Extiende `2026-10-21-notificaciones-solicitudes-design.md`, que ya está en `main`.

## Objetivo

Además del número junto a «Solicitudes», una campana que al tocarla muestra **qué** pasó: qué solicitud se agregó o pasó a *Plan enviado*, quién lo hizo y cuándo.

## Decisiones tomadas

| Tema | Decisión |
|---|---|
| Convivencia | Campana **y** número en «Solicitudes». Muestran el mismo conteo y se ponen en cero juntos. |
| Qué lista | Los últimos **10** avisos de los últimos **7 días**, hechos por otra persona. Los no vistos van resaltados; los vistos, en gris. |
| Visto | Abrir la campana marca visto, igual que entrar a Solicitudes. Es la misma marca por persona de hoy (`solicitudes_marcar_visto`). |
| Quién | QA Lead y Admin activos, como hoy. QA no ve la campana. |

## Qué ve el usuario

1. **Campana.** Es un botón con ícono 🔔 (SVG en línea, `aria-hidden`):
   - En escritorio va en `.sidebar-brand`, a la derecha de «QA BCR Suite».
   - En móvil va en `.mobile-topbar`, junto a `.mobile-logo`.
   - Lleva el mismo número naranja que `#sol-badge` (clase `fb-badge nav-count`).
   - Nombre accesible: «Avisos» sin novedades, y «Avisos, 1 sin ver» o «Avisos, N sin ver» con novedades.
   - `aria-haspopup="dialog"` y `aria-expanded`.
   - Se oculta para quien no es QA Lead ni Admin.
2. **Panel.** Es un `<dialog>` no modal, anclado bajo la campana. En móvil ocupa el ancho con 16 px de margen. Tiene el título «Avisos» y una lista de hasta 10 líneas:
   - *«{Nombre} creó {nombre de la solicitud}»*, o *«{Nombre} pasó {nombre} a Plan enviado»*;
   - abajo, el tiempo con el mismo formato de `solAgo()` («hace 5 min»);
   - las no vistas llevan un punto naranja y el nombre de la solicitud en negrita;
   - los nombres de personas y solicitudes se muestran como texto (`textContent`), nunca como HTML;
   - si la persona fue eliminada, se muestra «Alguien».
   - Si no hay nada: «No hubo novedades en los últimos 7 días.»
3. **Abrir el panel** carga la lista y marca visto. El resaltado usa el visto **anterior**, así que lo nuevo se ve resaltado esa vez. La campana y «Solicitudes» quedan sin número.
4. **Tocar un aviso** cierra el panel, abre Solicitudes, desplaza la vista hasta esa fila y la resalta 2 s (clase `sol-flash`). Si la fila no se ve por el filtro o la búsqueda, se limpia la búsqueda y el filtro pasa a «Todas». Si la solicitud ya no existe, se avisa con `uiAlert('Esa solicitud ya no existe.')`.
5. **Con el panel abierto**, un cambio en vivo que genera aviso recarga la lista y vuelve a marcar visto.
6. **Teclado.**
   - Enter o Espacio abre el panel.
   - El foco va al primer aviso, o al texto vacío.
   - Las flechas no son obligatorias: los avisos son botones en orden de tabulación.
   - **Esc** o un clic fuera cierra el panel y el foco vuelve a la campana.
7. La misma solicitud puede aparecer dos veces, una como «creó» y otra como «pasó a Plan enviado». El número la sigue contando una sola vez, como hoy.

## Base (migración nueva `supabase/migrations/20261026000001_solicitudes_avisos_lista.sql`)

`public.solicitudes_avisos() returns table (solicitud_id bigint, nombre text, tipo text, autor text, fecha timestamptz, sin_ver boolean)`

- `security definer`, `set search_path = ''` y `private.is_lead()`. Si no es lead, devuelve error 42501.
- Arma una lista con dos tipos de eventos:
  - `'nueva'`: viene de `created_by` y `created_at`;
  - `'plan'`: viene de `plan_enviado_by` y `plan_enviado_at`, solo si `plan_enviado` sigue en verdadero.
- Solo incluye eventos con autor no nulo y distinto de `auth.uid()`, con fecha posterior a `now() - interval '7 days'`. Los ordena por fecha descendente y devuelve `limit 10`.
- `autor` = `profiles.full_name`, o NULL si el perfil se borró.
- `sin_ver` = `fecha > visto_at` del usuario. Si no tiene fila de visto, es falso para todos. **No crea la fila**: eso lo sigue haciendo `solicitudes_novedades()`.
- `grant execute` a `authenticated`; `revoke` a `public` y `anon`.
- Cada solicitud tiene un solo `plan_enviado_at`, el último. Si se destilda y se vuelve a tildar, aparece solo el último. Es aceptable.

## App

- **`js/avisos.js` (nuevo):**
  - `openAvisos()`, `closeAvisos()` y `renderAvisos(rows)`;
  - `goToSolicitud(id)`;
  - el estado del panel.
  - Se carga después de `solicitudes.js`.
- **`js/solicitudes.js`:**
  - `setSolBadge(n)` también actualiza el número y el nombre accesible de la campana.
  - `solOnChange`, con el panel abierto, llama a `refreshAvisosOpen()`.
- **`js/auth.js`:** `applyPermissions()` muestra u oculta la campana.
- **`index.html` y `css/styles.css`:** la campana en los dos lugares, el panel, los estilos de aviso visto y no visto, y `.sol-flash`.
- **CSP:** sin estilos ni manejadores en línea. Los eventos van por `data-click`/`ACCIONES` o `addEventListener`, igual que el resto.

## Errores

- Si falla `solicitudes_avisos`, el panel muestra «No se pudieron cargar los avisos.» con un botón «Reintentar».
- Si falla marcar visto, la lista se ve igual y el número queda como estaba.

## Pruebas

- **SQL** (`supabase/tests/solicitudes_avisos_lista_test.sql`):
  - devuelve los eventos de otros, ordenados y como máximo 10;
  - excluye lo propio, los eventos de hace más de 7 días y los planes destildados;
  - `sin_ver` respeta el visto;
  - un autor borrado sale como NULL;
  - QA e inactivos reciben 42501.
- **E2E** (`tests/test-auth.mjs`, mock más la ruta `rpc/solicitudes_avisos`):
  - la campana tiene número, y al abrirla aparece la lista con vistos y no vistos y el número queda en cero en los dos lugares;
  - Esc devuelve el foco a la campana;
  - tocar un aviso lleva a la fila resaltada, cambiando el filtro si hace falta;
  - una solicitud borrada muestra el aviso;
  - lo propio no aparece;
  - QA no ve la campana;
  - un nombre con HTML se ve como texto;
  - con el panel abierto, lo que llega en vivo aparece.
- **Capturas** del panel abierto en escritorio y móvil, en claro y oscuro, y sin desborde en 375 px.

## Fuera de alcance

Marcar avisos uno por uno, avisos de otros estados, notificaciones del navegador y correo.

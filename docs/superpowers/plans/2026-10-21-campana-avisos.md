# Campana de avisos: plan de implementación

> **Para agentes:** SUB-SKILL REQUERIDO: superpowers:subagent-driven-development (recomendado) o superpowers:executing-plans. Los pasos usan casillas (`- [ ]`) para el seguimiento.

**Objetivo:** campana con el mismo número que «Solicitudes». Al tocarla abre un panel con los últimos 10 avisos de 7 días (creó o pasó a Plan enviado), con los no vistos resaltados, y lleva a la fila de cada solicitud.

**Arquitectura:** una RPC nueva, `solicitudes_avisos()`, arma la lista en la base. `js/avisos.js` maneja la campana y el panel (un `<dialog>` no modal compartido por las dos campanas) y reutiliza `solMarkSeen` y `setSolBadge`.

**Tecnología:** Postgres/Supabase, JS sin framework, Playwright con mock (`tests/test-auth.mjs`) y PGlite 0.3.7.

**Spec:** `docs/superpowers/specs/2026-10-21-campana-avisos-design.md`

## Restricciones globales

- Worktree `qa-bcr-suite-campana`, rama `feat/campana-avisos`. No tocar la carpeta principal. PR con `gh pr create` y después `gh pr merge --auto --merge`.
- Sin datos reales ni nombres del equipo. UI según CLAUDE.md: taste-skill no aplica a pantallas de app (decisión ya tomada), auditar con web-design-guidelines y sacar capturas.
- CSP: nada en línea; los eventos van por `data-click` y `ACCIONES` o por `addEventListener`. Todo texto de usuario se escribe con `textContent`.
- Textos exactos:
  - nombre del botón: «Avisos», «Avisos, 1 sin ver» o «Avisos, N sin ver»;
  - título del panel: «Avisos»;
  - avisos: «{autor} creó {nombre}» y «{autor} pasó {nombre} a Plan enviado»;
  - autor borrado: «Alguien»;
  - lista vacía: «No hubo novedades en los últimos 7 días.»;
  - error: «No se pudieron cargar los avisos.» con el botón «Reintentar»;
  - solicitud borrada: «Esa solicitud ya no existe.»
- E2E y SQL: los mismos comandos del plan anterior (`2026-10-21-notificaciones-solicitudes.md`, Restricciones globales).

## Foco de revisión

- Con el panel abierto se cambia de pantalla con el menú: el panel se cierra y el foco no se pierde. Se prueba en la Tarea 2.
- Un nombre de solicitud o de persona con `<b>`/`<img>` se ve como texto. Se prueba en la Tarea 2.
- Abrir el panel dos veces seguidas: la segunda vez nada sale resaltado, porque ya se marcó visto. Se prueba en la Tarea 2.
- En 375 px el panel no desborda y la campana no empuja los botones de arriba. Se prueba en la Tarea 3.
- Tocar un aviso de una solicitud cerrada con el filtro «Abiertas» la muestra igual. Se prueba en la Tarea 2.

---

### Tarea 1: RPC `solicitudes_avisos()`

**Archivos:**
- Crear: `supabase/migrations/20261026000001_solicitudes_avisos_lista.sql`
- Crear: `supabase/tests/solicitudes_avisos_lista_test.sql`, con el estilo de `solicitudes_avisos_test.sql`: usuarios a1/b1/c1/d1/e1, `begin`/`rollback`, «OK»/«FALLO».

**Produce:** `public.solicitudes_avisos() returns table (solicitud_id bigint, nombre text, tipo text, autor text, fecha timestamptz, sin_ver boolean)`, donde `tipo` es `'nueva'` o `'plan'`.

- [ ] **Paso 1: pruebas que fallan.** Las fechas se preparan como superusuario (`reset role`), porque `now()` no avanza dentro de la transacción.
  1. B crea 12 solicitudes. Para A, la lista trae 10, ordenadas por `fecha` descendente.
  2. Una solicitud creada por B y pasada a plan por E da, para A, dos filas: `'nueva'` y `'plan'`.
  3. Para B no aparece su propia `'nueva'`, y sí la `'plan'` de E.
  4. Una solicitud con `created_at` de hace 8 días no aparece.
  5. Un plan destildado (`plan_enviado = false`) no aparece como `'plan'`.
  6. Con `visto_at` entre dos eventos, `sin_ver` es verdadero solo para el más nuevo. Sin fila de visto, todo es falso y no se crea la fila.
  7. Si se borra el usuario E (`delete from auth.users`), su evento **sale** de la lista: `on delete set null` deja la fila sin autor. «Alguien» queda en la app solo como respaldo, para cuando `autor` llegue NULL.
  8. C (QA) y D (lead inactivo) reciben `sqlstate '42501'`.
- [ ] **Paso 2:** correr el runner con el archivo nuevo. Resultado esperado: `FALLA` porque la función no existe.
- [ ] **Paso 3: migración.**
  - `language plpgsql stable security definer set search_path = ''`. Valida `private.is_lead()`, lanza 42501 si no corresponde y después hace `return query`.
  - El cuerpo es `union all` de los dos tipos de evento, `left join public.profiles`, `left join public.solicitudes_vistas` del usuario, `order by fecha desc`, `limit 10`.
  - `revoke` a `public` y `anon`; `grant execute` a `authenticated`.
- [ ] **Paso 4:** correr el runner con los 10 `supabase/tests/*.sql`. Resultado esperado: `PASA` en los 10.
- [ ] **Paso 5: commit** `feat(db): lista de avisos de solicitudes`

### Tarea 2: campana y panel

**Archivos:**
- Crear: `js/avisos.js`, que se carga en `index.html` después de `js/solicitudes.js`.
- Modificar:
  - `index.html`: botón `#avisos-btn` dentro de `.sidebar-brand`, botón `#mavisos-btn` dentro de `.mobile-topbar` después de `.mobile-logo`, y `<dialog id="avisos-panel" aria-labelledby="avisos-title">` con `<h2 id="avisos-title">Avisos</h2>` y `<ul id="avisos-list">`.
  - `js/solicitudes.js`: `setSolBadge`; `solOnChange` llama a `refreshAvisosOpen()`.
  - `js/auth.js`: en `applyPermissions`, los botones `hidden=!lead`.
  - `js/acciones.js`: `toggleAvisos` y `goToSolicitud`.
  - `tests/test-auth.mjs`: la ruta mock `rpc/solicitudes_avisos`, con las mismas reglas que la Tarea 1 sobre `tables.solicitudes`, `users` y `vistas`, y el flag `failAvisos`.

**Interfaces:**
- Consume: `solMarkSeen()`, `SOL_SEEN_PREV`, `setSolBadge(n)`, `solAgo(iso)`, `showPage('solicitudes')` y `SOL`.
- Produce:
  - `openAvisos(btn): Promise<void>`, `closeAvisos(): void` y `refreshAvisosOpen(): void` (debounce de 300 ms; no hace nada si el panel está cerrado);
  - `goToSolicitud(id: number): Promise<void>`;
  - el estado `AVISOS_PREV: string|null`, que es el visto anterior usado para resaltar.

- [ ] **Paso 1: escribir la prueba E2E que falla.** Va en un bloque nuevo `// 19c.` después del 19b, con dos contextos: Admin en Daily y Lead.
  1. Con `vistas = {}`, el Admin carga la app y su visto queda en "ahora". El Lead crea «Solicitud P3_400 <b>Campana</b>» por la UI, se hace `rtPush('INSERT')`, y `#avisos-btn .nav-count` muestra «1» con `aria-label` «Avisos, 1 sin ver».
  2. Click en `#avisos-btn`: `#avisos-panel[open]`. La primera línea muestra «Laura Lead creó Solicitud P3_400 <b>Campana</b>» como texto, sin un `b` real en el DOM. Tiene la clase `.aviso-nuevo`, y el foco está en ese botón. `#sol-badge` y el número de la campana quedan ocultos.
  3. Esc: el panel se cierra y `document.activeElement.id === 'avisos-btn'`.
  4. Volver a abrir: ninguna línea tiene `.aviso-nuevo`.
  5. Con el panel abierto, el Lead pasa otra solicitud a Plan enviado y se hace `rtPush('UPDATE')`. Aparece arriba la línea «… pasó … a Plan enviado».
  6. Con el filtro de Solicitudes en «Abiertas» y una solicitud cerrada de la lista: click en su aviso. Se abre `#page-solicitudes`, `#sol-filter` vale `all` y la fila tiene la clase `sol-flash`.
  7. Una solicitud borrada de `tables` y del modelo: click en su aviso muestra el diálogo «Esa solicitud ya no existe.»
  8. Con `failAvisos = true`: el panel muestra «No se pudieron cargar los avisos.»; «Reintentar» con el flag apagado carga la lista.
  9. Con el panel abierto, click en `#nav-daily`: el panel se cierra.
  10. QA: `#avisos-btn` y `#mavisos-btn` están ocultos.

  Mensajes `ok(...)`, uno por grupo: 1–4, 5, 6–7, 8–9 y 10.
- [ ] **Paso 2:** correr la E2E. Resultado esperado: falla en el paso 1.1 porque no existe `#avisos-btn`.
- [ ] **Paso 3: implementar.**
  - El panel se abre con `dialog.show()` (no modal).
  - Se cierra con un clic fuera (listener en `document` que ignora clics dentro del panel o de las campanas), con `keydown` Escape y desde `showPage`.
  - Al abrir, el orden es: `await solMarkSeen()`, después `AVISOS_PREV = SOL_SEEN_PREV`, después `rpc('solicitudes_avisos')` y por último el render.
  - `.aviso-nuevo` se calcula con `sin_ver` de la RPC. La RPC se pide **después** de marcar visto, así que `sin_ver` vendría falso; por eso se usa `fecha > AVISOS_PREV`.
  - `setSolBadge(n)` también actualiza `#avisos-btn` y `#mavisos-btn`: el número y el `aria-label`.
  - `goToSolicitud`:
    - `closeAvisos()` y después `showPage('solicitudes')`;
    - espera a que carguen las filas;
    - si la fila no está, vacía la búsqueda, pone el filtro en `all` y vuelve a renderizar;
    - si sigue sin estar, `uiAlert('Esa solicitud ya no existe.')`;
    - si está, `scrollIntoView({block:'center'})` y la clase `sol-flash` durante 2 s.
- [ ] **Paso 4:** correr la E2E completa. Resultado esperado: exit 0.
- [ ] **Paso 5: commit** `feat: campana de avisos con la lista de novedades`

### Tarea 3: estilo, capturas, revisión y PR

- [ ] **Paso 1: CSS.**
  - `.avisos-btn`: área táctil de 44×44 en móvil, `focus-visible` y `hover`.
  - `#avisos-panel`: `position: fixed`. En escritorio va arriba a la izquierda, bajo la marca, con 340 px de ancho. En móvil va a 16 px de los bordes.
  - Avisos: `.aviso-nuevo` con punto `--mark` y nombre en 700; los vistos en `--ink-2`.
  - `.sol-flash`: fondo `--mark` al 25 % con transición.
  - Todo con tokens, para que funcione en claro y oscuro.
- [ ] **Paso 2: capturas** en el bloque 19c: `tests/shot-avisos.png`, `tests/shot-avisos-oscuro.png` y `tests/shot-avisos-movil.png` (375 px, sin desborde horizontal). Revisarlas a ojo.
- [ ] **Paso 3:** auditar con web-design-guidelines: nombre accesible, foco, Esc y contraste. Corregir lo que aplique, con una prueba cuando se trate de comportamiento.
- [ ] **Paso 4:** correr la E2E completa y las 10 SQL.
- [ ] **Paso 5:** revisión de Codex (`codex exec --sandbox read-only`) sobre el diff `origin/main...HEAD`. Verificar cada hallazgo; los importantes se corrigen con su prueba (RED→GREEN) y los menores se anotan en el PR.
- [ ] **Paso 6:** commit, push, `gh pr create` con la línea de Claude Code y `gh pr merge --auto --merge`. Avisar a Bray que tiene que aplicar la migración nueva en Supabase.

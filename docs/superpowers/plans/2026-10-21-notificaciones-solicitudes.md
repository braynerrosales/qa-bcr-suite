# Avisos de solicitudes: plan de implementación

> **Para agentes:** SUB-SKILL REQUERIDO: superpowers:subagent-driven-development (recomendado) o superpowers:executing-plans. Los pasos usan casillas (`- [ ]`) para el seguimiento.

**Objetivo:** contador de novedades de Solicitudes (creada o pasada a *Plan enviado* por otra persona) para QA Lead y Admin, con un "visto" propio de cada usuario.

**Arquitectura:** una migración agrega columnas que completa el trigger, la tabla `solicitudes_vistas` y dos RPC. La app consulta el contador con la RPC, lo refresca con el canal Realtime de Solicitudes (que ya existe y ahora se abre al iniciar sesión) y, al abrir la pantalla, marca visto y etiqueta las filas.

**Tecnología:** Postgres/Supabase (RLS, `security definer`), JS sin framework (`js/*.js`), Playwright con Supabase simulado (`tests/test-auth.mjs`) y PGlite 0.3.7 para el SQL.

**Spec:** `docs/superpowers/specs/2026-10-21-notificaciones-solicitudes-design.md`

## Restricciones globales

- Worktree `qa-bcr-suite-notif`, rama `feat/notificaciones-solicitudes`. No tocar la carpeta principal, que está en `feat/dialogos-propios` con cambios de otra persona.
- Nunca push a `main`: PR con `gh pr create` y después `gh pr merge --auto --merge`. El check requerido es «Prueba de punta a punta».
- Sin datos reales ni nombres del equipo en código, pruebas ni capturas.
- UI según CLAUDE.md: taste-skill, web-design-guidelines y capturas con Playwright.
- SQL: `security definer` siempre con `set search_path = ''`, y validar `private.is_lead()` antes de tocar datos. Error de permiso: `errcode = '42501'`.
- Textos visibles exactos: etiquetas «Nueva» y «Plan enviado»; aria del contador «N novedades», o «1 novedad» en singular.
- E2E: `CHROME_PATH="$LOCALAPPDATA/ms-playwright/chromium-1243/chrome-win64/chrome.exe" node tests/test-auth.mjs`, con `node_modules` y `package` copiados al worktree.
- SQL: `node C:/Users/brayn/AppData/Local/Temp/claude/C--Users-brayn/e4cf3af4-c298-4e0c-b29d-e9f717c4c7d6/scratchpad/pg/run.mjs <worktree> supabase/tests/<archivo>.sql`. Si no existe, recrearlo como dice el resumen de la sesión: stub, `auth.sessions`, migraciones, semilla mínima y rollback ante error.

## Foco de revisión

- Un lead destilda y vuelve a tildar *Plan enviado*: debe volver a avisar a los demás, con fecha nueva y autor nuevo. Se prueba en la Tarea 1.
- Una ráfaga de eventos Realtime, por ejemplo al tildar varias casillas: el contador hace una sola llamada por ráfaga, no una por evento. Se prueba en la Tarea 2 con un contador de llamadas en el mock.
- Cerrar sesión y entrar con otro usuario en la misma pestaña: no quedan el canal ni el contador del anterior. Se prueba en la Tarea 2.
- Un QA, o un lead desactivado, que llama a la RPC directo: recibe 42501. Se prueba en la Tarea 1.
- Volver a Solicitudes por segunda vez: solo se etiqueta lo nuevo desde la visita anterior, no lo de la primera. Se prueba en la Tarea 3.

---

### Tarea 1: migración y pruebas SQL

**Archivos:**
- Crear: `supabase/migrations/20261025000001_solicitudes_avisos.sql`
- Crear: `supabase/tests/solicitudes_avisos_test.sql`, con el estilo de `supabase/tests/solicitudes_test.sql`: `begin`, usuarios `...a1/b1/c1/d1` más un segundo lead `...e1`, `set local role authenticated`, `request.jwt.claims`, bloques `do $$` que imprimen «OK …» o abortan con «FALLO …», y `rollback` al final.

**Interfaces que produce:**
- `public.solicitudes_novedades() returns integer`
- `public.solicitudes_marcar_visto() returns timestamptz`, que devuelve el visto anterior, o `now()` si no había
- Columnas `solicitudes.created_by`, `plan_enviado_at` y `plan_enviado_by`, legibles por los leads. La tabla `public.solicitudes_vistas(user_id, visto_at)` no se puede escribir directo.

- [ ] **Paso 1: escribir las pruebas que fallan**
  1. El lead B crea una solicitud y queda `created_by = B`.
  2. Una solicitud que nace con `plan_enviado = true` también completa `plan_enviado_at` y `plan_enviado_by`.
  3. El lead B tilda *Plan enviado* en una existente: queda `plan_enviado_by = B`. La destilda y la vuelve a tildar el lead E: queda `plan_enviado_by = E` con un `plan_enviado_at` mayor.
  4. El primer `solicitudes_novedades()` del Admin A devuelve 0.
  5. Para avanzar el reloj se ajusta `solicitudes_vistas.visto_at` como superusuario, con `reset role`, a `now() - interval '1 min'`. B crea dos solicitudes y la novedad de A es 2. Para B es 0, porque fue el autor.
  6. Una solicitud creada por B y que E pasa a plan enviado cuenta 1 para A, no 2.
  7. `solicitudes_marcar_visto()` de A devuelve el visto anterior y después la novedad de A es 0. La de E no cambia.
  8. El QA C y el lead inactivo D reciben `sqlstate '42501'` en las dos RPC.
  9. Escribir directo falla para un lead: `update solicitudes set created_by = ...` (permiso de columna) e `insert into solicitudes_vistas` (sin grant).
  10. Las filas anteriores a la migración no cuentan: una solicitud con `created_by` NULL y `created_at` posterior al visto no suma.

  En el bloque del paso 6 se puede usar `set_config('request.jwt.claims', ...)` entre sentencias para cambiar de usuario, como hace `solicitudes_test.sql`.
- [ ] **Paso 2: correr la prueba y confirmar que falla**
  Ejecutar el runner con `supabase/tests/solicitudes_avisos_test.sql`. Resultado esperado: `FALLA`, porque no existe la columna `created_by` o la función.
- [ ] **Paso 3: escribir la migración**
  - Agregar las tres columnas, con `references public.profiles(id) on delete set null` donde corresponde.
  - Reemplazar `public.solicitudes_touch()` conservando todo lo que hace hoy, que está en `20261016000001_solicitudes.sql`. En INSERT agrega `created_by = auth.uid()`. Agrega el bloque de plan: si `new.plan_enviado` y (INSERT o `not old.plan_enviado`), entonces `plan_enviado_at = now()` y `plan_enviado_by = auth.uid()`. En UPDATE se fuerza `new.created_by = old.created_by`.
  - Crear la tabla `solicitudes_vistas` con RLS, una policy de select `user_id = (select auth.uid())`, `grant select` y nada más.
  - Las dos funciones van en `security definer` y validan `private.is_lead()`. `novedades` hace `insert ... on conflict do nothing` con `now()` y después cuenta según la spec, usando `is distinct from auth.uid()`. `grant execute ... to authenticated` y `revoke ... from public, anon`.
  - Encabezado de comentarios con el estilo de las otras migraciones.
- [ ] **Paso 4: correr las pruebas nuevas y las existentes**
  Correr el runner con `supabase/tests/solicitudes_avisos_test.sql`, `supabase/tests/solicitudes_test.sql`, `supabase/tests/seguridad_test.sql` y `supabase/tests/rls_test.sql`. Resultado esperado: `PASA` en las cuatro.
- [ ] **Paso 5: commit** `feat(db): avisos de solicitudes (autor, plan enviado y visto por usuario)`

### Tarea 2: contador en el menú, en vivo

**Archivos:**
- Modificar: `index.html:50` y `:205`, para agregar `<span class="fb-badge sol-badge" id="sol-badge" hidden></span>` dentro de `#nav-solicitudes` y `id="msol-badge"` dentro de `#mnav-solicitudes`.
- Modificar: `js/solicitudes.js`, con `refreshSolBadge`, `solUnsubscribe`, y `solSubscribe`/`solOnChange` refrescando el contador.
- Modificar: `js/auth.js:146-157` (`applyPermissions`) y `js/auth.js:127` (`logout`).
- Modificar: `tests/test-auth.mjs`, que tiene el mock y la sección 19.

**Interfaces:**
- Consume: las RPC de la Tarea 1.
- Produce: `refreshSolBadge(): Promise<void>`, que muestra u oculta `#sol-badge` y `#msol-badge`; `solBadgeSoon(): void`, el debounce de 300 ms que llama a `refreshSolBadge`; y `solUnsubscribe(): void`, que hace `supabaseClient.removeChannel(solChannel)`, pone `solChannel = null` y `solLiveOnce = false`, y oculta los contadores.

- [ ] **Paso 1: mock.** En `tests/test-auth.mjs`:
  - El POST y el PATCH de `solicitudes` imitan el trigger: `created_by` en el alta, y `plan_enviado_at`/`plan_enviado_by` cuando pasa a verdadero.
  - Agregar el estado `vistas = {}` por usuario.
  - Agregar las rutas `/rest/v1/rpc/solicitudes_novedades` y `/rest/v1/rpc/solicitudes_marcar_visto`, con las reglas de la spec. Responden 403 con `code '42501'` si el usuario no es lead activo.
  - Agregar el contador `rpcCalls.novedades`.
  - Para avanzar el reloj, la prueba ajusta `vistas[id]` directamente.
- [ ] **Paso 2: escribir la prueba E2E que falla.** Va al final de la sección 19, con dos contextos: Admin en Daily y Lead.
  1. Admin entra y `#sol-badge` está oculto.
  2. Se retrocede `vistas[admin]` un minuto. Lead crea una solicitud por la UI y se emite `rtPush('INSERT', fila)`. Se espera que `#sol-badge` del Admin muestre `1` con `aria-label` «1 novedad» y que `#msol-badge` muestre `1`.
  3. El Lead no tiene contador.
  4. Se emiten 5 `rtPush('UPDATE', ...)` seguidos y `rpcCalls.novedades` sube como máximo 2.
  5. El QA no tiene contador y la RPC no se llama con su sesión.
  6. Admin cierra sesión y entra el QA en la misma pestaña: `#sol-badge` está oculto y `rtSockets` no tiene canales del Admin.

  Mensaje: `ok('Solicitudes: los demás QA Lead y Admin ven el contador de novedades en vivo; el autor y QA no')`.
- [ ] **Paso 3: correr y confirmar que falla** en el paso 2.1 o 2.2, porque no existe `#sol-badge`.
- [ ] **Paso 4: implementar.**
  - `applyPermissions()`: si `lead`, llamar a `refreshSolBadge()` y `solSubscribe()`.
  - `logout()`: llamar a `solUnsubscribe()` antes de `signOut`.
  - `solOnChange`: al final, `solBadgeSoon()`.
  - Si la RPC falla, los contadores se ocultan, igual que en `refreshFeedbackBadge`.
- [ ] **Paso 5: correr la E2E completa y confirmar que pasa.**
- [ ] **Paso 6: commit** `feat: contador de novedades de solicitudes para QA Lead y Admin`

### Tarea 3: marcar visto y etiquetar filas

**Archivos:**
- Modificar: `js/solicitudes.js`, con `solMarkSeen`, `solNovedad`, la etiqueta en `solRow`/`updateSolRow`, y `solOnChange` mientras la pantalla está activa.
- Modificar: `js/base.js:140`, que queda `if(id==='solicitudes')solMarkSeen().then(loadSolicitudes);`.
- Modificar: `tests/test-auth.mjs`, sección 19.

**Interfaces:**
- Consume: `solicitudes_marcar_visto` y `refreshSolBadge` de la Tarea 2.
- Produce:
  - `SOL_SEEN_PREV: string|null`, el ISO del visto anterior.
  - `solMarkSeen(): Promise<void>`. Llama a la RPC, guarda el valor anterior y oculta los contadores. Si falla, `SOL_SEEN_PREV = null` y los contadores no se tocan.
  - `solNovedad(r): 'nueva'|'plan'|null`. Devuelve `'nueva'` si `r.created_by!==currentUser.id && r.created_at>SOL_SEEN_PREV`. Si no, `'plan'` si se cumple lo mismo con `plan_enviado_by`/`plan_enviado_at`. Si no, `null`. Con `SOL_SEEN_PREV` en null siempre devuelve `null`.

- [ ] **Paso 1: escribir la prueba E2E que falla.** Sigue al bloque de la Tarea 2.
  1. Admin abre Solicitudes: la fila nueva tiene `.sol-new` con el texto «Nueva» y los contadores se ocultan.
  2. Lead tilda *Plan enviado* en otra fila y se emite `rtPush('UPDATE')` mientras el Admin sigue en la pantalla: esa fila muestra «Plan enviado» y el contador sigue oculto, porque `marcar_visto` se volvió a llamar.
  3. Admin va a Daily y vuelve a Solicitudes sin novedades nuevas: no queda ninguna `.sol-new`.
  4. Con un `marcar_visto` que falla una vez (flag `rejectNextVisto` en el mock), la tabla carga sin etiquetas y sin errores.

  Mensaje: `ok('Solicitudes: al abrir se marcan las novedades («Nueva», «Plan enviado») y el contador vuelve a cero')`.
- [ ] **Paso 2: correr y confirmar que falla** en el paso 1.1.
- [ ] **Paso 3: implementar.**
  - La etiqueta es un `<span class="sol-new">` dentro de la celda del nombre, con `textContent`.
  - En `solOnChange`, si `#page-solicitudes` está activa y `solNovedad(fila)` no es null, se vuelve a llamar a `solMarkSeen()` sin perder `SOL_SEEN_PREV`: solo se actualiza la marca en el servidor y se ocultan los contadores. Para eso, separar `solMarkSeen({keepPrev:true})`.
- [ ] **Paso 4: correr la E2E completa y confirmar que pasa.**
- [ ] **Paso 5: commit** `feat: etiquetas de novedades al abrir Solicitudes`

### Tarea 4: estilo, capturas, revisión y PR

**Archivos:**
- Modificar: `css/styles.css`, con `.sol-badge`, que reutiliza `.fb-badge` y solo ajusta la alineación en los menús, y `.sol-new`, una etiqueta chica con tokens del tema que funcione en claro y oscuro.
- Modificar: `tests/test-auth.mjs`, con capturas `tests/shot-sol-aviso.png` y `tests/shot-sol-aviso-movil.png`.

- [ ] **Paso 1:** aplicar taste-skill y web-design-guidelines a las dos piezas: contraste AA, nada de solo color (el número y el texto son visibles) y objetivo táctil intacto en el menú móvil.
- [ ] **Paso 2:** agregar las capturas a la sección 19, en escritorio y móvil, en tema claro y oscuro, y revisarlas a ojo.
- [ ] **Paso 3:** correr la E2E completa y las cuatro pruebas SQL de la Tarea 1. Resultado esperado: todo pasa.
- [ ] **Paso 4:** pedir revisión a Codex con `codex exec --sandbox read-only --skip-git-repo-check` y el diff `origin/main...HEAD`. Verificar cada observación antes de aplicarla y anotar en el PR cuáles se aplicaron y cuáles se descartaron, con el motivo.
- [ ] **Paso 5:** commit, `git push -u origin feat/notificaciones-solicitudes`, `gh pr create` con la descripción en español y la línea de Claude Code al final, y después `gh pr merge --auto --merge`. Avisar a Bray que tiene que aplicar la migración en Supabase. El CI no la aplica.

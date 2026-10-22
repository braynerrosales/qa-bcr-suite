# Daily: motivos de ausencia e intercambio de leads — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cada ausencia del Daily lleva motivo (sin justificar, justificada, vacaciones) y solo las sin justificar bajan el % de asistencia; QA Lead y Admin intercambian a los leads entre Daily con un botón.

**Architecture:** `daily_run_members` suma `motivo` (null = sin justificar) sin tocar `absent`; `daily_guardar` y `daily_historial` lo guardan y lo devuelven; `daily_intercambiar_leads()` cambia de Daily a las personas fijas al final. En la app, el botón «No asistió» abre un menú propio y el historial calcula el % sin los días justificados.

**Tech Stack:** Supabase (Postgres, plpgsql), JS vanilla, Playwright (Supabase simulado), PGlite.

**Spec:** `docs/superpowers/specs/2026-10-22-daily-motivos-y-leads-design.md`

## Global Constraints

- Motivos en pantalla: *Sin justificar*, *Justificada*, *Vacaciones*; en la base `motivo` ∈ {null, `'justificada'`, `'vacaciones'`} y solo con `absent = true`.
- % asistencia = asistió ÷ (dailies − justificadas − vacaciones); rojo `< 80 %`; denominador 0 → «—».
- Tabla del mes: Persona · Asistió · Faltó · Justificada · Vacaciones · % asistencia · Empezó.
- Intercambio: solo QA Lead/Admin; las personas `LAST_FIXED` de cada Daily activo; exactamente una por Daily.
- QA Boss no guarda el Daily (sin cambios). CSP sin handlers inline; textos con `textContent`. UI según CLAUDE.md con capturas.

## Review Focus

1. Pestaña con la versión vieja de la app guarda sin `motivo` → se guarda como sin justificar, sin error.
2. Nombre con `<b>` o comillas en el menú, la lista de la derecha y el historial → se ve literal.
3. Menú abierto y se genera otro orden («Sortear») o se cambia de Daily → el menú se cierra y no queda colgado.
4. Intercambio con el Daily 2 sin nadie fijo al final → mensaje claro y nada cambia.
5. En el celular (375 px) el menú no se sale de la pantalla.

---

### Task 1: Base de datos

**Files:**
- Create: `supabase/migrations/20261030000001_daily_motivos.sql`
- Create: `supabase/tests/daily_motivos_test.sql`

**Interfaces:**
- Produces:
  - `daily_run_members.motivo text null`, checks `motivo in ('justificada','vacaciones')` y `motivo is null or absent`.
  - `daily_guardar(p_grupo bigint, p_fecha date, p_miembros jsonb)`: cuerpo actual (de `20261029000001_rol_qa_boss.sql`), lee `motivo text` de cada miembro y lo inserta; valida con 22023.
  - `daily_historial(p_grupo bigint, desde date, hasta date)`: mismas columnas + `motivo text` al final (drop y create; mismos grants).
  - `daily_intercambiar_leads() returns table (nombre text, a_grupo text)`: `security definer`, `is_lead()` o 42501; 22023 con mensaje si algún Daily activo no tiene exactamente una persona activa `LAST_FIXED`, si no hay exactamente dos Daily activos, o si choca el nombre en el otro Daily.

- [ ] **Step 1: Escribir `daily_motivos_test.sql`** (formato de `supabase/tests/qa_boss_test.sql`; Daily y personas propias `DM-…`, chequeos filtrados por esos nombres). Casos: guardar con un ausente `vacaciones`, uno `justificada`, uno sin motivo → `daily_historial` devuelve los tres motivos (null el último); motivo `'otro'` → 22023; motivo con `absent false` → 22023; QA Boss → 42501. Intercambio: con dos Daily de prueba (desactivando temporalmente los demás como superusuario dentro de la transacción) y una persona `LAST_FIXED` en cada uno, un lead llama la función → cada persona queda en el otro Daily y conserva su regla; un QA → 42501; con dos `LAST_FIXED` en un Daily → 22023 y nada cambia.
- [ ] **Step 2: Correr y ver que falla** — `node ".../pg/run.mjs" . supabase/tests/daily_motivos_test.sql` → `FALLA` (columna `motivo` inexistente).
- [ ] **Step 3: Migración**, copiando los cuerpos actuales de `daily_guardar` y `daily_historial` y cambiando solo lo necesario.
- [ ] **Step 4: Todas las SQL** — `node ".../pg/run.mjs" . supabase/tests/*.sql` → 13 `PASA`.
- [ ] **Step 5: Commit** `feat(db): motivo de ausencia en el Daily e intercambio de leads`

---

### Task 2: Motivo de ausencia en la app

**Files:**
- Modify: `js/daily.js` (fila, menú, lista de la derecha, guardado, historial), `js/acciones.js`, `index.html` (menú `#dly-motivo-menu`), `css/styles.css`
- Test: `tests/test-auth.mjs`

**Interfaces:**
- Consumes: Task 1 (`motivo` en `daily_guardar` / `daily_historial`).
- Produces: `setAbsent(item: HTMLElement, motivo: 'sin_justificar'|'justificada'|'vacaciones'|null)`; `item.dataset.motivo`; `openMotivoMenu(btn)` / `closeMotivoMenu()`. El menú es un único `<div id="dly-motivo-menu" role="menu">` con `button[role=menuitem][data-motivo]`; «Asistió» (`data-motivo=""`) solo si la fila ya está ausente. Botón de la fila: «No asistió ▾» o el motivo («Sin justificar ▾», «Justificada ▾», «Vacaciones ▾»), con `aria-haspopup="menu"` y `aria-expanded`.

- [ ] **Step 1: Simulador.** `dailyGuardar` guarda `motivo` (valida como Task 1) y `dailyHistorial` lo devuelve.
- [ ] **Step 2: Pruebas.** Actualizar el bloque 18 para que «No asistió» elija «Sin justificar» del menú (mismas aserciones que hoy). Nuevas:
  - El menú: abre con clic, foco en el primer ítem, flechas mueven el foco, Enter elige, Esc cierra y devuelve el foco al botón, clic afuera cierra; «Sortear» lo cierra.
  - Elegir «Vacaciones» → el botón dice «Vacaciones ▾» y la lista de la derecha «{nombre corto} (vacaciones)»; abrir de nuevo y elegir «Asistió» → vuelve a «No asistió ▾».
  - Guardar con 1 vacaciones y 1 justificada → mensaje con «(1 de vacaciones, 1 justificada)» y `tables.daily_runs[…].members` con los motivos.
  - Historial del mes con datos en `tables.daily_runs`: 20 dailies de una persona con 5 vacaciones y 1 sin justificar → «93%» sin `.dly-low`; otra persona con todo vacaciones → «—»; encabezados exactos de la tabla; lista de días «No asistieron: X (vacaciones), Y (justificada), Z».
  - Un guardado sin `motivo` (como la versión vieja) cuenta como «Faltó».
  - Capturas `tests/shot-daily-motivo.png` (menú abierto), `-oscuro`, `-movil` (375 px, el menú dentro de la pantalla).
- [ ] **Step 3: Correr y ver que falla** — `CHROME_PATH=… node tests/test-auth.mjs` → falla en el bloque 18 (no hay menú).
- [ ] **Step 4: Implementar.**
- [ ] **Step 5: E2E completa** → todo `OK`.
- [ ] **Step 6: Commit** `feat: motivo de ausencia en el Daily y % de asistencia sin justificadas ni vacaciones`

---

### Task 3: Botón «Intercambiar leads»

**Files:**
- Modify: `js/daily.js`, `js/auth.js` (visibilidad), `index.html` (`#dly-swap-btn` arriba de la lista del Daily de hoy), `css/styles.css`
- Test: `tests/test-auth.mjs`

**Interfaces:**
- Consumes: Task 1 (`daily_intercambiar_leads`), Task 2 nada.
- Produces: `swapLeads()`; tras el cambio, `loadConfig()` y se vuelve a dibujar el Daily actual.

- [ ] **Step 1: Simulador.** Ruta `rpc/daily_intercambiar_leads` con las reglas de Task 1 sobre `daily_members` / `daily_rule_members`.
- [ ] **Step 2: Pruebas.** Como QA Lead: `#dly-swap-btn` visible; confirmación «¿Pasar a {A} al Daily 2 y a {B} al Daily 1?»; al aceptar, `tables.daily_members` cambia de grupo y las reglas `LAST_FIXED` siguen; el Daily 1 muestra a B al final después de «Sortear». Cancelar no escribe. Con dos fijos al final en el Daily 1 → diálogo con el mensaje de la base y nada cambia. Como QA y QA Boss: botón no visible.
- [ ] **Step 3: Correr y ver que falla** (no existe `#dly-swap-btn`).
- [ ] **Step 4: Implementar.** La confirmación usa los nombres de `DB.rules[dk].lastFixed` de cada Daily; si alguno no tiene exactamente uno, avisar sin llamar a la base.
- [ ] **Step 5: E2E completa** → todo `OK`; SQL completa → 13 `PASA`.
- [ ] **Step 6: Commit** `feat: botón para intercambiar a los leads entre Daily`

Después: revisión de Codex del diff completo, PR con auto-merge; pasar a Bray el link raw de la migración (primera y última línea) y una consulta de verificación.

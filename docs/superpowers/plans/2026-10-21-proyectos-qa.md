# Proyectos para QA — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** QA puede agregar proyectos, variantes y tareas en una pantalla nueva «Proyectos»; cada uno borra lo suyo y QA Lead/Admin cualquier cosa.

**Architecture:** La base guarda el autor (`created_by`) y hace cumplir los permisos con RLS y dos funciones nuevas (`add_template_task`, `reorder_template_tasks`). La pantalla nueva (`js/proyectos.js`) lee las tablas directamente y muestra solo los botones permitidos; Generar tareas sigue con `get_app_config()`.

**Tech Stack:** Supabase (Postgres, RLS, plpgsql), JS vanilla sin build, Playwright (E2E con Supabase simulado), PGlite (pruebas SQL).

**Spec:** `docs/superpowers/specs/2026-10-21-proyectos-qa-design.md`

## Global Constraints

- Agregan: rol QA, QA_LEAD o ADMIN activos. **BETA no.**
- Borrar tarea/variante y editar texto de tarea: quien la creó, o QA_LEAD/ADMIN. `created_by` null → solo QA_LEAD/ADMIN.
- Borrar proyecto: quien lo creó (siempre, con lo de otros adentro) o QA_LEAD/ADMIN; el aviso dice cuántas variantes y tareas se van.
- Reordenar tareas: solo QA_LEAD/ADMIN; tareas nuevas al final.
- QA no reactiva proyectos ni variantes inactivos: aviso «pedile a un QA Lead o Admin».
- Funciones: `security definer`, `set search_path = ''`, `revoke` a public/anon, `grant` a authenticated.
- CSP: sin handlers inline; eventos con `data-click`/`data-change` y `ACCIONES` (`js/acciones.js`). Texto de usuario siempre con `textContent`.
- UI: seguir CLAUDE.md (taste-skill, web-design-guidelines, capturas con Playwright). No subir datos reales ni nombres del equipo.

## Review Focus

1. Texto de tarea con `<b>`, comillas o `{n}` → se ve literal y Generar tareas lo sigue usando.
2. Borrar algo que otro ya borró (pestaña vieja) → mensaje claro y la lista se recarga, sin error crudo.
3. QA intenta reordenar o borrar lo ajeno llamando a la API directo → la base lo rechaza (42501).
4. Persona autora eliminada (`created_by` pasa a null) → su tarea queda solo para leads y la fila no dice «agregada por».
5. Proyecto sin variantes → las tareas van a la plantilla sin variante (`p_variant_id` null).

---

### Task 1: Base de datos (migración + pruebas SQL)

**Files:**
- Create: `supabase/migrations/20261028000001_proyectos_qa.sql`
- Create: `supabase/tests/proyectos_qa_test.sql`

**Interfaces:**
- Produces:
  - Columnas `created_by uuid` (FK `public.profiles(id) on delete set null`) en `projects`, `project_variants`, `template_tasks`; trigger `before insert` que fija `new.created_by = auth.uid()`.
  - `private.can_edit_catalog() returns boolean` = `coalesce(private.app_role() in ('ADMIN','QA_LEAD','QA'), false)`.
  - `public.add_template_task(p_project_id bigint, p_variant_id bigint, p_task text) returns bigint` (id de la tarea). Error 42501 sin permiso; 22023 con texto vacío.
  - `public.reorder_template_tasks(p_template_id bigint, p_task_ids bigint[]) returns void`. 42501 si no es lead; 22023 si la lista no es exactamente las tareas de la plantilla.
  - `save_template`: `revoke execute ... from authenticated`.
  - Políticas: `projects`/`project_variants` insert `can_edit_catalog()`, update `is_lead()`, delete `is_lead() or created_by = auth.uid()`; `template_tasks` sin insert directo, update (solo columna `task`, vía `revoke update` + `grant update (task)`) y delete `is_lead() or created_by = auth.uid()`; `templates` sin cambios.

- [ ] **Step 1: Escribir `proyectos_qa_test.sql`** con el formato de `supabase/tests/solicitudes_avisos_lista_test.sql` (`begin` … `rollback`, usuarios de prueba propios, `raise notice 'OK: …'` / `raise exception 'FALLO: …'`, chequeos filtrados por códigos `PQ-…` para correr en una base con datos reales). Casos, cada uno un bloque:
  - QA inserta proyecto `PQ-UNO`, variante y tarea (`add_template_task`) → `created_by` = QA en las tres.
  - Insertar con `created_by` de otro → queda el del usuario (no se falsifica).
  - Dos `add_template_task` seguidas → posiciones `n` y `n+1`.
  - Texto `'  '` → 22023.
  - QA2 no borra la tarea ni la variante de QA (0 filas afectadas) y no edita su texto; QA sí.
  - QA2 agrega tarea a `PQ-UNO`; QA (dueño) borra `PQ-UNO` → desaparecen también variante y tarea de QA2.
  - Proyecto con `created_by` null: QA no lo borra; QA_LEAD sí.
  - QA llama `reorder_template_tasks` → 42501; QA_LEAD reordena y `created_by`/`task` no cambian.
  - Lista de ids incompleta → 22023.
  - BETA: insert en `projects` falla y `add_template_task` → 42501.
  - QA no puede `update projects set active = true` (0 filas).
  - `save_template` como authenticated → 42501 (permiso denegado).

- [ ] **Step 2: Correr y ver que falla**

Run: `node "C:/Users/brayn/AppData/Local/Temp/claude/C--Users-brayn/e4cf3af4-c298-4e0c-b29d-e9f717c4c7d6/scratchpad/pg/run.mjs" . supabase/tests/proyectos_qa_test.sql`
Expected: `FALLA` (columna `created_by` o función inexistente).

- [ ] **Step 3: Escribir la migración** con las interfaces de arriba. `add_template_task`: `insert … on conflict on constraint templates_project_variant_key do update set active = true` para obtener la plantilla, `select … for update` sobre ella, `coalesce(max(position),0)+1`. `reorder_template_tasks`: validar con `array_length` y que `{ids} = {ids de la plantilla}`; para no chocar con `unique(template_id, position)`, primero sumar un desplazamiento grande y después asignar 1..n por `ordinality`.

- [ ] **Step 4: Correr todas las pruebas SQL**

Run: `node ".../pg/run.mjs" . supabase/tests/*.sql`
Expected: todas `PASA` (las 10 de antes + la nueva).

- [ ] **Step 5: Commit** `feat(db): autor y permisos de proyectos, variantes y tareas para QA`

---

### Task 2: Simulador y pantalla «Proyectos» (ver y agregar)

**Files:**
- Create: `js/proyectos.js`
- Modify: `index.html` (botones `nav-proyectos`/`mnav-proyectos`, `<div class="page" id="page-proyectos">`, script `js/proyectos.js` después de `admin.js`; quitar `#atab-tasks` y `#asec-tasks`)
- Modify: `js/admin.js` (quitar el bloque «ADMIN: TAREAS / PROYECTOS» y `renderTaskProjectList` de `renderAdmin`)
- Modify: `js/auth.js` (`canEditCatalog()`, visibilidad de los botones), `js/base.js` (`showPage('proyectos')` → `loadProyectos()`), `js/acciones.js`, `css/styles.css`
- Test: `tests/test-auth.mjs`

**Interfaces:**
- Consumes: Task 1 (columnas y funciones).
- Produces (en `js/proyectos.js`):
  - `PROY = {projects:[], variants:[], templates:[], tasks:[], names:Map}`; `loadProyectos(): Promise<void>` (lee `projects`, `project_variants`, `templates`, `template_tasks`, `profiles(id,full_name)`; solo activos).
  - `proyPuedeBorrar(row): boolean` = `canManageConfig() || row.created_by === currentUser.id` (`canManageConfig()` de `js/auth.js` = QA_LEAD/ADMIN).
  - Acciones: `selectProyecto(id)`, `changeVariante()`, `addProyecto()`, `addVariante()`, `addTarea()`.
  - Tras cada escritura: `await loadConfig()` (para Generar tareas) y `await loadProyectos()`.
- `canEditCatalog()` en `js/auth.js`: `!!currentUser && currentUser.role !== 'BETA'`.

- [ ] **Step 1: Pasar el simulador a filas de tareas.** En `tests/test-auth.mjs`: `tables.template_tasks` con `{id, template_id, position, task, created_by}` (las dos plantillas actuales quedan con `created_by: null`), `templates` sin `tasks`; `appConfig()` arma las listas desde `template_tasks` por `position`; rutas `rpc/add_template_task` y `rpc/reorder_template_tasks` con las mismas reglas que Task 1; `tableRequest` aplica a `projects`, `project_variants`, `template_tasks` las reglas de insert/update/delete de Task 1 (delete sin permiso → 0 filas, como RLS) y pone `created_by` del usuario en los insert; borrar un proyecto o variante borra sus plantillas y tareas. Quitar la ruta `save_template`.

- [ ] **Step 2: Reemplazar las pruebas de «plantilla … save_template» y «proyecto: se crea/se elimina» del bloque de Administración** por un bloque nuevo «Proyectos» que, como QA (`qa@bcr.test`):
  - ve `#nav-proyectos` y no `#nav-admin`;
  - abre la pantalla, elige `COMERCIAL`, ve las tareas de la variante `normal` en orden, cada una `li.proy-tarea` con `.proy-tarea-txt` (texto literal, `<b>` como texto);
  - agrega `QA - {n} - Mía.` → aparece al final con «agregada por vos»; `tables.template_tasks` tiene `created_by` = QA;
  - en un proyecto sin variantes la tarea va a la plantilla con `variant_id` null;
  - agrega proyecto `nuevo` → queda `NUEVO`, seleccionado y aparece en `#project-grid` de Generar tareas;
  - agrega variante `urgente` → queda seleccionada;
  - proyecto inactivo con el mismo código → diálogo con «pedile a un QA Lead o Admin» y no se escribe nada.
  Y como BETA: no ve `#nav-proyectos` ni `#mnav-proyectos` (agregar el id a la prueba BETA existente).

- [ ] **Step 3: Correr y ver que falla**

Run: `CHROME_PATH="$LOCALAPPDATA/ms-playwright/chromium-1243/chrome-win64/chrome.exe" node tests/test-auth.mjs`
Expected: falla en el bloque «Proyectos» (`#nav-proyectos` no existe).

- [ ] **Step 4: Implementar** la pantalla, el CSS y el cableado según las interfaces. Diseño: lista de proyectos a la izquierda (reusar `.proj-btn`/`.proj-dot`), panel derecho con combo de variante + «Agregar variante», `<ol class="proy-tareas">` y fila «Agregar tarea» (input + botón, Enter agrega). Texto de ayuda: «Escribí `{n}` donde va el número del PBI o HU.»

- [ ] **Step 5: Correr toda la E2E**

Run: el comando del Step 3. Expected: todo `OK`, salida en 0.

- [ ] **Step 6: Commit** `feat: pantalla Proyectos; QA agrega proyectos, variantes y tareas`

---

### Task 3: Editar, borrar y reordenar

**Files:**
- Modify: `js/proyectos.js`, `js/acciones.js`, `css/styles.css`
- Test: `tests/test-auth.mjs`

**Interfaces:**
- Consumes: Task 2 (`PROY`, `loadProyectos`, `proyPuedeBorrar`).
- Produces: acciones `editTarea(id)`, `removeTarea(id)`, `moveTarea(id, dir)` (`dir` = -1|1, llama `reorder_template_tasks` con la lista completa), `removeVariante()`, `removeProyecto()`.

- [ ] **Step 1: Pruebas** (seguir el bloque «Proyectos»):
  - QA ve «Editar» y «Borrar» en su tarea y **no** en las tareas sin autor ni en las de otro; no ve botones de mover.
  - QA edita su tarea con `uiPrompt` → cambia en `tables.template_tasks`; texto vacío no guarda.
  - QA borra su tarea (confirmación) → desaparece.
  - QA ve «Eliminar proyecto» en `NUEVO` y no en `COMERCIAL`; «Eliminar variante» solo en la suya.
  - Con una tarea de Laura Lead dentro de `NUEVO`, el aviso dice «Se borran también 1 variante y 2 tareas» (los números reales) y al aceptar se borra todo.
  - Pestaña vieja: borrar una tarea que ya no existe → diálogo «Ya no existe o no tenés permiso…» y la lista se recarga.
  - Como QA_LEAD: ve botones de mover; «Bajar» la primera tarea cambia el orden en `tables.template_tasks` y conserva `created_by`; ve «Borrar» en todas.
  - Generar tareas con `COMERCIAL`/`normal` usa las tareas en el orden nuevo.

- [ ] **Step 2: Correr y ver que falla** (comando de Task 2 Step 3). Expected: falla en el primer chequeo de botones.

- [ ] **Step 3: Implementar** las acciones. Mensajes: confirmación de tarea «¿Borrar esta tarea?»; de proyecto título `¿Eliminar el proyecto "X"?` con el texto de conteo (omitir la parte en 0; «Se borra también su plantilla.» si no hay variantes ni tareas de otros como hoy). Cuando un delete/update devuelve 0 filas o 42501 → `uiAlert('Ya no existe o no tenés permiso para cambiarla. Se actualizó la lista.')` y `loadProyectos()`.

- [ ] **Step 4: Correr toda la E2E**. Expected: todo `OK`.

- [ ] **Step 5: Commit** `feat: Proyectos: editar, borrar y reordenar con permisos por autor`

---

### Task 4: Capturas y revisión visual

**Files:**
- Modify: `tests/test-auth.mjs` (capturas `tests/shot-proyectos.png`, `-oscuro`, `-movil` a 375 px como QA)
- Modify: `css/styles.css` si hace falta

- [ ] **Step 1:** Agregar las capturas y un chequeo de que a 375 px no hay desborde horizontal (`document.documentElement.scrollWidth <= 375`).
- [ ] **Step 2:** Correr la E2E, mirar las tres capturas y auditar con web-design-guidelines (foco visible, botones de 44 px en celular, contraste en oscuro). Corregir lo que salga.
- [ ] **Step 3:** E2E completa en verde y SQL completa en verde.
- [ ] **Step 4: Commit** `test: capturas de Proyectos`

Después: revisión final con Codex (`codex exec --sandbox read-only --skip-git-repo-check` con el diff) y PR con auto-merge; la migración se avisa en el PR: correrla justo cuando se fusione (el sitio viejo usa `save_template`, que la migración revoca; el nuevo necesita las funciones nuevas).

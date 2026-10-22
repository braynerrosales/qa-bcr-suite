# Rol QA Boss — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rol `BOSS` («QA Boss»): lo de BETA más Solicitudes y la campana en solo lectura, sin guardar el Daily.

**Architecture:** La base da a BOSS solo lectura de solicitudes y acceso a las RPC de la campana, y le niega `daily_guardar`, horas y el consolidado. La app agrega `canViewSolicitudes()` y dibuja la tabla de Solicitudes sin controles de edición cuando el usuario no es lead.

**Tech Stack:** Supabase (Postgres, RLS, plpgsql, Edge Function Deno), JS vanilla, Playwright (Supabase simulado), PGlite.

**Spec:** `docs/superpowers/specs/2026-10-22-rol-qa-boss-design.md`

## Global Constraints

- Código `BOSS`; etiqueta en pantalla **«QA Boss»**.
- BOSS: Generar tareas, Días hábiles, Daily (ver e historial, **sin guardar**), Solicitudes (**solo lectura, sin informes**), campana (sí, marca visto).
- BOSS no ve Horas, Proyectos ni Administración; no sale en el consolidado de horas.
- Insert/update/delete de `solicitudes` siguen solo para `is_lead()`.
- Funciones: `security definer` donde ya lo eran, `set search_path = ''`, mismos grants.
- CSP: sin handlers inline; textos con `textContent`. UI según CLAUDE.md, con capturas.

## Review Focus

1. BOSS con la tabla abierta recibe un cambio en vivo → la fila nueva o actualizada también sale sin controles de edición.
2. BOSS llama `rest/v1/solicitudes` con PATCH/DELETE/POST directo → la base lo rechaza (0 filas o 42501).
3. BOSS con contraseña temporal o desactivado → no ve solicitudes (como cualquier rol).
4. Solicitud cerrada con encargados → BOSS ve los nombres sin «×» ni combo.
5. El refresco cada 2 minutos y al volver a la pestaña (`solRefresh`) también funciona para BOSS.

---

### Task 1: Base de datos y Edge Function

**Files:**
- Create: `supabase/migrations/20261029000001_rol_qa_boss.sql`
- Create: `supabase/tests/qa_boss_test.sql`
- Modify: `supabase/functions/admin-create-user/index.ts:11` (`ROLES` agrega `'BOSS'`)

**Interfaces:**
- Produces:
  - `profiles_role_check`: `role in ('ADMIN','QA_LEAD','QA','BETA','BOSS')`.
  - `private.can_view_solicitudes() returns boolean` = `coalesce(private.app_role() in ('ADMIN','QA_LEAD','BOSS'), false)`.
  - Política `solicitudes_select` con `can_view_solicitudes()`.
  - `solicitudes_novedades()`, `solicitudes_marcar_visto()` (cuerpos de `20261025000001_solicitudes_avisos.sql`) y `solicitudes_avisos()` (cuerpo de `20261027000001_solicitudes_avisos_propios.sql`) recreadas con `can_view_solicitudes()` en lugar de `is_lead()`.
  - `private.can_use_horas()` = `coalesce(private.app_role() not in ('BETA','BOSS'), false)`.
  - `horas_resumen` (cuerpo de `20261020000001_rol_beta.sql`) con `p.role not in ('BETA','BOSS')`.
  - `daily_guardar` (cuerpo de `20261024000001_seguridad.sql`) rechaza `app_role() = 'BOSS'` con 42501.

- [ ] **Step 1: Escribir `qa_boss_test.sql`** con el formato de `supabase/tests/proyectos_qa_test.sql` (`begin`…`rollback`, usuarios propios, chequeos sobre solicitudes `QB-…`). Casos:
  - Un lead crea `QB-UNO`; BOSS la ve en `select`.
  - BOSS: `update` y `delete` → 0 filas; `insert` → 42501.
  - BOSS: `solicitudes_novedades()` devuelve número; `solicitudes_marcar_visto()` crea su visto; `solicitudes_avisos()` incluye `QB-UNO` con `propio = false`.
  - BOSS: `daily_guardar(...)` → 42501.
  - BOSS: `select` en `horas` no ve filas propias insertadas como superusuario; `insert` en `horas` → 42501; `horas_resumen` no lo incluye (con `en_informe = true`).
  - BOSS: `insert` en `projects` → 42501.
  - BOSS con `must_change_password = true` no ve `QB-UNO`.

- [ ] **Step 2: Correr y ver que falla**

Run: `node "C:/Users/brayn/AppData/Local/Temp/claude/C--Users-brayn/e4cf3af4-c298-4e0c-b29d-e9f717c4c7d6/scratchpad/pg/run.mjs" . supabase/tests/qa_boss_test.sql`
Expected: `FALLA` (el rol `BOSS` viola `profiles_role_check`).

- [ ] **Step 3: Escribir la migración** con las interfaces de arriba y agregar `'BOSS'` a `ROLES` en la Edge Function.

- [ ] **Step 4: Correr todas las pruebas SQL**

Run: `node ".../pg/run.mjs" . supabase/tests/*.sql`
Expected: todas `PASA` (12).

- [ ] **Step 5: Commit** `feat(db): rol QA Boss (lee solicitudes y la campana; no guarda el Daily ni ve horas)`

---

### Task 2: App — menú, Solicitudes en solo lectura, Daily sin guardar

**Files:**
- Modify: `js/auth.js` (`ROLE_LABELS`, `canViewSolicitudes()`, `canUseHoras()`, `canEditCatalog()`, `applyPermissions`)
- Modify: `js/base.js:134` (`showPage` deja entrar a `solicitudes` con `canViewSolicitudes()`)
- Modify: `js/solicitudes.js` (los `canManageConfig()` de lectura, suscripción, campana y refresco pasan a `canViewSolicitudes()`; `solRow` y `renderSolEncargados` en solo lectura)
- Modify: `js/daily.js` (no muestra `#dly-save` a BOSS), `js/horas.js:27,355` (excluye BOSS), `index.html` (opción «QA Boss» en los combos de rol si están en el HTML), `css/styles.css`
- Test: `tests/test-auth.mjs`

**Interfaces:**
- Consumes: Task 1.
- Produces: `canViewSolicitudes(): boolean` (ADMIN, QA_LEAD, BOSS) en `js/auth.js`; `canSaveDaily(): boolean` (`currentUser.role !== 'BOSS'`).
- Solo lectura = `!canManageConfig()` en la pantalla de Solicitudes: `#sol-new-open` y el botón «Informes semanales» ocultos; en `solRow`, `textarea`/`input` con `disabled` (el nombre `readOnly` para que se pueda leer y copiar), sin `.sol-del`; en `renderSolEncargados`, chips sin «×» y sin combo.

- [ ] **Step 1: Simulador.** En `tests/test-auth.mjs`: usuario `boss@bcr.test` (`role: 'BOSS'`, nombre «Bruno Boss»); `isLead` sigue igual; nuevo `canView = (me) => isLead(me) || (me?.active && me.role === 'BOSS')` para el GET de `solicitudes` y las RPC de la campana; `daily_guardar` → 403 para BOSS; horas como BETA.

- [ ] **Step 2: Pruebas** (bloque nuevo «QA Boss»):
  - Menú: `#nav-solicitudes`, `#nav-qa`, `#nav-daily`, `#nav-calc` visibles; `#nav-horas`, `#nav-proyectos`, `#nav-admin` no; `#sidebar-user-role` = «QA Boss».
  - Solicitudes: hay filas; `#sol-new-open` y «Informes semanales» no visibles; 0 `.sol-del` visibles; todos los `#sol-body input` y `select` deshabilitados; `.sol-name` con `readOnly`; chips de encargados sin botón; 0 escrituras en `writes`.
  - En vivo: `rtPush('INSERT', …)` de una solicitud nueva → la fila aparece y también está deshabilitada; la campana muestra `1` y al abrirla lista el aviso.
  - Daily: se puede sortear y `#dly-save` no se ve.
  - Admin: `#nu-role` incluye «QA Boss».
  - Capturas `tests/shot-boss.png`, `-oscuro`, `-movil` (375 px, sin desborde).

- [ ] **Step 3: Correr y ver que falla**

Run: `CHROME_PATH="$LOCALAPPDATA/ms-playwright/chromium-1243/chrome-win64/chrome.exe" node tests/test-auth.mjs`
Expected: falla en el bloque «QA Boss» (`#nav-solicitudes` oculto).

- [ ] **Step 4: Implementar** según las interfaces.

- [ ] **Step 5: Correr toda la E2E** (comando del Step 3). Expected: todo `OK`.

- [ ] **Step 6: Commit** `feat: rol QA Boss en la app (Solicitudes en solo lectura, sin guardar el Daily)`

Después: revisión con Codex del diff completo, PR con auto-merge. Avisar: correr la migración y volver a desplegar la Edge Function (`supabase functions deploy admin-create-user`).

# Rol QA Boss — diseño

Fecha: 2026-10-22 · Estado: aprobado en conversación, pendiente de revisión escrita

## Objetivo

Un rol para quien supervisa: ve lo mismo que BETA más las solicitudes, pero **solo para leer**.

## Decisiones

| Tema | Decisión |
|---|---|
| Nombre | Código `BOSS`; en pantalla **«QA Boss»**. |
| Generar tareas, Días hábiles | Igual que BETA. |
| Daily | Lo ve y consulta el historial; **no guarda** (la base rechaza `daily_guardar`; la app no muestra «Guardar»). |
| Solicitudes | Ve la tabla completa (búsqueda, filtros, estadísticas) en **solo lectura**: sin «Nueva solicitud», sin borrar, sin agregar o quitar encargados; casillas, fechas, horas y notas visibles pero no editables. **Sin informes.** |
| Campana | Sí: recibe los avisos y al abrirla los marca vistos (como QA Lead y Admin). |
| Horas, Proyectos, Administración | No los ve. No aparece en el consolidado de horas. |
| Seguridad | La base hace cumplir todo: QA Boss solo tiene **lectura** de solicitudes. |

## Datos (Supabase)

Migración `supabase/migrations/20261029000001_rol_qa_boss.sql`:

- `profiles_role_check`: agrega `'BOSS'`.
- `private.can_view_solicitudes()`: `coalesce(private.app_role() in ('ADMIN','QA_LEAD','BOSS'), false)`.
- `solicitudes_select`: pasa de `is_lead()` a `can_view_solicitudes()`. Insert, update y delete siguen con `is_lead()`.
- `solicitudes_novedades()`, `solicitudes_marcar_visto()` y `solicitudes_avisos()`: la comprobación pasa a `can_view_solicitudes()` (se recrean con el mismo cuerpo).
- `private.can_use_horas()`: excluye también `'BOSS'` (no lee ni guarda horas).
- `horas_resumen` (consolidado): excluye `'BOSS'` como hoy excluye `'BETA'`.
- `daily_guardar`: rechaza a `BOSS` con 42501.
- `private.can_edit_catalog()` ya deja afuera a BOSS (solo ADMIN, QA_LEAD, QA).
- La Edge Function `admin-create-user` acepta `'BOSS'` en su lista de roles (hay que volver a desplegarla).

## App

- `ROLE_LABELS.BOSS = 'QA Boss'`; el Admin lo puede elegir al crear o editar usuarios.
- `js/auth.js`: `canViewSolicitudes()` (ADMIN, QA_LEAD, BOSS) para el menú de Solicitudes, la tarjeta del inicio, la campana y su suscripción en vivo; `canUseHoras()` y `canEditCatalog()` excluyen BOSS.
- Solicitudes en modo lectura cuando el usuario no es lead: la tabla se arma con controles deshabilitados o como texto, sin botones de agregar, borrar ni encargados, sin «Informes».
- Daily: sin «Guardar» para BOSS; sortear y ver el historial siguen.
- Horas: la lista de personas excluye BOSS como excluye BETA.

## Pruebas

- SQL (`supabase/tests/qa_boss_test.sql`, filtrando por datos propios para correr en una base real):
  QA Boss lee solicitudes y no crea, edita ni borra (0 filas o 42501); usa novedades, marcar visto
  y avisos; `daily_guardar` → 42501; no lee horas; no sale en el consolidado; no agrega proyectos.
- E2E: menú de QA Boss (Solicitudes sí; Horas, Proyectos, Administración no); tabla en solo
  lectura (sin «Nueva solicitud», sin borrar, controles deshabilitados, sin «Informes»); campana
  con aviso; Daily sin «Guardar»; el Admin puede asignar «QA Boss». Capturas en claro, oscuro y celular.

## Fuera de alcance

Ver horas en modo lectura, permisos por solicitud, exportar.

# Proyectos, variantes y tareas para QA — diseño

Fecha: 2026-10-21 · Estado: aprobado en conversación, pendiente de revisión escrita

## Objetivo

Los QA pueden agregar proyectos, variantes y tareas sin depender de un QA Lead. Cada QA puede
borrar o editar solo lo que creó; QA Lead y Admin pueden borrar o editar cualquier cosa.

## Decisiones

| Tema | Decisión |
|---|---|
| Quién agrega | Usuario activo con rol QA, QA_LEAD o ADMIN. **BETA no.** |
| Tareas y variantes | Se pueden agregar a **cualquier** proyecto, no solo a los propios. |
| Editar el texto de una tarea; borrar tarea o variante | Quien la creó, o QA_LEAD / ADMIN. |
| Borrar proyecto | Quien lo creó (**siempre**, aunque tenga tareas o variantes de otros, que se borran con él), o QA_LEAD / ADMIN. Antes de borrar, la app avisa cuántas variantes y tareas se van. |
| Orden de las tareas | Solo QA_LEAD / ADMIN lo cambian (mover una tarea mueve las de otros). Las nuevas van al final. |
| Lo que ya existe | Sin autor (`created_by` null): solo QA_LEAD / ADMIN lo editan o borran. |
| Pantalla | Nueva pantalla **«Proyectos»** en el menú, para QA, QA_LEAD y ADMIN (no BETA). Sale de Administración. |
| Proyecto o variante inactivos con el mismo nombre | QA no los reactiva: la app avisa que ya existe y que lo reactive un QA Lead o Admin. QA_LEAD / ADMIN lo reactivan como hoy. |

## Datos (Supabase)

Migración nueva `supabase/migrations/20261028000001_proyectos_qa.sql`:

- `created_by uuid references public.profiles(id) on delete set null` en `projects`,
  `project_variants` y `template_tasks`. Un trigger `before insert` lo fija en `auth.uid()`
  (no se puede enviar otro). Las filas existentes quedan en null.
- `private.can_edit_catalog()`: usuario activo, sin contraseña temporal y con rol distinto de BETA
  (`private.app_role() in ('ADMIN','QA_LEAD','QA')`).
- Políticas RLS (reemplazan las de «solo lead» para estas tablas):
  - `projects` y `project_variants`: insert si `can_edit_catalog()`; update si `is_lead()`
    (reactivar o renombrar queda para leads); delete si `is_lead()` o `created_by = auth.uid()`.
  - `templates`: sin cambios para el cliente (solo lead); las filas se crean desde las funciones.
  - `template_tasks`: update de la columna `task` y delete si `is_lead()` o
    `created_by = auth.uid()`; insert solo por función. Grant de update solo sobre `task`.
- Al borrar un proyecto, el `on delete cascade` existente borra variantes, plantillas y tareas
  aunque sean de otros (los cascades no pasan por RLS): es lo decidido.
- Funciones (`security definer`, `search_path = ''`, `revoke` a public/anon, `grant` a authenticated):
  - `add_template_task(p_project_id bigint, p_variant_id bigint, p_task text) returns bigint`:
    exige `can_edit_catalog()`; crea la plantilla si no existe (como hoy `save_template`), la
    bloquea (`for update`) y agrega la tarea en `max(position)+1` con `created_by = auth.uid()`.
    Texto vacío → error. Dos altas a la vez no chocan por la posición.
  - `reorder_template_tasks(p_template_id bigint, p_task_ids bigint[])`: exige `is_lead()`;
    reasigna `position` 1..n en el orden dado sin tocar `created_by` ni `task`. La lista debe ser
    exactamente las tareas de esa plantilla.
- `save_template` deja de usarse desde la app (borraba y recreaba las tareas, perdiendo el autor).
  Se revoca su ejecución para `authenticated`.
- `get_app_config()` no cambia: Generar tareas sigue leyendo lo mismo.

## Pantalla «Proyectos»

- Botón «Proyectos» en el menú lateral y en el del celular, visible para QA, QA_LEAD y ADMIN.
  La sección de proyectos y tareas sale de Administración.
- Izquierda: lista de proyectos y campo «Agregar proyecto». Al elegir uno se ve su variante
  (combo, con «Agregar variante») y sus tareas.
- Tareas: una por fila, en orden, cada una con «agregada por {nombre}» («vos» si es propia; nada
  si no tiene autor). Botones «Editar» y «Borrar» solo donde el usuario puede. Para QA_LEAD /
  ADMIN, botones para subir y bajar cada tarea. Al final, campo «Agregar tarea».
- «Eliminar proyecto» y «Eliminar variante» solo aparecen si el usuario puede. El aviso de
  proyecto dice cuántas variantes y tareas se borran.
- Si una escritura falla por permisos (pestaña vieja, otro usuario borró algo), mensaje claro y
  se recarga la lista.
- Los textos de usuario siempre con `textContent`; eventos por `data-click` / `ACCIONES` (CSP).

## Pruebas

- SQL (`supabase/tests/proyectos_qa_test.sql`, corre también en una base con datos reales,
  filtrando por sus propios códigos de prueba):
  QA agrega proyecto, variante y tarea; QA borra/edita lo suyo y no lo ajeno; QA_LEAD borra
  cualquier cosa; el dueño borra su proyecto con tareas de otros; lo viejo sin autor solo lo toca
  un lead; `created_by` no se puede falsificar; reordenar es solo de leads y conserva autores;
  BETA no puede agregar; dos altas seguidas quedan en posiciones consecutivas.
- E2E (`tests/test-auth.mjs`): la pantalla vista como QA y como lead (qué botones ve cada uno),
  agregar/editar/borrar/reordenar, aviso al borrar un proyecto, BETA no ve la pantalla, y que
  Generar tareas siga usando las tareas. Capturas en claro, oscuro y celular (375 px).

## Fuera de alcance

Renombrar proyectos o cambiar su color desde la pantalla nueva, deshacer borrados, historial de
cambios, notificaciones de altas.

# QA BCR Suite v3 — Fase 1: base de datos

Esquema, RLS y migración inicial del JSON a Supabase. No cambia nada de la app todavía.

```
supabase/migrations/
  20261015000001_schema.sql   tablas, restricciones, triggers
  20261015000002_rls.sql      funciones de rol + políticas
  20261015000003_rpc.sql      get_app_config() y save_template()
supabase/tests/rls_test.sql   pruebas de permisos (terminan en ROLLBACK)
scripts/migrate-data.mjs      JSON actual → seed.sql + verify-seed.sql
local-test/                   imitación de Supabase para probar en Postgres local
```

## Si ya creaste las tablas

Usa `supabase/alinear-base-existente.sql` **en lugar de** las tres migraciones. Lleva la base que ya tienes al diseño de la Fase 1 sin borrar tablas ni datos:

- agrega `profiles.email`, `qa_generations.project_name` y `variant_name` (rellena los existentes);
- ajusta NOT NULL, valores por defecto, FKs con su `ON DELETE`, unique y check; si una restricción equivalente ya existe, la deja;
- cambia la FK de `templates.variant_id` por la compuesta `(variant_id, project_id)`;
- crea el trigger que genera el perfil al crear un usuario (quita otro trigger que hiciera lo mismo) y crea perfiles para los usuarios que no lo tengan;
- **borra todas las políticas RLS** de estas tablas y la función `public.current_user_role()`, y crea las de la Fase 1;
- crea `get_app_config()` y `save_template()`.
- da los permisos de tabla (`GRANT`) que necesita la app: los proyectos nuevos de Supabase no los dan por defecto y sin ellos la app recibe `42501 permission denied`.

Si ya ejecutaste una versión anterior del script y ves ese error, vuelve a ejecutar `alinear-base-existente.sql` (incluye los GRANT) **antes** de correr las migraciones siguientes. No lo ejecutes después de ellas: sus GRANT son los de la Fase 1 y deshacen los permisos por columna de `profiles` que agregan `20261017000001_acceso_usuarios.sql` y `20261018000002_horas_informe.sql`.

Corre en una transacción y es idempotente: si algo falla no cambia nada, y se puede volver a ejecutar. Después sigue desde el paso 4 de abajo (si la base ya tiene datos, `seed.sql` se niega a correr; ejecuta igual `verify-seed.sql`).

Probado en local contra una base con tus columnas y las restricciones del plan técnico, y contra otra solo con columnas: en ambos casos la estructura final queda idéntica a la de las migraciones y pasan la verificación y las pruebas de RLS.

## Pasos en Supabase (base vacía)

1. **Crear el proyecto** en supabase.com.
2. **Cerrar el registro público**: *Authentication → Sign In / Providers → Allow new users to sign up* desactivado. La página es pública; con el registro abierto cualquiera podría crearse una cuenta.
3. **Ejecutar las migraciones** en el *SQL Editor*, en orden: `001_schema`, `002_rls`, `003_rpc`.
4. **Migrar el JSON**:
   ```bash
   node scripts/migrate-data.mjs qa-bcr-suite-data.json out
   ```
   Pegar `out/seed.sql` en el SQL Editor y ejecutarlo. Si la base ya tiene datos, se niega a correr.
5. **Verificar**: ejecutar `out/verify-seed.sql`. Los conteos deben coincidir y `iguales` debe ser `true`.
6. **Probar permisos**: ejecutar `supabase/tests/rls_test.sql`. Si termina sin error, todas las pruebas pasaron.
7. **Crear el ADMIN**: *Authentication → Users → Add user* (correo y contraseña; en *User Metadata* `{"full_name": "Nombre Apellido"}`). Luego:
   ```sql
   update public.profiles set role = 'ADMIN'
   where id = (select id from auth.users where email = 'TU_CORREO');
   ```
   El resto del equipo se crea igual y queda como `QA`; el ADMIN les cambia el rol.

`out/` contiene nombres del equipo: no se sube al repositorio.

## Decisiones respecto al plan técnico

| Plan | Implementado | Por qué |
|---|---|---|
| RLS en 12 tablas | En las 15 (`daily_runs`, `daily_run_members`, `ai_usage_log` incluidas) | Una tabla de `public` sin RLS queda abierta con la anon key. |
| Lectura `using (true)` | Solo usuarios **activos** | Desactivar a alguien en `profiles` le corta el acceso de inmediato. |
| `current_user_role()` en `public` | `private.app_role()`, `is_lead()`, `is_admin()` | El esquema `private` no lo expone la API: no se puede llamar como RPC. |
| `unique(daily_member_id, rule_type)` | `unique(daily_member_id)` | La app quita una regla al marcar la otra; la base ahora lo garantiza. |
| `templates.variant_id` nullable | Igual, con `UNIQUE NULLS NOT DISTINCT` y FK compuesta | Evita dos plantillas sin variante en el mismo proyecto y variantes de otro proyecto. |
| — | `qa_generations.project_name/variant_name` | El historial conserva lo usado aunque luego se renombre el proyecto. |
| — | `profiles.email` + trigger que crea el perfil | La pestaña Usuarios necesita el correo y `auth.users` no se lee desde el cliente. |
| — | `daily_run_members`: solo se puede actualizar `completed` | El histórico del Daily no se reescribe. |
| `migrate-data.js` con cliente Supabase | Script que **genera SQL** | No necesita la `service_role` key; todo corre en una transacción. |
| `Repository.loadProjects()` etc. (Fase 3) | `get_app_config()` ya devuelve el `DB` actual | La Fase 3 puede cargar todo con una llamada sin tocar `generateOrder()`. |
| `Repository.saveTemplate()` (Fase 3) | `save_template()` transaccional | Dos QA_LEAD guardando a la vez no mezclan líneas. |

Cambiar una regla del Daily desde la Fase 3 es un upsert:

```js
await supabaseClient.from('daily_rule_members')
  .upsert({ daily_member_id: id, rule_type: 'LAST_FIXED' }, { onConflict: 'daily_member_id' });
```

## Datos del JSON actual

La migración avisa de dos incoherencias y las conserva sin perder nada:

- **DATA** tiene una plantilla con clave `""` además de sus variantes. La app no la usa (solo mira `""` cuando no hay variantes). Se migra como plantilla sin variante.
- **SISTAR** tiene la plantilla «Estimación y Especificación», que no está en `variants`. Se migra con la variante **desactivada**: no aparece en la app.

Si no hacen falta, se pueden borrar después desde Administración.

## Probar en local (opcional)

Con Postgres 15+:

```bash
createdb qabcr
psql -d qabcr -f local-test/supabase-stub.sql
for f in supabase/migrations/*.sql; do psql -v ON_ERROR_STOP=1 -d qabcr -f "$f"; done
node scripts/migrate-data.mjs qa-bcr-suite-data.json out
psql -d qabcr -f out/seed.sql -f out/verify-seed.sql -f supabase/tests/rls_test.sql
```

## Fase 2: login y roles (`index.html`)

Parte de `qa-bcr-suite_6.html`; los cambios están en `app/cambios-fase2.diff`. Desde la Fase 3 los datos vienen de Supabase (ver abajo).

**Configurar antes de publicar** — en el bloque `AUTH (Supabase)` del script:

```js
const SUPABASE_URL='https://<tu-proyecto>.supabase.co';
const SUPABASE_ANON_KEY='<anon / publishable key>';
```

Están en *Project Settings → API*. La anon key puede ir en el HTML público: lo que protege los datos es el RLS. **Nunca** pongas la `service_role` key. En *Authentication → URL Configuration* agrega la URL de GitHub Pages como *Site URL*.

Qué hace:

- Pantalla de login (correo y contraseña). La app no se muestra hasta tener sesión y perfil activo.
- La sesión se mantiene al recargar; si el usuario fue eliminado, vuelve al login.
- Usuario desactivado o sin perfil: aviso y botón para cerrar sesión.
- Nombre, rol y "Cerrar sesión" en el sidebar; botón "Salir" en móvil.
- **Administración** solo para ADMIN y QA_LEAD (menú, botón móvil y acceso directo).
- Pestaña **Usuarios** solo para ADMIN: cambiar rol y activar/desactivar. No deja cambiarse a uno mismo. Si Supabase rechaza el cambio, avisa y vuelve a mostrar lo guardado.
- Corrige un scroll horizontal en móvil que venía de v2 (`.main` sin `min-width: 0`).

Seguridad de la página publicada:

- Librería `@supabase/supabase-js@2.117.2` desde jsDelivr, versión fija y con `integrity` (SRI): si el archivo cambia, el navegador no lo ejecuta. Al subir de versión hay que recalcular el hash.
- *Content Security Policy*: solo carga scripts propios y ese archivo, y solo se conecta al proyecto de Supabase configurado. La página no llama a ninguna IA.
- El HTML no trae nombres de personas ni datos del equipo: todo se lee de Supabase después del login.
- Las claves `sb_secret_...` / `service_role` nunca van en el HTML ni en el repositorio.

**Pruebas** (`tests/test-auth.mjs`): Playwright con el cliente real de supabase-js y un Supabase simulado en la red. Cubre sin configuración, login correcto e incorrecto, sesión persistente, logout, usuario desactivado, usuario eliminado, permisos de QA / QA_LEAD / ADMIN, pestaña Usuarios (guardado y rechazo), vista móvil sin scroll horizontal y ausencia de errores de JavaScript.

## Fase 3: datos en Supabase

La app ya no usa `qa-bcr-suite-data.json` ni el archivo vinculado: personas, reglas, proyectos, variantes y plantillas se leen y se guardan en Supabase, y todo el equipo ve lo mismo.

- **Carga**: después del login, `get_app_config()` (los datos con la forma del `DB` de v2) y los ids de grupos, personas, proyectos y variantes. Hasta tenerlos no se muestra la app.
- **Guardado** (solo ADMIN y QA_LEAD; el RLS lo exige igual):

  | Acción | En Supabase |
  |---|---|
  | Agregar / renombrar / quitar persona | `daily_members` insert / update / delete (agregar a alguien inactivo lo reactiva) |
  | Regla de primeros / fijo al final | upsert en `daily_rule_members` por persona; desmarcar la borra |
  | Rango del bloque inicial | upsert en `daily_rules` |
  | Guardar plantilla | `save_template()` |
  | Proyecto / variante nuevo o eliminado | `projects` / `project_variants` insert / delete (en cascada sus plantillas; el historial conserva el nombre) |

  Después de cada cambio se recarga todo desde la base: si Supabase lo rechaza, se avisa y la pantalla muestra lo guardado.
- **Copia local**: la última configuración se guarda en `localStorage` con el id del usuario. Si Supabase no responde, se muestra esa copia con un aviso y un botón *Reintentar*; sin copia, no se entra. Se borra al cerrar sesión.
- **Respaldo**: *Exportar configuración* descarga el JSON actual. Importar y restablecer se quitaron (sobrescribían los datos de todos).
- **Base vacía**: si no hay proyectos ni personas, un aviso pide cargar `seed.sql` (paso 4).
- Corrige XSS de v2: nombres, proyectos, variantes, PBIs y respuestas de la IA se muestran como texto.

**Pruebas**: `tests/test-auth.mjs` simula las tablas y las dos RPC en memoria y cubre la carga, cada tipo de guardado, rechazos, permisos de QA, otro usuario viendo los cambios, sin conexión con y sin copia, base vacía y escapado de nombres. Las mismas sentencias se probaron contra Postgres con las migraciones y el RLS reales.

## Usuarios desde la app (Edge Function `admin-create-user`)

Crear usuarios necesita la clave secreta de Supabase, que nunca puede ir en la página. Lo hace la función `supabase/functions/admin-create-user/index.ts`: comprueba que quien llama sea un **ADMIN activo**, crea el usuario confirmado con la contraseña temporal y le asigna el rol. Responde solo a `https://braynerrosales.github.io` (CORS).

**Publicarla** (desde el navegador, sin instalar nada):

1. *Supabase → Edge Functions → Deploy a new function → Via Editor*.
2. Nombre: `admin-create-user` (exacto). Pegar el contenido de `index.ts` y *Deploy function*.
3. En la función → *Details*: desactivar **Verify JWT** y guardar. La función valida la sesión ella misma; con la verificación legacy activada, las sesiones de los proyectos nuevos se rechazan antes de llegar al código.

No hace falta configurar secretos: Supabase pone `SUPABASE_URL` y la clave secreta en el entorno de la función.

En la app: *Administración → Usuarios* → nombre, correo, rol y contraseña temporal (*Generar* crea una de 14 caracteres). La persona entra con esa contraseña y la cambia en *Cambiar contraseña* (sidebar) o *Clave* (móvil). Al crear el usuario aparece un mensaje listo para copiar (enlace, usuario, contraseña temporal y rol); en pantalla la contraseña se ve oculta y *Listo* la borra. Mandalo por chat directo. Al entrar por primera vez la app obliga a cambiar la contraseña temporal (sin Cancelar; puede cerrar sesión). En la lista, cada usuario muestra *Nunca entró*, *Entró, falta cambiar la contraseña* o su último ingreso; lo registra la base desde Supabase Auth con `supabase/migrations/20261017000001_acceso_usuarios.sql` (pruebas en `supabase/tests/acceso_test.sql`). Las fechas de ingreso solo las ve un ADMIN. Si la función no está publicada, la app lo dice.

**Contraseña olvidada:** en la lista, *Nueva contraseña* (no aparece en tu propio usuario) genera una contraseña temporal de 14 caracteres, la función la cambia en Supabase Auth (`action: 'reset_password'`) y vuelve a marcar que la persona debe cambiarla al entrar. Aparece el mismo mensaje para copiar. La contraseña anterior deja de servir y se cierran sus sesiones abiertas (`admin_cerrar_sesiones()`, de `20261022000001_admins_y_sesiones.sql`): quien siga con la app abierta queda fuera cuando vence su token, como máximo en una hora. Si actualizás la función, volvé a pegar `index.ts` y *Deploy* (mismo nombre, *Verify JWT* desactivado).

**Siempre queda un ADMIN:** la base rechaza quitarle el rol, desactivar o eliminar al último ADMIN activo (`20261022000001_admins_y_sesiones.sql`, pruebas en `supabase/tests/admins_test.sql`); la app muestra «Tiene que quedar al menos un ADMIN activo.».

**Cambiar nombre:** en la lista, *Cambiar nombre* edita el nombre en la misma fila (Enter guarda, Esc cancela). Sirve también para el propio usuario. Lo guarda `profiles.full_name` (solo ADMIN, por RLS); no hace falta SQL nuevo.

**Eliminar usuario:** en la lista, *Eliminar* (no aparece en tu propio usuario) pide confirmación y lo borra con la función `admin-create-user` (`action: 'delete_user'`): se borran su usuario, su perfil y su historial del QA Generator; en lo que modificó queda el registro sin el «modificado por». A quien tiene horas o ajustes de horas no se lo puede eliminar (`20261021000001_conservar_horas_al_eliminar.sql`), para no cambiar informes ya enviados: para que no entre más, desmarcá *Activo*. Requiere `20261019000001_feedback_y_eliminar_usuarios.sql` y volver a publicar la función (pegar `index.ts` → *Deploy*, *Verify JWT* desactivado).

## Feedback

Cualquier usuario envía ideas o errores con **Enviar feedback** (menú lateral; *Feedback* en el celular). Solo los ADMIN lo leen en **Administración → Feedback** (con un contador de sin leer), lo marcan como leído o lo eliminan; quien lo envía no lo vuelve a ver. La base pone el autor (no se puede enviar a nombre de otro) y limita a 20 mensajes por persona por día. Requiere `20261019000001_feedback_y_eliminar_usuarios.sql`.

## Generar tareas QA

Las tareas salen solo de la plantilla del proyecto (o de la variante). Si no hay plantilla, la app lo avisa y no genera nada: se agrega en Administración → Proyectos y tareas. La extracción de PBIs desde una captura con IA está desactivada. Después de generar, «Borrar» limpia los PBIs y las tareas y deja elegido el proyecto para la siguiente tanda.

## Control de solicitudes (QA Lead y Admin)

Reemplaza a `solicitudes_tracker.html`: una lista compartida en Supabase, en lugar de un JSON en cada navegador. Solo la ven y editan los QA_LEAD y ADMIN activos; a un QA el RLS no le devuelve filas aunque llame a la API.

1. En el SQL Editor, ejecutar `supabase/migrations/20261016000001_solicitudes.sql` y después `20261016000002_solicitudes_cerrada_sin_encargado.sql`.
2. (Opcional) `supabase/tests/solicitudes_test.sql`: imprime solo «OK» y termina en ROLLBACK.
3. Cargar las solicitudes existentes con `cargar-solicitudes.sql` (no está en el repo porque tiene nombres). Se niega a correr si la tabla ya tiene datos y al final muestra `iguales = true`.

Los cambios se guardan al salir de cada campo; marcar «Cierre enviado» cierra la solicitud y la saca del informe semanal (quita sus encargados; un trigger lo garantiza en la base). «↻ Recargar» trae los cambios que hicieron otros leads. El encargado del informe se elige de las personas activas del Daily. La base registra quién hizo el último cambio (`updated_by`) y la lista lo muestra en cada fila («Laura · hace 2 h»; el detalle al pasar el mouse).

**Informes semanales:** el botón arma el mensaje de Teams (solo se eligen las dos horas de envío, que se recuerdan) y la lista de las solicitudes abiertas con *Solicitud | Informe semanal | Encargados* («N/A» si no lleva informe; «Sin asignar» si lleva informe pero no tiene encargado). **Copiar** la deja lista para pegar en Excel, Teams o un correo (como tabla) e **Imprimir** imprime solo esa lista.

**En vivo:** con `supabase/migrations/20261017000002_solicitudes_realtime.sql` la tabla se publica en Supabase Realtime y los cambios de otros leads aparecen solos (indicador «● En vivo»). Realtime respeta el RLS: solo reciben cambios QA_LEAD y ADMIN activos. En la fila que estás editando solo se actualiza el estado, para no pisar lo que escribís. El plan gratuito incluye 200 conexiones simultáneas y 2 millones de mensajes por mes. Sin esa migración la app funciona igual con «↻ Recargar».

## Rol Beta

Para usuarios de prueba: un **Beta** solo ve **Generar tareas**, **Daily** (sortear, guardar y ver el historial) y **Días hábiles**, y puede enviar feedback. No ve Horas, Solicitudes ni Administración, y no sale en el informe de horas. El bloqueo está en la base: con `supabase/migrations/20261020000001_rol_beta.sql` un Beta no puede leer ni guardar horas ni pedir el consolidado aunque llame a Supabase directo. Se elige al crear el usuario o en Administración → Usuarios (la Edge Function `admin-create-user` acepta el rol `BETA`). Pruebas de la base: `supabase/tests/beta_test.sql`.

## Horas (todos los usuarios salvo Beta)

Reemplaza el libro «Horas semanales» (una pestaña por QA) y el informe «Horas mensuales equipo QA». Requiere `supabase/migrations/20261018000001_horas.sql`.

- **Mis horas:** semana de lunes a viernes. Cada línea tiene Soli/PBI, tarea, tipo, horas y horas **facturables** (número, no casilla: si Azure dice 8 y se cobran 7, se pone 7). Por defecto se factura todo lo trabajado. Feriado, licencia/incapacidad/citas y vacaciones/permisos son una línea más del día, sin horas facturables. Los feriados de Costa Rica tienen un botón para cargarlos. Cada día muestra su total contra 8 h.
- **Consolidado:** por semana o por mes, una fila por persona con Feriado, Facturable, No facturable, Licencia, Vacaciones, Total y Capacidad (días hábiles × 8). En naranja, quien no llega o se pasa. Una semana que cruza de mes se parte en dos tablas, como el Excel. «Copiar para Excel» copia las tablas para pegarlas en una hoja.
- **Permisos (RLS):** un QA ve y cambia solo sus líneas. QA_LEAD y ADMIN ven y corrigen las de todos (selector «Horas de» o tocando un nombre en el consolidado), y la línea queda marcada «Corregido por…». El consolidado lo ven todos los usuarios activos, pero `horas_resumen()` solo devuelve totales: nunca las tareas de otros.
- **Cierre de semanas:** un QA solo agrega, cambia o borra sus horas de la semana actual y de las dos anteriores (desde el lunes de hace dos semanas, hora de Costa Rica). Las semanas más viejas se ven en solo lectura con el aviso «Semana cerrada»; para corregirlas, un QA_LEAD o ADMIN (sin límite). Lo exige la base con el trigger `horas_cierre` (`20261023000001_horas_cierre_semanas.sql`, pruebas en `supabase/tests/horas_cierre_test.sql`).
- **Personas del informe (solo ADMIN):** en Consolidado, un ADMIN marca quién sale en el informe (`profiles.en_informe`, requiere `20261018000002_horas_informe.sql`). Quien queda fuera puede seguir cargando sus horas; solo deja de salir en el consolidado.
- **Ajustes al consolidado (QA_LEAD y ADMIN):** en la vista *Semana*, tocar un número (Feriado, Facturable, No facturable, Licencia o Vacaciones) abre una ventana para poner el número final y un motivo. Se guarda la diferencia en `horas_ajustes` (requiere `20261018000003_horas_ajustes.sql`): las líneas del QA no cambian, el Total se recalcula y el mes suma los ajustes de sus semanas (en *Mes* no se ajusta). Leads y ADMIN ven la celda con raya azul y, al pasar el mouse, quién ajustó, de cuánto a cuánto y por qué; los QA ven solo el número final.

## Daily: «No asistió»

Cada persona del orden tiene un botón **No asistió**: la saca de completados, la tacha y la pasa a la lista *No asistieron*. Se deshace con el mismo botón (*Asistió*) o tocando su fila en esa lista, y se limpia al generar otro orden.

## Daily: historial

Al terminar el daily, **Guardar daily de hoy** guarda el orden, quién habló y quién no asistió (quien no está en *No asistió* cuenta como que asistió). Hay un registro por daily por día: si se vuelve a guardar el mismo día, la app pregunta y lo reemplaza. La página tiene dos pestañas, **Daily de hoy** (el sorteo) e **Historial**, y las dos usan el Daily 1 o 2 elegido arriba. El historial abre en **Mes**: la asistencia de cada persona (asistió, faltó, % —en naranja si es menos de 80 %— y cuántas veces empezó) y cada día guardado con quién empezó, quién faltó, el orden y quién lo guardó. En **Semana** muestra solo los días. La pestaña y el período elegidos se recuerdan en ese navegador. Guarda cualquier usuario activo con `daily_guardar()` (solo desde 7 días atrás hasta mañana) y lo leen todos con `daily_historial()`. Requiere `20261019000002_daily_historial.sql`.

## Diseño

Hoja de trabajo clara con la tinta azul del banco y un solo acento: el naranja de Babel marca lo actual (la sección abierta y quién habla primero en el Daily). Tipografía Public Sans, con cifras alineadas en tablas; IBM Plex Mono solo para editar las plantillas de tareas. Marca: el login (público) muestra solo el logo de Babel; el logo del BCR aparece en Inicio y se carga recién después de iniciar sesión (`img/`). Ojo: los archivos del repo son públicos igual, así que eso evita mostrarlo, no esconderlo. Modo oscuro automático según el sistema, foco visible con teclado y sin animaciones si el sistema pide reducir movimiento.

## Siguiente: Fase 4

Guardar el historial del QA Generator. Si más adelante se vuelve a usar IA (extraer PBIs de una captura o proponer tareas), va por una Edge Function: la clave de Anthropic queda en Supabase y se registra el uso en `ai_usage_log`; nunca se llama a `api.anthropic.com` desde el navegador.

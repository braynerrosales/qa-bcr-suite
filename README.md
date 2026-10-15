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

Parte de `qa-bcr-suite_6.html`; los cambios están en `app/cambios-fase2.diff`. Los datos siguen en `localStorage` y el JSON: eso cambia en la Fase 3.

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
- *Content Security Policy*: solo carga scripts propios y ese archivo, y solo se conecta a `*.supabase.co` y a la API de Anthropic (esta última se quita en la Fase 4).
- `DEFAULT_DB` no trae nombres de personas. Se cargan con *Administración → Respaldo → Importar datos* hasta la Fase 3.
- Las claves `sb_secret_...` / `service_role` nunca van en el HTML ni en el repositorio.

**Pruebas** (`tests/test-auth.mjs`): Playwright con el cliente real de supabase-js y un Supabase simulado en la red. Cubre sin configuración, login correcto e incorrecto, sesión persistente, logout, usuario desactivado, usuario eliminado, permisos de QA / QA_LEAD / ADMIN, pestaña Usuarios (guardado y rechazo), vista móvil sin scroll horizontal y ausencia de errores de JavaScript.

## Siguiente: Fase 3

Cargar proyectos, variantes, plantillas, personas y reglas desde Supabase con `get_app_config()`, guardar con `save_template()` y los upserts, y dejar `localStorage` como caché.

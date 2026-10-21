# Avisos de solicitudes para QA Lead y Admin

Fecha: 2026-10-21 · Estado: borrador para revisión de Bray

## Objetivo

Que cada QA Lead y Admin se entere, sin tener que revisar la tabla, de dos cosas que hace otra persona en Solicitudes:

- se creó una solicitud nueva;
- una solicitud pasó a *Plan enviado*.

## Decisiones tomadas

| Tema | Decisión |
|---|---|
| Qué genera un aviso | Solicitud creada **o** pasada a *Plan enviado* por otra persona. |
| Quién lo recibe | Cada QA Lead y Admin activo, excepto quien hizo el cambio. |
| Dónde | Solo dentro de la app: sin correo, sin avisos del navegador y sin Teams. |
| Cuándo se da por visto | Al abrir Solicitudes. Cada usuario tiene su propio "visto": abrir la pantalla pone en cero solo su contador. |
| Primera vez | El contador arranca en cero. El historial no aparece como novedad. |

## Qué ve el usuario

1. **Contador en el menú.** Junto a «Solicitudes», en el menú lateral (`#nav-solicitudes`) y en el menú móvil (`#mnav-solicitudes`), aparece un número con la cantidad de solicitudes con novedades desde su última visita. Si no hay novedades, no se muestra. Tiene `aria-label`, por ejemplo «3 novedades», con el mismo estilo que `#fb-badge`.
2. **En vivo.** El contador se actualiza sin recargar, en cualquier pantalla de la app.
3. **Al abrir Solicitudes.** Las filas con novedades llevan una etiqueta: «Nueva», o «Plan enviado» cuando lo único nuevo es el plan. Una solicitud con las dos novedades muestra solo «Nueva» y cuenta una vez. Al abrir, el contador vuelve a cero. Las etiquetas se quedan hasta salir de la pantalla.
4. **Mientras está en Solicitudes**, lo que llega en vivo también se etiqueta y su "visto" se actualiza, así que el contador no sube.
5. Una solicitud borrada deja de contar.

## Datos (migración nueva `supabase/migrations/20261025000001_solicitudes_avisos.sql`)

### Columnas nuevas en `public.solicitudes`

- `created_by uuid references public.profiles(id) on delete set null`
- `plan_enviado_at timestamptz`
- `plan_enviado_by uuid references public.profiles(id) on delete set null`

Las completa la base: se amplía el trigger `solicitudes_touch`. La app no puede escribirlas, porque no se agregan a los `grant insert/update` por columna.

- En INSERT: `created_by = auth.uid()`. Si nace con `plan_enviado`, también se completan `plan_enviado_at = now()` y `plan_enviado_by = auth.uid()`.
- En UPDATE: si `plan_enviado` pasa de falso a verdadero, se completan `plan_enviado_at` y `plan_enviado_by`. Si vuelve a falso, quedan como estaban, y un nuevo paso a verdadero las actualiza.
- Las filas existentes quedan con NULL y no generan avisos.

### Tabla `public.solicitudes_vistas`

- `user_id uuid primary key references public.profiles(id) on delete cascade`
- `visto_at timestamptz not null`

RLS: cada uno ve solo su fila. Nadie escribe directo; se usa la función de abajo.

### Funciones (`security definer`, `set search_path = ''`, validan `private.is_lead()`)

- `solicitudes_novedades() returns integer`: cuenta las solicitudes con `(created_at > visto and created_by is distinct from me)` o `(plan_enviado_at > visto and plan_enviado_by is distinct from me)`. Si el usuario no tiene fila en `solicitudes_vistas`, la crea con `now()` y devuelve 0.
- `solicitudes_marcar_visto() returns timestamptz`: guarda `now()` como nuevo `visto_at` y devuelve el valor anterior, o `now()` si no había. La app usa ese valor anterior para saber qué filas etiquetar.

Las dos solo para QA Lead y Admin activos. A cualquier otro le devuelven un error 42501.

## App

- **`js/solicitudes.js`**
  - `solSubscribe()` se llama al iniciar sesión si el usuario es lead, no solo al abrir Solicitudes. Así el contador recibe los cambios en cualquier pantalla.
  - `solOnChange` sigue actualizando la tabla como hoy y además refresca el contador. Si se está en Solicitudes, etiqueta la fila y vuelve a marcar visto.
  - Funciones nuevas: `refreshSolBadge()`, que llama a `solicitudes_novedades` y a la que se le agrega un pequeño retraso (debounce) para que una ráfaga de eventos se convierta en una sola llamada, y `solMarkSeen()`, que llama a `solicitudes_marcar_visto` y guarda el valor anterior para las etiquetas.
- **`js/base.js`**: al entrar a `solicitudes`, `solMarkSeen()` se ejecuta antes de `loadSolicitudes()`.
- **`js/auth.js`**: después del login, si `canManageConfig()`, se ejecutan `refreshSolBadge()` y `solSubscribe()`. Al cerrar sesión se quita la suscripción.
- **`index.html` y `css/styles.css`**: el contador en los dos menús y la etiqueta de fila, siguiendo CLAUDE.md (taste-skill, web-design-guidelines y capturas con Playwright).

## Errores

- Si falla `solicitudes_novedades`, el contador se oculta, igual que el de feedback, y no se muestra error.
- Si falla `solicitudes_marcar_visto`, la pantalla carga igual sin etiquetas y el contador sigue como estaba. Se reintenta en la próxima visita.

## Pruebas

- **SQL (PGlite, `supabase/tests/solicitudes_avisos_test.sql`)**: los triggers completan las columnas nuevas; el autor no se cuenta a sí mismo; la primera llamada devuelve 0; `marcar_visto` devuelve el valor anterior y pone el contador en 0 solo para ese usuario; QA recibe 42501; nadie puede escribir `created_by` ni `plan_enviado_*` ni la tabla de vistas directamente.
- **E2E (`tests/test-auth.mjs`, mock de Supabase)**: un lead crea una solicitud y el otro ve el contador en 1 en otra pantalla; al abrir Solicitudes ve la etiqueta «Nueva» y el contador queda en 0; el autor no ve contador; el paso a *Plan enviado* muestra «Plan enviado»; QA no ve el contador.
- Capturas Playwright del contador en escritorio y móvil, en tema claro y oscuro.

## Fuera de alcance

Correo, avisos del navegador, Teams, historial o lista de avisos, y avisos por otros estados (*Pendiente de actualizar*, cierre).

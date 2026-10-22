# Daily: motivo de ausencia e intercambio de leads — diseño

Fecha: 2026-10-22 · Estado: aprobado en conversación, pendiente de revisión escrita

## Objetivo

1. Las vacaciones y las ausencias justificadas no bajan el % de asistencia del historial del Daily.
2. Los dos leads, que van una semana en cada Daily y siempre al final, se cambian de Daily con un botón.

## Parte 1 — Motivo de ausencia

### Decisiones

| Tema | Decisión |
|---|---|
| Motivos | *Sin justificar*, *Justificada*, *Vacaciones*. |
| Cómo se marca | El botón «No asistió» de cada fila abre un menú con los tres motivos. Con el motivo elegido, el botón muestra el motivo (p. ej. «Vacaciones ▾») y su menú agrega «Asistió» para deshacer. Se cierra con Esc o tocando afuera; se usa con el teclado. |
| Lista «No asistieron» (derecha) | Muestra el motivo: «Ana (vacaciones)». Sin justificar va sin paréntesis. |
| Mensaje al guardar | «Guardado el Daily 1 de hoy: 8 asistieron, 2 no asistieron (1 de vacaciones, 1 justificada).» (se omiten los conteos en 0). |
| % de asistencia | asistió ÷ (dailies − justificadas − vacaciones). Ejemplo: 20 dailies, 5 de vacaciones, 1 falta sin justificar → 14/15 = 93 %. |
| Rojo (< 80 %) | Igual que hoy, ahora solo por faltas sin justificar. |
| Todo justificado o de vacaciones | El % se muestra «—», sin rojo. |
| Tabla del mes | Columnas: Persona · Asistió · Faltó · Justificada · Vacaciones · % asistencia · Empezó. «Faltó» = sin justificar. Orden: más faltas sin justificar primero. |
| Lista de días | «No asistieron: Ana (vacaciones), Beto (justificada), Caro». |
| QA Boss | Sin cambios: ve el Daily y el historial, no guarda. |

### Datos (Supabase)

Migración `supabase/migrations/20261030000001_daily_motivos.sql`:

- `daily_run_members.motivo text` con `check (motivo in ('justificada','vacaciones'))`, null por defecto, y
  `check (motivo is null or absent)`. **`absent` se queda**: ausente sin motivo = sin justificar. Así lo
  guardado no cambia y una pestaña con la versión vieja de la app sigue guardando bien.
- `daily_guardar`: acepta `motivo` en cada miembro del JSON; rechaza (22023) un motivo inválido o un motivo
  sin `absent`. Mismo cuerpo que en `20261024000001_seguridad.sql` y `20261029000001_rol_qa_boss.sql`,
  más la columna.
- `daily_historial`: devuelve también `motivo` (cambia el tipo de resultado: se borra y se vuelve a crear,
  con los mismos permisos).

## Parte 2 — Intercambiar leads

### Decisiones

| Tema | Decisión |
|---|---|
| Quién | QA Lead y Admin. |
| Dónde | Botón «Intercambiar leads» arriba de la lista del Daily de hoy. |
| A quiénes cambia | A la persona **fija al final** (regla «fijo al final», `LAST_FIXED`) de cada Daily: la del Daily 1 pasa al Daily 2 y viceversa, y siguen fijas al final. |
| Confirmación | «¿Pasar a X al Daily 2 y a Y al Daily 1?». |
| Si no se puede | Si algún Daily no tiene exactamente una persona fija al final, o el otro Daily ya tiene a alguien con ese nombre, la app lo explica y no cambia nada. |
| Historial | No cambia: cada Daily guardado conserva quién estuvo ese día. |

### Datos (Supabase)

En la misma migración: `public.daily_intercambiar_leads() returns table (nombre text, a_grupo text)`,
`security definer`, `search_path = ''`, solo `is_lead()` (42501). En una transacción, cambia el
`daily_group_id` de las dos personas fijas al final de los Daily activos. Errores con 22023 y mensaje claro
en los casos de «Si no se puede». La regla `LAST_FIXED` va con la persona (es por `daily_member_id`).

## Pruebas

- SQL (`supabase/tests/daily_motivos_test.sql`): el motivo se guarda y vuelve en el historial; un ausente
  sin motivo queda como sin justificar; motivo inválido o sin ausencia → 22023; QA Boss sigue sin guardar.
  Intercambio: un lead lo hace y las dos personas cambian de Daily y siguen fijas al final; QA no puede
  (42501); con dos fijos al final en un Daily → 22023 y nada cambia.
- E2E: el menú con mouse y teclado (Esc, flechas, Enter), cambiar y deshacer el motivo, la lista de la
  derecha, el mensaje al guardar, el historial (columnas, 93 %, «—», lista de días), el botón de intercambio
  (solo para leads, confirmación, ambos Daily actualizados) y capturas en claro, oscuro y celular.

## Fuera de alcance

Rotación automática por semana, más de dos Daily, cargar vacaciones por adelantado.

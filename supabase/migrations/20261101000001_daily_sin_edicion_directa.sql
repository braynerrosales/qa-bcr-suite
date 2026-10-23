-- QA BCR Suite v3 — Lo guardado del Daily solo cambia con daily_guardar
--   · Antes, quien guardó un Daily podía cambiar "completed" directo en la tabla, de cualquier
--     fecha, salteando el límite de 7 días de daily_guardar. La app no lo usa: se quita.
-- Pruebas: supabase/tests/daily_motivos_test.sql.

drop policy if exists daily_run_members_update on public.daily_run_members;
revoke update on public.daily_run_members from authenticated;

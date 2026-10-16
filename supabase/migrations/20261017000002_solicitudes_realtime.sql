-- QA BCR Suite v3 — Solicitudes en tiempo real
-- Publica los cambios de public.solicitudes en Supabase Realtime: cuando un lead
-- cambia una solicitud, los demás lo ven sin tocar "Recargar".
-- Realtime respeta el RLS: solo reciben los cambios quienes pueden leer la tabla
-- (QA_LEAD y ADMIN activos). De un borrado solo llega el id.
-- Requiere 20261016000001_solicitudes.sql.

do $$
begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
       and not exists (
           select 1 from pg_publication_tables
           where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'solicitudes'
       ) then
        alter publication supabase_realtime add table public.solicitudes;
    end if;
end $$;

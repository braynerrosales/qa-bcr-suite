-- QA BCR Suite v3 — una solicitud cerrada sale del informe semanal
-- Al cerrarse (cerrada = true) se quitan sus encargados y se desmarca
-- "Informe semanal". Lo hace la base para que valga desde la app, desde el
-- SQL Editor o desde cualquier carga de datos.
-- Requiere 20261016000001_solicitudes.sql.

create or replace function public.solicitudes_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.updated_at = now();
    new.updated_by = auth.uid();
    if tg_op = 'INSERT' then
        new.created_at = now();
    end if;
    if new.cerrada then
        new.encargados = '{}';
        new.informe_semanal = false;
    end if;
    return new;
end;
$$;

-- Limpia las que ya estaban cerradas.
update public.solicitudes
set encargados = '{}', informe_semanal = false
where cerrada and (cardinality(encargados) > 0 or informe_semanal);

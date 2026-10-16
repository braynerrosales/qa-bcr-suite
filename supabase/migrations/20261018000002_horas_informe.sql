-- QA BCR Suite v3 — Quién sale en el consolidado de horas
-- Un ADMIN elige qué personas aparecen en el informe (por ejemplo, para dejar
-- fuera a un ADMIN o a alguien que no carga horas). Quien queda fuera puede
-- seguir cargando sus horas; solo deja de salir en el consolidado.
-- Requiere 20261018000001_horas.sql.

alter table public.profiles
    add column if not exists en_informe boolean not null default true;

-- Todos lo leen; solo un ADMIN lo cambia (política profiles_admin_update).
grant select (en_informe) on public.profiles to authenticated;
grant update (en_informe) on public.profiles to authenticated;

create or replace function public.horas_resumen(desde date, hasta date)
returns table (
    user_id uuid,
    full_name text,
    feriado numeric,
    facturable numeric,
    no_facturable numeric,
    licencia numeric,
    vacaciones numeric,
    total numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if not private.is_active_user() then
        raise exception 'Usuario sin acceso' using errcode = '42501';
    end if;
    if desde is null or hasta is null or hasta < desde or hasta - desde > 62 then
        raise exception 'Período inválido' using errcode = '22023';
    end if;
    return query
        select p.id,
               p.full_name,
               coalesce(sum(h.horas) filter (where h.tipo = 'FERIADO'), 0),
               coalesce(sum(h.facturable) filter (where h.tipo = 'TRABAJO'), 0),
               coalesce(sum(h.horas - h.facturable) filter (where h.tipo = 'TRABAJO'), 0),
               coalesce(sum(h.horas) filter (where h.tipo = 'LICENCIA'), 0),
               coalesce(sum(h.horas) filter (where h.tipo = 'VACACIONES'), 0),
               coalesce(sum(h.horas), 0)
        from public.profiles p
        left join public.horas h
            on h.user_id = p.id and h.fecha between desde and hasta
        where p.en_informe
        group by p.id, p.full_name, p.active
        having p.active or count(h.id) > 0
        order by p.full_name;
end;
$$;

revoke all on function public.horas_resumen(date, date) from public, anon;
grant execute on function public.horas_resumen(date, date) to authenticated;

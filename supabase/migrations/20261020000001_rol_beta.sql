-- QA BCR Suite v3 — Rol BETA
-- Un usuario BETA usa solo Generar tareas, Daily (sortear, guardar, historial)
-- y Días hábiles; también puede enviar feedback.
--   · No lee ni guarda horas (ni las suyas) y no ve el consolidado.
--   · No sale en el informe de horas.
--   · Solicitudes, ajustes y administración ya eran solo de ADMIN / QA_LEAD.
-- El bloqueo está en la base (RLS y RPC), no solo en el menú de la app.
-- Requiere 20261018000003_horas_ajustes.sql.

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
    add constraint profiles_role_check check (role in ('ADMIN', 'QA_LEAD', 'QA', 'BETA'));

-- Usuario activo que no es BETA.
create or replace function private.can_use_horas()
returns boolean
language sql
stable
set search_path = ''
as $$
    select coalesce(private.app_role() <> 'BETA', false);
$$;

drop policy if exists horas_select on public.horas;
drop policy if exists horas_insert on public.horas;
drop policy if exists horas_update on public.horas;
drop policy if exists horas_delete on public.horas;

create policy horas_select
on public.horas for select to authenticated
using (
    (user_id = (select auth.uid()) and (select private.can_use_horas()))
    or (select private.is_lead())
);

create policy horas_insert
on public.horas for insert to authenticated
with check (
    (user_id = (select auth.uid()) and (select private.can_use_horas()))
    or (select private.is_lead())
);

create policy horas_update
on public.horas for update to authenticated
using (
    (user_id = (select auth.uid()) and (select private.can_use_horas()))
    or (select private.is_lead())
)
with check (
    (user_id = (select auth.uid()) and (select private.can_use_horas()))
    or (select private.is_lead())
);

create policy horas_delete
on public.horas for delete to authenticated
using (
    (user_id = (select auth.uid()) and (select private.can_use_horas()))
    or (select private.is_lead())
);

-- Mismo consolidado que antes, pero un BETA no lo puede pedir y no aparece en él.
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
    if not private.can_use_horas() then
        raise exception 'Usuario sin acceso' using errcode = '42501';
    end if;
    if desde is null or hasta is null or hasta < desde or hasta - desde > 62 then
        raise exception 'Período inválido' using errcode = '22023';
    end if;
    return query
        with h as (
            select x.user_id,
                   coalesce(sum(x.horas) filter (where x.tipo = 'FERIADO'), 0) as feriado,
                   coalesce(sum(x.facturable) filter (where x.tipo = 'TRABAJO'), 0) as facturable,
                   coalesce(sum(x.horas - x.facturable) filter (where x.tipo = 'TRABAJO'), 0) as no_facturable,
                   coalesce(sum(x.horas) filter (where x.tipo = 'LICENCIA'), 0) as licencia,
                   coalesce(sum(x.horas) filter (where x.tipo = 'VACACIONES'), 0) as vacaciones
            from public.horas x
            where x.fecha between desde and hasta
            group by x.user_id
        ), a as (
            select y.user_id,
                   coalesce(sum(y.delta) filter (where y.columna = 'feriado'), 0) as feriado,
                   coalesce(sum(y.delta) filter (where y.columna = 'facturable'), 0) as facturable,
                   coalesce(sum(y.delta) filter (where y.columna = 'no_facturable'), 0) as no_facturable,
                   coalesce(sum(y.delta) filter (where y.columna = 'licencia'), 0) as licencia,
                   coalesce(sum(y.delta) filter (where y.columna = 'vacaciones'), 0) as vacaciones
            from public.horas_ajustes y
            where y.fecha between desde and hasta
            group by y.user_id
        ), t as (
            select p.id, p.full_name,
                   coalesce(h.feriado, 0) + coalesce(a.feriado, 0) as feriado,
                   coalesce(h.facturable, 0) + coalesce(a.facturable, 0) as facturable,
                   coalesce(h.no_facturable, 0) + coalesce(a.no_facturable, 0) as no_facturable,
                   coalesce(h.licencia, 0) + coalesce(a.licencia, 0) as licencia,
                   coalesce(h.vacaciones, 0) + coalesce(a.vacaciones, 0) as vacaciones
            from public.profiles p
            left join h on h.user_id = p.id
            left join a on a.user_id = p.id
            where p.en_informe and p.role <> 'BETA'
              and (p.active or h.user_id is not null or a.user_id is not null)
        )
        select t.id, t.full_name, t.feriado, t.facturable, t.no_facturable, t.licencia, t.vacaciones,
               t.feriado + t.facturable + t.no_facturable + t.licencia + t.vacaciones
        from t
        order by t.full_name;
end;
$$;

revoke all on function public.horas_resumen(date, date) from public, anon;
grant execute on function public.horas_resumen(date, date) to authenticated;

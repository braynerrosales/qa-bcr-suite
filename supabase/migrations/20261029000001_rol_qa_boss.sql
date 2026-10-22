-- QA BCR Suite v3 — Rol QA Boss (BOSS)
--   · Ve lo mismo que BETA (Generar tareas, Daily, Días hábiles) más Solicitudes y la campana,
--     pero solo para leer: crear, editar y borrar solicitudes sigue siendo de QA_LEAD y ADMIN.
--   · Mira el Daily y su historial, pero no lo guarda.
--   · No lee ni carga horas y no sale en el consolidado (como BETA).
--   · No agrega proyectos: private.can_edit_catalog() ya lo deja afuera.
-- Las funciones se recrean con el mismo cuerpo; solo cambia quién puede usarlas.
-- Pruebas: supabase/tests/qa_boss_test.sql.

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
    add constraint profiles_role_check check (role in ('ADMIN', 'QA_LEAD', 'QA', 'BETA', 'BOSS'));

-- Quién lee solicitudes y usa la campana.
create or replace function private.can_view_solicitudes()
returns boolean
language sql
stable
set search_path = ''
as $$
    select coalesce(private.app_role() in ('ADMIN', 'QA_LEAD', 'BOSS'), false);
$$;

drop policy solicitudes_select on public.solicitudes;
create policy solicitudes_select
on public.solicitudes for select to authenticated
using ((select private.can_view_solicitudes()));

-- ── Campana (mismo cuerpo que 20261025000001 y 20261027000001) ──
create or replace function public.solicitudes_novedades()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_visto timestamptz;
begin
    if not private.can_view_solicitudes() then
        raise exception 'Sin permiso' using errcode = '42501';
    end if;
    -- La primera vez arranca en cero: no se avisa del historial.
    insert into public.solicitudes_vistas (user_id, visto_at)
    values (auth.uid(), now())
    on conflict (user_id) do nothing;
    select v.visto_at into v_visto from public.solicitudes_vistas v where v.user_id = auth.uid();
    return (
        select count(*)
        from public.solicitudes s
        where (s.created_by is not null and s.created_by <> auth.uid() and s.created_at > v_visto)
           or (s.plan_enviado_by is not null and s.plan_enviado_by <> auth.uid() and s.plan_enviado_at > v_visto)
    );
end;
$$;

create or replace function public.solicitudes_marcar_visto()
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_antes timestamptz;
begin
    if not private.can_view_solicitudes() then
        raise exception 'Sin permiso' using errcode = '42501';
    end if;
    select v.visto_at into v_antes from public.solicitudes_vistas v where v.user_id = auth.uid();
    insert into public.solicitudes_vistas (user_id, visto_at)
    values (auth.uid(), now())
    on conflict (user_id) do update set visto_at = excluded.visto_at;
    return coalesce(v_antes, now());
end;
$$;

create or replace function public.solicitudes_avisos()
returns table (solicitud_id bigint, nombre text, tipo text, autor text, fecha timestamptz, sin_ver boolean, propio boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if not private.can_view_solicitudes() then
        raise exception 'Sin permiso' using errcode = '42501';
    end if;
    return query
    with eventos as (
        select s.id, s.nombre, 'nueva'::text as tipo, s.created_by as quien, s.created_at as cuando
        from public.solicitudes s
        where s.created_by is not null
          and s.created_at > now() - interval '7 days'
        union all
        select s.id, s.nombre, 'plan'::text, s.plan_enviado_by, s.plan_enviado_at
        from public.solicitudes s
        where s.plan_enviado and s.plan_enviado_by is not null
          and s.plan_enviado_at > now() - interval '7 days'
    )
    select e.id, e.nombre, e.tipo, p.full_name, e.cuando,
           e.quien <> auth.uid() and coalesce(e.cuando > v.visto_at, false),
           e.quien = auth.uid()
    from eventos e
    left join public.profiles p on p.id = e.quien
    left join public.solicitudes_vistas v on v.user_id = auth.uid()
    order by e.cuando desc, e.id desc, e.tipo
    limit 10;
end;
$$;

-- ── Horas: QA Boss no lee, no carga y no sale en el consolidado ──
create or replace function private.can_use_horas()
returns boolean
language sql
stable
set search_path = ''
as $$
    select coalesce(private.app_role() not in ('BETA', 'BOSS'), false);
$$;

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
            where p.en_informe and p.role not in ('BETA', 'BOSS')
              and (p.active or h.user_id is not null or a.user_id is not null)
        )
        select t.id, t.full_name, t.feriado, t.facturable, t.no_facturable, t.licencia, t.vacaciones,
               t.feriado + t.facturable + t.no_facturable + t.licencia + t.vacaciones
        from t
        order by t.full_name;
end;
$$;

-- ── Daily: QA Boss no guarda (mismo cuerpo que 20261024000001) ──
create or replace function public.daily_guardar(p_grupo bigint, p_fecha date, p_miembros jsonb)
returns table (run_id bigint, reemplazado boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_id bigint;
    v_autor uuid;
    v_reemplazado boolean := false;
begin
    -- QA Boss mira el Daily, pero no lo guarda.
    if not private.is_active_user() or private.app_role() = 'BOSS' then
        raise exception 'Usuario sin acceso' using errcode = '42501';
    end if;
    if p_fecha is null or p_fecha < current_date - 7 or p_fecha > current_date + 1 then
        raise exception 'Fecha inválida' using errcode = '22023';
    end if;
    if not exists (select 1 from public.daily_groups g where g.id = p_grupo and g.active) then
        raise exception 'Daily inválido' using errcode = '22023';
    end if;
    if jsonb_typeof(p_miembros) is distinct from 'array'
       or jsonb_array_length(p_miembros) not between 1 and 100 then
        raise exception 'Lista de personas inválida' using errcode = '22023';
    end if;
    if exists (
        select 1 from jsonb_to_recordset(p_miembros) as x(name text, position integer, completed boolean, absent boolean)
        where coalesce(char_length(btrim(x.name)), 0) not between 1 and 120
           or x.position is null or x.position < 1
           or (coalesce(x.completed, false) and coalesce(x.absent, false))
    ) then
        raise exception 'Lista de personas inválida' using errcode = '22023';
    end if;

    select r.id, r.created_by into v_id, v_autor
    from public.daily_runs r
    where r.daily_group_id = p_grupo and r.run_date = p_fecha
    for update;

    if found then
        -- Un día ya guardado solo lo reemplaza quien lo guardó o un QA_LEAD/ADMIN.
        if v_autor is distinct from auth.uid() and not private.is_lead() then
            raise exception 'Ese día ya lo guardó otra persona. Solo ella o un QA Lead lo puede reemplazar.';
        end if;
        v_reemplazado := true;
        delete from public.daily_run_members m where m.daily_run_id = v_id;
        update public.daily_runs r set created_by = auth.uid(), created_at = now() where r.id = v_id;
    else
        insert into public.daily_runs (daily_group_id, run_date, created_by)
        values (p_grupo, p_fecha, auth.uid())
        returning id into v_id;
    end if;

    insert into public.daily_run_members (daily_run_id, daily_member_id, member_name, position, completed, absent)
    select v_id,
           -- Solo se enlaza a la persona si es de ese daily.
           (select dm.id from public.daily_members dm where dm.id = x.daily_member_id and dm.daily_group_id = p_grupo),
           btrim(x.name), x.position, coalesce(x.completed, false), coalesce(x.absent, false)
    from jsonb_to_recordset(p_miembros) as x(daily_member_id bigint, name text, position integer, completed boolean, absent boolean);

    return query select v_id, v_reemplazado;
end;
$$;

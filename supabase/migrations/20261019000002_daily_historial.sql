-- QA BCR Suite v3 — Historial del Daily
-- Al terminar el daily se guarda el orden, quién habló y quién no asistió.
--   · Un registro por daily por día (run_date). Si se vuelve a guardar el mismo
--     día, se reemplaza: así un re-sorteo o una corrección no duplica el día.
--   · Guarda cualquier usuario activo (quien conduce el daily), con
--     daily_guardar(); lo leen todos los activos con daily_historial().
--   · Solo se puede guardar desde 7 días atrás hasta mañana: no se inventa
--     historial viejo.
-- Requiere 20261015000002_rls.sql. Usa las tablas daily_runs y
-- daily_run_members del esquema inicial (estaban vacías).

alter table public.daily_runs add column if not exists run_date date;
update public.daily_runs set run_date = created_at::date where run_date is null;
alter table public.daily_runs alter column run_date set not null;
alter table public.daily_runs alter column run_date set default current_date;
alter table public.daily_runs
    add constraint daily_runs_grupo_fecha unique (daily_group_id, run_date);

alter table public.daily_run_members add column if not exists absent boolean not null default false;
alter table public.daily_run_members
    add constraint daily_run_members_habla_o_falta check (not (completed and absent));

-- Guarda (o reemplaza) el daily de un día.
-- p_miembros: [{"daily_member_id": 1, "name": "Ana", "position": 1, "completed": true, "absent": false}, ...]
create or replace function public.daily_guardar(p_grupo bigint, p_fecha date, p_miembros jsonb)
returns table (run_id bigint, reemplazado boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_id bigint;
    v_reemplazado boolean := false;
begin
    if not private.is_active_user() then
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

    select r.id into v_id
    from public.daily_runs r
    where r.daily_group_id = p_grupo and r.run_date = p_fecha
    for update;

    if found then
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

-- Historial de un daily entre dos fechas (máximo un año): una fila por persona por día.
create or replace function public.daily_historial(p_grupo bigint, desde date, hasta date)
returns table (
    run_id bigint,
    run_date date,
    guardado_por text,
    member_name text,
    "position" integer,
    completed boolean,
    absent boolean
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
    if desde is null or hasta is null or hasta < desde or hasta - desde > 366 then
        raise exception 'Período inválido' using errcode = '22023';
    end if;
    return query
        select r.id, r.run_date, coalesce(p.full_name, ''), m.member_name, m.position, m.completed, m.absent
        from public.daily_runs r
        join public.daily_run_members m on m.daily_run_id = r.id
        left join public.profiles p on p.id = r.created_by
        where r.daily_group_id = p_grupo and r.run_date between desde and hasta
        order by r.run_date desc, m.position;
end;
$$;

revoke all on function public.daily_guardar(bigint, date, jsonb) from public, anon;
grant execute on function public.daily_guardar(bigint, date, jsonb) to authenticated;
revoke all on function public.daily_historial(bigint, date, date) from public, anon;
grant execute on function public.daily_historial(bigint, date, date) to authenticated;

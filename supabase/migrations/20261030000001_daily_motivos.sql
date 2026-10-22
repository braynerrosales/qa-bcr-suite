-- QA BCR Suite v3 — Daily: motivo de ausencia e intercambio de leads
--   · daily_run_members.motivo: 'justificada' o 'vacaciones'; null = sin justificar. absent no cambia:
--     lo ya guardado sigue igual y la versión vieja de la app guarda bien (sin motivo).
--   · daily_guardar y daily_historial guardan y devuelven el motivo (mismo cuerpo, más la columna).
--   · daily_intercambiar_leads(): QA_LEAD o ADMIN pasa a la persona fija al final de cada Daily al otro.
-- Pruebas: supabase/tests/daily_motivos_test.sql.

alter table public.daily_run_members
    add column motivo text check (motivo in ('justificada', 'vacaciones')),
    add constraint daily_run_members_motivo_ausente check (motivo is null or absent);

-- ── Guardar (mismo cuerpo que 20261029000001_rol_qa_boss.sql, más el motivo) ──
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
        select 1 from jsonb_to_recordset(p_miembros) as x(name text, position integer, completed boolean, absent boolean, motivo text)
        where coalesce(char_length(btrim(x.name)), 0) not between 1 and 120
           or x.position is null or x.position < 1
           or (coalesce(x.completed, false) and coalesce(x.absent, false))
           -- Motivo: solo de una ausencia, y solo justificada o vacaciones (sin motivo = sin justificar).
           or (x.motivo is not null and (x.motivo not in ('justificada', 'vacaciones') or not coalesce(x.absent, false)))
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

    insert into public.daily_run_members (daily_run_id, daily_member_id, member_name, position, completed, absent, motivo)
    select v_id,
           -- Solo se enlaza a la persona si es de ese daily.
           (select dm.id from public.daily_members dm where dm.id = x.daily_member_id and dm.daily_group_id = p_grupo),
           btrim(x.name), x.position, coalesce(x.completed, false), coalesce(x.absent, false), x.motivo
    from jsonb_to_recordset(p_miembros) as x(daily_member_id bigint, name text, position integer, completed boolean, absent boolean, motivo text);

    return query select v_id, v_reemplazado;
end;
$$;

-- ── Historial (mismo cuerpo que 20261019000002, más el motivo; cambia el tipo de resultado) ──
drop function public.daily_historial(bigint, date, date);
create function public.daily_historial(p_grupo bigint, desde date, hasta date)
returns table (
    run_id bigint,
    run_date date,
    guardado_por text,
    member_name text,
    "position" integer,
    completed boolean,
    absent boolean,
    motivo text
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
        select r.id, r.run_date, coalesce(p.full_name, ''), m.member_name, m.position, m.completed, m.absent, m.motivo
        from public.daily_runs r
        join public.daily_run_members m on m.daily_run_id = r.id
        left join public.profiles p on p.id = r.created_by
        where r.daily_group_id = p_grupo and r.run_date between desde and hasta
        order by r.run_date desc, m.position;
end;
$$;

revoke all on function public.daily_historial(bigint, date, date) from public, anon;
grant execute on function public.daily_historial(bigint, date, date) to authenticated;

-- ── Intercambiar leads ─────────────────────────────────────
-- Los leads van una semana en cada Daily y siempre al final (regla LAST_FIXED, que va con la persona).
create or replace function public.daily_intercambiar_leads()
returns table (nombre text, a_grupo text)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_grupos bigint[];
    v_a bigint;
    v_b bigint;
begin
    if not private.is_lead() then
        raise exception 'Sin permiso' using errcode = '42501';
    end if;
    select array_agg(g.id order by g.id) into v_grupos from public.daily_groups g where g.active;
    if coalesce(array_length(v_grupos, 1), 0) <> 2 then
        raise exception 'Para intercambiar tiene que haber exactamente dos Daily activos.' using errcode = '22023';
    end if;
    -- Bloquea las personas de los dos Daily mientras se decide.
    perform 1 from public.daily_members m where m.daily_group_id = any (v_grupos) for update;
    if exists (
        select 1 from unnest(v_grupos) as g(id)
        where (select count(*) from public.daily_members m
               join public.daily_rule_members r on r.daily_member_id = m.id and r.rule_type = 'LAST_FIXED'
               where m.daily_group_id = g.id and m.active) <> 1
    ) then
        raise exception 'Cada Daily tiene que tener exactamente una persona fija al final.' using errcode = '22023';
    end if;
    select m.id into v_a from public.daily_members m
    join public.daily_rule_members r on r.daily_member_id = m.id and r.rule_type = 'LAST_FIXED'
    where m.daily_group_id = v_grupos[1] and m.active;
    select m.id into v_b from public.daily_members m
    join public.daily_rule_members r on r.daily_member_id = m.id and r.rule_type = 'LAST_FIXED'
    where m.daily_group_id = v_grupos[2] and m.active;
    if exists (select 1 from public.daily_members m, public.daily_members a
               where a.id = v_a and m.daily_group_id = v_grupos[2] and m.name = a.name and m.id <> a.id)
       or exists (select 1 from public.daily_members m, public.daily_members b
                  where b.id = v_b and m.daily_group_id = v_grupos[1] and m.name = b.name and m.id <> b.id) then
        raise exception 'El otro Daily ya tiene a alguien con ese nombre.' using errcode = '22023';
    end if;
    update public.daily_members set daily_group_id = v_grupos[2], updated_at = now() where id = v_a;
    update public.daily_members set daily_group_id = v_grupos[1], updated_at = now() where id = v_b;
    return query
        select m.name, g.code from public.daily_members m join public.daily_groups g on g.id = m.daily_group_id
        where m.id in (v_a, v_b) order by g.id;
end;
$$;

revoke all on function public.daily_intercambiar_leads() from public, anon;
grant execute on function public.daily_intercambiar_leads() to authenticated;

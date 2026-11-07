-- QA BCR Suite v3 — Daily: una pestaña vieja no borra los motivos al reemplazar el día
--   · La app con motivos siempre manda "motivo" (null = sin justificar). Una pestaña abierta desde
--     antes no lo manda: al reemplazar el día, quien sigue ausente conserva el motivo que tenía.
--   · Lo demás de daily_guardar no cambia (mismo cuerpo que 20261030000001_daily_motivos.sql).
-- Pruebas: supabase/tests/daily_pestana_vieja_test.sql.

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
    v_motivos jsonb;
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
        -- Los motivos que había, por nombre, para quien venga sin "motivo" (pestaña vieja).
        select jsonb_object_agg(m.member_name, m.motivo) into v_motivos
        from public.daily_run_members m
        where m.daily_run_id = v_id and m.motivo is not null;
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
           btrim(x.name), x.position, coalesce(x.completed, false), coalesce(x.absent, false),
           -- Sin "motivo" y todavía ausente: se queda con el que tenía.
           case when e.el ? 'motivo' then x.motivo
                when coalesce(x.absent, false) then v_motivos ->> btrim(x.name) end
    from jsonb_array_elements(p_miembros) as e(el)
    cross join lateral jsonb_to_record(e.el) as x(daily_member_id bigint, name text, position integer, completed boolean, absent boolean, motivo text);

    return query select v_id, v_reemplazado;
end;
$$;

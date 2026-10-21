-- QA BCR Suite v3 — Endurecimiento de permisos (auditoría de seguridad)
--   · Un perfil nuevo nace inactivo: solo lo activa la Edge Function admin-create-user.
--     Si alguien vuelve a abrir el registro público de Supabase, quien se registre
--     no ve nada hasta que un ADMIN lo active.
--   · Con la contraseña temporal no hay permisos: primero hay que cambiarla.
--   · El historial del Daily solo se escribe con daily_guardar, y un día guardado
--     solo lo reemplaza quien lo guardó o un QA_LEAD/ADMIN.
--   · Un usuario desactivado ya no agrega ítems a sus generaciones del QA Generator.
-- Requiere las migraciones anteriores. Pruebas: supabase/tests/seguridad_test.sql.

-- ── Perfiles nuevos inactivos ───────────────────────────────
alter table public.profiles alter column active set default false;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.profiles (id, full_name, email, must_change_password, active)
    values (
        new.id,
        coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), new.email),
        new.email,
        true,
        false
    );
    return new;
end;
$$;

-- ── Sin permisos mientras tenga la contraseña temporal ─────
-- Cada usuario sigue leyendo su propio perfil (profiles_select), así la app sabe
-- que tiene que pedir el cambio. El aviso lo apaga solo el trigger de Auth.
create or replace function private.app_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
    select role
    from public.profiles
    where id = auth.uid()
      and active
      and not must_change_password;
$$;

-- ── Historial del Daily: solo por daily_guardar ─────────────
drop policy daily_runs_insert on public.daily_runs;
drop policy daily_run_members_insert on public.daily_run_members;
revoke insert on public.daily_runs, public.daily_run_members from authenticated;

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

-- ── QA Generator: solo usuarios activos agregan ítems ──────
drop policy qa_generation_items_insert on public.qa_generation_items;
create policy qa_generation_items_insert
on public.qa_generation_items for insert to authenticated
with check (
    (select private.is_active_user())
    and exists (
        select 1 from public.qa_generations g
        where g.id = generation_id and g.user_id = (select auth.uid())
    )
);

drop policy qa_generation_tasks_insert on public.qa_generation_tasks;
create policy qa_generation_tasks_insert
on public.qa_generation_tasks for insert to authenticated
with check (
    (select private.is_active_user())
    and exists (
        select 1
        from public.qa_generation_items i
        join public.qa_generations g on g.id = i.generation_id
        where i.id = generation_item_id and g.user_id = (select auth.uid())
    )
);

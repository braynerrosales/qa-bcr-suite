-- QA BCR Suite v3 — Proyectos, variantes y tareas para QA
--   · QA, QA_LEAD y ADMIN agregan proyectos, variantes y tareas (BETA no).
--   · Cada uno borra lo que creó (y edita el texto de sus tareas); QA_LEAD y ADMIN, cualquier cosa.
--   · Quien creó un proyecto lo puede borrar aunque tenga variantes o tareas de otros.
--   · Solo QA_LEAD y ADMIN reordenan tareas y reactivan proyectos o variantes.
--   · Lo que ya existía queda sin autor: solo lo tocan QA_LEAD y ADMIN.
-- Pruebas: supabase/tests/proyectos_qa_test.sql.

-- ── Autor ──────────────────────────────────────────────────
alter table public.projects         add column created_by uuid references public.profiles(id) on delete set null;
alter table public.project_variants add column created_by uuid references public.profiles(id) on delete set null;
alter table public.template_tasks   add column created_by uuid references public.profiles(id) on delete set null;

-- El autor lo pone la base: no se puede enviar otro.
create or replace function private.set_created_by() returns trigger
language plpgsql set search_path = '' as $$
begin
    new.created_by = auth.uid();
    return new;
end; $$;

create trigger projects_created_by         before insert on public.projects         for each row execute function private.set_created_by();
create trigger project_variants_created_by before insert on public.project_variants for each row execute function private.set_created_by();
create trigger template_tasks_created_by   before insert on public.template_tasks   for each row execute function private.set_created_by();

-- ── Quién puede agregar ────────────────────────────────────
create or replace function private.can_edit_catalog()
returns boolean
language sql
stable
set search_path = ''
as $$
    select coalesce(private.app_role() in ('ADMIN', 'QA_LEAD', 'QA'), false);
$$;

-- ── Políticas ──────────────────────────────────────────────
drop policy projects_insert on public.projects;
drop policy projects_delete on public.projects;
create policy projects_insert on public.projects for insert to authenticated
    with check ((select private.can_edit_catalog()));
create policy projects_delete on public.projects for delete to authenticated
    using ((select private.is_lead()) or created_by = (select auth.uid()));

drop policy project_variants_insert on public.project_variants;
drop policy project_variants_delete on public.project_variants;
create policy project_variants_insert on public.project_variants for insert to authenticated
    with check ((select private.can_edit_catalog()));
create policy project_variants_delete on public.project_variants for delete to authenticated
    using ((select private.is_lead()) or created_by = (select auth.uid()));

-- Tareas: se agregan solo con add_template_task; se edita solo el texto.
drop policy template_tasks_insert on public.template_tasks;
drop policy template_tasks_update on public.template_tasks;
drop policy template_tasks_delete on public.template_tasks;
revoke insert, update on public.template_tasks from authenticated;
grant update (task) on public.template_tasks to authenticated;
create policy template_tasks_update on public.template_tasks for update to authenticated
    using ((select private.is_lead()) or created_by = (select auth.uid()))
    with check (trim(task) <> '');
create policy template_tasks_delete on public.template_tasks for delete to authenticated
    using ((select private.is_lead()) or created_by = (select auth.uid()));

-- ── Agregar una tarea al final ─────────────────────────────
create or replace function public.add_template_task(p_project_id bigint, p_variant_id bigint, p_task text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_template bigint;
    v_id bigint;
begin
    if not private.can_edit_catalog() then
        raise exception 'Sin permiso' using errcode = '42501';
    end if;
    if trim(coalesce(p_task, '')) = '' then
        raise exception 'La tarea está vacía' using errcode = '22023';
    end if;

    insert into public.templates (project_id, variant_id)
    values (p_project_id, p_variant_id)
    on conflict on constraint templates_project_variant_key
    do update set active = true, updated_at = now()
    returning id into v_template;

    -- Bloquea la plantilla: dos altas a la vez quedan una detrás de la otra.
    perform 1 from public.templates where id = v_template for update;

    insert into public.template_tasks (template_id, position, task)
    select v_template, coalesce(max(position), 0) + 1, trim(p_task)
    from public.template_tasks where template_id = v_template
    returning id into v_id;
    return v_id;
end;
$$;

-- ── Reordenar (solo QA_LEAD y ADMIN) ───────────────────────
create or replace function public.reorder_template_tasks(p_template_id bigint, p_task_ids bigint[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    if not private.is_lead() then
        raise exception 'Sin permiso' using errcode = '42501';
    end if;
    perform 1 from public.templates where id = p_template_id for update;
    if coalesce(array_length(p_task_ids, 1), 0) <> (select count(*) from public.template_tasks where template_id = p_template_id)
       or exists (select 1 from public.template_tasks t where t.template_id = p_template_id and t.id <> all (p_task_ids))
       or (select count(distinct x) from unnest(p_task_ids) x) <> array_length(p_task_ids, 1) then
        raise exception 'La lista no coincide con las tareas de la plantilla' using errcode = '22023';
    end if;

    -- Primero fuera de rango, para no chocar con unique (template_id, position).
    update public.template_tasks set position = position + 1000000 where template_id = p_template_id;
    update public.template_tasks t set position = x.ord
    from unnest(p_task_ids) with ordinality as x(id, ord)
    where t.id = x.id and t.template_id = p_template_id;
end;
$$;

revoke all on function public.add_template_task(bigint, bigint, text) from public, anon;
grant execute on function public.add_template_task(bigint, bigint, text) to authenticated;
revoke all on function public.reorder_template_tasks(bigint, bigint[]) from public, anon;
grant execute on function public.reorder_template_tasks(bigint, bigint[]) to authenticated;

-- save_template borraba y recreaba las tareas (perdía el autor): ya no se usa.
revoke execute on function public.save_template(bigint, bigint, text[]) from authenticated;

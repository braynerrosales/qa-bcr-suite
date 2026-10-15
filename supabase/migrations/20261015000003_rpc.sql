-- QA BCR Suite v3 — Fase 1.3: funciones RPC
-- Ambas son security invoker: se ejecutan con los permisos del usuario
-- que llama, así que el RLS se sigue aplicando.

-- ─────────────────────────────────────────────────────────────
-- get_app_config()
-- Devuelve la configuración con la misma forma que el DB actual de la app:
--   { people: { daily1: [...] }, rules: { daily1: {firstGroup, range, lastFixed} },
--     projects: { CODE: { color, variants: [...], templates: { variante|'': [...] } } } }
-- Así la Fase 3 cambia la fuente de datos sin tocar generateOrder() ni el
-- QA Generator. También sirve para verificar la migración contra el JSON.
-- Las listas salen en orden de creación (id); las tareas, por position.
-- ─────────────────────────────────────────────────────────────
create or replace function public.get_app_config()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
    select jsonb_build_object(
        'people', coalesce((
            select jsonb_object_agg(g.code, coalesce((
                select jsonb_agg(m.name order by m.id)
                from public.daily_members m
                where m.daily_group_id = g.id and m.active
            ), '[]'::jsonb))
            from public.daily_groups g
            where g.active
        ), '{}'::jsonb),

        'rules', coalesce((
            select jsonb_object_agg(g.code, jsonb_build_object(
                'firstGroup', coalesce((
                    select jsonb_agg(m.name order by rm.id)
                    from public.daily_rule_members rm
                    join public.daily_members m on m.id = rm.daily_member_id
                    where m.daily_group_id = g.id and m.active and rm.rule_type = 'FIRST_GROUP'
                ), '[]'::jsonb),
                'range', coalesce((
                    select r.first_range from public.daily_rules r where r.daily_group_id = g.id
                ), 1),
                'lastFixed', coalesce((
                    select jsonb_agg(m.name order by rm.id)
                    from public.daily_rule_members rm
                    join public.daily_members m on m.id = rm.daily_member_id
                    where m.daily_group_id = g.id and m.active and rm.rule_type = 'LAST_FIXED'
                ), '[]'::jsonb)
            ))
            from public.daily_groups g
            where g.active
        ), '{}'::jsonb),

        'projects', coalesce((
            select jsonb_object_agg(p.code, jsonb_build_object(
                'color', p.color,
                'variants', coalesce((
                    select jsonb_agg(v.name order by v.id)
                    from public.project_variants v
                    where v.project_id = p.id and v.active
                ), '[]'::jsonb),
                'templates', coalesce((
                    select jsonb_object_agg(coalesce(v.name, ''), coalesce((
                        select jsonb_agg(tt.task order by tt.position)
                        from public.template_tasks tt
                        where tt.template_id = t.id
                    ), '[]'::jsonb))
                    from public.templates t
                    left join public.project_variants v on v.id = t.variant_id
                    where t.project_id = p.id and t.active
                ), '{}'::jsonb)
            ))
            from public.projects p
            where p.active
        ), '{}'::jsonb)
    );
$$;

revoke execute on function public.get_app_config() from public, anon;
grant execute on function public.get_app_config() to authenticated;

-- ─────────────────────────────────────────────────────────────
-- save_template(project, variant, tasks)
-- Reemplaza la lista completa de tareas en una sola transacción, igual que
-- hoy hace el botón Guardar. p_variant_id null = plantilla sin variante.
-- El upsert bloquea la fila de la plantilla: si dos QA_LEAD guardan a la
-- vez, el segundo espera y su lista reemplaza a la del primero sin mezclarse.
-- Las líneas vacías se descartan, como en la app.
-- ─────────────────────────────────────────────────────────────
create or replace function public.save_template(
    p_project_id bigint,
    p_variant_id bigint,
    p_tasks text[]
)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_template_id bigint;
begin
    if not private.is_lead() then
        raise exception 'Solo ADMIN o QA_LEAD pueden modificar plantillas'
            using errcode = '42501';
    end if;

    insert into public.templates (project_id, variant_id)
    values (p_project_id, p_variant_id)
    on conflict on constraint templates_project_variant_key
    do update set active = true, updated_at = now()
    returning id into v_template_id;

    delete from public.template_tasks where template_id = v_template_id;

    insert into public.template_tasks (template_id, position, task)
    select v_template_id, row_number() over (order by ord), trim(task)
    from unnest(p_tasks) with ordinality as x(task, ord)
    where trim(coalesce(task, '')) <> '';

    return v_template_id;
end;
$$;

revoke execute on function public.save_template(bigint, bigint, text[]) from public, anon;
grant execute on function public.save_template(bigint, bigint, text[]) to authenticated;

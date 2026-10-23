-- QA BCR Suite v3 — QA Boss no ve el historial del Daily
--   · daily_historial() rechaza a BOSS (mismo cuerpo que 20261030000001_daily_motivos.sql).
--   · Ya no guardaba el Daily (20261029000001_rol_qa_boss.sql); ahora tampoco ve el historial.
-- Pruebas: supabase/tests/qa_boss_test.sql.

create or replace function public.daily_historial(p_grupo bigint, desde date, hasta date)
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
    -- QA Boss mira el Daily de hoy, pero no su historial.
    if not private.is_active_user() or private.app_role() = 'BOSS' then
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

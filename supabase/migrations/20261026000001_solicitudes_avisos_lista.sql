-- QA BCR Suite v3 — Lista de avisos de solicitudes (campana)
--   · solicitudes_avisos() devuelve los últimos 10 avisos de los últimos 7 días hechos
--     por otra persona: solicitud creada ('nueva') o pasada a plan enviado ('plan').
--   · sin_ver: el aviso es posterior al último visto del usuario (sin visto guardado, falso).
--   · No crea la fila de visto: eso lo hace solicitudes_novedades().
-- Requiere 20261025000001_solicitudes_avisos.sql. Pruebas: supabase/tests/solicitudes_avisos_lista_test.sql.

create or replace function public.solicitudes_avisos()
returns table (solicitud_id bigint, nombre text, tipo text, autor text, fecha timestamptz, sin_ver boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if not private.is_lead() then
        raise exception 'Sin permiso' using errcode = '42501';
    end if;
    return query
    with eventos as (
        select s.id, s.nombre, 'nueva'::text as tipo, s.created_by as quien, s.created_at as cuando
        from public.solicitudes s
        where s.created_by is not null and s.created_by <> auth.uid()
          and s.created_at > now() - interval '7 days'
        union all
        select s.id, s.nombre, 'plan'::text, s.plan_enviado_by, s.plan_enviado_at
        from public.solicitudes s
        where s.plan_enviado and s.plan_enviado_by is not null and s.plan_enviado_by <> auth.uid()
          and s.plan_enviado_at > now() - interval '7 days'
    )
    select e.id, e.nombre, e.tipo, p.full_name, e.cuando, coalesce(e.cuando > v.visto_at, false)
    from eventos e
    left join public.profiles p on p.id = e.quien
    left join public.solicitudes_vistas v on v.user_id = auth.uid()
    order by e.cuando desc, e.id desc, e.tipo
    limit 10;
end;
$$;

revoke all on function public.solicitudes_avisos() from public, anon;
grant execute on function public.solicitudes_avisos() to authenticated;

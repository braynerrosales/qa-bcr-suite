-- QA BCR Suite v3 — La campana también lista lo propio
--   · solicitudes_avisos() trae también lo que hizo el mismo usuario, con propio = true.
--   · Lo propio nunca sale sin ver: el número de la campana (solicitudes_novedades) sigue
--     contando solo lo de otros.
-- Requiere 20261026000001_solicitudes_avisos_lista.sql. Pruebas: supabase/tests/solicitudes_avisos_lista_test.sql.

-- Cambia el tipo de resultado (nueva columna propio): hay que borrarla y crearla de nuevo.
drop function if exists public.solicitudes_avisos();

create function public.solicitudes_avisos()
returns table (solicitud_id bigint, nombre text, tipo text, autor text, fecha timestamptz, sin_ver boolean, propio boolean)
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

revoke all on function public.solicitudes_avisos() from public, anon;
grant execute on function public.solicitudes_avisos() to authenticated;

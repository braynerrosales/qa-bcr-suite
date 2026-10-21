-- QA BCR Suite v3 — Avisos de solicitudes para QA Lead y Admin
--   · La base registra quién creó cada solicitud y quién y cuándo la pasó a "Plan enviado".
--   · solicitudes_vistas guarda, por usuario, cuándo abrió Solicitudes por última vez.
--   · solicitudes_novedades() cuenta lo que otros crearon o pasaron a plan enviado desde
--     esa visita; solicitudes_marcar_visto() la actualiza y devuelve la anterior.
--   · Las solicitudes de antes de esta migración no tienen autor y no generan avisos.
-- Requiere las migraciones anteriores. Pruebas: supabase/tests/solicitudes_avisos_test.sql.

alter table public.solicitudes
    add column created_by uuid references public.profiles(id) on delete set null,
    add column plan_enviado_at timestamptz,
    add column plan_enviado_by uuid references public.profiles(id) on delete set null;

-- Mismo trigger de antes (20261016000002) más el autor y el plan enviado.
-- Las columnas nuevas no están en los grant por columna: el cliente no las escribe.
-- En UPDATE no se restauran desde OLD, así ON DELETE SET NULL puede limpiarlas.
create or replace function public.solicitudes_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.updated_at = now();
    new.updated_by = auth.uid();
    if tg_op = 'INSERT' then
        new.created_at = now();
        new.created_by = auth.uid();
    end if;
    if new.plan_enviado and (tg_op = 'INSERT' or not old.plan_enviado) then
        new.plan_enviado_at = now();
        new.plan_enviado_by = auth.uid();
    end if;
    if new.cerrada then
        new.encargados = '{}';
        new.informe_semanal = false;
    end if;
    return new;
end;
$$;

-- ── Última visita a Solicitudes, por usuario ───────────────
create table public.solicitudes_vistas (
    user_id uuid primary key references public.profiles(id) on delete cascade,
    visto_at timestamptz not null
);

alter table public.solicitudes_vistas enable row level security;

create policy solicitudes_vistas_select
on public.solicitudes_vistas for select to authenticated
using (user_id = (select auth.uid()));

revoke all on public.solicitudes_vistas from anon, authenticated;
grant select on public.solicitudes_vistas to authenticated;
grant all on public.solicitudes_vistas to service_role;

-- ── Contador de novedades ──────────────────────────────────
create or replace function public.solicitudes_novedades()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_visto timestamptz;
begin
    if not private.is_lead() then
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
    if not private.is_lead() then
        raise exception 'Sin permiso' using errcode = '42501';
    end if;
    select v.visto_at into v_antes from public.solicitudes_vistas v where v.user_id = auth.uid();
    insert into public.solicitudes_vistas (user_id, visto_at)
    values (auth.uid(), now())
    on conflict (user_id) do update set visto_at = excluded.visto_at;
    return coalesce(v_antes, now());
end;
$$;

revoke all on function public.solicitudes_novedades(), public.solicitudes_marcar_visto() from public, anon;
grant execute on function public.solicitudes_novedades(), public.solicitudes_marcar_visto() to authenticated;

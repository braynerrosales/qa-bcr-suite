-- QA BCR Suite v3 — Fase 1.2: Row Level Security
--
-- Reglas:
--   · Sin sesión: nada.
--   · Usuario desactivado: solo puede leer su propio perfil (para que la app
--     le muestre "usuario desactivado").
--   · QA activo: lee la configuración, ejecuta el Daily y guarda sus generaciones.
--   · QA_LEAD: además modifica configuración y ve el historial de todos.
--   · ADMIN: además administra usuarios y ve el uso de IA.

-- ─────────────────────────────────────────────────────────────
-- Funciones de rol
-- Viven en el esquema "private", que la API de Supabase no expone,
-- así que no se pueden llamar como RPC. Son security definer para
-- leer profiles sin pasar por su RLS (evita la recursión).
-- ─────────────────────────────────────────────────────────────
create schema if not exists private;
grant usage on schema private to authenticated;

-- Rol del usuario actual, o null si no tiene sesión o está desactivado.
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
      and active;
$$;

create or replace function private.is_active_user()
returns boolean
language sql
stable
set search_path = ''
as $$
    select private.app_role() is not null;
$$;

create or replace function private.is_lead()
returns boolean
language sql
stable
set search_path = ''
as $$
    select coalesce(private.app_role() in ('ADMIN', 'QA_LEAD'), false);
$$;

create or replace function private.is_admin()
returns boolean
language sql
stable
set search_path = ''
as $$
    select coalesce(private.app_role() = 'ADMIN', false);
$$;

revoke all on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated;

-- ─────────────────────────────────────────────────────────────
-- Activar RLS en todas las tablas
-- Una tabla de public sin RLS queda abierta a cualquiera con la anon key.
-- ─────────────────────────────────────────────────────────────
alter table public.profiles            enable row level security;
alter table public.daily_groups        enable row level security;
alter table public.daily_members       enable row level security;
alter table public.daily_rules         enable row level security;
alter table public.daily_rule_members  enable row level security;
alter table public.daily_runs          enable row level security;
alter table public.daily_run_members   enable row level security;
alter table public.projects            enable row level security;
alter table public.project_variants    enable row level security;
alter table public.templates           enable row level security;
alter table public.template_tasks      enable row level security;
alter table public.qa_generations      enable row level security;
alter table public.qa_generation_items enable row level security;
alter table public.qa_generation_tasks enable row level security;
alter table public.ai_usage_log        enable row level security;

-- ─────────────────────────────────────────────────────────────
-- profiles
-- No hay política de insert (los crea el trigger) ni de delete
-- (un usuario se desactiva, no se borra).
-- ─────────────────────────────────────────────────────────────
create policy profiles_select
on public.profiles for select to authenticated
using (id = (select auth.uid()) or (select private.is_active_user()));

create policy profiles_admin_update
on public.profiles for update to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

-- ─────────────────────────────────────────────────────────────
-- Configuración: leen los activos, escriben ADMIN y QA_LEAD
-- ─────────────────────────────────────────────────────────────
do $$
declare
    t text;
begin
    foreach t in array array[
        'daily_groups', 'daily_members', 'daily_rules', 'daily_rule_members',
        'projects', 'project_variants', 'templates', 'template_tasks'
    ]
    loop
        execute format(
            'create policy %1$s_select on public.%1$I for select to authenticated
             using ((select private.is_active_user()))', t);
        execute format(
            'create policy %1$s_insert on public.%1$I for insert to authenticated
             with check ((select private.is_lead()))', t);
        execute format(
            'create policy %1$s_update on public.%1$I for update to authenticated
             using ((select private.is_lead())) with check ((select private.is_lead()))', t);
        execute format(
            'create policy %1$s_delete on public.%1$I for delete to authenticated
             using ((select private.is_lead()))', t);
    end loop;
end;
$$;

-- ─────────────────────────────────────────────────────────────
-- Historial del Daily: compartido entre activos.
-- Cualquiera puede registrar una ejecución propia y marcar "completado"
-- en sus ejecuciones. Nadie borra historial desde el cliente.
-- ─────────────────────────────────────────────────────────────
create policy daily_runs_select
on public.daily_runs for select to authenticated
using ((select private.is_active_user()));

create policy daily_runs_insert
on public.daily_runs for insert to authenticated
with check ((select private.is_active_user()) and created_by = (select auth.uid()));

create policy daily_run_members_select
on public.daily_run_members for select to authenticated
using ((select private.is_active_user()));

create policy daily_run_members_insert
on public.daily_run_members for insert to authenticated
with check (
    (select private.is_active_user())
    and exists (
        select 1 from public.daily_runs r
        where r.id = daily_run_id and r.created_by = (select auth.uid())
    )
);

create policy daily_run_members_update
on public.daily_run_members for update to authenticated
using (
    (select private.is_active_user())
    and exists (
        select 1 from public.daily_runs r
        where r.id = daily_run_id and r.created_by = (select auth.uid())
    )
);

-- Solo se puede cambiar "completed"; el resto del histórico queda fijo.
revoke update on public.daily_run_members from authenticated;
grant update (completed) on public.daily_run_members to authenticated;

-- ─────────────────────────────────────────────────────────────
-- Historial del QA Generator
-- Cada uno ve lo suyo; ADMIN y QA_LEAD ven todo. Solo se inserta.
-- ─────────────────────────────────────────────────────────────
create policy qa_generations_select
on public.qa_generations for select to authenticated
using (
    (select private.is_active_user())
    and (user_id = (select auth.uid()) or (select private.is_lead()))
);

create policy qa_generations_insert
on public.qa_generations for insert to authenticated
with check ((select private.is_active_user()) and user_id = (select auth.uid()));

-- El exists pasa por el RLS de qa_generations: si ves la generación, ves sus ítems.
create policy qa_generation_items_select
on public.qa_generation_items for select to authenticated
using (exists (select 1 from public.qa_generations g where g.id = generation_id));

create policy qa_generation_items_insert
on public.qa_generation_items for insert to authenticated
with check (exists (
    select 1 from public.qa_generations g
    where g.id = generation_id and g.user_id = (select auth.uid())
));

create policy qa_generation_tasks_select
on public.qa_generation_tasks for select to authenticated
using (exists (select 1 from public.qa_generation_items i where i.id = generation_item_id));

create policy qa_generation_tasks_insert
on public.qa_generation_tasks for insert to authenticated
with check (exists (
    select 1
    from public.qa_generation_items i
    join public.qa_generations g on g.id = i.generation_id
    where i.id = generation_item_id and g.user_id = (select auth.uid())
));

-- ─────────────────────────────────────────────────────────────
-- Uso de IA: solo lectura para ADMIN.
-- La Edge Function escribe con la service_role key, que no pasa por RLS.
-- ─────────────────────────────────────────────────────────────
create policy ai_usage_log_admin_select
on public.ai_usage_log for select to authenticated
using ((select private.is_admin()));

-- ─────────────────────────────────────────────────────────────
-- Permisos de tabla (los proyectos nuevos de Supabase no los dan por defecto)
-- ─────────────────────────────────────────────────────────────
-- anon (sin login) no toca ninguna tabla.
revoke all on table
    public.profiles,
    public.daily_groups, public.daily_members, public.daily_rules, public.daily_rule_members,
    public.daily_runs, public.daily_run_members,
    public.projects, public.project_variants, public.templates, public.template_tasks,
    public.qa_generations, public.qa_generation_items, public.qa_generation_tasks,
    public.ai_usage_log
from anon, authenticated;

-- Perfiles: cada usuario lee; solo ADMIN actualiza (RLS), y solo estas columnas.
grant select on public.profiles to authenticated;
grant update (full_name, role, active) on public.profiles to authenticated;

-- Configuración: todos leen; ADMIN y QA_LEAD escriben (RLS).
grant select, insert, update, delete on table
    public.daily_groups, public.daily_members, public.daily_rules, public.daily_rule_members,
    public.projects, public.project_variants, public.templates, public.template_tasks
to authenticated;

-- Histórico del Daily: se inserta y solo se marca "completed".
grant select, insert on public.daily_runs, public.daily_run_members to authenticated;
grant update (completed) on public.daily_run_members to authenticated;

-- Historial del QA Generator: solo lectura e inserción.
grant select, insert on public.qa_generations, public.qa_generation_items, public.qa_generation_tasks
to authenticated;

-- Uso de IA: solo lectura (RLS: solo ADMIN). Escribe la Edge Function.
grant select on public.ai_usage_log to authenticated;

-- service_role (Edge Functions, panel de Supabase) sin restricciones.
grant all on table
    public.profiles,
    public.daily_groups, public.daily_members, public.daily_rules, public.daily_rule_members,
    public.daily_runs, public.daily_run_members,
    public.projects, public.project_variants, public.templates, public.template_tasks,
    public.qa_generations, public.qa_generation_items, public.qa_generation_tasks,
    public.ai_usage_log
to service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;

-- Permisos de tabla para la API de Supabase (Data API).
-- Los proyectos nuevos de Supabase no dan permisos automáticos sobre public
-- a anon ni a authenticated: sin estos GRANT, la app recibe
-- "42501 permission denied". El RLS decide además qué filas ve cada uno.
-- Idempotente: se puede volver a ejecutar.

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

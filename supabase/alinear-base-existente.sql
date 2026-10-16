-- QA BCR Suite v3 — alinear la base existente con el diseño de la Fase 1
--
-- Pensado para una base que ya tiene las tablas creadas. Es idempotente:
-- se puede ejecutar varias veces y sobre una base vacía o con datos.
-- Todo corre en una transacción: si algo falla (por ejemplo, un dato que
-- no cumple una restricción), no se aplica nada y el error dice qué fila
-- o restricción lo impidió.
--
-- Qué hace:
--   1. Agrega las columnas que faltan (profiles.email, qa_generations.project_name/variant_name).
--   2. Ajusta NOT NULL y valores por defecto.
--   3. Agrega o reemplaza restricciones (FK con ON DELETE, unique, check).
--      Si ya existe una equivalente, la deja como está.
--   4. Triggers: updated_at y creación automática del perfil al crear un usuario.
--   5. Índices.
--   6. Borra TODAS las políticas RLS de estas tablas y crea las de la Fase 1.
--   7. Funciones get_app_config() y save_template().

begin;

-- ─────────────────────────────────────────────────────────────
-- Utilidad temporal (desaparece al cerrar la sesión)
-- Busca restricciones del mismo tipo sobre las mismas columnas:
-- si una ya tiene la definición esperada la conserva; el resto se reemplaza.
-- ─────────────────────────────────────────────────────────────
create function pg_temp.ensure_constraint(p_table regclass, p_name text, p_type "char", p_cols text[], p_def text)
returns void
language plpgsql
as $$
declare
    v_cols smallint[];
    v_keep oid;
    r record;
begin
    select array_agg(a.attnum order by a.attnum) into v_cols
    from pg_attribute a
    where a.attrelid = p_table and a.attname = any (p_cols);

    for r in
        select c.oid, c.conname, pg_get_constraintdef(c.oid) as def
        from pg_constraint c
        where c.conrelid = p_table and c.contype = p_type
          and (select array_agg(x order by x) from unnest(c.conkey) x) = v_cols
    loop
        if v_keep is null and r.def = p_def then
            v_keep := r.oid;
        else
            execute format('alter table %s drop constraint %I', p_table, r.conname);
            raise notice 'Reemplazada %.%: %', p_table, r.conname, r.def;
        end if;
    end loop;

    if v_keep is null then
        -- el nombre podría estar usado por otra restricción con otras columnas
        if exists (select 1 from pg_constraint where conrelid = p_table and conname = p_name) then
            execute format('alter table %s drop constraint %I', p_table, p_name);
        end if;
        execute format('alter table %s add constraint %I %s', p_table, p_name, p_def);
        raise notice 'Agregada %.%: %', p_table, p_name, p_def;
    end if;
end;
$$;

-- ─────────────────────────────────────────────────────────────
-- 1. Columnas
-- ─────────────────────────────────────────────────────────────
set local client_min_messages = warning;
alter table public.profiles add column if not exists id uuid;
alter table public.profiles add column if not exists full_name text;
alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists role text;
alter table public.profiles add column if not exists active boolean;
alter table public.profiles add column if not exists created_at timestamp with time zone;
alter table public.profiles add column if not exists updated_at timestamp with time zone;
alter table public.daily_groups add column if not exists code text;
alter table public.daily_groups add column if not exists name text;
alter table public.daily_groups add column if not exists active boolean;
alter table public.daily_groups add column if not exists created_at timestamp with time zone;
alter table public.daily_groups add column if not exists updated_at timestamp with time zone;
alter table public.daily_members add column if not exists daily_group_id bigint;
alter table public.daily_members add column if not exists name text;
alter table public.daily_members add column if not exists active boolean;
alter table public.daily_members add column if not exists created_at timestamp with time zone;
alter table public.daily_members add column if not exists updated_at timestamp with time zone;
alter table public.daily_rules add column if not exists daily_group_id bigint;
alter table public.daily_rules add column if not exists first_range integer;
alter table public.daily_rules add column if not exists created_at timestamp with time zone;
alter table public.daily_rules add column if not exists updated_at timestamp with time zone;
alter table public.daily_rule_members add column if not exists daily_member_id bigint;
alter table public.daily_rule_members add column if not exists rule_type text;
alter table public.daily_rule_members add column if not exists created_at timestamp with time zone;
alter table public.daily_runs add column if not exists daily_group_id bigint;
alter table public.daily_runs add column if not exists created_by uuid;
alter table public.daily_runs add column if not exists created_at timestamp with time zone;
alter table public.daily_run_members add column if not exists daily_run_id bigint;
alter table public.daily_run_members add column if not exists daily_member_id bigint;
alter table public.daily_run_members add column if not exists member_name text;
alter table public.daily_run_members add column if not exists position integer;
alter table public.daily_run_members add column if not exists completed boolean;
alter table public.daily_run_members add column if not exists created_at timestamp with time zone;
alter table public.projects add column if not exists code text;
alter table public.projects add column if not exists name text;
alter table public.projects add column if not exists color text;
alter table public.projects add column if not exists active boolean;
alter table public.projects add column if not exists created_at timestamp with time zone;
alter table public.projects add column if not exists updated_at timestamp with time zone;
alter table public.project_variants add column if not exists project_id bigint;
alter table public.project_variants add column if not exists name text;
alter table public.project_variants add column if not exists active boolean;
alter table public.project_variants add column if not exists created_at timestamp with time zone;
alter table public.project_variants add column if not exists updated_at timestamp with time zone;
alter table public.templates add column if not exists project_id bigint;
alter table public.templates add column if not exists variant_id bigint;
alter table public.templates add column if not exists active boolean;
alter table public.templates add column if not exists created_by uuid;
alter table public.templates add column if not exists created_at timestamp with time zone;
alter table public.templates add column if not exists updated_at timestamp with time zone;
alter table public.template_tasks add column if not exists template_id bigint;
alter table public.template_tasks add column if not exists position integer;
alter table public.template_tasks add column if not exists task text;
alter table public.template_tasks add column if not exists created_at timestamp with time zone;
alter table public.qa_generations add column if not exists user_id uuid;
alter table public.qa_generations add column if not exists project_id bigint;
alter table public.qa_generations add column if not exists variant_id bigint;
alter table public.qa_generations add column if not exists project_name text;
alter table public.qa_generations add column if not exists variant_name text;
alter table public.qa_generations add column if not exists created_at timestamp with time zone;
alter table public.qa_generation_items add column if not exists generation_id bigint;
alter table public.qa_generation_items add column if not exists pbi_number text;
alter table public.qa_generation_items add column if not exists pbi_text text;
alter table public.qa_generation_items add column if not exists created_at timestamp with time zone;
alter table public.qa_generation_tasks add column if not exists generation_item_id bigint;
alter table public.qa_generation_tasks add column if not exists position integer;
alter table public.qa_generation_tasks add column if not exists task text;
alter table public.qa_generation_tasks add column if not exists created_at timestamp with time zone;
alter table public.ai_usage_log add column if not exists user_id uuid;
alter table public.ai_usage_log add column if not exists action text;
alter table public.ai_usage_log add column if not exists success boolean;
alter table public.ai_usage_log add column if not exists created_at timestamp with time zone;

set local client_min_messages = notice;

-- Rellenar lo nuevo antes de exigir NOT NULL
update public.qa_generations g
set project_name = coalesce((select p.code from public.projects p where p.id = g.project_id), '(desconocido)')
where project_name is null;

update public.qa_generations g
set variant_name = (select v.name from public.project_variants v where v.id = g.variant_id)
where variant_name is null and variant_id is not null;

-- ─────────────────────────────────────────────────────────────
-- 2. NOT NULL y valores por defecto
-- ─────────────────────────────────────────────────────────────
alter table public.profiles alter column id set not null;
alter table public.profiles alter column id drop default;
alter table public.profiles alter column full_name set not null;
alter table public.profiles alter column full_name drop default;
alter table public.profiles alter column email drop not null;
alter table public.profiles alter column email drop default;
alter table public.profiles alter column role set not null;
alter table public.profiles alter column role set default 'QA'::text;
alter table public.profiles alter column active set not null;
alter table public.profiles alter column active set default true;
alter table public.profiles alter column created_at set not null;
alter table public.profiles alter column created_at set default now();
alter table public.profiles alter column updated_at set not null;
alter table public.profiles alter column updated_at set default now();
alter table public.daily_groups alter column code set not null;
alter table public.daily_groups alter column code drop default;
alter table public.daily_groups alter column name set not null;
alter table public.daily_groups alter column name drop default;
alter table public.daily_groups alter column active set not null;
alter table public.daily_groups alter column active set default true;
alter table public.daily_groups alter column created_at set not null;
alter table public.daily_groups alter column created_at set default now();
alter table public.daily_groups alter column updated_at set not null;
alter table public.daily_groups alter column updated_at set default now();
alter table public.daily_members alter column daily_group_id set not null;
alter table public.daily_members alter column daily_group_id drop default;
alter table public.daily_members alter column name set not null;
alter table public.daily_members alter column name drop default;
alter table public.daily_members alter column active set not null;
alter table public.daily_members alter column active set default true;
alter table public.daily_members alter column created_at set not null;
alter table public.daily_members alter column created_at set default now();
alter table public.daily_members alter column updated_at set not null;
alter table public.daily_members alter column updated_at set default now();
alter table public.daily_rules alter column daily_group_id set not null;
alter table public.daily_rules alter column daily_group_id drop default;
alter table public.daily_rules alter column first_range set not null;
alter table public.daily_rules alter column first_range set default 1;
alter table public.daily_rules alter column created_at set not null;
alter table public.daily_rules alter column created_at set default now();
alter table public.daily_rules alter column updated_at set not null;
alter table public.daily_rules alter column updated_at set default now();
alter table public.daily_rule_members alter column daily_member_id set not null;
alter table public.daily_rule_members alter column daily_member_id drop default;
alter table public.daily_rule_members alter column rule_type set not null;
alter table public.daily_rule_members alter column rule_type drop default;
alter table public.daily_rule_members alter column created_at set not null;
alter table public.daily_rule_members alter column created_at set default now();
alter table public.daily_runs alter column daily_group_id set not null;
alter table public.daily_runs alter column daily_group_id drop default;
alter table public.daily_runs alter column created_by drop not null;
alter table public.daily_runs alter column created_by set default auth.uid();
alter table public.daily_runs alter column created_at set not null;
alter table public.daily_runs alter column created_at set default now();
alter table public.daily_run_members alter column daily_run_id set not null;
alter table public.daily_run_members alter column daily_run_id drop default;
alter table public.daily_run_members alter column daily_member_id drop not null;
alter table public.daily_run_members alter column daily_member_id drop default;
alter table public.daily_run_members alter column member_name set not null;
alter table public.daily_run_members alter column member_name drop default;
alter table public.daily_run_members alter column position set not null;
alter table public.daily_run_members alter column position drop default;
alter table public.daily_run_members alter column completed set not null;
alter table public.daily_run_members alter column completed set default false;
alter table public.daily_run_members alter column created_at set not null;
alter table public.daily_run_members alter column created_at set default now();
alter table public.projects alter column code set not null;
alter table public.projects alter column code drop default;
alter table public.projects alter column name set not null;
alter table public.projects alter column name drop default;
alter table public.projects alter column color drop not null;
alter table public.projects alter column color drop default;
alter table public.projects alter column active set not null;
alter table public.projects alter column active set default true;
alter table public.projects alter column created_at set not null;
alter table public.projects alter column created_at set default now();
alter table public.projects alter column updated_at set not null;
alter table public.projects alter column updated_at set default now();
alter table public.project_variants alter column project_id set not null;
alter table public.project_variants alter column project_id drop default;
alter table public.project_variants alter column name set not null;
alter table public.project_variants alter column name drop default;
alter table public.project_variants alter column active set not null;
alter table public.project_variants alter column active set default true;
alter table public.project_variants alter column created_at set not null;
alter table public.project_variants alter column created_at set default now();
alter table public.project_variants alter column updated_at set not null;
alter table public.project_variants alter column updated_at set default now();
alter table public.templates alter column project_id set not null;
alter table public.templates alter column project_id drop default;
alter table public.templates alter column variant_id drop not null;
alter table public.templates alter column variant_id drop default;
alter table public.templates alter column active set not null;
alter table public.templates alter column active set default true;
alter table public.templates alter column created_by drop not null;
alter table public.templates alter column created_by set default auth.uid();
alter table public.templates alter column created_at set not null;
alter table public.templates alter column created_at set default now();
alter table public.templates alter column updated_at set not null;
alter table public.templates alter column updated_at set default now();
alter table public.template_tasks alter column template_id set not null;
alter table public.template_tasks alter column template_id drop default;
alter table public.template_tasks alter column position set not null;
alter table public.template_tasks alter column position drop default;
alter table public.template_tasks alter column task set not null;
alter table public.template_tasks alter column task drop default;
alter table public.template_tasks alter column created_at set not null;
alter table public.template_tasks alter column created_at set default now();
alter table public.qa_generations alter column user_id set not null;
alter table public.qa_generations alter column user_id set default auth.uid();
alter table public.qa_generations alter column project_id drop not null;
alter table public.qa_generations alter column project_id drop default;
alter table public.qa_generations alter column variant_id drop not null;
alter table public.qa_generations alter column variant_id drop default;
alter table public.qa_generations alter column project_name set not null;
alter table public.qa_generations alter column project_name drop default;
alter table public.qa_generations alter column variant_name drop not null;
alter table public.qa_generations alter column variant_name drop default;
alter table public.qa_generations alter column created_at set not null;
alter table public.qa_generations alter column created_at set default now();
alter table public.qa_generation_items alter column generation_id set not null;
alter table public.qa_generation_items alter column generation_id drop default;
alter table public.qa_generation_items alter column pbi_number drop not null;
alter table public.qa_generation_items alter column pbi_number drop default;
alter table public.qa_generation_items alter column pbi_text set not null;
alter table public.qa_generation_items alter column pbi_text drop default;
alter table public.qa_generation_items alter column created_at set not null;
alter table public.qa_generation_items alter column created_at set default now();
alter table public.qa_generation_tasks alter column generation_item_id set not null;
alter table public.qa_generation_tasks alter column generation_item_id drop default;
alter table public.qa_generation_tasks alter column position set not null;
alter table public.qa_generation_tasks alter column position drop default;
alter table public.qa_generation_tasks alter column task set not null;
alter table public.qa_generation_tasks alter column task drop default;
alter table public.qa_generation_tasks alter column created_at set not null;
alter table public.qa_generation_tasks alter column created_at set default now();
alter table public.ai_usage_log alter column user_id drop not null;
alter table public.ai_usage_log alter column user_id drop default;
alter table public.ai_usage_log alter column action set not null;
alter table public.ai_usage_log alter column action drop default;
alter table public.ai_usage_log alter column success set not null;
alter table public.ai_usage_log alter column success drop default;
alter table public.ai_usage_log alter column created_at set not null;
alter table public.ai_usage_log alter column created_at set default now();

-- ─────────────────────────────────────────────────────────────
-- 3. Restricciones
-- ─────────────────────────────────────────────────────────────
-- La FK de templates pasa a ser compuesta (variant_id, project_id):
-- se quita una FK simple sobre variant_id si existe.
do $$
declare r record;
begin
    for r in
        select conname from pg_constraint
        where conrelid = 'public.templates'::regclass and contype = 'f'
          and conkey = array[(select attnum from pg_attribute
                              where attrelid = 'public.templates'::regclass and attname = 'variant_id')]
    loop
        execute format('alter table public.templates drop constraint %I', r.conname);
        raise notice 'Reemplazada templates.%: FK simple sobre variant_id', r.conname;
    end loop;
end;
$$;

do $$
begin
    perform pg_temp.ensure_constraint('public.daily_groups', 'daily_groups_code_key', 'u', array['code'], 'UNIQUE (code)');
    perform pg_temp.ensure_constraint('public.daily_members', 'daily_members_daily_group_id_name_key', 'u', array['daily_group_id','name'], 'UNIQUE (daily_group_id, name)');
    perform pg_temp.ensure_constraint('public.daily_rules', 'daily_rules_daily_group_id_key', 'u', array['daily_group_id'], 'UNIQUE (daily_group_id)');
    perform pg_temp.ensure_constraint('public.daily_rule_members', 'daily_rule_members_daily_member_id_key', 'u', array['daily_member_id'], 'UNIQUE (daily_member_id)');
    perform pg_temp.ensure_constraint('public.daily_run_members', 'daily_run_members_daily_run_id_position_key', 'u', array['daily_run_id','position'], 'UNIQUE (daily_run_id, "position")');
    perform pg_temp.ensure_constraint('public.projects', 'projects_code_key', 'u', array['code'], 'UNIQUE (code)');
    perform pg_temp.ensure_constraint('public.project_variants', 'project_variants_id_project_id_key', 'u', array['id','project_id'], 'UNIQUE (id, project_id)');
    perform pg_temp.ensure_constraint('public.project_variants', 'project_variants_project_id_name_key', 'u', array['project_id','name'], 'UNIQUE (project_id, name)');
    perform pg_temp.ensure_constraint('public.templates', 'templates_project_variant_key', 'u', array['project_id','variant_id'], 'UNIQUE NULLS NOT DISTINCT (project_id, variant_id)');
    perform pg_temp.ensure_constraint('public.template_tasks', 'template_tasks_template_id_position_key', 'u', array['template_id','position'], 'UNIQUE (template_id, "position")');
    perform pg_temp.ensure_constraint('public.profiles', 'profiles_role_check', 'c', array['role'], 'CHECK ((role = ANY (ARRAY[''ADMIN''::text, ''QA_LEAD''::text, ''QA''::text, ''BETA''::text])))');
    perform pg_temp.ensure_constraint('public.daily_members', 'daily_members_name_check', 'c', array['name'], 'CHECK ((TRIM(BOTH FROM name) <> ''''::text))');
    perform pg_temp.ensure_constraint('public.daily_rules', 'daily_rules_first_range_check', 'c', array['first_range'], 'CHECK ((first_range >= 0))');
    perform pg_temp.ensure_constraint('public.daily_rule_members', 'daily_rule_members_rule_type_check', 'c', array['rule_type'], 'CHECK ((rule_type = ANY (ARRAY[''FIRST_GROUP''::text, ''LAST_FIXED''::text])))');
    perform pg_temp.ensure_constraint('public.daily_run_members', 'daily_run_members_position_check', 'c', array['position'], 'CHECK (("position" >= 1))');
    perform pg_temp.ensure_constraint('public.projects', 'projects_code_check', 'c', array['code'], 'CHECK ((TRIM(BOTH FROM code) <> ''''::text))');
    perform pg_temp.ensure_constraint('public.projects', 'projects_color_check', 'c', array['color'], 'CHECK ((color ~ ''^#[0-9a-fA-F]{6}$''::text))');
    perform pg_temp.ensure_constraint('public.project_variants', 'project_variants_name_check', 'c', array['name'], 'CHECK ((TRIM(BOTH FROM name) <> ''''::text))');
    perform pg_temp.ensure_constraint('public.template_tasks', 'template_tasks_position_check', 'c', array['position'], 'CHECK (("position" >= 1))');
    perform pg_temp.ensure_constraint('public.template_tasks', 'template_tasks_task_check', 'c', array['task'], 'CHECK ((TRIM(BOTH FROM task) <> ''''::text))');
    perform pg_temp.ensure_constraint('public.qa_generation_tasks', 'qa_generation_tasks_position_check', 'c', array['position'], 'CHECK (("position" >= 1))');
    perform pg_temp.ensure_constraint('public.ai_usage_log', 'ai_usage_log_action_check', 'c', array['action'], 'CHECK ((action = ANY (ARRAY[''extract_pbis''::text, ''generate_tasks''::text])))');
    perform pg_temp.ensure_constraint('public.profiles', 'profiles_id_fkey', 'f', array['id'], 'FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE');
    perform pg_temp.ensure_constraint('public.daily_members', 'daily_members_daily_group_id_fkey', 'f', array['daily_group_id'], 'FOREIGN KEY (daily_group_id) REFERENCES daily_groups(id) ON DELETE CASCADE');
    perform pg_temp.ensure_constraint('public.daily_rules', 'daily_rules_daily_group_id_fkey', 'f', array['daily_group_id'], 'FOREIGN KEY (daily_group_id) REFERENCES daily_groups(id) ON DELETE CASCADE');
    perform pg_temp.ensure_constraint('public.daily_rule_members', 'daily_rule_members_daily_member_id_fkey', 'f', array['daily_member_id'], 'FOREIGN KEY (daily_member_id) REFERENCES daily_members(id) ON DELETE CASCADE');
    perform pg_temp.ensure_constraint('public.daily_runs', 'daily_runs_created_by_fkey', 'f', array['created_by'], 'FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL');
    perform pg_temp.ensure_constraint('public.daily_runs', 'daily_runs_daily_group_id_fkey', 'f', array['daily_group_id'], 'FOREIGN KEY (daily_group_id) REFERENCES daily_groups(id)');
    perform pg_temp.ensure_constraint('public.daily_run_members', 'daily_run_members_daily_member_id_fkey', 'f', array['daily_member_id'], 'FOREIGN KEY (daily_member_id) REFERENCES daily_members(id) ON DELETE SET NULL');
    perform pg_temp.ensure_constraint('public.daily_run_members', 'daily_run_members_daily_run_id_fkey', 'f', array['daily_run_id'], 'FOREIGN KEY (daily_run_id) REFERENCES daily_runs(id) ON DELETE CASCADE');
    perform pg_temp.ensure_constraint('public.project_variants', 'project_variants_project_id_fkey', 'f', array['project_id'], 'FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE');
    perform pg_temp.ensure_constraint('public.templates', 'templates_created_by_fkey', 'f', array['created_by'], 'FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL');
    perform pg_temp.ensure_constraint('public.templates', 'templates_project_id_fkey', 'f', array['project_id'], 'FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE');
    perform pg_temp.ensure_constraint('public.templates', 'templates_variant_fkey', 'f', array['variant_id','project_id'], 'FOREIGN KEY (variant_id, project_id) REFERENCES project_variants(id, project_id) ON DELETE CASCADE');
    perform pg_temp.ensure_constraint('public.template_tasks', 'template_tasks_template_id_fkey', 'f', array['template_id'], 'FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE');
    perform pg_temp.ensure_constraint('public.qa_generations', 'qa_generations_project_id_fkey', 'f', array['project_id'], 'FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL');
    perform pg_temp.ensure_constraint('public.qa_generations', 'qa_generations_user_id_fkey', 'f', array['user_id'], 'FOREIGN KEY (user_id) REFERENCES auth.users(id)');
    perform pg_temp.ensure_constraint('public.qa_generations', 'qa_generations_variant_id_fkey', 'f', array['variant_id'], 'FOREIGN KEY (variant_id) REFERENCES project_variants(id) ON DELETE SET NULL');
    perform pg_temp.ensure_constraint('public.qa_generation_items', 'qa_generation_items_generation_id_fkey', 'f', array['generation_id'], 'FOREIGN KEY (generation_id) REFERENCES qa_generations(id) ON DELETE CASCADE');
    perform pg_temp.ensure_constraint('public.qa_generation_tasks', 'qa_generation_tasks_generation_item_id_fkey', 'f', array['generation_item_id'], 'FOREIGN KEY (generation_item_id) REFERENCES qa_generation_items(id) ON DELETE CASCADE');
    perform pg_temp.ensure_constraint('public.ai_usage_log', 'ai_usage_log_user_id_fkey', 'f', array['user_id'], 'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL');
end;
$$;

-- ─────────────────────────────────────────────────────────────
-- 4. Triggers
-- ─────────────────────────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.profiles (id, full_name, email)
    values (
        new.id,
        coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), new.email),
        new.email
    );
    return new;
end;
$$;

-- Si ya había otro trigger que crea perfiles al registrar un usuario,
-- se quita para que no inserte dos veces el mismo perfil.
do $$
declare r record;
begin
    for r in
        select t.tgname
        from pg_trigger t
        join pg_proc p on p.oid = t.tgfoid
        where t.tgrelid = 'auth.users'::regclass
          and not t.tgisinternal
          and t.tgname <> 'on_auth_user_created'
          and p.prosrc ilike '%profiles%'
    loop
        execute format('drop trigger %I on auth.users', r.tgname);
        raise notice 'Quitado trigger previo en auth.users: %', r.tgname;
    end loop;
end;
$$;

create or replace trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- Usuarios que ya existían sin perfil, y correos de los perfiles existentes
insert into public.profiles (id, full_name, email)
select u.id, coalesce(nullif(trim(u.raw_user_meta_data ->> 'full_name'), ''), u.email), u.email
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id);

update public.profiles p
set email = u.email
from auth.users u
where u.id = p.id and p.email is distinct from u.email;

create or replace trigger profiles_updated_at before update on public.profiles for each row execute function public.set_updated_at();
create or replace trigger daily_groups_updated_at before update on public.daily_groups for each row execute function public.set_updated_at();
create or replace trigger daily_members_updated_at before update on public.daily_members for each row execute function public.set_updated_at();
create or replace trigger daily_rules_updated_at before update on public.daily_rules for each row execute function public.set_updated_at();
create or replace trigger projects_updated_at before update on public.projects for each row execute function public.set_updated_at();
create or replace trigger project_variants_updated_at before update on public.project_variants for each row execute function public.set_updated_at();
create or replace trigger templates_updated_at before update on public.templates for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────
-- 5. Índices
-- ─────────────────────────────────────────────────────────────
set local client_min_messages = warning;
create index if not exists ai_usage_log_user_idx ON public.ai_usage_log USING btree (user_id, created_at DESC);
create index if not exists daily_run_members_member_idx ON public.daily_run_members USING btree (daily_member_id);
create index if not exists daily_runs_group_idx ON public.daily_runs USING btree (daily_group_id, created_at DESC);
create index if not exists qa_generation_items_generation_idx ON public.qa_generation_items USING btree (generation_id);
create index if not exists qa_generation_items_pbi_idx ON public.qa_generation_items USING btree (pbi_number);
create index if not exists qa_generation_tasks_item_idx ON public.qa_generation_tasks USING btree (generation_item_id);
create index if not exists qa_generations_project_idx ON public.qa_generations USING btree (project_id);
create index if not exists qa_generations_user_idx ON public.qa_generations USING btree (user_id, created_at DESC);
create index if not exists qa_generations_variant_idx ON public.qa_generations USING btree (variant_id);
create index if not exists templates_variant_idx ON public.templates USING btree (variant_id, project_id);
set local client_min_messages = notice;

-- ─────────────────────────────────────────────────────────────
-- 6. RLS: se borran las políticas existentes y se crean las de la Fase 1
-- ─────────────────────────────────────────────────────────────
do $$
declare r record;
begin
    for r in
        select schemaname, tablename, policyname
        from pg_policies
        where schemaname = 'public'
          and tablename = any (array['profiles', 'daily_groups', 'daily_members', 'daily_rules', 'daily_rule_members', 'daily_runs', 'daily_run_members', 'projects', 'project_variants', 'templates', 'template_tasks', 'qa_generations', 'qa_generation_items', 'qa_generation_tasks', 'ai_usage_log'])
    loop
        execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
        raise notice 'Quitada política %.%', r.tablename, r.policyname;
    end loop;
end;
$$;

-- La función del plan técnico vivía en public y se podía llamar como RPC.
drop function if exists public.current_user_role();

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
-- 7. Funciones RPC
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

commit;

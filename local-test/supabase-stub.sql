-- Imitación mínima de Supabase para probar en un Postgres local.
-- Roles, auth.users, auth.uid() y los privilegios por defecto de public.
do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema auth;
create table auth.users (
    id uuid primary key,
    email text,
    raw_user_meta_data jsonb,
    encrypted_password text,
    last_sign_in_at timestamptz
);
create function auth.uid() returns uuid language sql stable as $$
    select coalesce(
        nullif(current_setting('request.jwt.claim.sub', true), ''),
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant references on auth.users to postgres;

grant usage on schema public to anon, authenticated, service_role;
-- Como un proyecto nuevo de Supabase: sin permisos automáticos sobre las tablas
-- de public (las migraciones dan los GRANT explícitos). Las funciones sí.
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

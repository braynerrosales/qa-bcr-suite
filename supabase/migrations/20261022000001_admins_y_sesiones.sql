-- QA BCR Suite v3 — Siempre queda un ADMIN activo, y una contraseña nueva cierra las sesiones
--   · La base rechaza cualquier cambio que deje sin ADMIN activo: quitarle el
--     rol o desactivar al último ADMIN, o borrar su perfil. Vale desde la app,
--     la API o el SQL Editor. Sin esto, dos ADMIN que se quitan el rol uno al
--     otro dejaban la app sin nadie que la administre.
--   · admin_cerrar_sesiones(): la usa la Edge Function admin-create-user al dar
--     una contraseña temporal nueva, para que nadie siga dentro con la sesión
--     vieja. Solo la puede llamar la service_role.
-- Requiere 20261021000001_conservar_horas_al_eliminar.sql.

create or replace function public.profiles_mantener_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    -- Solo importa si la fila era un ADMIN activo y deja de serlo.
    if not (old.role = 'ADMIN' and old.active) then
        return coalesce(new, old);
    end if;
    if tg_op = 'UPDATE' and new.role = 'ADMIN' and new.active then
        return new;
    end if;
    -- Dos cambios a la vez (dos ADMIN que se quitan el rol) se hacen en fila,
    -- así el segundo ve el resultado del primero.
    perform pg_advisory_xact_lock(hashtext('qa_bcr_profiles_admin'));
    if not exists (
        select 1 from public.profiles p
        where p.id <> old.id and p.role = 'ADMIN' and p.active
    ) then
        raise exception 'Tiene que quedar al menos un ADMIN activo.' using errcode = '23514';
    end if;
    return coalesce(new, old);
end;
$$;

create trigger profiles_mantener_admin
before update of role, active or delete on public.profiles
for each row execute function public.profiles_mantener_admin();

revoke all on function public.profiles_mantener_admin() from public, anon, authenticated;

-- Cierra todas las sesiones de un usuario. Borrar la sesión invalida su refresh
-- token: el navegador deja de poder renovarla y el token de acceso que ya tenía
-- vence solo (dura como máximo lo que diga "JWT expiry", 1 hora por defecto).
create or replace function public.admin_cerrar_sesiones(p_user uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
    n integer;
begin
    delete from auth.sessions s where s.user_id = p_user;
    get diagnostics n = row_count;
    return n;
end;
$$;

revoke all on function public.admin_cerrar_sesiones(uuid) from public, anon, authenticated;
grant execute on function public.admin_cerrar_sesiones(uuid) to service_role;

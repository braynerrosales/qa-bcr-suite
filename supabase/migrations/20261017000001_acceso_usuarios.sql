-- QA BCR Suite v3 — Primer ingreso y cambio de la contraseña temporal
-- La base registra (a partir de Supabase Auth, no de lo que diga el navegador):
--   · first_sign_in_at / last_sign_in_at: primer y último ingreso.
--   · password_changed_at: cuándo la persona cambió su contraseña.
--   · must_change_password: true para todo usuario nuevo; se apaga solo
--     cuando la persona cambia la contraseña después de haber entrado.
-- La app usa must_change_password para pedir el cambio al entrar, y el ADMIN
-- ve el estado de cada usuario. Requiere 20261015000001 y 20261015000002.

alter table public.profiles
    add column first_sign_in_at timestamptz,
    add column last_sign_in_at timestamptz,
    add column password_changed_at timestamptz,
    add column must_change_password boolean not null default false;

-- Usuarios que ya existían: se copia su último ingreso. No se les pide cambiar
-- la contraseña (default false); los nuevos sí (handle_new_user).
update public.profiles p
set last_sign_in_at = u.last_sign_in_at
from auth.users u
where u.id = p.id;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.profiles (id, full_name, email, must_change_password)
    values (
        new.id,
        coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), new.email),
        new.email,
        true
    );
    return new;
end;
$$;

create or replace function public.handle_user_access()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if new.last_sign_in_at is distinct from old.last_sign_in_at and new.last_sign_in_at is not null then
        update public.profiles
        set first_sign_in_at = coalesce(first_sign_in_at, new.last_sign_in_at),
            last_sign_in_at = new.last_sign_in_at
        where id = new.id;
    end if;
    -- Solo cuenta si ya había entrado: así un cambio hecho al crear el
    -- usuario (o por un admin antes del primer ingreso) no apaga el aviso.
    if new.encrypted_password is distinct from old.encrypted_password and new.last_sign_in_at is not null then
        update public.profiles
        set password_changed_at = now(),
            must_change_password = false
        where id = new.id;
    end if;
    return new;
end;
$$;

create trigger on_auth_user_access
after update of last_sign_in_at, encrypted_password on auth.users
for each row execute function public.handle_user_access();

-- Cada usuario sigue leyendo los perfiles (nombres para la app), pero las
-- fechas de ingreso solo las ve un ADMIN, con admin_user_access().
revoke select on public.profiles from authenticated;
grant select (id, full_name, email, role, active, created_at, updated_at, must_change_password)
    on public.profiles to authenticated;

create or replace function public.admin_user_access()
returns table (
    id uuid,
    first_sign_in_at timestamptz,
    last_sign_in_at timestamptz,
    password_changed_at timestamptz,
    must_change_password boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if not private.is_admin() then
        raise exception 'Solo un ADMIN puede ver los ingresos' using errcode = '42501';
    end if;
    return query
        select p.id, p.first_sign_in_at, p.last_sign_in_at, p.password_changed_at, p.must_change_password
        from public.profiles p;
end;
$$;

revoke all on function public.admin_user_access() from public, anon;
grant execute on function public.admin_user_access() to authenticated;
revoke all on function public.handle_user_access() from public, anon, authenticated;

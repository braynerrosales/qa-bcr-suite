-- QA BCR Suite v3 — pruebas de "siempre queda un ADMIN activo" y de cerrar sesiones
-- Ejecutar en el SQL Editor de Supabase después de 20261022000001_admins_y_sesiones.sql.
-- Termina en ROLLBACK: no deja nada guardado. Si algo falla, aborta con "FALLO ...";
-- si todo pasa, el SQL Editor muestra "Success" (los "OK" son notices y no se ven ahí).

begin;

insert into auth.users (id, email, raw_user_meta_data) values
    ('00000000-0000-0000-0000-0000000000a5', 'adm-uno@test.local', '{"full_name":"Adm Uno"}'),
    ('00000000-0000-0000-0000-0000000000a6', 'adm-dos@test.local', '{"full_name":"Adm Dos"}');
-- Los perfiles nacen inactivos y con la contraseña temporal (20261024000001_seguridad.sql): se dejan listos.
update public.profiles set active = true, must_change_password = false
where id in (
    '00000000-0000-0000-0000-0000000000a5',
    '00000000-0000-0000-0000-0000000000a6'
);

-- Para probar el caso del último ADMIN, durante la prueba solo quedan estos dos.
-- (Los ADMIN reales se vuelven a activar con el ROLLBACK.)
update public.profiles set role = 'ADMIN'
where id in ('00000000-0000-0000-0000-0000000000a5', '00000000-0000-0000-0000-0000000000a6');
update public.profiles set active = false
where role = 'ADMIN'
  and id not in ('00000000-0000-0000-0000-0000000000a5', '00000000-0000-0000-0000-0000000000a6');

-- ── Como ADMIN (Adm Uno), por la API ─────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a5","role":"authenticated"}', true);
do $$
begin
    update public.profiles set role = 'QA' where id = '00000000-0000-0000-0000-0000000000a6';
    if not found then raise exception 'FALLO: el ADMIN no pudo quitarle el rol a otro ADMIN'; end if;
    raise notice 'OK: con otro ADMIN activo, se le puede quitar el rol';

    begin
        update public.profiles set role = 'QA' where id = '00000000-0000-0000-0000-0000000000a5';
        raise exception 'FALLO: el último ADMIN se quitó el rol';
    exception when check_violation then
        raise notice 'OK: el último ADMIN no puede quitarse el rol';
    end;

    begin
        update public.profiles set active = false where id = '00000000-0000-0000-0000-0000000000a5';
        raise exception 'FALLO: se desactivó al último ADMIN';
    exception when check_violation then
        raise notice 'OK: no se puede desactivar al último ADMIN';
    end;

    update public.profiles set full_name = 'Adm Uno Renombrado' where id = '00000000-0000-0000-0000-0000000000a5';
    raise notice 'OK: el último ADMIN puede cambiar otros datos';

    begin
        perform public.admin_cerrar_sesiones('00000000-0000-0000-0000-0000000000a6');
        raise exception 'FALLO: un usuario de la app pudo llamar a admin_cerrar_sesiones';
    exception when insufficient_privilege then
        raise notice 'OK: admin_cerrar_sesiones no se puede llamar desde la app';
    end;
end $$;
reset role;

-- ── Como dueño (SQL Editor / Edge Function) ──────────────────
do $$
declare n int;
begin
    begin
        delete from auth.users where id = '00000000-0000-0000-0000-0000000000a5';
        raise exception 'FALLO: se eliminó al último ADMIN';
    exception when check_violation then
        raise notice 'OK: no se puede eliminar al último ADMIN';
    end;

    insert into auth.sessions (id, user_id, created_at, updated_at)
    values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000a6', now(), now()),
           (gen_random_uuid(), '00000000-0000-0000-0000-0000000000a6', now(), now());
    n := public.admin_cerrar_sesiones('00000000-0000-0000-0000-0000000000a6');
    if n <> 2 or exists (select 1 from auth.sessions where user_id = '00000000-0000-0000-0000-0000000000a6') then
        raise exception 'FALLO: admin_cerrar_sesiones cerró % sesiones', n;
    end if;
    raise notice 'OK: admin_cerrar_sesiones cierra todas las sesiones del usuario';
end $$;

rollback;

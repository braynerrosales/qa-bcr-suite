-- QA BCR Suite v3 — pruebas de primer ingreso y cambio de contraseña
-- Ejecutar en el SQL Editor de Supabase después de 20261017000001_acceso_usuarios.sql.
-- Termina en ROLLBACK: no deja nada guardado. Imprime "OK ..." o aborta con "FALLO ...".

begin;

insert into auth.users (id, email, raw_user_meta_data, encrypted_password) values
    ('00000000-0000-0000-0000-0000000000a2', 'acc-admin@test.local', '{"full_name":"Acc Admin"}', 'x'),
    ('00000000-0000-0000-0000-0000000000c2', 'acc-qa@test.local',    '{"full_name":"Acc QA"}',    'temporal');
-- Los perfiles nacen inactivos y con la contraseña temporal (20261024000001_seguridad.sql): se dejan listos.
update public.profiles set active = true where id in ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000c2');
update public.profiles set must_change_password = false where id = '00000000-0000-0000-0000-0000000000a2';
update public.profiles set role = 'ADMIN' where id = '00000000-0000-0000-0000-0000000000a2';

do $$
declare p record;
begin
    select * into p from public.profiles where id = '00000000-0000-0000-0000-0000000000c2';
    if not p.must_change_password or p.last_sign_in_at is not null then
        raise exception 'FALLO: un usuario nuevo debe quedar pendiente de cambiar la contraseña';
    end if;
    raise notice 'OK: usuario nuevo queda "nunca entró" y debe cambiar la contraseña';

    -- Cambio antes del primer ingreso (p. ej. al crearlo): no cuenta.
    update auth.users set encrypted_password = 'otra-temporal' where id = '00000000-0000-0000-0000-0000000000c2';
    select * into p from public.profiles where id = '00000000-0000-0000-0000-0000000000c2';
    if not p.must_change_password then raise exception 'FALLO: un cambio antes de entrar apagó el aviso'; end if;
    raise notice 'OK: un cambio de contraseña antes del primer ingreso no cuenta';

    update auth.users set last_sign_in_at = now() - interval '1 hour' where id = '00000000-0000-0000-0000-0000000000c2';
    update auth.users set last_sign_in_at = now() where id = '00000000-0000-0000-0000-0000000000c2';
    select * into p from public.profiles where id = '00000000-0000-0000-0000-0000000000c2';
    if p.first_sign_in_at is null or p.first_sign_in_at >= p.last_sign_in_at then
        raise exception 'FALLO: primer/último ingreso mal registrados (% / %)', p.first_sign_in_at, p.last_sign_in_at;
    end if;
    if not p.must_change_password then raise exception 'FALLO: entrar no debe apagar el aviso'; end if;
    raise notice 'OK: se registra el primer y el último ingreso';

    update auth.users set encrypted_password = 'definitiva' where id = '00000000-0000-0000-0000-0000000000c2';
    select * into p from public.profiles where id = '00000000-0000-0000-0000-0000000000c2';
    if p.must_change_password or p.password_changed_at is null then
        raise exception 'FALLO: cambiar la contraseña después de entrar no se registró';
    end if;
    raise notice 'OK: cambiar la contraseña después de entrar apaga el aviso y guarda la fecha';
end $$ language plpgsql;

-- ── QA: ve su aviso, pero no las fechas de nadie ───────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c2","role":"authenticated"}', true);
do $$
declare b boolean;
begin
    select must_change_password into b from public.profiles where id = '00000000-0000-0000-0000-0000000000c2';
    raise notice 'OK: cada usuario lee su must_change_password';

    begin
        perform last_sign_in_at from public.profiles limit 1;
        raise exception 'FALLO: un QA pudo leer last_sign_in_at';
    exception when insufficient_privilege then
        raise notice 'OK: un QA no lee las fechas de ingreso';
    end;

    begin
        perform * from public.admin_user_access();
        raise exception 'FALLO: un QA pudo llamar admin_user_access';
    exception when insufficient_privilege then
        raise notice 'OK: admin_user_access rechaza a un QA';
    end;

    begin
        update public.profiles set must_change_password = false where id = '00000000-0000-0000-0000-0000000000c2';
        raise exception 'FALLO: el usuario pudo apagar su propio aviso';
    exception when insufficient_privilege then
        raise notice 'OK: nadie apaga el aviso desde la app; solo cambiando la contraseña';
    end;
end $$ language plpgsql;

-- ── ADMIN: ve el estado de todos ───────────────────────────
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
do $$
declare r record;
begin
    select * into r from public.admin_user_access() where id = '00000000-0000-0000-0000-0000000000c2';
    if r.first_sign_in_at is null or r.password_changed_at is null or r.must_change_password then
        raise exception 'FALLO: el ADMIN no ve el estado correcto';
    end if;
    raise notice 'OK: el ADMIN ve primer ingreso y cambio de contraseña';
end $$ language plpgsql;

reset role;
rollback;

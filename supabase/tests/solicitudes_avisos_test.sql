-- QA BCR Suite v3 — pruebas de los avisos de solicitudes
-- Ejecutar en el SQL Editor de Supabase después de 20261025000001_solicitudes_avisos.sql.
-- Corre dentro de una transacción que termina en ROLLBACK: no deja nada guardado.
-- Cada prueba imprime "OK ..." o aborta con "FALLO ...".
-- Dentro de una transacción now() no avanza: para simular "antes" se atrasan
-- visto_at o plan_enviado_at como superusuario (reset role).

begin;

insert into auth.users (id, email, raw_user_meta_data) values
    ('00000000-0000-0000-0000-0000000000a1', 'av-admin@test.local',    '{"full_name":"Av Admin"}'),
    ('00000000-0000-0000-0000-0000000000b1', 'av-lead@test.local',     '{"full_name":"Av Lead"}'),
    ('00000000-0000-0000-0000-0000000000c1', 'av-qa@test.local',       '{"full_name":"Av QA"}'),
    ('00000000-0000-0000-0000-0000000000d1', 'av-inactivo@test.local', '{"full_name":"Av Inactivo"}'),
    ('00000000-0000-0000-0000-0000000000e1', 'av-lead2@test.local',    '{"full_name":"Av Lead Dos"}');
update public.profiles set active = true, must_change_password = false
where id in (
    '00000000-0000-0000-0000-0000000000a1',
    '00000000-0000-0000-0000-0000000000b1',
    '00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000000d1',
    '00000000-0000-0000-0000-0000000000e1'
);
update public.profiles set role = 'ADMIN'   where id = '00000000-0000-0000-0000-0000000000a1';
update public.profiles set role = 'QA_LEAD' where id in ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e1');
update public.profiles set role = 'QA_LEAD', active = false where id = '00000000-0000-0000-0000-0000000000d1';

-- Una solicitud de antes de la migración: sin autor.
insert into public.solicitudes (nombre) values ('Solicitud P9_100 Vieja');
update public.solicitudes set created_by = null where nombre = 'Solicitud P9_100 Vieja';

-- ── El trigger registra autor y plan enviado ───────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
do $$
declare r record;
begin
    insert into public.solicitudes (nombre) values ('Solicitud P9_101 Lead');
    select * into r from public.solicitudes where nombre = 'Solicitud P9_101 Lead';
    if r.created_by is distinct from '00000000-0000-0000-0000-0000000000b1' then
        raise exception 'FALLO: created_by no es el QA_LEAD (%)', r.created_by;
    end if;
    if r.plan_enviado_at is not null or r.plan_enviado_by is not null then
        raise exception 'FALLO: sin plan enviado quedó plan_enviado_* completado';
    end if;
    raise notice 'OK: al crear queda el autor';

    insert into public.solicitudes (nombre, plan_enviado) values ('Solicitud P9_102 Con plan', true);
    select * into r from public.solicitudes where nombre = 'Solicitud P9_102 Con plan';
    if r.plan_enviado_at is null or r.plan_enviado_by is distinct from '00000000-0000-0000-0000-0000000000b1' then
        raise exception 'FALLO: nacer con plan enviado no completó plan_enviado_*';
    end if;
    raise notice 'OK: si nace con plan enviado también queda quién y cuándo';

    update public.solicitudes set plan_enviado = true where nombre = 'Solicitud P9_101 Lead';
    select * into r from public.solicitudes where nombre = 'Solicitud P9_101 Lead';
    if r.plan_enviado_at is null or r.plan_enviado_by is distinct from '00000000-0000-0000-0000-0000000000b1' then
        raise exception 'FALLO: pasar a plan enviado no completó plan_enviado_*';
    end if;
    update public.solicitudes set plan_enviado = false where nombre = 'Solicitud P9_101 Lead';
    select * into r from public.solicitudes where nombre = 'Solicitud P9_101 Lead';
    if r.plan_enviado_by is distinct from '00000000-0000-0000-0000-0000000000b1' then
        raise exception 'FALLO: destildar plan enviado borró plan_enviado_by';
    end if;
    raise notice 'OK: pasar a plan enviado registra quién y cuándo; destildarlo no lo borra';

    begin
        update public.solicitudes set created_by = null where nombre = 'Solicitud P9_101 Lead';
        raise exception 'FALLO: el cliente pudo escribir created_by';
    exception when insufficient_privilege then
        raise notice 'OK: created_by no se puede escribir desde el cliente';
    end;
    begin
        update public.solicitudes set plan_enviado_by = null where nombre = 'Solicitud P9_101 Lead';
        raise exception 'FALLO: el cliente pudo escribir plan_enviado_by';
    exception when insufficient_privilege then
        raise notice 'OK: plan_enviado_* no se puede escribir desde el cliente';
    end;
    begin
        insert into public.solicitudes_vistas (user_id, visto_at) values ('00000000-0000-0000-0000-0000000000b1', now() - interval '1 year');
        raise exception 'FALLO: el cliente pudo escribir solicitudes_vistas';
    exception when insufficient_privilege then
        raise notice 'OK: solicitudes_vistas no se escribe directo';
    end;
end $$ language plpgsql;

-- Volver a tildar (otra persona) actualiza quién y cuándo.
reset role;
update public.solicitudes set plan_enviado_at = now() - interval '1 day' where nombre = 'Solicitud P9_101 Lead';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"authenticated"}', true);
do $$
declare r record;
begin
    update public.solicitudes set plan_enviado = true where nombre = 'Solicitud P9_101 Lead';
    select * into r from public.solicitudes where nombre = 'Solicitud P9_101 Lead';
    if r.plan_enviado_by is distinct from '00000000-0000-0000-0000-0000000000e1' or r.plan_enviado_at < now() then
        raise exception 'FALLO: volver a tildar no actualizó plan_enviado_* (% / %)', r.plan_enviado_by, r.plan_enviado_at;
    end if;
    raise notice 'OK: volver a tildar plan enviado registra a la nueva persona y la nueva fecha';
end $$ language plpgsql;

-- ── Contador: arranca en cero ──────────────────────────────
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
do $$
begin
    if public.solicitudes_novedades() <> 0 then
        raise exception 'FALLO: la primera vez el contador no es 0 (%)', public.solicitudes_novedades();
    end if;
    raise notice 'OK: la primera vez el contador arranca en 0';
end $$ language plpgsql;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
select public.solicitudes_novedades();
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"authenticated"}', true);
select public.solicitudes_novedades();

-- Todos vieron Solicitudes hace un minuto: lo de esta transacción es posterior.
reset role;
update public.solicitudes_vistas set visto_at = now() - interval '1 minute';
set local role authenticated;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
do $$
declare n int; prev timestamptz;
begin
    -- B creó P9_101 y P9_102; E pasó P9_101 a plan enviado (cuenta una vez). P9_100 no tiene autor.
    n := public.solicitudes_novedades();
    if n <> 2 then raise exception 'FALLO: ADMIN debería tener 2 novedades y tiene %', n; end if;
    raise notice 'OK: cuenta solicitudes nuevas y planes enviados por otros, una vez por solicitud, sin las viejas';

    prev := public.solicitudes_marcar_visto();
    if prev is null or prev >= now() then raise exception 'FALLO: marcar_visto no devolvió el visto anterior (%)', prev; end if;
    n := public.solicitudes_novedades();
    if n <> 0 then raise exception 'FALLO: después de marcar visto quedan % novedades', n; end if;
    raise notice 'OK: marcar visto devuelve el anterior y pone el contador en 0';
end $$ language plpgsql;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
do $$
declare n int;
begin
    -- B es autor de las dos; E pasó P9_101 a plan enviado.
    n := public.solicitudes_novedades();
    if n <> 1 then raise exception 'FALLO: el autor debería ver solo el plan de otro (1) y ve %', n; end if;
    raise notice 'OK: el autor no cuenta lo suyo; el visto del ADMIN no afecta al lead';
end $$ language plpgsql;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"authenticated"}', true);
do $$
declare n int;
begin
    -- E: las dos de B son nuevas; el plan de P9_101 es suyo.
    n := public.solicitudes_novedades();
    if n <> 2 then raise exception 'FALLO: el segundo lead debería tener 2 novedades y tiene %', n; end if;
    raise notice 'OK: cada usuario tiene su propio visto';
end $$ language plpgsql;

-- ── Sin permiso: QA y lead desactivado ─────────────────────
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}', true);
do $$
begin
    begin
        perform public.solicitudes_novedades();
        raise exception 'FALLO: QA pudo pedir el contador';
    exception when sqlstate '42501' then raise notice 'OK: QA no tiene contador';
    end;
    begin
        perform public.solicitudes_marcar_visto();
        raise exception 'FALLO: QA pudo marcar visto';
    exception when sqlstate '42501' then raise notice 'OK: QA no marca visto';
    end;
end $$ language plpgsql;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}', true);
do $$
begin
    begin
        perform public.solicitudes_novedades();
        raise exception 'FALLO: un lead desactivado pudo pedir el contador';
    exception when sqlstate '42501' then raise notice 'OK: un lead desactivado no tiene contador';
    end;
end $$ language plpgsql;

reset role;
rollback;

-- QA BCR Suite v3 — pruebas de la lista de avisos (campana)
-- Ejecutar en el SQL Editor de Supabase después de 20261026000001_solicitudes_avisos_lista.sql.
-- Corre dentro de una transacción que termina en ROLLBACK: no deja nada guardado.
-- Cada prueba imprime "OK ..." o aborta con "FALLO ...".
-- now() no avanza dentro de la transacción: las fechas se preparan como superusuario.

begin;

insert into auth.users (id, email, raw_user_meta_data) values
    ('00000000-0000-0000-0000-0000000000a1', 'li-admin@test.local',    '{"full_name":"Li Admin"}'),
    ('00000000-0000-0000-0000-0000000000b1', 'li-lead@test.local',     '{"full_name":"Li Lead"}'),
    ('00000000-0000-0000-0000-0000000000c1', 'li-qa@test.local',       '{"full_name":"Li QA"}'),
    ('00000000-0000-0000-0000-0000000000d1', 'li-inactivo@test.local', '{"full_name":"Li Inactivo"}'),
    ('00000000-0000-0000-0000-0000000000e1', 'li-lead2@test.local',    '{"full_name":"Li Lead Dos"}');
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

-- B crea 12 solicitudes (Li-01 es la más nueva) y otras tres para los casos borde.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
insert into public.solicitudes (nombre)
select 'Li-' || lpad(g::text, 2, '0') from generate_series(1, 12) g;
insert into public.solicitudes (nombre) values ('Li-plan'), ('Li-vieja'), ('Li-destildada');
update public.solicitudes set created_at = now() - interval '1 hour' - (substr(nombre, 4)::int * interval '1 minute')
where nombre ~ '^Li-[0-9]+$';
update public.solicitudes set created_at = now() - interval '2 hours' where nombre = 'Li-plan';
update public.solicitudes set created_at = now() - interval '8 days' where nombre in ('Li-vieja', 'Li-destildada');
-- E pasa Li-plan a plan enviado; Li-destildada la tilda y la destilda.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"authenticated"}', true);
update public.solicitudes set plan_enviado = true where nombre in ('Li-plan', 'Li-destildada');
update public.solicitudes set plan_enviado = false where nombre = 'Li-destildada';

set local role authenticated;

-- ── ADMIN: lo de otros, del más nuevo al más viejo, hasta 10 ──
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
do $$
declare n int; r record; prev timestamptz := 'infinity';
begin
    select count(*) into n from public.solicitudes_avisos();
    if n <> 10 then raise exception 'FALLO: la lista trae % avisos y no 10', n; end if;
    for r in select * from public.solicitudes_avisos() loop
        if r.fecha > prev then raise exception 'FALLO: la lista no está ordenada por fecha'; end if;
        prev := r.fecha;
    end loop;
    raise notice 'OK: hasta 10 avisos, del más nuevo al más viejo';

    select * into r from public.solicitudes_avisos() limit 1;
    if r.nombre <> 'Li-plan' or r.tipo <> 'plan' or r.autor <> 'Li Lead Dos' then
        raise exception 'FALLO: el primero debería ser el plan de Li-plan por Li Lead Dos (% / % / %)', r.nombre, r.tipo, r.autor;
    end if;
    raise notice 'OK: el plan enviado aparece con su autor';

    if exists (select 1 from public.solicitudes_avisos() where nombre in ('Li-vieja', 'Li-destildada')) then
        raise exception 'FALLO: aparecen avisos de más de 7 días o de un plan destildado';
    end if;
    raise notice 'OK: sin avisos de más de 7 días ni de planes destildados';

    if exists (select 1 from public.solicitudes_avisos() where sin_ver) then
        raise exception 'FALLO: sin visto guardado algún aviso sale sin ver';
    end if;
    if exists (select 1 from public.solicitudes_vistas where user_id = auth.uid()) then
        raise exception 'FALLO: la lista creó la fila de visto';
    end if;
    raise notice 'OK: sin visto guardado nada sale resaltado y no se crea el visto';
end $$ language plpgsql;

-- Li-plan, creada por B, aparece dos veces para el ADMIN cuando entra en las 10 más nuevas.
reset role;
update public.solicitudes set created_at = now() - interval '10 minutes' where nombre = 'Li-plan';
insert into public.solicitudes_vistas (user_id, visto_at) values ('00000000-0000-0000-0000-0000000000a1', now() - interval '30 minutes');
set local role authenticated;
do $$
declare n int;
begin
    select count(*) into n from public.solicitudes_avisos() where nombre = 'Li-plan';
    if n <> 2 then raise exception 'FALLO: Li-plan debería salir como nueva y como plan (sale % veces)', n; end if;
    raise notice 'OK: la misma solicitud sale como creada y como plan enviado';

    select count(*) into n from public.solicitudes_avisos() where sin_ver;
    if n <> 2 then raise exception 'FALLO: deberían salir 2 sin ver (los de Li-plan) y salen %', n; end if;
    if exists (select 1 from public.solicitudes_avisos() where sin_ver and nombre <> 'Li-plan') then
        raise exception 'FALLO: sale sin ver un aviso anterior al visto';
    end if;
    raise notice 'OK: sin_ver marca solo lo posterior al visto';
end $$ language plpgsql;

-- ── El autor no ve lo suyo ─────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
do $$
declare n int;
begin
    if exists (select 1 from public.solicitudes_avisos() where tipo = 'nueva') then
        raise exception 'FALLO: el autor ve sus propias solicitudes creadas';
    end if;
    select count(*) into n from public.solicitudes_avisos() where tipo = 'plan';
    if n <> 1 then raise exception 'FALLO: el autor debería ver el plan de otro (ve %)', n; end if;
    raise notice 'OK: el autor no ve lo suyo y sí lo de otros';
end $$ language plpgsql;

-- ── Sin permiso: QA y lead desactivado ─────────────────────
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}', true);
do $$
begin
    perform * from public.solicitudes_avisos();
    raise exception 'FALLO: QA pudo ver los avisos';
exception when sqlstate '42501' then raise notice 'OK: QA no ve los avisos';
end $$ language plpgsql;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}', true);
do $$
begin
    perform * from public.solicitudes_avisos();
    raise exception 'FALLO: un lead desactivado pudo ver los avisos';
exception when sqlstate '42501' then raise notice 'OK: un lead desactivado no ve los avisos';
end $$ language plpgsql;

-- ── Persona borrada: su aviso sale de la lista ─────────────
reset role;
delete from auth.users where id = '00000000-0000-0000-0000-0000000000e1';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
do $$
begin
    if exists (select 1 from public.solicitudes_avisos() where tipo = 'plan') then
        raise exception 'FALLO: sigue el aviso de una persona borrada';
    end if;
    raise notice 'OK: al borrar a una persona su aviso sale de la lista';
end $$ language plpgsql;

reset role;
rollback;

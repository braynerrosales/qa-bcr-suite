-- QA BCR Suite v3 — pruebas de RLS de solicitudes
-- Ejecutar en el SQL Editor de Supabase después de 20261016000001_solicitudes.sql.
-- Corre dentro de una transacción que termina en ROLLBACK: no deja nada guardado.
-- Cada prueba imprime "OK ..." o aborta con "FALLO ...".

begin;

insert into auth.users (id, email, raw_user_meta_data) values
    ('00000000-0000-0000-0000-0000000000a1', 'sol-admin@test.local',    '{"full_name":"Sol Admin"}'),
    ('00000000-0000-0000-0000-0000000000b1', 'sol-lead@test.local',     '{"full_name":"Sol Lead"}'),
    ('00000000-0000-0000-0000-0000000000c1', 'sol-qa@test.local',       '{"full_name":"Sol QA"}'),
    ('00000000-0000-0000-0000-0000000000d1', 'sol-inactivo@test.local', '{"full_name":"Sol Inactivo"}');
update public.profiles set role = 'ADMIN'   where id = '00000000-0000-0000-0000-0000000000a1';
update public.profiles set role = 'QA_LEAD' where id = '00000000-0000-0000-0000-0000000000b1';
update public.profiles set role = 'QA_LEAD', active = false where id = '00000000-0000-0000-0000-0000000000d1';

-- ── QA_LEAD: crea, edita y ve ──────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
do $$
declare n int; r record;
begin
    insert into public.solicitudes (nombre, encargados, cierra)
    values ('Solicitud P9_001 Prueba RLS', array['Persona Uno'], current_date);
    select * into r from public.solicitudes where nombre = 'Solicitud P9_001 Prueba RLS';
    if r.updated_by is distinct from '00000000-0000-0000-0000-0000000000b1' then
        raise exception 'FALLO: updated_by no es el QA_LEAD (%)', r.updated_by;
    end if;
    raise notice 'OK: QA_LEAD crea una solicitud y la base registra quién fue';

    update public.solicitudes set cierre_enviado = true, cerrada = true
    where nombre = 'Solicitud P9_001 Prueba RLS';
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'FALLO: QA_LEAD no pudo editar'; end if;
    raise notice 'OK: QA_LEAD edita';

    select * into r from public.solicitudes where nombre = 'Solicitud P9_001 Prueba RLS';
    if cardinality(r.encargados) <> 0 or r.informe_semanal then
        raise exception 'FALLO: la solicitud cerrada sigue en el informe (% / %)', r.encargados, r.informe_semanal;
    end if;
    update public.solicitudes set encargados = array['Persona Uno'], informe_semanal = true
    where nombre = 'Solicitud P9_001 Prueba RLS';
    select * into r from public.solicitudes where nombre = 'Solicitud P9_001 Prueba RLS';
    if cardinality(r.encargados) <> 0 or r.informe_semanal then
        raise exception 'FALLO: una solicitud cerrada aceptó encargados';
    end if;
    raise notice 'OK: al cerrarse sale del informe semanal y no acepta encargados';

    begin
        update public.solicitudes set updated_by = null;
        raise exception 'FALLO: el cliente pudo escribir updated_by';
    exception when insufficient_privilege then
        raise notice 'OK: updated_by no se puede escribir desde el cliente';
    end;

    begin
        insert into public.solicitudes (nombre) values ('   ');
        raise exception 'FALLO: aceptó un nombre vacío';
    exception when check_violation then
        raise notice 'OK: no acepta nombre vacío';
    end;
end $$ language plpgsql;

-- ── QA: no ve ni toca nada ─────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}', true);
do $$
declare n int;
begin
    select count(*) into n from public.solicitudes;
    if n <> 0 then raise exception 'FALLO: QA ve % solicitudes', n; end if;
    raise notice 'OK: QA no ve solicitudes';

    update public.solicitudes set observaciones = 'x';
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'FALLO: QA editó % solicitudes', n; end if;
    delete from public.solicitudes;
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'FALLO: QA borró % solicitudes', n; end if;
    raise notice 'OK: QA no edita ni borra';

    begin
        insert into public.solicitudes (nombre) values ('Solicitud de QA');
        raise exception 'FALLO: QA pudo crear una solicitud';
    exception when insufficient_privilege then
        raise notice 'OK: QA no crea solicitudes';
    end;
end $$ language plpgsql;

-- ── Lead desactivado: nada ─────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}', true);
do $$
declare n int;
begin
    select count(*) into n from public.solicitudes;
    if n <> 0 then raise exception 'FALLO: lead desactivado ve % solicitudes', n; end if;
    raise notice 'OK: un lead desactivado no ve solicitudes';
end $$ language plpgsql;

-- ── ADMIN: ve la misma lista y borra ───────────────────────
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
do $$
declare n int;
begin
    select count(*) into n from public.solicitudes where nombre = 'Solicitud P9_001 Prueba RLS';
    if n <> 1 then raise exception 'FALLO: ADMIN no ve la solicitud del lead'; end if;
    raise notice 'OK: la lista es compartida (ADMIN ve la del QA_LEAD)';

    delete from public.solicitudes where nombre = 'Solicitud P9_001 Prueba RLS';
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'FALLO: ADMIN no pudo borrar'; end if;
    raise notice 'OK: ADMIN borra';
end $$ language plpgsql;

-- ── Sin sesión ─────────────────────────────────────────────
set local role anon;
select set_config('request.jwt.claims', '', true);
do $$
declare n int;
begin
    begin
        select count(*) into n from public.solicitudes;
        if n <> 0 then raise exception 'FALLO: anon ve % solicitudes', n; end if;
        raise notice 'OK: sin login no se ven solicitudes';
    exception when insufficient_privilege then
        raise notice 'OK: sin login no se ven solicitudes (permiso denegado)';
    end;
end $$ language plpgsql;

reset role;
rollback;

-- QA BCR Suite v3 — pruebas del rol BETA
-- Ejecutar en el SQL Editor de Supabase DESPUÉS de 20261020000001_rol_beta.sql.
-- Todo corre dentro de una transacción que termina en ROLLBACK:
-- los usuarios de prueba y los cambios no quedan guardados.
-- Cada prueba imprime "OK ..." o aborta con "FALLO ...".

begin;

insert into auth.users (id, email, raw_user_meta_data) values
    ('00000000-0000-0000-0000-0000000000e1', 'beta@test.local', '{"full_name":"Test Beta"}'),
    ('00000000-0000-0000-0000-0000000000e2', 'lead@test.local', '{"full_name":"Test Lead"}');
-- Los perfiles nacen inactivos y con la contraseña temporal (20261024000001_seguridad.sql): se dejan listos.
update public.profiles set active = true, must_change_password = false
where id in (
    '00000000-0000-0000-0000-0000000000e1',
    '00000000-0000-0000-0000-0000000000e2'
);
update public.profiles set role = 'BETA'    where id = '00000000-0000-0000-0000-0000000000e1';
update public.profiles set role = 'QA_LEAD' where id = '00000000-0000-0000-0000-0000000000e2';

insert into public.daily_groups (code, name)
select 'daily_beta_test', 'Daily prueba'
where not exists (select 1 from public.daily_groups where active);
insert into public.horas (user_id, fecha, tipo, soli, tarea, horas, facturable)
values ('00000000-0000-0000-0000-0000000000e1', current_date, 'TRABAJO', 'P3_1', 'Antes de ser Beta', 2, 2);

create temp table test_ids as
select (select id from public.daily_groups where active order by id limit 1) as group_id;
grant select on test_ids to authenticated;

-- ── BETA ────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"authenticated"}', true);
do $$
declare n int;
begin
    select count(*) into n from public.horas;
    if n <> 0 then raise exception 'FALLO: BETA ve % líneas de horas', n; end if;
    raise notice 'OK: BETA no ve horas, ni las suyas';

    begin
        insert into public.horas (user_id, fecha, tipo, soli, tarea, horas, facturable)
        values (auth.uid(), current_date, 'TRABAJO', 'P3_1', 'x', 1, 1);
        raise exception 'FALLO: BETA guardó horas';
    exception when insufficient_privilege then
        raise notice 'OK: BETA no puede guardar horas';
    end;

    begin
        perform * from public.horas_resumen(current_date, current_date);
        raise exception 'FALLO: BETA pidió el consolidado';
    exception when insufficient_privilege then
        raise notice 'OK: BETA no puede pedir el consolidado';
    end;

    select count(*) into n from public.solicitudes;
    if n <> 0 then raise exception 'FALLO: BETA ve % solicitudes', n; end if;
    raise notice 'OK: BETA no ve solicitudes';

    perform * from public.daily_guardar((select group_id from test_ids), current_date,
        '[{"name":"Ana Prueba","position":1,"completed":true,"absent":false}]'::jsonb);
    select count(*) into n from public.daily_historial((select group_id from test_ids), current_date, current_date);
    if n <> 1 then raise exception 'FALLO: BETA no ve el daily que guardó'; end if;
    raise notice 'OK: BETA guarda el daily y ve el historial';

    insert into public.feedback (mensaje) values ('Prueba de feedback de Beta');
    raise notice 'OK: BETA envía feedback';

    update public.profiles set role = 'QA' where id = auth.uid();
    get diagnostics n = row_count;
    if exists (select 1 from public.profiles where id = auth.uid() and role <> 'BETA') then
        raise exception 'FALLO: BETA se cambió el rol';
    end if;
    raise notice 'OK: BETA no puede cambiarse el rol';
exception when insufficient_privilege then
    raise notice 'OK: BETA no puede cambiarse el rol (permiso denegado)';
end $$;

-- ── QA_LEAD: el consolidado no incluye al BETA ───────────────
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e2","role":"authenticated"}', true);
do $$
begin
    if exists (select 1 from public.horas_resumen(current_date, current_date)
               where user_id = '00000000-0000-0000-0000-0000000000e1') then
        raise exception 'FALLO: el BETA sale en el consolidado';
    end if;
    raise notice 'OK: el BETA no sale en el consolidado';
end $$;

rollback;

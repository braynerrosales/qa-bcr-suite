-- QA BCR Suite v3 — pruebas de RLS
-- Ejecutar en el SQL Editor de Supabase DESPUÉS de seed.sql.
-- Todo corre dentro de una transacción que termina en ROLLBACK:
-- los usuarios de prueba y los cambios no quedan guardados.
-- Cada prueba imprime "OK ..." o aborta con "FALLO ...".

begin;

-- Usuarios de prueba (el trigger les crea el perfil QA)
insert into auth.users (id, email, raw_user_meta_data) values
    ('00000000-0000-0000-0000-00000000000a', 'admin@test.local',    '{"full_name":"Test Admin"}'),
    ('00000000-0000-0000-0000-00000000000b', 'lead@test.local',     '{"full_name":"Test Lead"}'),
    ('00000000-0000-0000-0000-00000000000c', 'qa@test.local',       '{"full_name":"Test QA"}'),
    ('00000000-0000-0000-0000-00000000000d', 'inactivo@test.local', '{"full_name":"Test Inactivo"}');

update public.profiles set role = 'ADMIN'   where id = '00000000-0000-0000-0000-00000000000a';
update public.profiles set role = 'QA_LEAD' where id = '00000000-0000-0000-0000-00000000000b';
update public.profiles set active = false   where id = '00000000-0000-0000-0000-00000000000d';

create temp table test_ids as
select
    (select id from public.projects order by id limit 1) as project_id,
    (select id from public.daily_groups order by id limit 1) as group_id;
grant select on test_ids to anon, authenticated;

-- ── Sin sesión ──────────────────────────────────────────────
set local role anon;
select set_config('request.jwt.claims', '', true);
-- Supabase da SELECT a anon sobre public; el RLS lo deja en 0 filas.
do $$
declare n int;
begin
    begin
        select count(*) into n from public.projects;
        if n <> 0 then raise exception 'FALLO: anon ve % proyectos', n; end if;
        raise notice 'OK: sin login no se ven proyectos';
    exception when insufficient_privilege then
        raise notice 'OK: sin login no se ven proyectos (permiso denegado)';
    end;
    begin
        perform public.get_app_config();
        raise exception 'FALLO: anon pudo llamar get_app_config()';
    exception when insufficient_privilege then
        raise notice 'OK: sin login no se llama get_app_config()';
    end;
end $$ language plpgsql;

-- ── QA ──────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000c","role":"authenticated"}', true);
do $$
declare n int;
begin
    select count(*) into n from public.projects;
    if n = 0 then raise exception 'FALLO: QA no ve proyectos'; end if;
    raise notice 'OK: QA lee % proyectos', n;

    if jsonb_typeof(public.get_app_config() -> 'projects') <> 'object' then
        raise exception 'FALLO: QA no obtiene get_app_config()';
    end if;
    raise notice 'OK: QA obtiene get_app_config()';

    begin
        insert into public.projects (code, name) values ('TEST_QA', 'TEST_QA');
        raise exception 'FALLO: QA pudo crear proyecto';
    exception when insufficient_privilege then
        raise notice 'OK: QA no puede crear proyecto';
    end;

    update public.daily_members set name = name || ' x';
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'FALLO: QA modificó % personas', n; end if;
    raise notice 'OK: QA no puede modificar personas';

    begin
        perform public.save_template((select project_id from test_ids), null, array['QA - {n} - x']);
        raise exception 'FALLO: QA pudo guardar plantilla';
    exception when insufficient_privilege then
        raise notice 'OK: QA no puede guardar plantillas';
    end;

    update public.profiles set role = 'ADMIN' where id = auth.uid();
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'FALLO: QA se cambió el rol'; end if;
    raise notice 'OK: QA no puede cambiarse el rol';

    insert into public.qa_generations (project_name) values ('PRUEBA');
    insert into public.qa_generation_items (generation_id, pbi_number, pbi_text)
        values (currval(pg_get_serial_sequence('public.qa_generations', 'id')), '123', 'PBI de prueba');
    insert into public.qa_generation_tasks (generation_item_id, position, task)
        values (currval(pg_get_serial_sequence('public.qa_generation_items', 'id')), 1, 'QA - 123 - x');
    raise notice 'OK: QA guarda su propia generación';

    begin
        insert into public.qa_generations (user_id, project_name)
            values ('00000000-0000-0000-0000-00000000000b', 'SUPLANTADA');
        raise exception 'FALLO: QA guardó una generación a nombre de otro';
    exception when insufficient_privilege then
        raise notice 'OK: QA no puede guardar generaciones a nombre de otro';
    end;

    insert into public.daily_runs (daily_group_id) values ((select group_id from test_ids));
    insert into public.daily_run_members (daily_run_id, member_name, position)
        values (currval(pg_get_serial_sequence('public.daily_runs', 'id')), 'Persona', 1);
    update public.daily_run_members set completed = true
        where daily_run_id = currval(pg_get_serial_sequence('public.daily_runs', 'id'));
    raise notice 'OK: QA registra un Daily y marca completados';

    begin
        update public.daily_run_members set member_name = 'Otro';
        raise exception 'FALLO: QA cambió el nombre en el historial del Daily';
    exception when insufficient_privilege then
        raise notice 'OK: el historial del Daily solo permite cambiar "completed"';
    end;

    select count(*) into n from public.ai_usage_log;
    if n <> 0 then raise exception 'FALLO: QA ve el uso de IA'; end if;
    raise notice 'OK: QA no ve el uso de IA';
end $$ language plpgsql;

-- ── QA_LEAD ─────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);
do $$
declare n int; tid bigint;
begin
    insert into public.projects (code, name, color) values ('TEST_LEAD', 'TEST_LEAD', '#123456');
    raise notice 'OK: QA_LEAD crea proyecto';

    tid := public.save_template((select id from public.projects where code = 'TEST_LEAD'), null,
                                array['QA - {n} - uno', '  ', 'QA - {n} - dos']);
    tid := public.save_template((select id from public.projects where code = 'TEST_LEAD'), null,
                                array['QA - {n} - tres']);
    select count(*) into n from public.template_tasks where template_id = tid;
    if n <> 1 then raise exception 'FALLO: save_template dejó % tareas (esperado 1)', n; end if;
    raise notice 'OK: save_template reemplaza la lista completa';

    select count(*) into n from public.qa_generations;
    if n = 0 then raise exception 'FALLO: QA_LEAD no ve el historial de otros'; end if;
    raise notice 'OK: QA_LEAD ve el historial de todos (% generaciones)', n;

    update public.profiles set role = 'QA' where id = '00000000-0000-0000-0000-00000000000c';
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'FALLO: QA_LEAD cambió un rol'; end if;
    raise notice 'OK: QA_LEAD no puede cambiar roles';
end $$ language plpgsql;

-- ── ADMIN ───────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
do $$
declare n int;
begin
    update public.profiles set role = 'QA_LEAD' where id = '00000000-0000-0000-0000-00000000000c';
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'FALLO: ADMIN no pudo cambiar un rol'; end if;
    raise notice 'OK: ADMIN modifica usuarios';

    select count(*) into n from public.profiles;
    if n < 4 then raise exception 'FALLO: ADMIN ve solo % perfiles', n; end if;
    raise notice 'OK: ADMIN ve todos los perfiles';
end $$ language plpgsql;

-- ── Usuario desactivado ─────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000d","role":"authenticated"}', true);
do $$
declare n int;
begin
    select count(*) into n from public.projects;
    if n <> 0 then raise exception 'FALLO: usuario desactivado ve % proyectos', n; end if;
    raise notice 'OK: usuario desactivado no ve configuración';

    select count(*) into n from public.profiles;
    if n <> 1 then raise exception 'FALLO: usuario desactivado ve % perfiles', n; end if;
    raise notice 'OK: usuario desactivado solo ve su perfil (la app puede avisarle)';
end $$ language plpgsql;

reset role;
rollback;

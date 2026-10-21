-- QA BCR Suite v3 — pruebas del endurecimiento de permisos
-- Ejecutar en el SQL Editor de Supabase después de 20261024000001_seguridad.sql (y de seed.sql).
-- Termina en ROLLBACK: no deja nada guardado. Imprime "OK ..." o aborta con "FALLO ...".

begin;

insert into auth.users (id, email, raw_user_meta_data) values
    ('00000000-0000-0000-0000-0000000005e1', 'seg-lead@test.local',    '{"full_name":"Seg Lead"}'),
    ('00000000-0000-0000-0000-0000000005e2', 'seg-qa@test.local',      '{"full_name":"Seg QA"}'),
    ('00000000-0000-0000-0000-0000000005e3', 'seg-otro@test.local',    '{"full_name":"Seg Otro"}'),
    ('00000000-0000-0000-0000-0000000005e4', 'seg-nuevo@test.local',   '{"full_name":"Seg Nuevo"}'),
    ('00000000-0000-0000-0000-0000000005e5', 'seg-temporal@test.local','{"full_name":"Seg Temporal"}'),
    ('00000000-0000-0000-0000-0000000005e6', 'seg-inactivo@test.local','{"full_name":"Seg Inactivo"}');

-- ── Perfil nuevo: inactivo y con la contraseña temporal ────
do $$
declare p record;
begin
    select * into p from public.profiles where id = '00000000-0000-0000-0000-0000000005e4';
    if p.active or not p.must_change_password or p.role <> 'QA' then
        raise exception 'FALLO: un usuario nuevo debe nacer QA, inactivo y con la contraseña temporal';
    end if;
    raise notice 'OK: un usuario recién registrado nace inactivo';
end $$ language plpgsql;

-- Lo que hace la Edge Function al crearlos (s4 queda como recién registrado).
update public.profiles set active = true, must_change_password = false
where id in ('00000000-0000-0000-0000-0000000005e1', '00000000-0000-0000-0000-0000000005e2',
             '00000000-0000-0000-0000-0000000005e3', '00000000-0000-0000-0000-0000000005e6');
update public.profiles set active = true where id = '00000000-0000-0000-0000-0000000005e5';
update public.profiles set role = 'QA_LEAD' where id = '00000000-0000-0000-0000-0000000005e1';

create temp table seg_ids as
select (select id from public.daily_groups order by id limit 1) as group_id,
       (select id from public.projects order by id limit 1) as project_id;
grant select on seg_ids to authenticated;

-- Generación de s6, hecha cuando estaba activo; después se lo desactiva.
insert into public.qa_generations (id, user_id, project_name)
values (990001, '00000000-0000-0000-0000-0000000005e6', 'Proyecto');
update public.profiles set active = false where id = '00000000-0000-0000-0000-0000000005e6';

set local role authenticated;

-- ── Recién registrado: no ve nada ──────────────────────────
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000005e4","role":"authenticated"}', true);
do $$
declare n int;
begin
    select count(*) into n from public.profiles;
    if n <> 1 then raise exception 'FALLO: un recién registrado ve % perfiles (debe ver solo el suyo)', n; end if;
    select count(*) into n from public.projects;
    if n <> 0 then raise exception 'FALLO: un recién registrado ve la configuración'; end if;
    raise notice 'OK: un recién registrado solo ve su perfil';
end $$ language plpgsql;

-- ── Con la contraseña temporal: sin permisos ───────────────
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000005e5","role":"authenticated"}', true);
do $$
declare n int; b boolean;
begin
    select must_change_password into b from public.profiles where id = '00000000-0000-0000-0000-0000000005e5';
    if not b then raise exception 'FALLO: debe poder leer su aviso de cambio de contraseña'; end if;
    select count(*) into n from public.projects;
    if n <> 0 then raise exception 'FALLO: con la contraseña temporal ve la configuración'; end if;
    begin
        perform * from public.daily_guardar((select group_id from seg_ids), current_date, '[{"name":"Ana","position":1}]');
        raise exception 'FALLO: con la contraseña temporal pudo guardar el daily';
    exception when insufficient_privilege then null;
    end;
    raise notice 'OK: con la contraseña temporal no hay permisos hasta cambiarla';
end $$ language plpgsql;

-- ── Historial del Daily ─────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000005e2","role":"authenticated"}', true);
do $$
declare r record;
begin
    begin
        insert into public.daily_runs (daily_group_id, run_date, created_by)
        values ((select group_id from seg_ids), date '2020-01-01', '00000000-0000-0000-0000-0000000005e2');
        raise exception 'FALLO: un QA insertó directo en daily_runs';
    exception when insufficient_privilege then null;
    end;
    raise notice 'OK: el historial del Daily solo se escribe con daily_guardar';

    select * into r from public.daily_guardar((select group_id from seg_ids), current_date, '[{"name":"Ana","position":1}]');
    if r.reemplazado then raise exception 'FALLO: el primer guardado no debe reemplazar'; end if;
    select * into r from public.daily_guardar((select group_id from seg_ids), current_date, '[{"name":"Ana","position":1},{"name":"Beto","position":2}]');
    if not r.reemplazado then raise exception 'FALLO: quien lo guardó debe poder reemplazarlo'; end if;
    raise notice 'OK: quien guardó el día lo puede reemplazar';
end $$ language plpgsql;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000005e3","role":"authenticated"}', true);
do $$
begin
    begin
        perform * from public.daily_guardar((select group_id from seg_ids), current_date, '[{"name":"Falso","position":1}]');
        raise exception 'FALLO: otro QA reemplazó el daily guardado por otra persona';
    exception when raise_exception then
        if sqlerrm not like 'Ese día ya lo guardó otra persona%' then raise; end if;
    end;
    raise notice 'OK: otro QA no reemplaza un día guardado por otra persona';
end $$ language plpgsql;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000005e1","role":"authenticated"}', true);
do $$
declare r record; n int;
begin
    select * into r from public.daily_guardar((select group_id from seg_ids), current_date, '[{"name":"Ana","position":1}]');
    if not r.reemplazado then raise exception 'FALLO: un QA Lead debe poder reemplazar el día'; end if;
    select count(*) into n from public.daily_run_members where daily_run_id = r.run_id;
    if n <> 1 then raise exception 'FALLO: el reemplazo del QA Lead dejó % personas', n; end if;
    raise notice 'OK: un QA Lead reemplaza el día guardado por otra persona';
end $$ language plpgsql;

-- ── QA Generator: un desactivado no agrega ítems ───────────
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000005e6","role":"authenticated"}', true);
do $$
begin
    begin
        insert into public.qa_generation_items (generation_id, pbi_text) values (990001, 'Falso');
        raise exception 'FALLO: un usuario desactivado agregó ítems a su generación';
    exception when insufficient_privilege then null;
    end;
    raise notice 'OK: un usuario desactivado no agrega ítems al QA Generator';
end $$ language plpgsql;

rollback;

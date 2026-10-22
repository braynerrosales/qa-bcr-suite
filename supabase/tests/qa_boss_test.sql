-- QA BCR Suite v3 — pruebas del rol QA Boss
-- Ejecutar en el SQL Editor de Supabase después de 20261029000001_rol_qa_boss.sql.
-- Corre dentro de una transacción que termina en ROLLBACK: no deja nada guardado.
-- Cada prueba imprime "OK ..." o aborta con "FALLO ...".
-- Solo mira sus propias solicitudes ('QB-...'), así corre también en una base con datos reales.

begin;

insert into auth.users (id, email, raw_user_meta_data) values
    ('00000000-0000-0000-0000-0000000000b7', 'qb-boss@test.local', '{"full_name":"QB Boss"}'),
    ('00000000-0000-0000-0000-0000000000b8', 'qb-lead@test.local', '{"full_name":"QB Lead"}'),
    ('00000000-0000-0000-0000-0000000000b9', 'qb-temp@test.local', '{"full_name":"QB Temporal"}');
update public.profiles set active = true, must_change_password = false, role = 'BOSS', en_informe = true
where id = '00000000-0000-0000-0000-0000000000b7';
update public.profiles set active = true, must_change_password = false, role = 'QA_LEAD'
where id = '00000000-0000-0000-0000-0000000000b8';
update public.profiles set active = true, must_change_password = true, role = 'BOSS'
where id = '00000000-0000-0000-0000-0000000000b9';

set local role authenticated;

-- Un lead crea la solicitud.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b8","role":"authenticated"}', true);
insert into public.solicitudes (nombre) values ('QB-UNO');

-- ── QA Boss lee y usa la campana, pero no escribe ──────────
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b7","role":"authenticated"}', true);
do $$
declare n int;
begin
    if not exists (select 1 from public.solicitudes where nombre = 'QB-UNO') then
        raise exception 'FALLO: QA Boss no ve las solicitudes';
    end if;
    raise notice 'OK: QA Boss ve las solicitudes';

    update public.solicitudes set observaciones = 'pisada' where nombre = 'QB-UNO';
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'FALLO: QA Boss editó una solicitud'; end if;
    delete from public.solicitudes where nombre = 'QB-UNO';
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'FALLO: QA Boss borró una solicitud'; end if;
    begin
        insert into public.solicitudes (nombre) values ('QB-DOS');
        raise exception 'FALLO: QA Boss creó una solicitud';
    exception when insufficient_privilege then null;
    end;
    raise notice 'OK: QA Boss no crea, edita ni borra solicitudes';

    perform public.solicitudes_novedades();
    perform public.solicitudes_marcar_visto();
    if not exists (select 1 from public.solicitudes_vistas where user_id = auth.uid()) then
        raise exception 'FALLO: QA Boss no guardó su visto';
    end if;
    if not exists (select 1 from public.solicitudes_avisos() where nombre = 'QB-UNO' and not propio) then
        raise exception 'FALLO: QA Boss no ve el aviso de la solicitud';
    end if;
    raise notice 'OK: QA Boss usa la campana';

    begin
        perform public.daily_guardar((select id from public.daily_groups order by id limit 1), current_date, '[]'::jsonb);
        raise exception 'FALLO: QA Boss guardó el Daily';
    exception when insufficient_privilege then raise notice 'OK: QA Boss no guarda el Daily';
    end;

    begin
        insert into public.horas (user_id, fecha, tipo, horas) values (auth.uid(), current_date, 'TRABAJO', 1);
        raise exception 'FALLO: QA Boss cargó horas';
    exception when insufficient_privilege then raise notice 'OK: QA Boss no carga horas';
    end;
    begin
        perform public.horas_resumen(current_date - 7, current_date);
        raise exception 'FALLO: QA Boss pidió el consolidado de horas';
    exception when insufficient_privilege then raise notice 'OK: QA Boss no pide el consolidado';
    end;

    begin
        insert into public.projects (code, name) values ('QB-PROY', 'QB-PROY');
        raise exception 'FALLO: QA Boss agregó un proyecto';
    exception when insufficient_privilege then raise notice 'OK: QA Boss no agrega proyectos';
    end;
end $$ language plpgsql;

-- ── QA Boss no sale en el consolidado ──────────────────────
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b8","role":"authenticated"}', true);
do $$
begin
    if exists (select 1 from public.horas_resumen(current_date - 7, current_date)
               where user_id = '00000000-0000-0000-0000-0000000000b7') then
        raise exception 'FALLO: QA Boss sale en el consolidado de horas';
    end if;
    raise notice 'OK: QA Boss no sale en el consolidado de horas';
end $$ language plpgsql;

-- ── Con la contraseña temporal no ve nada ──────────────────
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b9","role":"authenticated"}', true);
do $$
begin
    if exists (select 1 from public.solicitudes where nombre = 'QB-UNO') then
        raise exception 'FALLO: QA Boss con contraseña temporal ve solicitudes';
    end if;
    raise notice 'OK: QA Boss con contraseña temporal no ve solicitudes';
end $$ language plpgsql;

reset role;
rollback;

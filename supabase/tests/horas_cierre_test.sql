-- QA BCR Suite v3 — pruebas del cierre de semanas en Horas
-- Ejecutar en el SQL Editor de Supabase después de 20261023000001_horas_cierre_semanas.sql.
-- Termina en ROLLBACK: no deja nada guardado. Si algo falla, aborta con "FALLO ...";
-- si todo pasa, el SQL Editor muestra "Success" o la última consulta (los "OK" son notices).

begin;

insert into auth.users (id, email, raw_user_meta_data) values
    ('00000000-0000-0000-0000-0000000000b7', 'cierre-qa@test.local',   '{"full_name":"Cierre QA"}'),
    ('00000000-0000-0000-0000-0000000000b8', 'cierre-lead@test.local', '{"full_name":"Cierre Lead"}');
update public.profiles set role = 'QA_LEAD' where id = '00000000-0000-0000-0000-0000000000b8';

-- Una línea en una semana cerrada (hace tres semanas) y otra en la más vieja abierta.
-- Como dueño (sin auth.uid()) el cierre no aplica.
create temp table cierre as
select private.horas_abiertas_desde() - 7 as vieja, private.horas_abiertas_desde() as abierta;
grant select on cierre to authenticated;
insert into public.horas (user_id, fecha, tipo, soli, tarea, horas, facturable)
select '00000000-0000-0000-0000-0000000000b7', vieja, 'TRABAJO', 'P3_1', 'Vieja', 8, 8 from cierre
union all
select '00000000-0000-0000-0000-0000000000b7', abierta, 'TRABAJO', 'P3_1', 'Abierta', 8, 8 from cierre;

-- ── QA ──────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b7","role":"authenticated"}', true);
do $$
declare v_vieja date; v_abierta date;
begin
    select vieja, abierta into v_vieja, v_abierta from cierre;

    begin
        update public.horas set tarea = 'x' where fecha = v_vieja;
        raise exception 'FALLO: el QA cambió una línea de una semana cerrada';
    exception when raise_exception then
        if sqlerrm not like 'Esa semana está cerrada%' then raise; end if;
        raise notice 'OK: el QA no cambia líneas de semanas cerradas';
    end;

    begin
        delete from public.horas where fecha = v_vieja;
        raise exception 'FALLO: el QA borró una línea de una semana cerrada';
    exception when raise_exception then
        if sqlerrm not like 'Esa semana está cerrada%' then raise; end if;
        raise notice 'OK: el QA no borra líneas de semanas cerradas';
    end;

    begin
        insert into public.horas (user_id, fecha, tipo, soli, tarea, horas, facturable)
        values (auth.uid(), v_vieja, 'TRABAJO', 'P3_1', 'Nueva vieja', 1, 1);
        raise exception 'FALLO: el QA agregó una línea en una semana cerrada';
    exception when raise_exception then
        if sqlerrm not like 'Esa semana está cerrada%' then raise; end if;
        raise notice 'OK: el QA no agrega líneas en semanas cerradas';
    end;

    begin
        update public.horas set fecha = v_vieja where fecha = v_abierta;
        raise exception 'FALLO: el QA movió una línea a una semana cerrada';
    exception when raise_exception then
        if sqlerrm not like 'Esa semana está cerrada%' then raise; end if;
        raise notice 'OK: el QA no mueve líneas a semanas cerradas';
    end;

    update public.horas set tarea = 'Abierta cambiada' where fecha = v_abierta;
    if not found then raise exception 'FALLO: el QA no pudo cambiar una línea de hace dos semanas'; end if;
    insert into public.horas (user_id, fecha, tipo, soli, tarea, horas, facturable)
    values (auth.uid(), v_abierta, 'TRABAJO', 'P3_1', 'Otra', 1, 1);
    raise notice 'OK: el QA cambia y agrega líneas desde el lunes de hace dos semanas';
end $$;

-- ── QA_LEAD: sin límite ─────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b8","role":"authenticated"}', true);
do $$
begin
    update public.horas set tarea = 'Corregida por lead'
    where user_id = '00000000-0000-0000-0000-0000000000b7' and fecha = (select vieja from cierre);
    if not found then raise exception 'FALLO: el lead no pudo corregir una semana cerrada'; end if;
    raise notice 'OK: el lead corrige semanas cerradas';
end $$;

rollback;

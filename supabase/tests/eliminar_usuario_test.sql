-- QA BCR Suite v3 — pruebas de eliminar usuarios
-- Ejecutar en el SQL Editor de Supabase después de 20261021000001_conservar_horas_al_eliminar.sql.
-- Termina en ROLLBACK: no deja nada guardado. Imprime "OK ..." o aborta con "FALLO ...".

begin;

insert into auth.users (id, email, raw_user_meta_data) values
    ('00000000-0000-0000-0000-0000000000f1', 'del-horas@test.local',   '{"full_name":"Del Con Horas"}'),
    ('00000000-0000-0000-0000-0000000000f2', 'del-ajuste@test.local',  '{"full_name":"Del Con Ajuste"}'),
    ('00000000-0000-0000-0000-0000000000f3', 'del-limpio@test.local',  '{"full_name":"Del Sin Horas"}');

insert into public.horas (user_id, fecha, tipo, soli, tarea, horas, facturable)
values ('00000000-0000-0000-0000-0000000000f1', date '2026-10-12', 'TRABAJO', 'P3_1', 'Prueba', 8, 8);
insert into public.horas_ajustes (user_id, fecha, columna, delta, motivo)
values ('00000000-0000-0000-0000-0000000000f2', date '2026-10-12', 'facturable', 2, 'Prueba');

do $$
declare n int;
begin
    begin
        delete from auth.users where id = '00000000-0000-0000-0000-0000000000f1';
        raise exception 'FALLO: se eliminó un usuario con horas';
    exception when foreign_key_violation then
        raise notice 'OK: no se elimina un usuario con horas';
    end;
    select count(*) into n from public.horas where user_id = '00000000-0000-0000-0000-0000000000f1';
    if n <> 1 then raise exception 'FALLO: sus horas cambiaron (% líneas)', n; end if;
    raise notice 'OK: sus horas se conservan';

    begin
        delete from auth.users where id = '00000000-0000-0000-0000-0000000000f2';
        raise exception 'FALLO: se eliminó un usuario con ajustes de horas';
    exception when foreign_key_violation then
        raise notice 'OK: no se elimina un usuario con ajustes de horas';
    end;

    delete from auth.users where id = '00000000-0000-0000-0000-0000000000f3';
    if exists (select 1 from public.profiles where id = '00000000-0000-0000-0000-0000000000f3') then
        raise exception 'FALLO: quedó el perfil del usuario eliminado';
    end if;
    raise notice 'OK: un usuario sin horas se elimina con su perfil';
end $$;

rollback;

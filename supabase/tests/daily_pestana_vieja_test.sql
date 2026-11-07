-- QA BCR Suite v3 — pruebas: una pestaña vieja (sin motivos) que reemplaza el Daily no borra los motivos
-- Ejecutar en el SQL Editor de Supabase después de 20261101000001_daily_motivos_pestana_vieja.sql.
-- Corre dentro de una transacción que termina en ROLLBACK: no deja nada guardado.
-- Cada prueba imprime "OK ..." o aborta con "FALLO ...".
-- Usa su propio Daily ('PV-1'); los demás se desactivan solo dentro de la transacción.

begin;

insert into auth.users (id, email, raw_user_meta_data) values
    ('00000000-0000-0000-0000-0000000000e1', 'pv-qa@test.local', '{"full_name":"PV QA"}');
update public.profiles set active = true, must_change_password = false, role = 'QA' where id = '00000000-0000-0000-0000-0000000000e1';

update public.daily_groups set active = false;
insert into public.daily_groups (code, name) values ('PV-1', 'PV Uno');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"authenticated"}', true);

do $$
declare g bigint;
begin
    select id into g from public.daily_groups where code = 'PV-1';
    -- La app nueva guarda con motivos (y manda "motivo": null en quien asistió o falta sin justificar).
    perform public.daily_guardar(g, current_date, jsonb_build_array(
        jsonb_build_object('name', 'PV Ana', 'position', 1, 'completed', false, 'absent', true, 'motivo', 'vacaciones'),
        jsonb_build_object('name', 'PV Beto', 'position', 2, 'completed', false, 'absent', true, 'motivo', 'justificada'),
        jsonb_build_object('name', 'PV Caro', 'position', 3, 'completed', false, 'absent', true, 'motivo', 'justificada'),
        jsonb_build_object('name', 'PV Dani', 'position', 4, 'completed', true, 'absent', false, 'motivo', null)));

    -- Una pestaña vieja reemplaza el día: no conoce los motivos y no los manda.
    -- Ana y Beto siguen ausentes; Caro ya no falta; Eli falta y antes no estaba.
    perform public.daily_guardar(g, current_date, jsonb_build_array(
        jsonb_build_object('name', 'PV Ana', 'position', 1, 'completed', false, 'absent', true),
        jsonb_build_object('name', ' PV Beto ', 'position', 2, 'completed', false, 'absent', true),
        jsonb_build_object('name', 'PV Caro', 'position', 3, 'completed', true, 'absent', false),
        jsonb_build_object('name', 'PV Eli', 'position', 4, 'completed', false, 'absent', true)));
    if (select motivo from public.daily_historial(g, current_date, current_date) where member_name = 'PV Ana') is distinct from 'vacaciones'
       or (select motivo from public.daily_historial(g, current_date, current_date) where member_name = 'PV Beto') is distinct from 'justificada' then
        raise exception 'FALLO: la pestaña vieja borró los motivos de quienes siguen ausentes';
    end if;
    raise notice 'OK: una pestaña vieja conserva el motivo de quien sigue ausente';
    if (select motivo from public.daily_historial(g, current_date, current_date) where member_name = 'PV Caro') is not null
       or (select motivo from public.daily_historial(g, current_date, current_date) where member_name = 'PV Eli') is not null then
        raise exception 'FALLO: quedó un motivo en quien asistió o en quien no tenía';
    end if;
    raise notice 'OK: quien ya no falta o no tenía motivo queda sin motivo';

    -- La app nueva manda "motivo": null a propósito (sin justificar): eso se respeta.
    perform public.daily_guardar(g, current_date, jsonb_build_array(
        jsonb_build_object('name', 'PV Ana', 'position', 1, 'completed', false, 'absent', true, 'motivo', null),
        jsonb_build_object('name', 'PV Beto', 'position', 2, 'completed', false, 'absent', true, 'motivo', 'vacaciones')));
    if (select motivo from public.daily_historial(g, current_date, current_date) where member_name = 'PV Ana') is not null
       or (select motivo from public.daily_historial(g, current_date, current_date) where member_name = 'PV Beto') is distinct from 'vacaciones' then
        raise exception 'FALLO: la app nueva no pudo cambiar o quitar un motivo';
    end if;
    raise notice 'OK: la app nueva cambia y quita motivos como siempre';
end $$ language plpgsql;

reset role;
rollback;

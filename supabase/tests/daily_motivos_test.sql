-- QA BCR Suite v3 — pruebas de motivos de ausencia e intercambio de leads del Daily
-- Ejecutar en el SQL Editor de Supabase después de 20261030000001_daily_motivos.sql.
-- Corre dentro de una transacción que termina en ROLLBACK: no deja nada guardado.
-- Cada prueba imprime "OK ..." o aborta con "FALLO ...".
-- Usa sus propios Daily ('DM-...'); los demás se desactivan solo dentro de la transacción.

begin;

insert into auth.users (id, email, raw_user_meta_data) values
    ('00000000-0000-0000-0000-0000000000d7', 'dm-lead@test.local', '{"full_name":"DM Lead"}'),
    ('00000000-0000-0000-0000-0000000000d8', 'dm-qa@test.local',   '{"full_name":"DM QA"}'),
    ('00000000-0000-0000-0000-0000000000d9', 'dm-boss@test.local', '{"full_name":"DM Boss"}');
update public.profiles set active = true, must_change_password = false, role = 'QA_LEAD' where id = '00000000-0000-0000-0000-0000000000d7';
update public.profiles set active = true, must_change_password = false, role = 'QA'      where id = '00000000-0000-0000-0000-0000000000d8';
update public.profiles set active = true, must_change_password = false, role = 'BOSS'    where id = '00000000-0000-0000-0000-0000000000d9';

update public.daily_groups set active = false;
insert into public.daily_groups (code, name) values ('DM-1', 'DM Uno'), ('DM-2', 'DM Dos');
insert into public.daily_members (daily_group_id, name)
select g.id, x.name from public.daily_groups g
join (values ('DM-1', 'DM Ana'), ('DM-1', 'DM Beto'), ('DM-1', 'DM Lead Uno'), ('DM-2', 'DM Caro'), ('DM-2', 'DM Lead Dos')) as x(code, name)
  on x.code = g.code;
insert into public.daily_rule_members (daily_member_id, rule_type)
select m.id, 'LAST_FIXED' from public.daily_members m where m.name in ('DM Lead Uno', 'DM Lead Dos');

set local role authenticated;

-- ── El motivo se guarda y vuelve ───────────────────────────
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d8","role":"authenticated"}', true);
do $$
declare g bigint; r record;
begin
    select id into g from public.daily_groups where code = 'DM-1';
    perform public.daily_guardar(g, current_date, jsonb_build_array(
        jsonb_build_object('name', 'DM Ana', 'position', 1, 'completed', false, 'absent', true, 'motivo', 'vacaciones'),
        jsonb_build_object('name', 'DM Beto', 'position', 2, 'completed', false, 'absent', true, 'motivo', 'justificada'),
        jsonb_build_object('name', 'DM Lead Uno', 'position', 3, 'completed', false, 'absent', true)));
    for r in select * from public.daily_historial(g, current_date, current_date) loop
        if (r.member_name = 'DM Ana' and r.motivo is distinct from 'vacaciones')
           or (r.member_name = 'DM Beto' and r.motivo is distinct from 'justificada')
           or (r.member_name = 'DM Lead Uno' and r.motivo is not null) then
            raise exception 'FALLO: motivo de % es %', r.member_name, r.motivo;
        end if;
    end loop;
    raise notice 'OK: el motivo se guarda y vuelve; sin motivo queda sin justificar';

    begin
        perform public.daily_guardar(g, current_date, jsonb_build_array(
            jsonb_build_object('name', 'DM Ana', 'position', 1, 'absent', true, 'motivo', 'otro')));
        raise exception 'FALLO: se aceptó un motivo inválido';
    exception when sqlstate '22023' then raise notice 'OK: un motivo inválido se rechaza';
    end;
    begin
        perform public.daily_guardar(g, current_date, jsonb_build_array(
            jsonb_build_object('name', 'DM Ana', 'position', 1, 'absent', false, 'motivo', 'vacaciones')));
        raise exception 'FALLO: se aceptó un motivo sin ausencia';
    exception when sqlstate '22023' then raise notice 'OK: un motivo sin ausencia se rechaza';
    end;

    begin
        perform public.daily_intercambiar_leads();
        raise exception 'FALLO: un QA intercambió los leads';
    exception when sqlstate '42501' then raise notice 'OK: un QA no intercambia los leads';
    end;
end $$ language plpgsql;

-- ── QA Boss sigue sin guardar ──────────────────────────────
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d9","role":"authenticated"}', true);
do $$
begin
    perform public.daily_guardar((select id from public.daily_groups where code = 'DM-1'), current_date,
        jsonb_build_array(jsonb_build_object('name', 'DM Ana', 'position', 1)));
    raise exception 'FALLO: QA Boss guardó el Daily';
exception when sqlstate '42501' then raise notice 'OK: QA Boss sigue sin guardar el Daily';
end $$ language plpgsql;

-- ── Un lead intercambia a los leads ────────────────────────
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d7","role":"authenticated"}', true);
do $$
declare n int;
begin
    select count(*) into n from public.daily_intercambiar_leads();
    if n <> 2 then raise exception 'FALLO: el intercambio devolvió % filas', n; end if;
    if (select g.code from public.daily_members m join public.daily_groups g on g.id = m.daily_group_id where m.name = 'DM Lead Uno') <> 'DM-2'
       or (select g.code from public.daily_members m join public.daily_groups g on g.id = m.daily_group_id where m.name = 'DM Lead Dos') <> 'DM-1' then
        raise exception 'FALLO: los leads no cambiaron de Daily';
    end if;
    if (select count(*) from public.daily_rule_members r join public.daily_members m on m.id = r.daily_member_id
        where m.name in ('DM Lead Uno', 'DM Lead Dos') and r.rule_type = 'LAST_FIXED') <> 2 then
        raise exception 'FALLO: los leads perdieron la regla de fijo al final';
    end if;
    raise notice 'OK: un lead intercambia a los leads y siguen fijos al final';
end $$ language plpgsql;

-- ── Con dos fijos al final en un Daily no cambia nada ──────
reset role;
insert into public.daily_rule_members (daily_member_id, rule_type)
select id, 'LAST_FIXED' from public.daily_members where name = 'DM Ana';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d7","role":"authenticated"}', true);
do $$
begin
    begin
        perform public.daily_intercambiar_leads();
        raise exception 'FALLO: se intercambió con dos fijos al final';
    exception when sqlstate '22023' then null;
    end;
    if (select g.code from public.daily_members m join public.daily_groups g on g.id = m.daily_group_id where m.name = 'DM Lead Dos') <> 'DM-1' then
        raise exception 'FALLO: cambió algo aunque no se podía';
    end if;
    raise notice 'OK: con dos fijos al final avisa y no cambia nada';
end $$ language plpgsql;

reset role;
rollback;

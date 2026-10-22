-- QA BCR Suite v3 — pruebas de proyectos, variantes y tareas para QA
-- Ejecutar en el SQL Editor de Supabase después de 20261028000001_proyectos_qa.sql.
-- Corre dentro de una transacción que termina en ROLLBACK: no deja nada guardado.
-- Cada prueba imprime "OK ..." o aborta con "FALLO ...".
-- Solo mira sus propios proyectos ('PQ-...'), así corre también en una base con datos reales.

begin;

insert into auth.users (id, email, raw_user_meta_data) values
    ('00000000-0000-0000-0000-0000000000f1', 'pq-qa@test.local',   '{"full_name":"PQ QA"}'),
    ('00000000-0000-0000-0000-0000000000f2', 'pq-qa2@test.local',  '{"full_name":"PQ QA Dos"}'),
    ('00000000-0000-0000-0000-0000000000f3', 'pq-lead@test.local', '{"full_name":"PQ Lead"}'),
    ('00000000-0000-0000-0000-0000000000f4', 'pq-beta@test.local', '{"full_name":"PQ Beta"}');
update public.profiles set active = true, must_change_password = false, role = 'QA'
where id in ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f2');
update public.profiles set active = true, must_change_password = false, role = 'QA_LEAD' where id = '00000000-0000-0000-0000-0000000000f3';
update public.profiles set active = true, must_change_password = false, role = 'BETA'    where id = '00000000-0000-0000-0000-0000000000f4';

-- Proyecto viejo, sin autor (como lo que ya existe), y uno inactivo.
insert into public.projects (code, name) values ('PQ-VIEJO', 'PQ-VIEJO');
insert into public.projects (code, name, active) values ('PQ-INACTIVO', 'PQ-INACTIVO', false);
update public.projects set created_by = null where code = 'PQ-VIEJO';

set local role authenticated;

-- ── QA agrega proyecto, variante y tareas ──────────────────
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f1","role":"authenticated"}', true);
do $$
declare p bigint; v bigint; t1 bigint; t2 bigint; pos1 int; pos2 int;
begin
    insert into public.projects (code, name, created_by)
    values ('PQ-UNO', 'PQ-UNO', '00000000-0000-0000-0000-0000000000f3') returning id into p;
    if (select created_by from public.projects where id = p) <> auth.uid() then
        raise exception 'FALLO: el proyecto no quedó con el autor real';
    end if;
    raise notice 'OK: QA agrega un proyecto y el autor no se puede falsificar';

    insert into public.project_variants (project_id, name) values (p, 'pq-var') returning id into v;
    if (select created_by from public.project_variants where id = v) <> auth.uid() then
        raise exception 'FALLO: la variante no quedó con su autor';
    end if;
    raise notice 'OK: QA agrega una variante';

    t1 := public.add_template_task(p, v, ' Tarea uno ');
    t2 := public.add_template_task(p, v, 'Tarea dos');
    select position into pos1 from public.template_tasks where id = t1;
    select position into pos2 from public.template_tasks where id = t2;
    if pos2 <> pos1 + 1 then raise exception 'FALLO: las tareas no quedaron seguidas (% y %)', pos1, pos2; end if;
    if (select task from public.template_tasks where id = t1) <> 'Tarea uno' then raise exception 'FALLO: el texto no se recortó'; end if;
    if (select created_by from public.template_tasks where id = t1) <> auth.uid() then raise exception 'FALLO: la tarea no quedó con su autor'; end if;
    raise notice 'OK: QA agrega tareas al final, con su autor';

    begin
        perform public.add_template_task(p, v, '   ');
        raise exception 'FALLO: se agregó una tarea vacía';
    exception when sqlstate '22023' then raise notice 'OK: una tarea vacía no se agrega';
    end;

    -- Tarea sin variante en el proyecto viejo.
    perform public.add_template_task((select id from public.projects where code = 'PQ-VIEJO'), null, 'Sin variante');
    if not exists (select 1 from public.template_tasks tt join public.templates tp on tp.id = tt.template_id
                   join public.projects pr on pr.id = tp.project_id
                   where pr.code = 'PQ-VIEJO' and tp.variant_id is null and tt.task = 'Sin variante') then
        raise exception 'FALLO: la tarea sin variante no fue a la plantilla sin variante';
    end if;
    raise notice 'OK: sin variante, la tarea va a la plantilla sin variante';

    update public.projects set active = true where code = 'PQ-INACTIVO';
    if (select active from public.projects where code = 'PQ-INACTIVO') then
        raise exception 'FALLO: un QA reactivó un proyecto';
    end if;
    raise notice 'OK: QA no reactiva proyectos';

    delete from public.projects where code = 'PQ-VIEJO';
    if not exists (select 1 from public.projects where code = 'PQ-VIEJO') then
        raise exception 'FALLO: QA borró un proyecto sin autor';
    end if;
    raise notice 'OK: QA no borra lo que no tiene autor';

    begin
        perform public.reorder_template_tasks((select template_id from public.template_tasks where id = t1), array[t2, t1]);
        raise exception 'FALLO: QA pudo reordenar';
    exception when sqlstate '42501' then raise notice 'OK: QA no reordena';
    end;

    begin
        perform public.save_template(p, v, array['x']);
        raise exception 'FALLO: save_template sigue disponible';
    exception when insufficient_privilege then raise notice 'OK: save_template ya no se puede usar';
    end;
end $$ language plpgsql;

-- ── Otro QA: agrega, pero no toca lo ajeno ─────────────────
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f2","role":"authenticated"}', true);
do $$
declare p bigint; v bigint; ajena bigint;
begin
    select id into p from public.projects where code = 'PQ-UNO';
    select id into v from public.project_variants where project_id = p;
    perform public.add_template_task(p, v, 'Tarea de QA dos');
    select id into ajena from public.template_tasks where task = 'Tarea uno'
      and template_id in (select id from public.templates where project_id = p);

    delete from public.template_tasks where id = ajena;
    update public.template_tasks set task = 'Pisada' where id = ajena;
    delete from public.project_variants where id = v;
    delete from public.projects where id = p;
    if not exists (select 1 from public.template_tasks where id = ajena and task = 'Tarea uno')
       or not exists (select 1 from public.project_variants where id = v)
       or not exists (select 1 from public.projects where id = p) then
        raise exception 'FALLO: un QA tocó lo de otro';
    end if;
    raise notice 'OK: un QA no borra ni edita lo de otro';
end $$ language plpgsql;

-- ── El autor edita y borra lo suyo ─────────────────────────
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f1","role":"authenticated"}', true);
do $$
declare t bigint;
begin
    select tt.id into t from public.template_tasks tt join public.templates tp on tp.id = tt.template_id
    join public.projects pr on pr.id = tp.project_id where pr.code = 'PQ-UNO' and tt.task = 'Tarea dos';
    update public.template_tasks set task = 'Tarea dos editada' where id = t;
    if (select task from public.template_tasks where id = t) <> 'Tarea dos editada' then
        raise exception 'FALLO: el autor no pudo editar su tarea';
    end if;
    delete from public.template_tasks where id = t;
    if exists (select 1 from public.template_tasks where id = t) then
        raise exception 'FALLO: el autor no pudo borrar su tarea';
    end if;
    raise notice 'OK: el autor edita y borra su tarea';
end $$ language plpgsql;

-- ── QA Lead: reordena (sin perder autores) y borra cualquier cosa ──
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f3","role":"authenticated"}', true);
do $$
declare tpl bigint; ids bigint[]; autores uuid[];
begin
    select tp.id into tpl from public.templates tp join public.projects pr on pr.id = tp.project_id
    where pr.code = 'PQ-UNO' and tp.variant_id is not null;
    select array_agg(id order by position), array_agg(created_by order by position) into ids, autores
    from public.template_tasks where template_id = tpl;

    begin
        perform public.reorder_template_tasks(tpl, ids[1:1]);
        raise exception 'FALLO: se aceptó una lista incompleta';
    exception when sqlstate '22023' then raise notice 'OK: reordenar exige todas las tareas';
    end;

    perform public.reorder_template_tasks(tpl, array[ids[2], ids[1]]);
    if (select array_agg(id order by position) from public.template_tasks where template_id = tpl) <> array[ids[2], ids[1]] then
        raise exception 'FALLO: no cambió el orden';
    end if;
    if (select array_agg(created_by order by position) from public.template_tasks where template_id = tpl) <> array[autores[2], autores[1]] then
        raise exception 'FALLO: reordenar cambió los autores';
    end if;
    raise notice 'OK: el QA Lead reordena y cada tarea conserva su autor';

    delete from public.projects where code = 'PQ-VIEJO';
    if exists (select 1 from public.projects where code = 'PQ-VIEJO') then
        raise exception 'FALLO: el QA Lead no pudo borrar un proyecto sin autor';
    end if;
    raise notice 'OK: el QA Lead borra lo que no tiene autor';
end $$ language plpgsql;

-- ── El dueño borra su proyecto aunque tenga cosas de otros ──
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f1","role":"authenticated"}', true);
do $$
begin
    delete from public.projects where code = 'PQ-UNO';
    if exists (select 1 from public.projects where code = 'PQ-UNO') then
        raise exception 'FALLO: el dueño no pudo borrar su proyecto';
    end if;
    if exists (select 1 from public.template_tasks where task = 'Tarea de QA dos') then
        raise exception 'FALLO: quedaron tareas del proyecto borrado';
    end if;
    raise notice 'OK: el dueño borra su proyecto con las tareas de otros';
end $$ language plpgsql;

-- ── Nada sobre lo inactivo, ni por la API ──────────────────
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f1","role":"authenticated"}', true);
do $$
declare inactivo bigint;
begin
    select id into inactivo from public.projects where code = 'PQ-INACTIVO';
    begin
        perform public.add_template_task(inactivo, null, 'En un inactivo');
        raise exception 'FALLO: se agregó una tarea a un proyecto inactivo';
    exception when sqlstate '22023' then raise notice 'OK: no se agregan tareas a un proyecto inactivo';
    end;
    begin
        insert into public.project_variants (project_id, name) values (inactivo, 'pq-var-inactiva');
        raise exception 'FALLO: se agregó una variante a un proyecto inactivo';
    exception when insufficient_privilege then raise notice 'OK: no se agregan variantes a un proyecto inactivo';
    end;
end $$ language plpgsql;

-- ── Si el autor deja de poder editar (pasa a BETA), ya no toca lo suyo ──
do $$
declare p bigint; t bigint;
begin
    insert into public.projects (code, name) values ('PQ-EXQA', 'PQ-EXQA') returning id into p;
    t := public.add_template_task(p, null, 'Tarea del ex QA');
    -- Lo cambia un admin (fuera de esta sesión).
    perform set_config('request.jwt.claims', '', true);
end $$ language plpgsql;
reset role;
update public.profiles set role = 'BETA' where id = '00000000-0000-0000-0000-0000000000f1';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f1","role":"authenticated"}', true);
do $$
begin
    update public.template_tasks set task = 'Pisada' where task = 'Tarea del ex QA';
    delete from public.template_tasks where task = 'Tarea del ex QA';
    delete from public.projects where code = 'PQ-EXQA';
    if not exists (select 1 from public.template_tasks where task = 'Tarea del ex QA')
       or not exists (select 1 from public.projects where code = 'PQ-EXQA') then
        raise exception 'FALLO: un autor que pasó a BETA siguió editando o borrando lo suyo';
    end if;
    raise notice 'OK: un autor que pasó a BETA ya no edita ni borra lo suyo';
end $$ language plpgsql;

-- ── BETA no agrega ─────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f4","role":"authenticated"}', true);
do $$
begin
    begin
        insert into public.projects (code, name) values ('PQ-BETA', 'PQ-BETA');
        raise exception 'FALLO: BETA agregó un proyecto';
    exception when insufficient_privilege then raise notice 'OK: BETA no agrega proyectos';
    end;
    begin
        perform public.add_template_task((select id from public.projects where code = 'PQ-INACTIVO'), null, 'x');
        raise exception 'FALLO: BETA agregó una tarea';
    exception when sqlstate '42501' then raise notice 'OK: BETA no agrega tareas';
    end;
end $$ language plpgsql;

reset role;
rollback;

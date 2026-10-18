-- QA BCR Suite v3 — Cierre de semanas en Horas
-- Un QA solo agrega, cambia o borra sus horas de la semana actual y de las dos
-- anteriores (desde el lunes de hace dos semanas, hora de Costa Rica). Las
-- semanas más viejas quedan cerradas para que no cambien informes ya enviados;
-- si hace falta corregir una, lo hace un QA_LEAD o ADMIN (sin límite).
-- La fecha nueva también cuenta: no se puede mover una línea a una semana cerrada.
-- El SQL Editor y la service_role (sin auth.uid()) no tienen límite.
-- Requiere 20261020000001_rol_beta.sql.

-- Primer día que un QA todavía puede tocar: el lunes de hace dos semanas.
create or replace function private.horas_abiertas_desde()
returns date
language sql
stable
set search_path = ''
as $$
    select (date_trunc('week', now() at time zone 'America/Costa_Rica'))::date - 14;
$$;

revoke all on function private.horas_abiertas_desde() from public, anon;
grant execute on function private.horas_abiertas_desde() to authenticated;

create or replace function public.horas_cierre()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
    v_desde date;
begin
    if auth.uid() is null or private.is_lead() then
        return coalesce(new, old);
    end if;
    v_desde := private.horas_abiertas_desde();
    if (tg_op <> 'INSERT' and old.fecha < v_desde)
       or (tg_op <> 'DELETE' and new.fecha < v_desde) then
        raise exception 'Esa semana está cerrada: solo podés cambiar horas desde el %. Para corregir una semana anterior, pedíselo a un QA Lead.',
            to_char(v_desde, 'DD/MM/YYYY');
    end if;
    return coalesce(new, old);
end;
$$;

create trigger horas_cierre
before insert or update or delete on public.horas
for each row execute function public.horas_cierre();

revoke all on function public.horas_cierre() from public, anon, authenticated;

-- QA BCR Suite v3 — Eliminar un usuario no borra sus horas
-- Antes, al eliminar un usuario se borraban en cascada sus horas y los ajustes
-- de sus horas, y cambiaban los consolidados de meses ya informados.
-- Ahora la base no deja eliminar a quien tenga horas o ajustes: la Edge Function
-- admin-create-user avisa antes, y para que no entre más se lo desactiva.
-- Quien no tiene horas se sigue eliminando igual que antes.
-- Requiere 20261019000001_feedback_y_eliminar_usuarios.sql.

alter table public.horas drop constraint if exists horas_user_id_fkey;
alter table public.horas
    add constraint horas_user_id_fkey
    foreign key (user_id) references public.profiles(id) on delete restrict;

alter table public.horas_ajustes drop constraint if exists horas_ajustes_user_id_fkey;
alter table public.horas_ajustes
    add constraint horas_ajustes_user_id_fkey
    foreign key (user_id) references public.profiles(id) on delete restrict;

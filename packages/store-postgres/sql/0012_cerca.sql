-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 Cláudio Penedo.
--
-- Reservas com dono e cerca (decisão D20, marco M5). Idempotente.
--
-- A reserva de uma tentativa já era uma troca atômica pela versão, e a conclusão de um processo que
-- perdeu a reserva já era descartada. Faltava o meio: um processo lento, com a reserva vencida e
-- tomada por outro, ainda podia gravar passos e chamar ferramentas. Agora:
--
--   • missions.cerca sobe a cada reserva (nunca desce) e missions.reservada_por diz qual processo a
--     tem (nome do processo, sem dado da pessoa);
--   • todo passo novo leva a cerca da reserva em que foi gravado, e o banco recusa passo com cerca
--     diferente da atual. Como o início de uma chamada é gravado antes da chamada (M1), o processo
--     com cerca velha não chama mais nada.

alter table obedient.missions add column if not exists cerca bigint not null default 0;
alter table obedient.missions add column if not exists reservada_por text;
do $$
begin
  if not exists (select from pg_constraint where conname = 'missions_reservada_por_tamanho') then
    alter table obedient.missions add constraint missions_reservada_por_tamanho check (reservada_por is null or length(reservada_por) between 1 and 200);
  end if;
  if not exists (select from pg_constraint where conname = 'missions_cerca_positiva') then
    alter table obedient.missions add constraint missions_cerca_positiva check (cerca >= 0);
  end if;
end $$;
grant update (cerca, reservada_por) on obedient.missions to obedient_app;

-- A cerca nunca desce.
create or replace function obedient.missions_cerca_sobe() returns trigger
  language plpgsql
  set search_path = obedient, pg_temp
  as $$
begin
  if new.cerca < old.cerca then
    raise exception 'a cerca da reserva não desce (% → %)', old.cerca, new.cerca using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists missions_cerca_sobe on obedient.missions;
create trigger missions_cerca_sobe before update of cerca on obedient.missions
  for each row execute function obedient.missions_cerca_sobe();

alter table obedient.mission_steps add column if not exists cerca bigint;

-- Passo novo só com a cerca da reserva atual. Lê a missão com a RLS de quem grava (a própria pessoa).
create or replace function obedient.mission_steps_cerca() returns trigger
  language plpgsql
  set search_path = obedient, pg_temp
  as $$
declare
  atual bigint;
begin
  select m.cerca into atual from obedient.missions m where m.id = new.mission_id;
  -- Missão que a pessoa não enxerga: a RLS e a chave estrangeira recusam adiante, como antes.
  if not found then
    return new;
  end if;
  if new.cerca is distinct from atual then
    raise exception 'cerca velha: o passo é de uma reserva que já não vale (% ≠ %)', coalesce(new.cerca::text, 'nenhuma'), atual
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists mission_steps_cerca on obedient.mission_steps;
create trigger mission_steps_cerca before insert on obedient.mission_steps
  for each row execute function obedient.mission_steps_cerca();

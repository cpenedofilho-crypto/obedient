-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 Cláudio Penedo.
--
-- Endurecimento do banco (auditoria de segurança interna, Fase 8). Idempotente. As migrations já
-- aplicadas não mudam (o hash delas é conferido): o que muda vem aqui.
--
--   • proposals: máquina de estados no banco. A RLS já separava as pessoas, mas o papel do app podia
--     inserir uma proposta já "approved" (sem grant) ou mudar o status para qualquer outro. Agora,
--     para TODO papel (o dono das tabelas inclusive, por gatilho):
--       - proposta nasce "pending", sem decisão nem execução, e com grant;
--       - só as transições do motor valem: pending → approved | rejected | expired;
--         approved → executing | rejected | expired; executing → executed | failed;
--       - aprovar exige decided_by = a própria pessoa (user_id) e decided_at;
--       - status igual (o "apagar o que o OBEDIENT sabe" esvazia o conteúdo das já decididas) não
--         pode mexer na decisão nem na execução.
--     Isto não substitui o motor (quem tem SQL na transação da pessoa ainda pode aprovar como ela):
--     fecha os atalhos que nem o motor permite.
--   • audit_chain: a conferência da entrada com as colunas usava `<>`, e com a chave faltando no JSON
--     o resultado é NULL e o IF passava (uma entrada '{}' entrava e quebrava a verificação da cadeia
--     da pessoa para sempre). Agora `is distinct from`.
--   • missions.proposta_id: a FK simples deixava uma pessoa testar se um id de proposta existe (de
--     outra pessoa: a FK não passa pela RLS). Agora a FK é composta (user_id, proposta_id).

-- ------------------------------------------------------------------- proposals: máquina de estados
create or replace function obedient.proposals_estados() returns trigger
  language plpgsql
  set search_path = obedient, pg_temp
  as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending' or new.decided_by is not null or new.decided_at is not null or new.executed_at is not null then
      raise exception 'proposta nasce pendente, sem decisão nem execução' using errcode = 'check_violation';
    end if;
    if new.grant_id is null then
      raise exception 'proposta sem grant não existe (Art. 3º)' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- UPDATE
  if new.id <> old.id or new.user_id <> old.user_id or new.grant_id is distinct from old.grant_id
     or new.payload_hash <> old.payload_hash or new.approver <> old.approver or new.created_at <> old.created_at or new.expires_at <> old.expires_at then
    raise exception 'proposta: só status, decisão, execução e o conteúdo apagado a pedido mudam' using errcode = 'check_violation';
  end if;

  if new.status = old.status then
    if new.decided_by is distinct from old.decided_by or new.decided_at is distinct from old.decided_at or new.executed_at is distinct from old.executed_at then
      raise exception 'proposta: decisão e execução só mudam junto com o status' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if not (
       (old.status = 'pending' and new.status in ('approved', 'rejected', 'expired'))
    or (old.status = 'approved' and new.status in ('executing', 'rejected', 'expired'))
    or (old.status = 'executing' and new.status in ('executed', 'failed'))
  ) then
    raise exception 'proposta: % → % não é uma transição válida', old.status, new.status using errcode = 'check_violation';
  end if;

  if new.status = 'approved' and (new.decided_by is distinct from new.user_id or new.decided_at is null) then
    raise exception 'proposta: só a própria pessoa aprova' using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke all on function obedient.proposals_estados() from public;

drop trigger if exists proposals_estados on obedient.proposals;
create trigger proposals_estados before insert or update on obedient.proposals
  for each row execute function obedient.proposals_estados();

-- ------------------------------------------------------------- auditoria: conferência sem NULL
create or replace function obedient.audit_chain() returns trigger
  language plpgsql security definer
  set search_path = obedient, pg_temp
  as $$
declare
  h record;
begin
  perform pg_advisory_xact_lock(hashtextextended('obedient.audit:' || new.user_id, 0));
  select seq, hash into h from obedient.audit_heads where user_id = new.user_id;
  if h is null then
    if new.seq <> 1 or new.prev_hash <> repeat('0', 64) then
      raise exception 'cadeia de auditoria quebrada: primeira entrada de % precisa de seq 1 e gênese', new.user_id using errcode = 'check_violation';
    end if;
    insert into obedient.audit_heads (user_id, seq, hash) values (new.user_id, new.seq, new.hash);
  else
    if new.seq <> h.seq + 1 or new.prev_hash <> h.hash then
      raise exception 'cadeia de auditoria quebrada: esperava seq % depois de %', h.seq + 1, h.hash using errcode = 'check_violation';
    end if;
    update obedient.audit_heads set seq = new.seq, hash = new.hash where user_id = new.user_id;
  end if;
  -- `is distinct from`: chave faltando no JSON (NULL) também é inconsistência.
  if (new.entry ->> 'seq') is distinct from new.seq::text or (new.entry ->> 'hash') is distinct from new.hash
     or (new.entry ->> 'prevHash') is distinct from new.prev_hash or (new.entry ->> 'userId') is distinct from new.user_id
     or (new.entry ->> 'event') is null or (new.entry ->> 'at') is null then
    raise exception 'entrada de auditoria inconsistente com as colunas' using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke all on function obedient.audit_chain() from public;

-- ------------------------------------------------- missions.proposta_id: FK presa à mesma pessoa
do $$
begin
  if not exists (select from pg_constraint where conname = 'proposals_user_id_id_key') then
    alter table obedient.proposals add constraint proposals_user_id_id_key unique (user_id, id);
  end if;
  if exists (select from pg_constraint where conname = 'missions_proposta_id_fkey') then
    alter table obedient.missions drop constraint missions_proposta_id_fkey;
  end if;
  if not exists (select from pg_constraint where conname = 'missions_proposta_da_pessoa') then
    alter table obedient.missions add constraint missions_proposta_da_pessoa
      foreign key (user_id, proposta_id) references obedient.proposals (user_id, id);
  end if;
end $$;

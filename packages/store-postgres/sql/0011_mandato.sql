-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 Cláudio Penedo.
--
-- Mandato da missão e teto do mês (decisão D20, marco M4; D21; D22). Idempotente.
--
--   • missions.mandato_ferramentas: a lista de ferramentas (nome ou prefixo com *) que a missão pode
--     usar; null = as que a pessoa conectou. missions.prazo_final_em: depois dele, a missão termina.
--     Os dois fixos depois da criação (o app não altera);
--   • obedient.mission_spend: o gasto de cada tentativa, só inserção, para o teto de R$ 300 por mês.
--     "Apagar o que o OBEDIENT sabe" NÃO apaga o gasto: é contabilidade sem conteúdo da pessoa, e
--     apagá-lo zeraria o teto do mês;
--   • transição nova: created → blocked (o teto do mês pode parar a missão antes da primeira tentativa).

alter table obedient.missions add column if not exists mandato_ferramentas jsonb;
alter table obedient.missions add column if not exists prazo_final_em timestamptz;
do $$
begin
  if not exists (select from pg_constraint where conname = 'missions_mandato_lista') then
    alter table obedient.missions add constraint missions_mandato_lista
      check (mandato_ferramentas is null or (jsonb_typeof(mandato_ferramentas) = 'array' and jsonb_array_length(mandato_ferramentas) between 1 and 30));
  end if;
end $$;
grant update (mandato_ferramentas) on obedient.missions to obedient_eraser;

create table if not exists obedient.mission_spend (
  id bigserial primary key,
  user_id text not null,
  mission_id text not null references obedient.missions(id) on delete cascade,
  tentativa integer not null check (tentativa >= 0),
  centavos integer not null check (centavos > 0),
  em timestamptz not null
);
create index if not exists mission_spend_user_em on obedient.mission_spend (user_id, em);

alter table obedient.mission_spend enable row level security;
alter table obedient.mission_spend force row level security;
drop policy if exists mission_spend_owner on obedient.mission_spend;
create policy mission_spend_owner on obedient.mission_spend to obedient_app
  using (user_id = obedient.current_user_id()) with check (user_id = obedient.current_user_id());
revoke all on obedient.mission_spend from public, obedient_app, obedient_operator, obedient_auth, obedient_eraser;
grant select, insert on obedient.mission_spend to obedient_app;
grant usage on sequence obedient.mission_spend_id_seq to obedient_app;

insert into obedient.mission_transitions (de, para) values ('created', 'blocked') on conflict do nothing;

create or replace function obedient.apagar_meus_dados(p_now timestamptz)
  returns jsonb
  language plpgsql security definer
  set search_path = obedient, pg_temp
  as $$
declare
  u text := obedient.current_user_id();
  n_memorias integer;
  n_pedidos integer;
  n_grants integer;
  n_consentimentos integer;
  n_ops integer;
  n_missoes integer;
  n_passos integer;
  n_evidencias integer;
begin
  if u is null then raise exception 'sem usuário na transação'; end if;

  delete from obedient.memories where user_id = u;
  get diagnostics n_memorias = row_count;

  delete from obedient.mission_steps where user_id = u;
  get diagnostics n_passos = row_count;

  delete from obedient.mission_evidence where user_id = u;
  get diagnostics n_evidencias = row_count;

  update obedient.missions
     set objetivo = '(apagado a pedido da pessoa)',
         criterios = '[]'::jsonb,
         mandato_ferramentas = null,
         desfecho_explicacao = case when desfecho_explicacao is null then null else '(apagado a pedido da pessoa)' end,
         impedimento = case when estado in ('created', 'planning', 'running', 'verifying', 'retrying', 'waiting_approval', 'blocked') then null else impedimento end,
         estado = case when estado in ('created', 'planning', 'running', 'verifying', 'retrying', 'waiting_approval', 'blocked') then 'cancelled' else estado end,
         proxima_tentativa_em = null,
         rodada = null,
         atualizada_em = p_now,
         versao = versao + 1
   where user_id = u;
  get diagnostics n_missoes = row_count;

  update obedient.proposals
     set payload = '{}'::jsonb,
         summary = '(apagado a pedido da pessoa)',
         status = case when status in ('pending', 'approved') then 'rejected' else status end,
         decided_by = case when status in ('pending', 'approved') then 'apagado-a-pedido' else decided_by end,
         decided_at = case when status in ('pending', 'approved') then p_now else decided_at end
   where user_id = u;
  get diagnostics n_pedidos = row_count;

  update obedient.grants
     set purpose = '(apagado a pedido da pessoa)',
         revoked_at = coalesce(revoked_at, p_now),
         revoked_by = coalesce(revoked_by, 'apagado-a-pedido')
   where user_id = u;
  get diagnostics n_grants = row_count;

  update obedient.consents set revoked_at = p_now where user_id = u and revoked_at is null;
  get diagnostics n_consentimentos = row_count;

  delete from obedient.client_ops where user_id = u;
  get diagnostics n_ops = row_count;

  return jsonb_build_object(
    'memorias', n_memorias, 'pedidos', n_pedidos, 'autorizacoes', n_grants,
    'consentimentos_revogados', n_consentimentos, 'acoes_do_aparelho', n_ops, 'missoes', n_missoes,
    'passos', n_passos, 'evidencias', n_evidencias
  );
end $$;
alter function obedient.apagar_meus_dados(timestamptz) owner to obedient_eraser;
revoke all on function obedient.apagar_meus_dados(timestamptz) from public;
grant execute on function obedient.apagar_meus_dados(timestamptz) to obedient_app;

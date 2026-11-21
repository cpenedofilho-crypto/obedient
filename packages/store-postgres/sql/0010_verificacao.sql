-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 Cláudio Penedo.
--
-- Critérios de conclusão e evidências (decisão D20, marco M3). Idempotente.
--
--   • missions.criterios: a lista de critérios fixada na criação (lista fechada de tipos, validada no
--     código); o app não altera depois de criada;
--   • obedient.mission_evidence: o que o verificador conferiu, critério a critério, antes de a missão
--     terminar. Só inserção, RLS por pessoa. Guarda referências (passos, hash do resultado) e uma frase
--     curta, nunca o resultado em si;
--   • a transição running → completed sai da tabela: terminar passa sempre por verifying;
--   • "apagar o que o OBEDIENT sabe" apaga as evidências e esvazia os critérios.

alter table obedient.missions add column if not exists criterios jsonb not null default '[]'::jsonb;
do $$
begin
  if not exists (select from pg_constraint where conname = 'missions_criterios_lista') then
    alter table obedient.missions add constraint missions_criterios_lista
      check (jsonb_typeof(criterios) = 'array' and jsonb_array_length(criterios) <= 10 and pg_column_size(criterios) <= 40000);
  end if;
end $$;
grant update (criterios) on obedient.missions to obedient_eraser;

create table if not exists obedient.mission_evidence (
  mission_id text not null references obedient.missions(id) on delete cascade,
  user_id text not null,
  tentativa integer not null check (tentativa >= 0),
  seq integer not null check (seq >= 1),
  criterio integer check (criterio >= 0),
  tipo text not null check (tipo in ('ferramenta_ok', 'resultado_conforme', 'sem_criterio', 'nao_sei')),
  ok boolean not null,
  referencia text check (length(referencia) <= 400),
  detalhe text not null check (length(detalhe) between 1 and 500),
  criado_em timestamptz not null,
  primary key (mission_id, seq),
  check ((tipo in ('sem_criterio', 'nao_sei')) = (criterio is null))
);
create index if not exists mission_evidence_user on obedient.mission_evidence (user_id);

alter table obedient.mission_evidence enable row level security;
alter table obedient.mission_evidence force row level security;
drop policy if exists mission_evidence_owner on obedient.mission_evidence;
create policy mission_evidence_owner on obedient.mission_evidence to obedient_app
  using (user_id = obedient.current_user_id()) with check (user_id = obedient.current_user_id());
revoke all on obedient.mission_evidence from public, obedient_app, obedient_operator, obedient_auth, obedient_eraser;
grant select, insert on obedient.mission_evidence to obedient_app;
grant select, delete on obedient.mission_evidence to obedient_eraser;
drop policy if exists mission_evidence_eraser on obedient.mission_evidence;
create policy mission_evidence_eraser on obedient.mission_evidence to obedient_eraser
  using (user_id = obedient.current_user_id());

-- Terminar passa sempre por verifying.
delete from obedient.mission_transitions where de = 'running' and para = 'completed';

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

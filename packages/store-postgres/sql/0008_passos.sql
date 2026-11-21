-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 Cláudio Penedo.
--
-- O registro de passos das missões (decisão D20, marco M1). Idempotente.
--
-- Até aqui, uma tentativa só deixava rastro no fim: a conversa salva (missions.rodada) e a trilha de
-- auditoria. Se o processo caísse no meio, a tentativa inteira se perdia, e uma ferramenta chamada
-- nesse trecho podia rodar de novo na tentativa seguinte. Agora cada passo vira uma linha:
--
--   • 'inicio' é gravado ANTES de chamar uma ferramenta governada, com a chave de idempotência do
--     passo (missão:tentativa:passo); o fim do mesmo passo ('ferramenta' ou 'retomada') aponta para
--     ele em fecha_tentativa/fecha_seq;
--   • na tentativa seguinte, um 'inicio' sem fim é fechado com uma linha 'incerto'. Leitura segue;
--     qualquer outra categoria para a missão até a pessoa conferir (nada é repetido sozinho);
--   • só inserção: o app não altera nem apaga linha. Guarda o nome da ferramenta, a categoria, o hash
--     dos argumentos e a decisão, nunca os argumentos nem o resultado;
--   • "apagar o que o OBEDIENT sabe" apaga os passos da pessoa.

create table if not exists obedient.mission_steps (
  mission_id text not null references obedient.missions(id) on delete cascade,
  user_id text not null,
  tentativa integer not null check (tentativa >= 0),
  seq integer not null check (seq >= 1),
  tipo text not null check (tipo in ('modelo', 'inicio', 'ferramenta', 'recusada', 'retomada', 'incerto')),
  status text not null check (length(status) between 1 and 60),
  decisao text check (length(decisao) <= 200),
  ferramenta text check (length(ferramenta) <= 200),
  categoria text check (categoria in ('READ', 'WRITE', 'COMMUNICATION', 'FINANCIAL', 'LEGAL', 'DESTRUCTIVE')),
  hash_argumentos text check (hash_argumentos ~ '^[0-9a-f]{64}$'),
  chave text check (length(chave) <= 200),
  aprovacao_id text,
  fecha_tentativa integer,
  fecha_seq integer,
  tokens_entrada integer check (tokens_entrada >= 0),
  tokens_saida integer check (tokens_saida >= 0),
  criado_em timestamptz not null,
  primary key (mission_id, tentativa, seq),
  -- Um 'inicio' tem chave e categoria; o que fecha aponta para um passo anterior.
  check (tipo <> 'inicio' or (chave is not null and categoria is not null)),
  check ((fecha_tentativa is null) = (fecha_seq is null)),
  check (tipo <> 'incerto' or fecha_seq is not null)
);
create index if not exists mission_steps_user on obedient.mission_steps (user_id);

alter table obedient.mission_steps enable row level security;
alter table obedient.mission_steps force row level security;

drop policy if exists mission_steps_owner on obedient.mission_steps;
create policy mission_steps_owner on obedient.mission_steps to obedient_app
  using (user_id = obedient.current_user_id()) with check (user_id = obedient.current_user_id());

revoke all on obedient.mission_steps from public, obedient_app, obedient_operator, obedient_auth, obedient_eraser;
grant select, insert on obedient.mission_steps to obedient_app;

-- Quem apaga só apaga as linhas da própria pessoa.
grant select, delete on obedient.mission_steps to obedient_eraser;
drop policy if exists mission_steps_eraser on obedient.mission_steps;
create policy mission_steps_eraser on obedient.mission_steps to obedient_eraser
  using (user_id = obedient.current_user_id());

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
begin
  if u is null then raise exception 'sem usuário na transação'; end if;

  delete from obedient.memories where user_id = u;
  get diagnostics n_memorias = row_count;

  delete from obedient.mission_steps where user_id = u;
  get diagnostics n_passos = row_count;

  update obedient.missions
     set objetivo = '(apagado a pedido da pessoa)',
         desfecho_explicacao = case when desfecho_explicacao is null then null else '(apagado a pedido da pessoa)' end,
         impedimento = case when estado in ('running', 'waiting_approval', 'blocked') then null else impedimento end,
         estado = case when estado in ('running', 'waiting_approval', 'blocked') then 'cancelled' else estado end,
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
    'passos', n_passos
  );
end $$;
alter function obedient.apagar_meus_dados(timestamptz) owner to obedient_eraser;
revoke all on function obedient.apagar_meus_dados(timestamptz) from public;
grant execute on function obedient.apagar_meus_dados(timestamptz) to obedient_app;

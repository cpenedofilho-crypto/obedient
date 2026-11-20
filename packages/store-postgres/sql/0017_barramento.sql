-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 Cláudio Penedo.
--
-- Barramento de eventos em Postgres (decisão D20, marco M7; G10). Idempotente.
--
-- A mesma semântica do barramento em memória (@obedient/event-bus, memoria.ts) e do despachante do
-- Growth OS (casa-de-ia/src/event-bus/despachar.ts), com o tenant sendo a PESSOA:
--   • obedient.events: só inserção; idempotente por (pessoa, fonte, chave) com o hash do conteúdo
--     (mesma chave e conteúdo diferente é conflito, no código);
--   • obedient.event_subscriptions: o consumidor e os padrões de tipo que ele quer;
--   • obedient.event_deliveries: uma por evento e assinatura que casa. Reivindicada com FOR UPDATE SKIP
--     LOCKED, com trava com prazo (locked_until) e dono (locked_by): só o dono da trava grava o desfecho
--     (cerca). Falha volta com espera crescente até 6 h; esgotou, dead_letter;
--   • RLS por pessoa; o agendador só descobre QUEM tem entrega devida (função), nunca lê evento;
--   • "apagar o que o OBEDIENT sabe" apaga eventos, entregas e assinaturas da pessoa.

create table if not exists obedient.events (
  id uuid primary key,
  user_id text not null,
  type text not null check (type ~ '^[a-z]+(_[a-z]+)*(\.[a-z]+(_[a-z]+)*)*$'),
  source text not null check (length(source) between 1 and 40),
  entity_type text not null check (length(entity_type) between 1 and 40),
  entity_id text not null check (length(entity_id) between 1 and 200),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 40000),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 10000),
  correlation_id text check (length(correlation_id) <= 200),
  causation_id uuid,
  priority integer not null default 5 check (priority between 0 and 9),
  occurred_at timestamptz not null,
  created_at timestamptz not null,
  idempotency_key text check (length(idempotency_key) <= 200),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$')
);
create unique index if not exists events_idempotencia on obedient.events (user_id, source, idempotency_key) where idempotency_key is not null;
create index if not exists events_user on obedient.events (user_id, created_at);

create table if not exists obedient.event_subscriptions (
  id uuid primary key,
  user_id text not null,
  consumer text not null check (consumer ~ '^[a-z0-9]+([-_.][a-z0-9]+)*$'),
  padroes text[] not null check (cardinality(padroes) between 1 and 20),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  backoff_seconds integer not null default 30 check (backoff_seconds between 1 and 3600),
  ativa boolean not null default true,
  created_at timestamptz not null,
  unique (user_id, consumer)
);

create table if not exists obedient.event_deliveries (
  id uuid primary key,
  user_id text not null,
  event_id uuid not null references obedient.events(id) on delete cascade,
  consumer text not null,
  status text not null check (status in ('pending', 'processing', 'processed', 'failed', 'dead_letter')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null check (max_attempts between 1 and 20),
  backoff_seconds integer not null check (backoff_seconds between 1 and 3600),
  priority integer not null check (priority between 0 and 9),
  next_attempt_at timestamptz not null,
  locked_until timestamptz,
  locked_by text check (length(locked_by) <= 200),
  last_error text check (length(last_error) <= 500),
  result jsonb,
  unique (event_id, consumer),
  check ((status = 'processing') = (locked_by is not null))
);
create index if not exists event_deliveries_devidas on obedient.event_deliveries (user_id, next_attempt_at) where status in ('pending', 'failed', 'processing');

alter table obedient.events enable row level security;
alter table obedient.events force row level security;
alter table obedient.event_subscriptions enable row level security;
alter table obedient.event_subscriptions force row level security;
alter table obedient.event_deliveries enable row level security;
alter table obedient.event_deliveries force row level security;
drop policy if exists events_owner on obedient.events;
create policy events_owner on obedient.events to obedient_app
  using (user_id = obedient.current_user_id()) with check (user_id = obedient.current_user_id());
drop policy if exists event_subscriptions_owner on obedient.event_subscriptions;
create policy event_subscriptions_owner on obedient.event_subscriptions to obedient_app
  using (user_id = obedient.current_user_id()) with check (user_id = obedient.current_user_id());
drop policy if exists event_deliveries_owner on obedient.event_deliveries;
create policy event_deliveries_owner on obedient.event_deliveries to obedient_app
  using (user_id = obedient.current_user_id()) with check (user_id = obedient.current_user_id());

revoke all on obedient.events, obedient.event_subscriptions, obedient.event_deliveries from public, obedient_app, obedient_operator, obedient_auth, obedient_eraser;
-- Evento é fato: só inserção.
grant select, insert on obedient.events to obedient_app;
grant select, insert on obedient.event_subscriptions to obedient_app;
grant update (ativa) on obedient.event_subscriptions to obedient_app;
grant select, insert on obedient.event_deliveries to obedient_app;
grant update (status, attempts, next_attempt_at, locked_until, locked_by, last_error, result) on obedient.event_deliveries to obedient_app;

-- Quem apaga só apaga o da própria pessoa.
grant select, delete on obedient.events, obedient.event_subscriptions, obedient.event_deliveries to obedient_eraser;
drop policy if exists events_eraser on obedient.events;
create policy events_eraser on obedient.events to obedient_eraser using (user_id = obedient.current_user_id());
drop policy if exists event_subscriptions_eraser on obedient.event_subscriptions;
create policy event_subscriptions_eraser on obedient.event_subscriptions to obedient_eraser using (user_id = obedient.current_user_id());
drop policy if exists event_deliveries_eraser on obedient.event_deliveries;
create policy event_deliveries_eraser on obedient.event_deliveries to obedient_eraser using (user_id = obedient.current_user_id());

-- O agendador descobre QUEM tem entrega devida (pendente, falha vencida ou trava vencida); não lê evento.
grant select (user_id, status, next_attempt_at, locked_until) on obedient.event_deliveries to obedient_scheduler;
drop policy if exists scheduler_le on obedient.event_deliveries;
create policy scheduler_le on obedient.event_deliveries for select to obedient_scheduler using (true);

create or replace function obedient.pessoas_com_entrega_devida(p_now timestamptz, p_limite integer)
  returns setof text
  language sql stable security definer
  set search_path = obedient, pg_temp
  as $$
  select distinct d.user_id
    from obedient.event_deliveries d
   where (d.status in ('pending', 'failed') and d.next_attempt_at <= p_now)
      or (d.status = 'processing' and d.locked_until < p_now)
   order by d.user_id
   limit least(greatest(p_limite, 1), 1000)
$$;
alter function obedient.pessoas_com_entrega_devida(timestamptz, integer) owner to obedient_scheduler;
revoke all on function obedient.pessoas_com_entrega_devida(timestamptz, integer) from public;
grant execute on function obedient.pessoas_com_entrega_devida(timestamptz, integer) to obedient_operator;

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
  n_tarefas integer;
  n_eventos integer;
begin
  if u is null then raise exception 'sem usuário na transação'; end if;

  delete from obedient.memories where user_id = u;
  get diagnostics n_memorias = row_count;

  delete from obedient.mission_steps where user_id = u;
  get diagnostics n_passos = row_count;

  delete from obedient.mission_evidence where user_id = u;
  get diagnostics n_evidencias = row_count;

  -- O plano tem o texto das tarefas: some junto (as dependências caem em cascata).
  delete from obedient.mission_tasks where user_id = u;
  get diagnostics n_tarefas = row_count;

  -- Barramento (0017): eventos, entregas (em cascata) e assinaturas da pessoa.
  delete from obedient.events where user_id = u;
  get diagnostics n_eventos = row_count;
  delete from obedient.event_subscriptions where user_id = u;

  update obedient.missions
     set objetivo = '(apagado a pedido da pessoa)',
         criterios = '[]'::jsonb,
         mandato_ferramentas = null,
         plano_hash = null,
         plano_aprovado_em = null,
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
    'passos', n_passos, 'evidencias', n_evidencias, 'tarefas', n_tarefas, 'eventos', n_eventos
  );
end $$;
alter function obedient.apagar_meus_dados(timestamptz) owner to obedient_eraser;
revoke all on function obedient.apagar_meus_dados(timestamptz) from public;
grant execute on function obedient.apagar_meus_dados(timestamptz) to obedient_app;

-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 Cláudio Penedo.
--
-- Conexões com sistemas de fora (Fase 7). Idempotente.
--
--   • oauth_states: o fluxo OAuth em andamento. Uso único, 10 minutos, preso ao usuário que iniciou
--     E ao navegador que iniciou (hash de um nonce que fica num cookie). O retorno do provedor chega
--     sem a sessão (o cookie dela é SameSite=Strict), então quem o lê é o papel de entrada;
--   • connections: a credencial da pessoa em cada integração, CIFRADA (o banco só vê bytes; a chave
--     fica fora dele) e presa ao usuário e à integração pela própria cifra;
--   • token_revocations: credenciais a revogar no provedor (desconectar, parar, apagar). Revogar é
--     chamada de rede, feita fora da transação; a fila garante que nada se perde se ela falhar.

create table if not exists obedient.oauth_states (
  state_hash text primary key,
  user_id text not null,
  integracao text not null,
  nonce_hash text not null,
  verifier_cifra bytea not null,
  chave_id text not null,
  criado_em timestamptz not null,
  expira_em timestamptz not null,
  usado_em timestamptz
);

create table if not exists obedient.connections (
  user_id text not null,
  integracao text not null,
  escopos text[] not null,
  cifra bytea not null,
  chave_id text not null,
  conectada_em timestamptz not null,
  atualizada_em timestamptz not null,
  primary key (user_id, integracao)
);

create table if not exists obedient.token_revocations (
  id text primary key,
  user_id text not null,
  integracao text not null,
  cifra bytea not null,
  chave_id text not null,
  motivo text not null,
  criada_em timestamptz not null,
  tentativas integer not null default 0
);
create index if not exists token_revocations_user on obedient.token_revocations (user_id);

alter table obedient.oauth_states enable row level security;
alter table obedient.oauth_states force row level security;
alter table obedient.connections enable row level security;
alter table obedient.connections force row level security;
alter table obedient.token_revocations enable row level security;
alter table obedient.token_revocations force row level security;

-- A pessoa inicia o fluxo (só para si); o papel de entrada lê e gasta o state no retorno.
drop policy if exists oauth_states_owner on obedient.oauth_states;
create policy oauth_states_owner on obedient.oauth_states for insert to obedient_app with check (user_id = obedient.current_user_id());
drop policy if exists oauth_states_auth on obedient.oauth_states;
create policy oauth_states_auth on obedient.oauth_states to obedient_auth using (true) with check (true);

drop policy if exists connections_owner on obedient.connections;
create policy connections_owner on obedient.connections to obedient_app
  using (user_id = obedient.current_user_id()) with check (user_id = obedient.current_user_id());
drop policy if exists token_revocations_owner on obedient.token_revocations;
create policy token_revocations_owner on obedient.token_revocations to obedient_app
  using (user_id = obedient.current_user_id()) with check (user_id = obedient.current_user_id());

revoke all on obedient.oauth_states, obedient.connections, obedient.token_revocations from public, obedient_app, obedient_operator, obedient_auth, obedient_eraser;
grant insert on obedient.oauth_states to obedient_app;
grant select on obedient.oauth_states to obedient_auth;
grant update (usado_em) on obedient.oauth_states to obedient_auth;
grant select, insert, delete on obedient.connections to obedient_app;
grant update (escopos, cifra, chave_id, atualizada_em) on obedient.connections to obedient_app;
grant select, insert, delete on obedient.token_revocations to obedient_app;
grant update (tentativas) on obedient.token_revocations to obedient_app;

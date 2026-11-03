-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 Cláudio Penedo.
--
-- Identidade e fila do aparelho (Fase 5). Idempotente.
--
--   • passkeys (WebAuthn): a pessoa entra e reautentica com o aparelho, sem senha. A chave privada
--     nunca sai do aparelho; o banco guarda só a chave pública e o contador;
--   • desafios de uso único, com prazo curto;
--   • convite: código de uso único que cadastra a PRIMEIRA passkey de um usuário (gerado pela linha
--     de comando do dono do servidor; o banco guarda só o hash);
--   • client_ops: cada ação do app carrega um id gerado no aparelho. Reenviar a mesma ação devolve o
--     mesmo resultado em vez de fazer de novo (padrão client_op_id do Ronda).
--
-- Credenciais, desafios e convites são só do papel obedient_auth (o serviço de entrada). O papel do
-- app não lê nenhuma dessas tabelas.

create table if not exists obedient.credentials (
  id text primary key,
  user_id text not null,
  public_key bytea not null,
  counter bigint not null default 0,
  transports text[] not null default '{}',
  created_at timestamptz not null,
  last_used_at timestamptz
);
create index if not exists credentials_user on obedient.credentials (user_id);

create table if not exists obedient.auth_challenges (
  challenge text primary key,
  user_id text,
  purpose text not null check (purpose in ('enroll', 'login', 'reauth')),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  used_at timestamptz
);

create table if not exists obedient.invites (
  code_hash text primary key,
  user_id text not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  used_at timestamptz
);

create table if not exists obedient.client_ops (
  user_id text not null,
  op_id text not null check (op_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  kind text not null,
  result jsonb not null,
  created_at timestamptz not null,
  primary key (user_id, op_id)
);

alter table obedient.credentials enable row level security;
alter table obedient.credentials force row level security;
alter table obedient.auth_challenges enable row level security;
alter table obedient.auth_challenges force row level security;
-- Convites: sem FORCE, porque quem cria é o dono do schema, pela linha de comando (src/cli.ts do
-- servidor). O papel de entrada continua preso à policy.
alter table obedient.invites enable row level security;
alter table obedient.client_ops enable row level security;
alter table obedient.client_ops force row level security;

-- O serviço de entrada vê todas as credenciais: é ele que descobre de quem é a passkey apresentada.
drop policy if exists credentials_auth on obedient.credentials;
create policy credentials_auth on obedient.credentials to obedient_auth using (true) with check (true);
drop policy if exists challenges_auth on obedient.auth_challenges;
create policy challenges_auth on obedient.auth_challenges to obedient_auth using (true) with check (true);
drop policy if exists invites_auth on obedient.invites;
create policy invites_auth on obedient.invites to obedient_auth using (true) with check (true);

drop policy if exists client_ops_owner on obedient.client_ops;
create policy client_ops_owner on obedient.client_ops to obedient_app
  using (user_id = obedient.current_user_id()) with check (user_id = obedient.current_user_id());

revoke all on obedient.credentials, obedient.auth_challenges, obedient.invites, obedient.client_ops from public, obedient_app, obedient_operator, obedient_auth;

grant select, insert on obedient.credentials to obedient_auth;
grant update (counter, last_used_at) on obedient.credentials to obedient_auth;
grant select, insert on obedient.auth_challenges to obedient_auth;
grant update (used_at) on obedient.auth_challenges to obedient_auth;
grant select on obedient.invites to obedient_auth;
grant update (used_at) on obedient.invites to obedient_auth;

grant select, insert on obedient.client_ops to obedient_app;

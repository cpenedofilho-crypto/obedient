-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 Cláudio Penedo.
--
-- Persistência do Ethics Engine (Fase 4b). Idempotente: rodar duas vezes não muda nada.
--
-- Três barreiras, nesta ordem:
--   1. papéis sem login e com o mínimo de privilégio (obedient_app, obedient_operator, obedient_auth);
--   2. RLS FORÇADA em toda tabela: a linha é do usuário de obedient.current_user_id(), que só a
--      sessão autenticada grava (src/sessao.ts), com SET LOCAL dentro da transação;
--   3. a trilha de auditoria é só de inclusão, e a cadeia de hash é conferida pelo próprio banco.
--
-- O servidor conecta com um papel de login que é MEMBRO desses papéis e não é dono das tabelas
-- nem superusuário (ver docs/architecture/persistencia.md).

create schema if not exists obedient;

do $$
begin
  if not exists (select from pg_roles where rolname = 'obedient_app') then create role obedient_app nologin; end if;
  if not exists (select from pg_roles where rolname = 'obedient_operator') then create role obedient_operator nologin; end if;
  if not exists (select from pg_roles where rolname = 'obedient_auth') then create role obedient_auth nologin; end if;
end $$;

grant usage on schema obedient to obedient_app, obedient_operator, obedient_auth;

-- Quem é o usuário desta transação. Vazio = ninguém (e então nenhuma policy casa).
create or replace function obedient.current_user_id() returns text
  language sql stable
  as $$ select nullif(current_setting('obedient.user_id', true), '') $$;

-- ------------------------------------------------------------------------------------- grants (Art. 3º)
create table if not exists obedient.grants (
  id text primary key,
  user_id text not null,
  agent_id text not null,
  system_id text,
  capability text not null,
  purpose text not null,
  limits jsonb not null,
  expires_at timestamptz not null,
  granted_at timestamptz not null,
  granted_by text not null,
  revoked_at timestamptz,
  revoked_by text,
  parent_id text references obedient.grants(id),
  constitution_version text not null,
  check (user_id <> agent_id)
);
create index if not exists grants_user on obedient.grants (user_id);

-- ------------------------------------------------------------------------------- consents (Art. 4º)
create table if not exists obedient.consents (
  id text primary key,
  user_id text not null,
  purpose text not null,
  category text not null,
  given_at timestamptz not null,
  specific boolean not null,
  expires_at timestamptz,
  revoked_at timestamptz
);
create index if not exists consents_user on obedient.consents (user_id);

-- ---------------------------------------------------------------------------- proposals (Art. 1º e 12)
create table if not exists obedient.proposals (
  id text primary key,
  user_id text not null,
  requested_by text not null,
  payload jsonb not null,
  payload_hash text not null,
  summary text not null,
  approver text not null check (approver in ('user', 'user_strong_auth')),
  reason text not null,
  grant_id text references obedient.grants(id),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  status text not null check (status in ('pending', 'approved', 'rejected', 'expired', 'executing', 'executed', 'failed')),
  decided_by text,
  decided_at timestamptz,
  executed_at timestamptz
);
create index if not exists proposals_user on obedient.proposals (user_id);

-- ------------------------------------------------------------------------------ emergency stop (Art. 9º)
-- scope_key: 'global' (user_id nulo) ou 'user:<id>'.
create table if not exists obedient.emergency_stops (
  scope_key text primary key,
  user_id text,
  engaged_at timestamptz not null,
  engaged_by text not null,
  reason text not null,
  check ((scope_key = 'global' and user_id is null) or (scope_key = 'user:' || user_id))
);

-- ---------------------------------------------------------------------------------- audit (Art. 8º)
create table if not exists obedient.audit_log (
  user_id text not null,
  seq integer not null check (seq >= 1),
  prev_hash text not null,
  hash text not null,
  entry jsonb not null,
  primary key (user_id, seq)
);

-- Cabeça da cadeia de cada usuário. Só o gatilho escreve aqui.
create table if not exists obedient.audit_heads (
  user_id text primary key,
  seq integer not null,
  hash text not null
);

-- --------------------------------------------------------------------------------------- sessions
-- Guarda o HASH do token, nunca o token. Nenhum papel lê a tabela: só as funções abaixo.
create table if not exists obedient.sessions (
  token_hash text primary key,
  user_id text not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  strong_auth_at timestamptz,
  revoked_at timestamptz
);

-- ============================================================================== RLS (forçada)
alter table obedient.grants enable row level security;
alter table obedient.grants force row level security;
alter table obedient.consents enable row level security;
alter table obedient.consents force row level security;
alter table obedient.proposals enable row level security;
alter table obedient.proposals force row level security;
alter table obedient.emergency_stops enable row level security;
alter table obedient.emergency_stops force row level security;
alter table obedient.audit_log enable row level security;
alter table obedient.audit_log force row level security;
-- audit_heads e sessions: RLS ligada sem FORCE. Só as funções SECURITY DEFINER (dono) escrevem
-- nelas; nenhum outro papel tem policy de escrita, e sessions não tem policy nenhuma.
alter table obedient.audit_heads enable row level security;
alter table obedient.sessions enable row level security;

-- Usuário: só as próprias linhas.
drop policy if exists grants_owner on obedient.grants;
create policy grants_owner on obedient.grants to obedient_app
  using (user_id = obedient.current_user_id()) with check (user_id = obedient.current_user_id());

drop policy if exists consents_owner on obedient.consents;
create policy consents_owner on obedient.consents to obedient_app
  using (user_id = obedient.current_user_id()) with check (user_id = obedient.current_user_id());

drop policy if exists proposals_owner on obedient.proposals;
create policy proposals_owner on obedient.proposals to obedient_app
  using (user_id = obedient.current_user_id()) with check (user_id = obedient.current_user_id());

-- A parada global é LIDA por todo usuário (bloqueia todos); só o operador a grava.
drop policy if exists stops_read on obedient.emergency_stops;
create policy stops_read on obedient.emergency_stops for select to obedient_app
  using (user_id is null or user_id = obedient.current_user_id());
drop policy if exists stops_own_insert on obedient.emergency_stops;
create policy stops_own_insert on obedient.emergency_stops for insert to obedient_app
  with check (user_id = obedient.current_user_id());
drop policy if exists stops_own_update on obedient.emergency_stops;
create policy stops_own_update on obedient.emergency_stops for update to obedient_app
  using (user_id = obedient.current_user_id()) with check (user_id = obedient.current_user_id());
drop policy if exists stops_own_delete on obedient.emergency_stops;
create policy stops_own_delete on obedient.emergency_stops for delete to obedient_app
  using (user_id = obedient.current_user_id());
drop policy if exists stops_global on obedient.emergency_stops;
create policy stops_global on obedient.emergency_stops to obedient_operator
  using (user_id is null) with check (user_id is null);

drop policy if exists audit_owner_read on obedient.audit_log;
create policy audit_owner_read on obedient.audit_log for select to obedient_app
  using (user_id = obedient.current_user_id());
drop policy if exists audit_owner_insert on obedient.audit_log;
create policy audit_owner_insert on obedient.audit_log for insert to obedient_app
  with check (user_id = obedient.current_user_id());
-- O operador só escreve e lê a cadeia que não é de ninguém ("*": parada global).
drop policy if exists audit_operator on obedient.audit_log;
create policy audit_operator on obedient.audit_log to obedient_operator
  using (user_id = '*') with check (user_id = '*');

drop policy if exists heads_owner_read on obedient.audit_heads;
create policy heads_owner_read on obedient.audit_heads for select to obedient_app
  using (user_id = obedient.current_user_id());
drop policy if exists heads_operator_read on obedient.audit_heads;
create policy heads_operator_read on obedient.audit_heads for select to obedient_operator
  using (user_id = '*');
-- sessions: nenhuma policy e nenhum privilégio. Ninguém além do dono lê ou escreve direto.

-- =========================================================================== privilégios mínimos
revoke all on all tables in schema obedient from public, obedient_app, obedient_operator, obedient_auth;

grant select, insert on obedient.grants to obedient_app;
grant update (revoked_at, revoked_by) on obedient.grants to obedient_app;

grant select, insert on obedient.consents to obedient_app;
grant update (revoked_at) on obedient.consents to obedient_app;

grant select, insert on obedient.proposals to obedient_app;
grant update (status, decided_by, decided_at, executed_at) on obedient.proposals to obedient_app;

grant select, insert, update, delete on obedient.emergency_stops to obedient_app, obedient_operator;

-- Auditoria: só incluir e ler. Sem UPDATE nem DELETE para ninguém.
grant select, insert on obedient.audit_log to obedient_app, obedient_operator;
grant select on obedient.audit_heads to obedient_app, obedient_operator;

-- ================================================================== auditoria: só inclusão e cadeia
-- Nem o dono da tabela edita ou apaga: o gatilho recusa. Correção = entrada nova.
create or replace function obedient.audit_immutable() returns trigger
  language plpgsql
  as $$
begin
  raise exception 'a trilha de auditoria é só de inclusão (Art. 8º)' using errcode = 'insufficient_privilege';
end $$;

drop trigger if exists audit_no_update on obedient.audit_log;
create trigger audit_no_update before update or delete on obedient.audit_log
  for each row execute function obedient.audit_immutable();
drop trigger if exists audit_no_truncate on obedient.audit_log;
create trigger audit_no_truncate before truncate on obedient.audit_log
  for each statement execute function obedient.audit_immutable();

-- A entrada nova tem de continuar a cadeia do usuário: seq = cabeça + 1 e prev_hash = hash da
-- cabeça. Trava por usuário (advisory lock da transação), então duas gravações simultâneas do mesmo
-- usuário entram uma depois da outra. SECURITY DEFINER porque o papel do app não escreve na cabeça.
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
  if (new.entry ->> 'seq')::int <> new.seq or new.entry ->> 'hash' <> new.hash or new.entry ->> 'prevHash' <> new.prev_hash or new.entry ->> 'userId' <> new.user_id then
    raise exception 'entrada de auditoria inconsistente com as colunas' using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke all on function obedient.audit_chain() from public;

drop trigger if exists audit_chain on obedient.audit_log;
create trigger audit_chain before insert on obedient.audit_log
  for each row execute function obedient.audit_chain();

-- Trava que o app toma ANTES de ler a cabeça (a leitura e a gravação ficam na mesma vez).
create or replace function obedient.audit_lock(p_user_id text) returns void
  language sql
  as $$ select pg_advisory_xact_lock(hashtextextended('obedient.audit:' || p_user_id, 0)) $$;
grant execute on function obedient.audit_lock(text) to obedient_app, obedient_operator;

-- ============================================================================== sessões
-- Emitir, elevar e resolver é do serviço de autenticação (obedient_auth), depois de verificar a
-- pessoa no provedor de identidade. O app não lê a tabela.
create or replace function obedient.session_issue(p_token_hash text, p_user_id text, p_now timestamptz, p_expires_at timestamptz, p_strong boolean)
  returns void
  language plpgsql security definer
  set search_path = obedient, pg_temp
  as $$
begin
  if p_user_id is null or p_user_id = '' or p_user_id = '*' then raise exception 'usuário inválido'; end if;
  if p_expires_at <= p_now then raise exception 'sessão já nasceria vencida'; end if;
  insert into obedient.sessions (token_hash, user_id, created_at, expires_at, strong_auth_at)
    values (p_token_hash, p_user_id, p_now, p_expires_at, case when p_strong then p_now end);
end $$;

create or replace function obedient.session_resolve(p_token_hash text, p_now timestamptz)
  returns table (user_id text, strong_auth_at timestamptz, expires_at timestamptz)
  language sql stable security definer
  set search_path = obedient, pg_temp
  as $$
    select s.user_id, s.strong_auth_at, s.expires_at from obedient.sessions s
     where s.token_hash = p_token_hash and s.revoked_at is null and s.expires_at > p_now
  $$;

create or replace function obedient.session_elevate(p_token_hash text, p_now timestamptz)
  returns boolean
  language plpgsql security definer
  set search_path = obedient, pg_temp
  as $$
begin
  update obedient.sessions set strong_auth_at = p_now
   where token_hash = p_token_hash and revoked_at is null and expires_at > p_now;
  return found;
end $$;

create or replace function obedient.session_revoke(p_token_hash text, p_now timestamptz)
  returns boolean
  language plpgsql security definer
  set search_path = obedient, pg_temp
  as $$
begin
  update obedient.sessions set revoked_at = p_now where token_hash = p_token_hash and revoked_at is null;
  return found;
end $$;

-- Encerrar todas as sessões de um usuário (parada de emergência, troca de credencial). O app só
-- encerra as do próprio usuário da transação.
create or replace function obedient.session_revoke_user(p_now timestamptz)
  returns integer
  language plpgsql security definer
  set search_path = obedient, pg_temp
  as $$
declare n integer;
begin
  if obedient.current_user_id() is null then raise exception 'sem usuário na transação'; end if;
  update obedient.sessions set revoked_at = p_now where user_id = obedient.current_user_id() and revoked_at is null;
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function obedient.session_issue(text, text, timestamptz, timestamptz, boolean) from public;
revoke all on function obedient.session_resolve(text, timestamptz) from public;
revoke all on function obedient.session_elevate(text, timestamptz) from public;
revoke all on function obedient.session_revoke(text, timestamptz) from public;
revoke all on function obedient.session_revoke_user(timestamptz) from public;
grant execute on function obedient.session_issue(text, text, timestamptz, timestamptz, boolean) to obedient_auth;
grant execute on function obedient.session_resolve(text, timestamptz) to obedient_auth;
grant execute on function obedient.session_elevate(text, timestamptz) to obedient_auth;
grant execute on function obedient.session_revoke(text, timestamptz) to obedient_auth;
grant execute on function obedient.session_revoke_user(timestamptz) to obedient_app;

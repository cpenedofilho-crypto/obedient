-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 Cláudio Penedo.
--
-- Memória pessoal (Art. 10) e direitos do titular (Art. 13; LGPD art. 18). Idempotente.
--
--   • memories: o que o agente aprendeu, por categoria. O app lê, inclui e apaga (a pessoa apaga
--     uma lição; desligar uma categoria apaga as dela);
--   • contestations: a pessoa contesta uma entrada da trilha. Fica registrada e não se edita pelo app;
--   • obedient.apagar_meus_dados(): "apague o que você sabe sobre mim" num passo só. O que apaga e
--     o que guarda (e por quê) está em docs/architecture/memoria-e-direitos.md.

create table if not exists obedient.memories (
  id text primary key,
  user_id text not null,
  categoria text not null,
  texto text not null check (length(texto) between 1 and 500),
  agente text not null,
  aprendida_em timestamptz not null
);
create index if not exists memories_user on obedient.memories (user_id);

create table if not exists obedient.contestations (
  id text primary key,
  user_id text not null,
  audit_seq integer not null check (audit_seq >= 1),
  motivo text not null check (length(motivo) between 1 and 1000),
  criada_em timestamptz not null,
  status text not null default 'aberta' check (status in ('aberta', 'respondida')),
  resposta text,
  respondida_em timestamptz,
  -- Só se contesta entrada que existe na trilha do próprio usuário.
  foreign key (user_id, audit_seq) references obedient.audit_log (user_id, seq)
);
create index if not exists contestations_user on obedient.contestations (user_id);

alter table obedient.memories enable row level security;
alter table obedient.memories force row level security;
alter table obedient.contestations enable row level security;
alter table obedient.contestations force row level security;

drop policy if exists memories_owner on obedient.memories;
create policy memories_owner on obedient.memories to obedient_app
  using (user_id = obedient.current_user_id()) with check (user_id = obedient.current_user_id());
drop policy if exists contestations_owner on obedient.contestations;
create policy contestations_owner on obedient.contestations to obedient_app
  using (user_id = obedient.current_user_id()) with check (user_id = obedient.current_user_id());

revoke all on obedient.memories, obedient.contestations from public, obedient_app, obedient_operator, obedient_auth;
grant select, insert, delete on obedient.memories to obedient_app;
grant select, insert on obedient.contestations to obedient_app;

-- Papel que só apaga. A função abaixo roda como ELE (dono da função), não como o dono das tabelas:
-- com RLS forçada, o dono das tabelas não enxerga linha nenhuma, e a função apagaria zero linhas em
-- silêncio. Este papel tem policy por usuário e privilégio só nas colunas que a função esvazia.
do $$
begin
  if not exists (select from pg_roles where rolname = 'obedient_eraser') then create role obedient_eraser nologin; end if;
end $$;
grant obedient_eraser to current_user;
grant usage on schema obedient to obedient_eraser;
revoke all on all tables in schema obedient from obedient_eraser;
grant select, delete on obedient.memories, obedient.client_ops to obedient_eraser;
grant select on obedient.proposals, obedient.grants, obedient.consents to obedient_eraser;
grant update (payload, summary, status, decided_by, decided_at) on obedient.proposals to obedient_eraser;
grant update (purpose, revoked_at, revoked_by) on obedient.grants to obedient_eraser;
grant update (revoked_at) on obedient.consents to obedient_eraser;
do $$
declare t text;
begin
  foreach t in array array['memories', 'client_ops', 'proposals', 'grants', 'consents'] loop
    execute format('drop policy if exists eraser_owner on obedient.%I', t);
    execute format('create policy eraser_owner on obedient.%I to obedient_eraser using (user_id = obedient.current_user_id()) with check (user_id = obedient.current_user_id())', t);
  end loop;
end $$;

-- "Apague o que você sabe sobre mim", num passo, para o usuário da transação e só para ele.
--   apaga:   lições da memória; ações do aparelho já resolvidas (client_ops);
--   esvazia: o conteúdo dos pedidos (argumentos e resumo) e a finalidade escrita nos grants;
--   encerra: pedidos que esperavam (recusados), grants (revogados), consentimentos (revogados);
--   guarda:  a trilha (só de inclusão: guarda nomes de ferramenta, hashes e motivos, nunca o
--            conteúdo; LGPD art. 16, I e II, e art. 37), o REGISTRO dos consentimentos (prova de que
--            houve consentimento, LGPD art. 8º, §2º) e as contestações (são reclamação da pessoa).
-- SECURITY DEFINER com dono obedient_eraser: esvaziar colunas que o app não pode mudar (payload,
-- purpose) é justamente o que se quer só aqui, e a RLS por usuário continua valendo dentro dela.
-- O usuário vem da transação; sem ele, a função recusa.
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
begin
  if u is null then raise exception 'sem usuário na transação'; end if;

  delete from obedient.memories where user_id = u;
  get diagnostics n_memorias = row_count;

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
    'consentimentos_revogados', n_consentimentos, 'acoes_do_aparelho', n_ops
  );
end $$;
alter function obedient.apagar_meus_dados(timestamptz) owner to obedient_eraser;
revoke all on function obedient.apagar_meus_dados(timestamptz) from public;
grant execute on function obedient.apagar_meus_dados(timestamptz) to obedient_app;

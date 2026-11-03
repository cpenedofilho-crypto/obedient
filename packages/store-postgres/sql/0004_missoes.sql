-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 Cláudio Penedo.
--
-- Missões (Arts. 5º e 7º) e a identificação das mensagens enviadas em nome da pessoa (Art. 5º).
-- Idempotente.

create table if not exists obedient.missions (
  id text primary key,
  user_id text not null,
  agente text not null,
  objetivo text not null check (length(objetivo) between 1 and 2000),
  estado text not null check (estado in ('running', 'waiting_approval', 'blocked', 'completed', 'failed', 'cancelled')),
  impedimento text,
  desfecho_tipo text check (desfecho_tipo in ('feito', 'nao_sei', 'nao_consegui')),
  desfecho_explicacao text check (length(desfecho_explicacao) <= 2000),
  tentativas integer not null check (tentativas >= 0),
  -- Art. 7º no banco também: teto de tentativas e de custo têm limite, e a missão impedida diz por quê.
  max_tentativas integer not null check (max_tentativas between 1 and 5),
  proxima_tentativa_em timestamptz,
  custo_centavos integer not null check (custo_centavos >= 0),
  teto_custo_centavos integer not null check (teto_custo_centavos between 1 and 10000),
  proposta_id text references obedient.proposals(id),
  criada_em timestamptz not null,
  atualizada_em timestamptz not null,
  versao integer not null check (versao >= 1),
  check (estado <> 'blocked' or impedimento is not null),
  check (estado <> 'completed' or desfecho_tipo is not null),
  check (tentativas <= max_tentativas)
);
create index if not exists missions_user on obedient.missions (user_id);

create table if not exists obedient.preferences (
  user_id text primary key,
  identificacao text check (length(identificacao) between 3 and 200),
  atualizada_em timestamptz not null
);

alter table obedient.missions enable row level security;
alter table obedient.missions force row level security;
alter table obedient.preferences enable row level security;
alter table obedient.preferences force row level security;

drop policy if exists missions_owner on obedient.missions;
create policy missions_owner on obedient.missions to obedient_app
  using (user_id = obedient.current_user_id()) with check (user_id = obedient.current_user_id());
drop policy if exists preferences_owner on obedient.preferences;
create policy preferences_owner on obedient.preferences to obedient_app
  using (user_id = obedient.current_user_id()) with check (user_id = obedient.current_user_id());

revoke all on obedient.missions, obedient.preferences from public, obedient_app, obedient_operator, obedient_auth, obedient_eraser;
grant select, insert on obedient.missions to obedient_app;
-- O objetivo, o agente e o dono não mudam depois de criada.
grant update (estado, impedimento, desfecho_tipo, desfecho_explicacao, tentativas, proxima_tentativa_em, custo_centavos, teto_custo_centavos, proposta_id, atualizada_em, versao)
  on obedient.missions to obedient_app;
grant select, insert on obedient.preferences to obedient_app;
grant update (identificacao, atualizada_em) on obedient.preferences to obedient_app;

-- "Apagar o que o OBEDIENT sabe" passa a cobrir as missões: o objetivo e a explicação são texto da
-- pessoa (esvaziados) e as abertas são canceladas. Fica o esqueleto (estado, tentativas, custo).
grant select on obedient.missions to obedient_eraser;
grant update (objetivo, estado, impedimento, desfecho_explicacao, proxima_tentativa_em, atualizada_em, versao) on obedient.missions to obedient_eraser;
drop policy if exists eraser_owner on obedient.missions;
create policy eraser_owner on obedient.missions to obedient_eraser
  using (user_id = obedient.current_user_id()) with check (user_id = obedient.current_user_id());

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
begin
  if u is null then raise exception 'sem usuário na transação'; end if;

  delete from obedient.memories where user_id = u;
  get diagnostics n_memorias = row_count;

  update obedient.missions
     set objetivo = '(apagado a pedido da pessoa)',
         desfecho_explicacao = case when desfecho_explicacao is null then null else '(apagado a pedido da pessoa)' end,
         impedimento = case when estado in ('running', 'waiting_approval', 'blocked') then null else impedimento end,
         estado = case when estado in ('running', 'waiting_approval', 'blocked') then 'cancelled' else estado end,
         proxima_tentativa_em = null,
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
    'consentimentos_revogados', n_consentimentos, 'acoes_do_aparelho', n_ops, 'missoes', n_missoes
  );
end $$;
alter function obedient.apagar_meus_dados(timestamptz) owner to obedient_eraser;
revoke all on function obedient.apagar_meus_dados(timestamptz) from public;
grant execute on function obedient.apagar_meus_dados(timestamptz) to obedient_app;

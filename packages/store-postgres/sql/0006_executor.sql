-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 Cláudio Penedo.
--
-- O executor das missões (Fase 7, parte 3). Idempotente.
--
--   • missions.rodada: onde a tentativa parou (a conversa com o modelo), para continuar dali depois
--     da aprovação ou de uma falha passageira. É conteúdo da pessoa: o app grava, e "apagar o que o
--     OBEDIENT sabe" esvazia;
--   • o agendador: um papel que só vê QUEM tem missão para andar agora (o id da pessoa), por uma
--     função. Nada do conteúdo das missões, dos pedidos ou de qualquer outra tabela.

alter table obedient.missions add column if not exists rodada jsonb;
do $$
begin
  if not exists (select from pg_constraint where conname = 'missions_rodada_tamanho') then
    alter table obedient.missions add constraint missions_rodada_tamanho check (rodada is null or pg_column_size(rodada) <= 2000000);
  end if;
end $$;
grant update (rodada) on obedient.missions to obedient_app;
grant update (rodada) on obedient.missions to obedient_eraser;

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
    'consentimentos_revogados', n_consentimentos, 'acoes_do_aparelho', n_ops, 'missoes', n_missoes
  );
end $$;
alter function obedient.apagar_meus_dados(timestamptz) owner to obedient_eraser;
revoke all on function obedient.apagar_meus_dados(timestamptz) from public;
grant execute on function obedient.apagar_meus_dados(timestamptz) to obedient_app;

-- O agendador. Como o papel que apaga, ele é dono da função e tem policy própria: com RLS forçada,
-- ninguém mais vê linha de outra pessoa. Privilégio só nas colunas que a função precisa.
do $$
begin
  if not exists (select from pg_roles where rolname = 'obedient_scheduler') then create role obedient_scheduler nologin; end if;
end $$;
grant obedient_scheduler to current_user;
grant usage on schema obedient to obedient_scheduler;
revoke all on all tables in schema obedient from obedient_scheduler;
grant select (user_id, estado, proxima_tentativa_em, proposta_id) on obedient.missions to obedient_scheduler;
grant select (id, status, expires_at) on obedient.proposals to obedient_scheduler;
drop policy if exists scheduler_le on obedient.missions;
create policy scheduler_le on obedient.missions for select to obedient_scheduler using (true);
drop policy if exists scheduler_le on obedient.proposals;
create policy scheduler_le on obedient.proposals for select to obedient_scheduler using (true);

-- Quem tem missão para andar agora: tentativa vencida, ou pedido de aprovação já decidido (ou vencido:
-- o pedido só vira 'expired' quando alguém o lê, e é a missão que vai lê-lo).
-- Devolve só o id da pessoa, e no máximo p_limite.
create or replace function obedient.pessoas_com_missao_devida(p_now timestamptz, p_limite integer)
  returns setof text
  language sql stable security definer
  set search_path = obedient, pg_temp
  as $$
  select distinct m.user_id
    from obedient.missions m
    left join obedient.proposals p on p.id = m.proposta_id
   where (m.estado = 'running' and m.proxima_tentativa_em <= p_now)
      or (m.estado = 'waiting_approval' and (p.id is null or p.status <> 'pending' or p.expires_at <= p_now))
   order by m.user_id
   limit least(greatest(p_limite, 1), 1000)
$$;
alter function obedient.pessoas_com_missao_devida(timestamptz, integer) owner to obedient_scheduler;
revoke all on function obedient.pessoas_com_missao_devida(timestamptz, integer) from public;
grant execute on function obedient.pessoas_com_missao_devida(timestamptz, integer) to obedient_operator;

-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 Cláudio Penedo.
--
-- Estados da missão e a tabela única de transições (decisão D20, marco M2). Idempotente.
--
--   • estados novos: created (criada, esperando a primeira tentativa), planning (o plano está sendo
--     feito, M5), verifying (os critérios estão sendo conferidos, M3) e retrying (falhou de passagem e
--     espera a hora da próxima tentativa). Até aqui, "esperando tentativa" era um 'running' sem reserva;
--   • obedient.mission_transitions guarda os pares permitidos, os mesmos de TRANSICOES em
--     packages/missions (um teste compara as duas). Um gatilho recusa qualquer troca de estado fora dela,
--     mesmo que o código erre, e toda missão nasce 'created';
--   • as missões que já existiam: 'running' sem reserva vira 'created' (nenhuma tentativa ainda) ou
--     'retrying' (já tentou); 'running' com reserva continua 'running';
--   • o agendador e "apagar o que o OBEDIENT sabe" passam a conhecer os estados novos.

alter table obedient.missions drop constraint if exists missions_estado_check;
alter table obedient.missions add constraint missions_estado_check
  check (estado in ('created', 'planning', 'running', 'verifying', 'retrying', 'waiting_approval', 'blocked', 'completed', 'failed', 'cancelled'));

create table if not exists obedient.mission_transitions (
  de text not null,
  para text not null,
  primary key (de, para)
);
delete from obedient.mission_transitions;
insert into obedient.mission_transitions (de, para) values
  ('created', 'planning'),
  ('created', 'running'),
  ('created', 'failed'),
  ('created', 'cancelled'),
  ('planning', 'running'),
  ('planning', 'waiting_approval'),
  ('planning', 'blocked'),
  ('planning', 'failed'),
  ('planning', 'cancelled'),
  ('running', 'verifying'),
  ('running', 'waiting_approval'),
  ('running', 'retrying'),
  ('running', 'blocked'),
  ('running', 'completed'),
  ('running', 'failed'),
  ('running', 'cancelled'),
  ('verifying', 'completed'),
  ('verifying', 'running'),
  ('verifying', 'blocked'),
  ('verifying', 'failed'),
  ('verifying', 'cancelled'),
  ('retrying', 'running'),
  ('retrying', 'blocked'),
  ('retrying', 'failed'),
  ('retrying', 'cancelled'),
  ('waiting_approval', 'running'),
  ('waiting_approval', 'blocked'),
  ('waiting_approval', 'failed'),
  ('waiting_approval', 'cancelled'),
  ('blocked', 'retrying'),
  ('blocked', 'planning'),
  ('blocked', 'running'),
  ('blocked', 'failed'),
  ('blocked', 'cancelled');
revoke all on obedient.mission_transitions from public, obedient_app, obedient_operator, obedient_auth, obedient_eraser;
grant select on obedient.mission_transitions to obedient_app;

-- Missões que já existiam. Com RLS forçada, nem o dono da tabela vê as linhas: tira a força só aqui.
alter table obedient.missions no force row level security;
update obedient.missions
   set estado = case when tentativas = 0 then 'created' else 'retrying' end
 where estado = 'running' and reservada_ate is null;
alter table obedient.missions force row level security;

-- Esperar tentativa sempre tem hora marcada (antes valia só para 'running').
alter table obedient.missions drop constraint if exists missions_running_tem_proxima;
do $$
begin
  if not exists (select from pg_constraint where conname = 'missions_devida_tem_proxima') then
    alter table obedient.missions add constraint missions_devida_tem_proxima
      check (estado not in ('created', 'running', 'retrying') or proxima_tentativa_em is not null);
  end if;
end $$;

create or replace function obedient.missions_transicao()
  returns trigger
  language plpgsql security definer
  set search_path = obedient, pg_temp
  as $$
begin
  if tg_op = 'INSERT' then
    if new.estado <> 'created' then
      raise exception 'missão nasce created, não %', new.estado using errcode = 'check_violation';
    end if;
  elsif new.estado is distinct from old.estado
        and not exists (select 1 from obedient.mission_transitions t where t.de = old.estado and t.para = new.estado) then
    raise exception 'transição de estado não permitida: % → %', old.estado, new.estado using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke all on function obedient.missions_transicao() from public;
drop trigger if exists missions_transicao on obedient.missions;
create trigger missions_transicao before insert or update of estado on obedient.missions
  for each row execute function obedient.missions_transicao();

create or replace function obedient.pessoas_com_missao_devida(p_now timestamptz, p_limite integer)
  returns setof text
  language sql stable security definer
  set search_path = obedient, pg_temp
  as $$
  select distinct m.user_id
    from obedient.missions m
    left join obedient.proposals p on p.id = m.proposta_id
   where (m.estado in ('created', 'retrying', 'running') and m.proxima_tentativa_em <= p_now)
      or (m.estado = 'waiting_approval' and (p.id is null or p.status <> 'pending' or p.expires_at <= p_now))
   order by m.user_id
   limit least(greatest(p_limite, 1), 1000)
$$;
alter function obedient.pessoas_com_missao_devida(timestamptz, integer) owner to obedient_scheduler;
revoke all on function obedient.pessoas_com_missao_devida(timestamptz, integer) from public;
grant execute on function obedient.pessoas_com_missao_devida(timestamptz, integer) to obedient_operator;

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
    'passos', n_passos
  );
end $$;
alter function obedient.apagar_meus_dados(timestamptz) owner to obedient_eraser;
revoke all on function obedient.apagar_meus_dados(timestamptz) from public;
grant execute on function obedient.apagar_meus_dados(timestamptz) to obedient_app;

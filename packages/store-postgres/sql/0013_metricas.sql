-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 Cláudio Penedo.
--
-- Saúde e métricas do servidor (decisão D20, marco M5). Idempotente.
--
-- O operador não lê missão de ninguém (RLS). As métricas saem de duas funções que devolvem só
-- NÚMEROS SOMADOS sobre todas as pessoas (nenhum id, objetivo, ferramenta ou texto), donas de um
-- papel próprio, obedient_metrics, que enxerga só as colunas de que as contas precisam:
--
--   • obedient.metricas(p_now): missões por estado, reservas vencidas, pedidos de aprovação
--     pendentes, passos das últimas 24 h por tipo, gasto do mês e de pessoas no teto, parada geral;
--   • obedient.migracoes_aplicadas(): nome e hash das migrations aplicadas, para a rota de prontidão
--     conferir com as do código.

do $$
begin
  if not exists (select from pg_roles where rolname = 'obedient_metrics') then create role obedient_metrics nologin; end if;
end $$;
grant obedient_metrics to current_user;
grant usage on schema obedient to obedient_metrics;
revoke all on all tables in schema obedient from obedient_metrics;

grant select (estado, reservada_ate, user_id) on obedient.missions to obedient_metrics;
grant select (status, expires_at) on obedient.proposals to obedient_metrics;
grant select (tipo, criado_em) on obedient.mission_steps to obedient_metrics;
grant select (user_id, centavos, em) on obedient.mission_spend to obedient_metrics;
grant select (scope_key) on obedient.emergency_stops to obedient_metrics;
grant select (name, hash) on obedient.schema_migrations to obedient_metrics;

drop policy if exists metricas_le on obedient.missions;
create policy metricas_le on obedient.missions for select to obedient_metrics using (true);
drop policy if exists metricas_le on obedient.proposals;
create policy metricas_le on obedient.proposals for select to obedient_metrics using (true);
drop policy if exists metricas_le on obedient.mission_steps;
create policy metricas_le on obedient.mission_steps for select to obedient_metrics using (true);
drop policy if exists metricas_le on obedient.mission_spend;
create policy metricas_le on obedient.mission_spend for select to obedient_metrics using (true);
drop policy if exists metricas_le on obedient.emergency_stops;
create policy metricas_le on obedient.emergency_stops for select to obedient_metrics using (true);

create or replace function obedient.metricas(p_now timestamptz, p_inicio_mes timestamptz, p_teto_mes integer)
  returns jsonb
  language sql stable security definer
  set search_path = obedient, pg_temp
  as $$
  select jsonb_build_object(
    'missoes_por_estado', coalesce((select jsonb_object_agg(estado, n) from (select estado, count(*) as n from obedient.missions group by estado) e), '{}'::jsonb),
    'reservas_vencidas', (select count(*) from obedient.missions where estado in ('running', 'verifying') and reservada_ate is not null and reservada_ate < p_now),
    'aprovacoes_pendentes', (select count(*) from obedient.proposals where status = 'pending' and expires_at > p_now),
    'passos_24h_por_tipo', coalesce((select jsonb_object_agg(tipo, n) from (select tipo, count(*) as n from obedient.mission_steps where criado_em > p_now - interval '24 hours' group by tipo) t), '{}'::jsonb),
    'gasto_mes_centavos', (select coalesce(sum(centavos), 0) from obedient.mission_spend where em >= p_inicio_mes),
    'pessoas_no_teto_mes', (select count(*) from (select user_id from obedient.mission_spend where em >= p_inicio_mes group by user_id having sum(centavos) >= p_teto_mes) x),
    'parada_geral', exists (select 1 from obedient.emergency_stops where scope_key = 'global')
  )
$$;
alter function obedient.metricas(timestamptz, timestamptz, integer) owner to obedient_metrics;
revoke all on function obedient.metricas(timestamptz, timestamptz, integer) from public;
grant execute on function obedient.metricas(timestamptz, timestamptz, integer) to obedient_operator;

create or replace function obedient.migracoes_aplicadas()
  returns table (name text, hash text)
  language sql stable security definer
  set search_path = obedient, pg_temp
  as $$ select name, hash from obedient.schema_migrations order by name $$;
alter function obedient.migracoes_aplicadas() owner to obedient_metrics;
revoke all on function obedient.migracoes_aplicadas() from public;
grant execute on function obedient.migracoes_aplicadas() to obedient_operator;

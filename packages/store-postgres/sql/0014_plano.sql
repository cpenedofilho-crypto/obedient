-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 Cláudio Penedo.
--
-- O plano da missão em DAG (decisão D20, marco M5; G5). Idempotente.
--
--   • missions.planejar (fixo na criação), missions.plano_versao (sobe a cada plano novo),
--     missions.plano_hash (o plano em vigor; null = nenhum) e missions.plano_aprovado_em;
--   • obedient.mission_tasks: as tarefas de cada versão do plano (só inserção; o app só muda o estado
--     de pendente para feita). obedient.mission_task_deps: as dependências, da mesma missão e versão,
--     sem aresta de um nó (o ciclo maior o código recusa antes, em validarPlano);
--   • o banco recusa marcar feita uma tarefa cuja dependência não esteja feita, e desfazer uma feita;
--   • transições novas: planning → retrying e retrying → planning (falha passageira do planejador);
--   • evidência nova: plano_completo;
--   • o agendador não pega missão que espera a pessoa aprovar o plano;
--   • "apagar o que o OBEDIENT sabe" apaga as tarefas e tira o plano.

alter table obedient.missions add column if not exists planejar boolean not null default false;
alter table obedient.missions add column if not exists plano_versao integer not null default 0;
alter table obedient.missions add column if not exists plano_hash text;
alter table obedient.missions add column if not exists plano_aprovado_em timestamptz;
do $$
begin
  if not exists (select from pg_constraint where conname = 'missions_plano_hash_formato') then
    alter table obedient.missions add constraint missions_plano_hash_formato check (plano_hash is null or plano_hash ~ '^[0-9a-f]{64}$');
  end if;
  if not exists (select from pg_constraint where conname = 'missions_plano_aprovado_tem_plano') then
    alter table obedient.missions add constraint missions_plano_aprovado_tem_plano check (plano_aprovado_em is null or plano_hash is not null);
  end if;
  if not exists (select from pg_constraint where conname = 'missions_plano_versao_positiva') then
    alter table obedient.missions add constraint missions_plano_versao_positiva check (plano_versao >= 0);
  end if;
end $$;
grant update (plano_versao, plano_hash, plano_aprovado_em) on obedient.missions to obedient_app;
grant update (plano_hash, plano_aprovado_em) on obedient.missions to obedient_eraser;
grant select (plano_hash, plano_aprovado_em) on obedient.missions to obedient_scheduler;

create table if not exists obedient.mission_tasks (
  mission_id text not null references obedient.missions(id) on delete cascade,
  user_id text not null,
  versao integer not null check (versao >= 1),
  chave text not null check (chave ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  ordem integer not null check (ordem between 0 and 29),
  titulo text not null check (length(titulo) between 3 and 200),
  estado text not null default 'pendente' check (estado in ('pendente', 'feita')),
  feita_em timestamptz,
  feita_tentativa integer,
  criado_em timestamptz not null,
  primary key (mission_id, versao, chave),
  unique (mission_id, versao, ordem),
  check ((estado = 'feita') = (feita_em is not null))
);
create index if not exists mission_tasks_user on obedient.mission_tasks (user_id);

create table if not exists obedient.mission_task_deps (
  mission_id text not null,
  user_id text not null,
  versao integer not null,
  chave text not null,
  depende_de text not null,
  primary key (mission_id, versao, chave, depende_de),
  check (chave <> depende_de),
  foreign key (mission_id, versao, chave) references obedient.mission_tasks (mission_id, versao, chave) on delete cascade,
  foreign key (mission_id, versao, depende_de) references obedient.mission_tasks (mission_id, versao, chave) on delete cascade
);

alter table obedient.mission_tasks enable row level security;
alter table obedient.mission_tasks force row level security;
alter table obedient.mission_task_deps enable row level security;
alter table obedient.mission_task_deps force row level security;
drop policy if exists mission_tasks_owner on obedient.mission_tasks;
create policy mission_tasks_owner on obedient.mission_tasks to obedient_app
  using (user_id = obedient.current_user_id()) with check (user_id = obedient.current_user_id());
drop policy if exists mission_task_deps_owner on obedient.mission_task_deps;
create policy mission_task_deps_owner on obedient.mission_task_deps to obedient_app
  using (user_id = obedient.current_user_id()) with check (user_id = obedient.current_user_id());
drop policy if exists mission_tasks_eraser on obedient.mission_tasks;
create policy mission_tasks_eraser on obedient.mission_tasks to obedient_eraser using (user_id = obedient.current_user_id());
drop policy if exists mission_task_deps_eraser on obedient.mission_task_deps;
create policy mission_task_deps_eraser on obedient.mission_task_deps to obedient_eraser using (user_id = obedient.current_user_id());

revoke all on obedient.mission_tasks from public, obedient_app, obedient_operator, obedient_auth, obedient_eraser;
revoke all on obedient.mission_task_deps from public, obedient_app, obedient_operator, obedient_auth, obedient_eraser;
grant select, insert on obedient.mission_tasks to obedient_app;
grant update (estado, feita_em, feita_tentativa) on obedient.mission_tasks to obedient_app;
grant select, insert on obedient.mission_task_deps to obedient_app;
grant select, delete on obedient.mission_tasks to obedient_eraser;
grant select, delete on obedient.mission_task_deps to obedient_eraser;

-- A dependência é da mesma pessoa que a tarefa (a chave estrangeira já garante missão e versão).
create or replace function obedient.mission_task_deps_dono() returns trigger
  language plpgsql
  set search_path = obedient, pg_temp
  as $$
begin
  if not exists (select 1 from obedient.mission_tasks t where t.mission_id = new.mission_id and t.versao = new.versao and t.chave = new.chave and t.user_id = new.user_id) then
    raise exception 'dependência de tarefa de outra pessoa' using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists mission_task_deps_dono on obedient.mission_task_deps;
create trigger mission_task_deps_dono before insert on obedient.mission_task_deps
  for each row execute function obedient.mission_task_deps_dono();

-- Feita é para sempre, e só depois de todas as dependências.
create or replace function obedient.mission_tasks_feita() returns trigger
  language plpgsql
  set search_path = obedient, pg_temp
  as $$
begin
  if old.estado = 'feita' and new.estado <> 'feita' then
    raise exception 'tarefa feita não volta a pendente' using errcode = 'check_violation';
  end if;
  if new.estado = 'feita' and old.estado <> 'feita' and exists (
       select 1 from obedient.mission_task_deps d
         join obedient.mission_tasks t on t.mission_id = d.mission_id and t.versao = d.versao and t.chave = d.depende_de
        where d.mission_id = new.mission_id and d.versao = new.versao and d.chave = new.chave and t.estado <> 'feita') then
    raise exception 'tarefa com dependência pendente não pode ser marcada feita' using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists mission_tasks_feita on obedient.mission_tasks;
create trigger mission_tasks_feita before update of estado on obedient.mission_tasks
  for each row execute function obedient.mission_tasks_feita();

insert into obedient.mission_transitions (de, para) values ('planning', 'retrying'), ('retrying', 'planning') on conflict do nothing;

-- Evidência nova: plano_completo (sem critério, como sem_criterio e nao_sei).
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'obedient.mission_evidence'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) like '%sem_criterio%' loop
    execute format('alter table obedient.mission_evidence drop constraint %I', c.conname);
  end loop;
end $$;
alter table obedient.mission_evidence add constraint mission_evidence_tipo
  check (tipo in ('ferramenta_ok', 'resultado_conforme', 'sem_criterio', 'nao_sei', 'plano_completo'));
alter table obedient.mission_evidence add constraint mission_evidence_criterio
  check ((tipo in ('sem_criterio', 'nao_sei', 'plano_completo')) = (criterio is null));

-- O agendador: missão esperando a pessoa aprovar o plano não é devida.
create or replace function obedient.pessoas_com_missao_devida(p_now timestamptz, p_limite integer)
  returns setof text
  language sql stable security definer
  set search_path = obedient, pg_temp
  as $$
  select distinct m.user_id
    from obedient.missions m
    left join obedient.proposals p on p.id = m.proposta_id
   where (m.estado in ('created', 'retrying', 'running', 'planning') and m.proxima_tentativa_em <= p_now)
      or (m.estado = 'waiting_approval' and m.proposta_id is null and m.plano_hash is not null and m.plano_aprovado_em is not null)
      or (m.estado = 'waiting_approval' and m.proposta_id is not null and (p.id is null or p.status <> 'pending' or p.expires_at <= p_now))
      or (m.estado = 'waiting_approval' and m.proposta_id is null and m.plano_hash is null)
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
  n_evidencias integer;
  n_tarefas integer;
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
    'passos', n_passos, 'evidencias', n_evidencias, 'tarefas', n_tarefas
  );
end $$;
alter function obedient.apagar_meus_dados(timestamptz) owner to obedient_eraser;
revoke all on function obedient.apagar_meus_dados(timestamptz) from public;
grant execute on function obedient.apagar_meus_dados(timestamptz) to obedient_app;

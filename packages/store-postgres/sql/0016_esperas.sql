-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 Cláudio Penedo.
--
-- Espera por sistema externo e evidência de Pull Request (decisão D20, marco M6). Idempotente.
--
--   • missions.esperas: quantas vezes a missão esperou outro sistema (por exemplo, a tarefa de código
--     no Growth OS, que tem portões humanos lá). A espera não gasta tentativa; o limite é do código
--     (MAX_ESPERAS) e o banco só impede número negativo;
--   • evidência nova: pull_request (o PR que o Growth OS abriu, com a CI do commit), sem critério.

alter table obedient.missions add column if not exists esperas integer not null default 0;
do $$
begin
  if not exists (select from pg_constraint where conname = 'missions_esperas_positiva') then
    alter table obedient.missions add constraint missions_esperas_positiva check (esperas >= 0);
  end if;
end $$;
grant update (esperas) on obedient.missions to obedient_app;

alter table obedient.mission_evidence drop constraint if exists mission_evidence_tipo;
alter table obedient.mission_evidence drop constraint if exists mission_evidence_criterio;
alter table obedient.mission_evidence add constraint mission_evidence_tipo
  check (tipo in ('ferramenta_ok', 'resultado_conforme', 'sem_criterio', 'nao_sei', 'plano_completo', 'pull_request'));
alter table obedient.mission_evidence add constraint mission_evidence_criterio
  check ((tipo in ('sem_criterio', 'nao_sei', 'plano_completo', 'pull_request')) = (criterio is null));

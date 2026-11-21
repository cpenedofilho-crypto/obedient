-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 Cláudio Penedo.
--
-- Ambiente no mandato da missão (decisão D20, marco M5). Idempotente.
--
-- missions.mandato_ambientes: os ambientes cujas ferramentas a missão pode usar (produção,
-- homologação, teste); null = todos os que os grants deixarem. Fixo depois da criação, como o resto
-- do mandato. O ambiente de cada ferramenta vem da configuração do servidor (o que não declara é
-- produção).

alter table obedient.missions add column if not exists mandato_ambientes jsonb;
do $$
begin
  if not exists (select from pg_constraint where conname = 'missions_mandato_ambientes') then
    alter table obedient.missions add constraint missions_mandato_ambientes
      check (mandato_ambientes is null or (
        jsonb_typeof(mandato_ambientes) = 'array'
        and jsonb_array_length(mandato_ambientes) between 1 and 3
        and mandato_ambientes <@ '["producao", "homologacao", "teste"]'::jsonb));
  end if;
end $$;

-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 Cláudio Penedo.
--
-- A reserva da tentativa passa a ter prazo (durabilidade do executor). Idempotente.
--
-- Até a 0006, reservar uma tentativa gravava proxima_tentativa_em = null. Se o processo caísse no meio
-- da tentativa, ninguém a concluía e a missão ficava 'running' para sempre sem voltar a ser devida
-- (nem no código nem em pessoas_com_missao_devida). Agora a reserva grava reservada_ate = agora + prazo
-- e proxima_tentativa_em = reservada_ate: vencido o prazo, a missão volta a ser devida pela MESMA
-- função do agendador (que não muda), e a retomada registra a interrupção (reservada_ate preenchida).
--
--   • reservada_ate: até quando a tentativa em andamento está reservada; null = nenhuma em andamento;
--   • as missões que já estavam órfãs são resgatadas: viram reserva vencida no prazo padrão (15 min)
--     contado da última gravação;
--   • o banco passa a recusar missão 'running' sem hora de próxima tentativa (a órfã), mesmo se o
--     código errar.

alter table obedient.missions add column if not exists reservada_ate timestamptz;
grant update (reservada_ate) on obedient.missions to obedient_app;

-- Resgate das órfãs. Com RLS forçada, nem o dono da tabela vê as linhas: tira a força só durante o
-- resgate, na mesma transação da migration.
alter table obedient.missions no force row level security;
update obedient.missions
   set reservada_ate = atualizada_em + interval '15 minutes',
       proxima_tentativa_em = atualizada_em + interval '15 minutes'
 where estado = 'running' and proxima_tentativa_em is null;
alter table obedient.missions force row level security;

do $$
begin
  if not exists (select from pg_constraint where conname = 'missions_running_tem_proxima') then
    alter table obedient.missions add constraint missions_running_tem_proxima check (estado <> 'running' or proxima_tentativa_em is not null);
  end if;
end $$;

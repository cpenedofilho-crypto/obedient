// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Tudo o que uma requisição usa, montado sobre a MESMA transação da sessão: motor, memória e
// missões. Montar as missões sempre (mesmo quando a requisição não fala delas) é o que garante que
// apertar parar cancele as missões e tire as conexões no mesmo commit (Art. 9º): os ouvintes da
// parada são registrados aqui.

import type { Clock } from "@obedient/core";
import { retirarAutoridade, tirarConexoes } from "@obedient/integrations";
import { type Executor, type OpcoesMotor, memoriaNaTransacao, missoesNaTransacao, motorNaTransacao } from "@obedient/store-postgres";

export function contexto(tx: Executor, opcoesMotor: OpcoesMotor, clock: Clock) {
  const motor = motorNaTransacao(tx, opcoesMotor);
  // Art. 9º: parar tira as conexões com o Google (e põe as credenciais na fila de revogação) no
  // mesmo commit. A revogação no provedor é chamada depois, fora da transação (api.ts).
  // Num SAVEPOINT: um erro aqui não pode abortar a transação da parada (a parada vale mesmo assim).
  motor.stop.onEngage(async (scope) => {
    if (scope.kind !== "user") return;
    await tx.query("savepoint conexoes_na_parada");
    try {
      for (const id of await tirarConexoes(tx, scope.userId, "parada de emergência")) await retirarAutoridade(motor, scope.userId, id);
      await tx.query("release savepoint conexoes_na_parada");
    } catch (e) {
      await tx.query("rollback to savepoint conexoes_na_parada");
      console.error(JSON.stringify({ evento: "parada.conexoes_falhou", erro: e instanceof Error ? e.message : String(e) }));
    }
  });
  return { tx, motor, memoria: memoriaNaTransacao(tx, motor, clock), missoes: missoesNaTransacao(tx, motor, clock), clock };
}
export type Contexto = ReturnType<typeof contexto>;

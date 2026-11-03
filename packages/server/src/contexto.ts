// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Tudo o que uma requisição usa, montado sobre a MESMA transação da sessão: motor, memória e
// missões. Montar as missões sempre (mesmo quando a requisição não fala delas) é o que garante que
// apertar parar cancele as missões no mesmo commit (Art. 9º): o ouvinte da parada é registrado aqui.

import type { Clock } from "@obedient/core";
import { type Executor, type OpcoesMotor, memoriaNaTransacao, missoesNaTransacao, motorNaTransacao } from "@obedient/store-postgres";

export function contexto(tx: Executor, opcoesMotor: OpcoesMotor, clock: Clock) {
  const motor = motorNaTransacao(tx, opcoesMotor);
  return { tx, motor, memoria: memoriaNaTransacao(tx, motor, clock), missoes: missoesNaTransacao(tx, motor, clock), clock };
}
export type Contexto = ReturnType<typeof contexto>;

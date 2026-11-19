// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Processa as missões devidas de uma pessoa: para cada uma, reserva a tentativa numa transação
// curta, executa FORA do banco (a chamada ao modelo pode levar minutos) e conclui noutra transação
// curta. Assim, uma tentativa longa não segura trava no banco, e apertar parar no meio dela vale:
// a conclusão encontra a missão cancelada e descarta o resultado.
//
// Quem executa é a porta `Executor` (@obedient/missions): no servidor, executorDeMissoes()
// (executor.ts), o laço do agente com o modelo e as ferramentas governadas. Quem chama isto de tempos
// em tempos é o agendador (agendador.ts).

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { Clock } from "@obedient/core";
import type { Executor as ExecutorDeMissao, Missao } from "@obedient/missions";
import { type Database, type OpcoesMotor, comoUsuario } from "@obedient/store-postgres";
import { contexto } from "./contexto.ts";

/**
 * Quem reserva (M5): o nome deste processo, para a trilha da reserva. Sem dado de pessoa; o sufixo
 * aleatório separa dois processos na mesma máquina com o mesmo pid (contêiner reiniciado).
 */
export const ESTE_PROCESSO = `${hostname().slice(0, 100)}:${process.pid}:${randomUUID().slice(0, 8)}`;

export async function processarMissoes(db: Database, userId: string, executar: ExecutorDeMissao, opcoesMotor: OpcoesMotor, clock: Clock, dono = ESTE_PROCESSO): Promise<Missao[]> {
  const ctx = (tx: Parameters<typeof contexto>[0]) => contexto(tx, { ...opcoesMotor, clock }, clock);
  const devidas = await comoUsuario(db, userId, (tx) => ctx(tx).missoes.devidas(userId));
  const out: Missao[] = [];
  for (const d of devidas) {
    const r = await comoUsuario(db, userId, (tx) => ctx(tx).missoes.reservar(d.id, dono));
    if (!r.reservada) {
      out.push(r.missao);
      continue;
    }
    let resultado: Awaited<ReturnType<ExecutorDeMissao>>;
    try {
      resultado = await executar(r.missao);
    } catch (e) {
      resultado = { tipo: "falha_temporaria", erro: e instanceof Error ? e.message : String(e), custoCentavos: 0 };
    }
    out.push(await comoUsuario(db, userId, (tx) => ctx(tx).missoes.concluir(r.missao, resultado)));
  }
  return out;
}

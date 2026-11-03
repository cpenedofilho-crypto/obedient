// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Processa as missões devidas de uma pessoa: para cada uma, reserva a tentativa numa transação
// curta, executa FORA do banco (a chamada ao modelo pode levar minutos) e conclui noutra transação
// curta. Assim, uma tentativa longa não segura trava no banco, e apertar parar no meio dela vale:
// a conclusão encontra a missão cancelada e descarta o resultado.
//
// Quem executa é a porta `Executor` (@obedient/missions). O laço do agente com modelo e
// ferramentas governadas (agent-orchestrator + Ethics Engine) entra com as integrações (Fase 7);
// até lá o servidor não tem executor configurado e não processa missões sozinho.

import type { Clock } from "@obedient/core";
import type { Executor as ExecutorDeMissao, Missao } from "@obedient/missions";
import { type Database, type OpcoesMotor, comoUsuario } from "@obedient/store-postgres";
import { contexto } from "./contexto.ts";

export async function processarMissoes(db: Database, userId: string, executar: ExecutorDeMissao, opcoesMotor: OpcoesMotor, clock: Clock): Promise<Missao[]> {
  const ctx = (tx: Parameters<typeof contexto>[0]) => contexto(tx, { ...opcoesMotor, clock }, clock);
  const devidas = await comoUsuario(db, userId, (tx) => ctx(tx).missoes.devidas(userId));
  const out: Missao[] = [];
  for (const d of devidas) {
    const r = await comoUsuario(db, userId, (tx) => ctx(tx).missoes.reservar(d.id));
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

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Parada geral pela linha de comando do operador (CONSTITUTION Art. 9º; runbook, "Parar tudo").
//
// O Ethics Engine confere a parada antes de cada ferramenta, por pessoa e global. A global vale para
// todos os processos (fica no banco) e só o operador a libera. Aqui o operador liga, vê e libera;
// o motivo é obrigatório e fica gravado. Nada disto passa pelo agente.

import type { Clock } from "@obedient/core";
import { type Database, comoOperador, motorNaTransacao } from "@obedient/store-postgres";

const GLOBAL = { kind: "global" } as const;

export interface EstadoParada {
  ativa: boolean;
  desde?: string;
  por?: string;
  motivo?: string;
}

export async function verParadaGeral(db: Database, clock: Clock): Promise<EstadoParada> {
  const s = await comoOperador(db, (tx) => motorNaTransacao(tx, { clock }).stop.blockingScope(""));
  return s?.scope.kind === "global" ? { ativa: true, desde: s.state.engagedAt.toISOString(), por: s.state.engagedBy, motivo: s.state.reason } : { ativa: false };
}

/** Liga a parada geral. Ligar de novo mantém a primeira (quem ligou e quando não se perdem). */
export async function ligarParadaGeral(db: Database, clock: Clock, operador: string, motivo: string): Promise<EstadoParada> {
  const texto = motivo.trim();
  if (texto.length < 5 || texto.length > 300) throw new Error("diga o motivo da parada (5 a 300 caracteres)");
  const antes = await verParadaGeral(db, clock);
  if (antes.ativa) return antes;
  await comoOperador(db, (tx) => motorNaTransacao(tx, { clock }).stop.engage(GLOBAL, operador, texto));
  return verParadaGeral(db, clock);
}

export async function liberarParadaGeral(db: Database, clock: Clock, operador: string): Promise<EstadoParada> {
  await comoOperador(db, (tx) => motorNaTransacao(tx, { clock, operators: new Set([operador]) }).stop.release(GLOBAL, operador, "operator"));
  return verParadaGeral(db, clock);
}

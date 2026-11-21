// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Saúde e métricas (D20, marco M5): só números somados sobre todas as pessoas, lidos com o papel do
// operador por funções do banco (0013). Nenhum id, objetivo, ferramenta ou texto sai daqui.

import { TETO_MENSAL_CENTAVOS, inicioDoMes } from "@obedient/missions";
import type { Executor } from "./db.ts";
import { migrations } from "./migrate.ts";

export interface Metricas {
  missoesPorEstado: Record<string, number>;
  reservasVencidas: number;
  aprovacoesPendentes: number;
  passos24hPorTipo: Record<string, number>;
  gastoMesCentavos: number;
  pessoasNoTetoMes: number;
  paradaGeral: boolean;
}

const numeros = (o: unknown): Record<string, number> =>
  Object.fromEntries(Object.entries((o && typeof o === "object" ? o : {}) as Record<string, unknown>).map(([k, v]) => [k, Number(v)]));

/** Roda com comoOperador. */
export async function lerMetricas(tx: Executor, agora: Date): Promise<Metricas> {
  const { rows } = await tx.query<{ m: Record<string, unknown> }>("select obedient.metricas($1, $2, $3) as m", [agora, inicioDoMes(agora), TETO_MENSAL_CENTAVOS]);
  const m = rows[0]!.m;
  return {
    missoesPorEstado: numeros(m.missoes_por_estado),
    reservasVencidas: Number(m.reservas_vencidas),
    aprovacoesPendentes: Number(m.aprovacoes_pendentes),
    passos24hPorTipo: numeros(m.passos_24h_por_tipo),
    gastoMesCentavos: Number(m.gasto_mes_centavos),
    pessoasNoTetoMes: Number(m.pessoas_no_teto_mes),
    paradaGeral: m.parada_geral === true,
  };
}

/** As migrations do código estão todas aplicadas, com o mesmo conteúdo? Roda com comoOperador. */
export async function conferirMigracoes(tx: Executor): Promise<{ pendentes: string[]; divergentes: string[] }> {
  const { rows } = await tx.query<{ name: string; hash: string }>("select name, hash from obedient.migracoes_aplicadas()");
  const aplicadas = new Map(rows.map((r) => [r.name, r.hash]));
  const pendentes: string[] = [];
  const divergentes: string[] = [];
  for (const m of migrations()) {
    const h = aplicadas.get(m.name);
    if (h === undefined) pendentes.push(m.name);
    else if (h !== m.hash) divergentes.push(m.name);
  }
  return { pendentes, divergentes };
}

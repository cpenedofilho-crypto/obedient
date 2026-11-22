// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Sinal sintético e determinístico (mesma semente, mesmas amostras) para testes e demonstração.
// A F1 roda SÓ com isto: nenhum dado real de pessoa entra no motor antes da F0 (D31).

import type { AmostraSinal, SensorAdapter } from "@obedient/music-contracts";

/** Um trecho do treino: de onde a FC parte, onde chega e quanto tempo leva. */
export interface TrechoSintetico {
  readonly duracaoS: number;
  readonly bpmInicial: number;
  readonly bpmFinal: number;
}

export interface OpcoesSinal {
  readonly semente: number;
  readonly trechos: readonly TrechoSintetico[];
  /** Ruído em bpm (amplitude). Padrão 2. */
  readonly ruido?: number;
  /** Fração de amostras com artefato (salto ou falta de contato). Padrão 0. */
  readonly artefatos?: number;
  /** Intervalos sem nenhuma amostra, em segundos desde o início: [inicio, fim). */
  readonly lacunas?: readonly (readonly [number, number])[];
}

/** mulberry32: pequeno, determinístico, bom o bastante para teste. */
export function rng(semente: number): () => number {
  let a = semente >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uma amostra por segundo, t em ms a partir de 0. */
export function gerarSinal(o: OpcoesSinal): AmostraSinal[] {
  const aleatorio = rng(o.semente);
  const ruido = o.ruido ?? 2;
  const artefatos = o.artefatos ?? 0;
  const lacunas = o.lacunas ?? [];
  const saida: AmostraSinal[] = [];
  let s = 0;
  for (const trecho of o.trechos) {
    for (let i = 0; i < trecho.duracaoS; i++, s++) {
      if (lacunas.some(([a, b]) => s >= a && s < b)) continue;
      const base = trecho.bpmInicial + ((trecho.bpmFinal - trecho.bpmInicial) * i) / Math.max(trecho.duracaoS - 1, 1);
      let bpm = Math.round(base + (aleatorio() * 2 - 1) * ruido);
      let contato = true;
      if (aleatorio() < artefatos) {
        if (aleatorio() < 0.5) bpm += 60;
        else contato = false;
      }
      const rr = Math.round(60000 / Math.max(bpm, 30));
      saida.push({ t: s * 1000, fonte: "simulado", bpm, rrMs: [rr], contato });
    }
  }
  return saida;
}

export class SensorSimulado implements SensorAdapter {
  readonly fonte = "simulado" as const;
  constructor(
    readonly id: string,
    private readonly amostrasProntas: readonly AmostraSinal[],
  ) {}
  async *amostras(sinal: AbortSignal): AsyncIterable<AmostraSinal> {
    for (const a of this.amostrasProntas) {
      if (sinal.aborted) return;
      yield a;
    }
  }
}

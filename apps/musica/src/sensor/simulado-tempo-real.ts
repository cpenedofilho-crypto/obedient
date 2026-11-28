// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Sinal simulado em tempo real para o modo demonstração: as amostras do gerador do motor
// (gerarSinal, determinístico) saem uma por segundo, com o instante do relógio do aparelho, o mesmo que
// o player usa para marcar a troca. Nenhum dado de pessoa.
import type { AmostraSinal, SensorAdapter } from "@obedient/music-contracts";
import { gerarSinal } from "@obedient/music-engine";

/** Treino de demonstração: aquecimento, esforço, tiro e volta à calma (~17 min). */
export const TREINO_DEMO = [
  { duracaoS: 180, bpmInicial: 85, bpmFinal: 125 },
  { duracaoS: 420, bpmInicial: 150, bpmFinal: 165 },
  { duracaoS: 120, bpmInicial: 175, bpmFinal: 182 },
  { duracaoS: 300, bpmInicial: 140, bpmFinal: 95 },
] as const;

export class SensorSimuladoTempoReal implements SensorAdapter {
  readonly fonte = "simulado" as const;
  readonly id = "simulado";
  constructor(
    private readonly relogio: () => number,
    private readonly espera: (ms: number) => Promise<void>,
    private readonly semente = 1,
    private readonly intervaloMs = 1000,
  ) {}

  async *amostras(sinal: AbortSignal): AsyncIterable<AmostraSinal> {
    for (const a of gerarSinal({ semente: this.semente, trechos: TREINO_DEMO, artefatos: 0.02 })) {
      if (sinal.aborted) return;
      yield { ...a, t: this.relogio() };
      await this.espera(this.intervaloMs);
    }
  }
}

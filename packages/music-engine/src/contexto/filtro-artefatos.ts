// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Filtro de artefatos: decide se uma amostra é confiável. Regras fixas e explicáveis; nada é
// "corrigido" nem inventado. Amostra ruim é marcada e o contexto segue com as boas.

import { type AmostraFiltrada, type AmostraSinal, BPM_MAXIMO, BPM_MINIMO, RR_MAXIMO_MS, RR_MINIMO_MS } from "@obedient/music-contracts";

/** Maior salto aceito entre duas amostras boas, por segundo decorrido. */
export const SALTO_MAXIMO_BPM_POR_S = 25;
/** RR que se afasta mais que isto da mediana do pacote é batimento ectópico ou ruído. */
export const DESVIO_MAXIMO_RR = 0.2;

export function mediana(valores: readonly number[]): number {
  const v = [...valores].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

/** RR dentro da faixa fisiológica e perto da mediana do próprio pacote. */
export function filtrarRr(rrMs: readonly number[]): number[] {
  const validos = rrMs.filter((r) => Number.isFinite(r) && r >= RR_MINIMO_MS && r <= RR_MAXIMO_MS);
  if (validos.length < 3) return validos;
  const med = mediana(validos);
  return validos.filter((r) => Math.abs(r - med) / med <= DESVIO_MAXIMO_RR);
}

/**
 * Classifica a amostra em relação à última amostra boa.
 * - sem bpm, bpm fora de 25–250 ou sensor sem contato: descartada;
 * - salto maior que 25 bpm/s desde a última boa: duvidosa (não entra na média);
 * - o resto: boa.
 */
export function classificar(amostra: AmostraSinal, ultimaBoa: AmostraFiltrada | null): AmostraFiltrada {
  const rrMs = amostra.rrMs ? filtrarRr(amostra.rrMs) : undefined;
  const base = { ...amostra, ...(rrMs ? { rrMs } : {}) };
  const bpm = amostra.bpm;
  if (bpm === undefined || !Number.isFinite(bpm) || bpm < BPM_MINIMO || bpm > BPM_MAXIMO || amostra.contato === false)
    return { ...base, qualidade: "descartada" };
  if (ultimaBoa?.bpm !== undefined) {
    const dt = Math.max((amostra.t - ultimaBoa.t) / 1000, 1);
    if (Math.abs(bpm - ultimaBoa.bpm) / dt > SALTO_MAXIMO_BPM_POR_S) return { ...base, qualidade: "duvidosa" };
  }
  return { ...base, qualidade: "boa" };
}

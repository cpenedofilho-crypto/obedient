// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Zona de esforço pela frequência cardíaca de reserva (método de Karvonen):
//   reserva = (bpm − repouso) / (máxima − repouso)
// Limites usuais de cinco zonas (50, 60, 70, 80, 90 %). A pessoa informa repouso e máxima; o motor
// não estima pela idade. Abaixo de 50 % da reserva é "repouso".

import type { ParametrosFisiologicos, Zona } from "@obedient/music-contracts";
import { BPM_MAXIMO, BPM_MINIMO } from "@obedient/music-contracts";

/** Limite inferior de cada zona em fração da reserva. */
export const LIMITES_ZONA: ReadonlyArray<readonly [Zona, number]> = [
  ["z5", 0.9],
  ["z4", 0.8],
  ["z3", 0.7],
  ["z2", 0.6],
  ["z1", 0.5],
  ["repouso", -Infinity],
];

export type ErroParametros = "repouso_fora_da_faixa" | "maxima_fora_da_faixa" | "maxima_nao_supera_repouso";

export function validarParametros(p: ParametrosFisiologicos): ErroParametros | null {
  if (!Number.isFinite(p.fcRepouso) || p.fcRepouso < BPM_MINIMO || p.fcRepouso > 120) return "repouso_fora_da_faixa";
  if (!Number.isFinite(p.fcMaxima) || p.fcMaxima < 100 || p.fcMaxima > BPM_MAXIMO) return "maxima_fora_da_faixa";
  if (p.fcMaxima - p.fcRepouso < 20) return "maxima_nao_supera_repouso";
  return null;
}

export function fracaoReserva(bpm: number, p: ParametrosFisiologicos): number {
  return (bpm - p.fcRepouso) / (p.fcMaxima - p.fcRepouso);
}

export function zonaDe(bpm: number, p: ParametrosFisiologicos): Zona {
  const f = fracaoReserva(bpm, p);
  for (const [zona, limite] of LIMITES_ZONA) if (f >= limite) return zona;
  return "repouso";
}

/** bpm do limite inferior de uma zona (para a histerese). */
export function bpmLimiteInferior(zona: Zona, p: ParametrosFisiologicos): number {
  const limite = LIMITES_ZONA.find(([z]) => z === zona)![1];
  return limite === -Infinity ? -Infinity : p.fcRepouso + limite * (p.fcMaxima - p.fcRepouso);
}

export function ordemZona(z: Zona): number {
  return ["repouso", "z1", "z2", "z3", "z4", "z5"].indexOf(z);
}

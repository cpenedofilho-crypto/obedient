// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Catálogo real (F4) vindo do Growth OS. O servidor já conferiu instrumento e evidência da licença e não
// os manda ao aparelho; aqui eles viram uma referência ao servidor, e o motor confere de novo o que dá
// para conferir no aparelho (uso comercial, validade). Faixa sem arquivo publicado fica de fora.
import type { FaixaCatalogo } from "@obedient/music-contracts";
import { validarFaixa } from "@obedient/music-engine";
import type { ArquivoRemoto, FaixaRemota } from "../api/cliente.ts";

export interface FaixaComArquivo { faixa: FaixaCatalogo; arquivo: ArquivoRemoto }

export const BYTES_MAXIMOS_POR_ARQUIVO = 30 * 1024 * 1024;

export function doGrowthOs(remotas: readonly FaixaRemota[], agoraIso: string): FaixaComArquivo[] {
  const saida: FaixaComArquivo[] = [];
  for (const r of remotas) {
    if (!r.arquivo || !/^[0-9a-f]{64}$/.test(r.arquivo.sha256) || !(r.arquivo.bytes > 0 && r.arquivo.bytes <= BYTES_MAXIMOS_POR_ARQUIVO)) continue;
    if (r.origem !== "proprio" && r.origem !== "licenciado") continue;
    const faixa: FaixaCatalogo = {
      id: r.trackRef, origem: r.origem, genero: r.genero, explicita: r.explicita, energia: r.energia,
      duracaoMs: r.duracaoMs, fronteirasMs: r.fronteirasMs,
      licenca: {
        instrumento: "conferido no Growth OS", evidencia: `growth-os:${r.trackRef}`, permiteComercial: true,
        permiteCrossfade: r.licenca.permiteCrossfade, permiteCacheOffline: r.licenca.permiteCacheOffline, validaAte: r.licenca.validaAte,
      },
    };
    if (validarFaixa(faixa, agoraIso).length === 0) saida.push({ faixa, arquivo: r.arquivo });
  }
  return saida;
}

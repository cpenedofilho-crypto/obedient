// SPDX-License-Identifier: AGPL-3.0-only
// Catálogo fictício para os testes do motor de música. Nenhuma faixa real.
import type { FaixaCatalogo, LicencaFaixa } from "@obedient/music-contracts";

export const LICENCA_OK: LicencaFaixa = {
  instrumento: "contrato-encomenda-teste-001",
  permiteComercial: true,
  permiteCrossfade: true,
  permiteCacheOffline: true,
  evidencia: "docs-internos/licencas/teste-001.pdf",
  validaAte: null,
};

export function faixa(id: string, energia: number, extra: Partial<FaixaCatalogo> = {}): FaixaCatalogo {
  return {
    id,
    origem: "proprio",
    genero: "eletronica",
    explicita: false,
    energia,
    duracaoMs: 180_000,
    fronteirasMs: [15_000, 30_000, 45_000, 60_000, 90_000, 120_000, 150_000],
    licenca: LICENCA_OK,
    ...extra,
  };
}

/** Uma faixa a cada 0,05 de energia, de 0,05 a 1,0. */
export const CATALOGO: FaixaCatalogo[] = Array.from({ length: 20 }, (_, i) => faixa(`f${String(i + 1).padStart(2, "0")}`, Math.round((i + 1) * 5) / 100));

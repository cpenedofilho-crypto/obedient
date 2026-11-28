// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Catálogo de demonstração: 10 faixas geradas pelo próprio app (catalogo/wav.ts), da energia 0,1 à 1,0.
// A licença é "proprio" porque o som é produzido aqui; a evidência aponta para este arquivo. Nada disso
// é música de terceiros. O catálogo de verdade vem do Growth OS (F2) com os arquivos da F4.
import type { FaixaCatalogo } from "@obedient/music-contracts";
import type { PadraoDemo } from "./wav.ts";

export const DURACAO_DEMO_S = 30;

export interface FaixaDemo { faixa: FaixaCatalogo; padrao: PadraoDemo }

export const CATALOGO_DEMO: readonly FaixaDemo[] = Array.from({ length: 10 }, (_, i) => {
  const energia = Math.round((i + 1) * 10) / 100;
  const id = `demo-${String(i + 1).padStart(2, "0")}`;
  return {
    padrao: { batidasPorMinuto: 70 + i * 10, frequenciaHz: 110 + i * 22, duracaoS: DURACAO_DEMO_S },
    faixa: {
      id,
      origem: "proprio",
      genero: "demonstracao",
      explicita: false,
      energia,
      duracaoMs: DURACAO_DEMO_S * 1000,
      fronteirasMs: [7_500, 15_000, 22_500],
      licenca: {
        instrumento: "som gerado pelo app (apps/musica/src/catalogo/wav.ts)",
        permiteComercial: true,
        permiteCrossfade: true,
        permiteCacheOffline: true,
        evidencia: "apps/musica/src/catalogo/demo.ts",
        validaAte: null,
      },
    },
  };
});

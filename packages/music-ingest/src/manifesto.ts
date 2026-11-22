// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Manifesto de ingestão: o que o produtor (ou a biblioteca licenciada) entrega para cada faixa, mais o
// que a análise mede. Sai um RASCUNHO por faixa, com o que precisa de revisão humana marcado. Nada é
// publicado daqui: publicar é enviar o rascunho revisado ao Growth OS (POST /api/musica/catalogo), por
// quem tem musica:catalogo_gerir.
//
// Regras (D31; docs/governance/music-catalogo-f4.md):
//   - toda faixa precisa de licença com uso comercial, instrumento e evidência; a validade é conferida;
//   - o arquivo de distribuição (o que o app baixa) leva SHA-256 e tamanho, para o aparelho conferir;
//   - a energia medida é sugestão: a revisão pode trocar, e a troca fica registrada no rascunho.
import { createHash } from "node:crypto";
import type { FaixaCatalogo, LicencaFaixa, OrigemFaixa } from "@obedient/music-contracts";
import { validarFaixa } from "@obedient/music-engine";
import { analisar, type Medidas } from "./analise.ts";
import { lerWav } from "./wav.ts";

export const FORMATOS_DISTRIBUICAO = ["audio/mp4", "audio/mpeg", "audio/wav"] as const;
export type FormatoDistribuicao = (typeof FORMATOS_DISTRIBUICAO)[number];

/** Uma linha do manifesto que acompanha a entrega. */
export interface EntradaManifesto {
  trackRef: string;
  titulo: string;
  origem: OrigemFaixa;
  genero: string;
  explicita: boolean;
  /** WAV mestre, só para a análise. */
  mestre: string;
  /** Arquivo que o app baixa (AAC em .m4a, MP3 ou WAV). */
  distribuicao: { arquivo: string; formato: FormatoDistribuicao };
  licenca: LicencaFaixa;
  /** Energia decidida na revisão, se diferente da medida. */
  energiaRevisada?: number;
}

export interface Rascunho {
  faixa: FaixaCatalogo & { titulo: string };
  arquivo: { sha256: string; bytes: number; formato: FormatoDistribuicao };
  /** Caminho local do arquivo de distribuição, para o envio subir os bytes (não vai ao Growth OS). */
  caminhoDistribuicao: string;
  medidas: Medidas;
  energiaMedida: number;
  revisada: boolean;
  problemas: string[];
}

export interface LeitorArquivos { ler(caminho: string): Uint8Array }

const REF = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const GENERO = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function montarRascunho(e: EntradaManifesto, arquivos: LeitorArquivos, agoraIso: string): Rascunho {
  const problemas: string[] = [];
  if (!REF.test(e.trackRef)) problemas.push("track_ref_invalido");
  if (!GENERO.test(e.genero)) problemas.push("genero_invalido");
  if (!e.titulo?.trim() || e.titulo.length > 200) problemas.push("titulo_invalido");
  if (!(FORMATOS_DISTRIBUICAO as readonly string[]).includes(e.distribuicao.formato)) problemas.push("formato_distribuicao_invalido");

  const analise = analisar(lerWav(arquivos.ler(e.mestre)));
  const dist = arquivos.ler(e.distribuicao.arquivo);
  const revisada = e.energiaRevisada !== undefined;
  const energia = revisada ? e.energiaRevisada! : analise.energia;
  if (!(energia >= 0 && energia <= 1)) problemas.push("energia_fora_da_faixa");

  const faixa = {
    id: e.trackRef, titulo: e.titulo, origem: e.origem, genero: e.genero, explicita: e.explicita,
    energia, duracaoMs: analise.medidas.duracaoMs, fronteirasMs: analise.fronteirasMs, licenca: e.licenca,
  };
  problemas.push(...validarFaixa(faixa, agoraIso));
  if (dist.length === 0) problemas.push("distribuicao_vazia");
  return {
    faixa,
    arquivo: { sha256: sha256(dist), bytes: dist.length, formato: e.distribuicao.formato },
    caminhoDistribuicao: e.distribuicao.arquivo,
    medidas: analise.medidas,
    energiaMedida: analise.energia,
    revisada,
    problemas,
  };
}

/** O corpo que POST /api/musica/catalogo do Growth OS aceita (src/musica/contratos.ts lá). */
export function corpoParaGrowthOs(r: Rascunho) {
  const { faixa, arquivo } = r;
  return {
    trackRef: faixa.id, titulo: faixa.titulo, origem: faixa.origem, genero: faixa.genero, explicita: faixa.explicita,
    energia: faixa.energia, duracaoMs: faixa.duracaoMs, fronteirasMs: faixa.fronteirasMs,
    licenca: {
      instrumento: faixa.licenca.instrumento, evidencia: faixa.licenca.evidencia, permiteComercial: faixa.licenca.permiteComercial,
      permiteCrossfade: faixa.licenca.permiteCrossfade, permiteCacheOffline: faixa.licenca.permiteCacheOffline, validaAte: faixa.licenca.validaAte,
    },
    arquivo,
  };
}

/** Distribuição de energia do catálogo, para ver se cada zona tem música bastante. */
export function coberturaPorFaixa(rascunhos: readonly Rascunho[]): Record<string, number> {
  const faixas: Record<string, number> = { "0.0-0.2": 0, "0.2-0.4": 0, "0.4-0.6": 0, "0.6-0.8": 0, "0.8-1.0": 0 };
  for (const r of rascunhos) {
    const e = r.faixa.energia;
    const k = e < 0.2 ? "0.0-0.2" : e < 0.4 ? "0.2-0.4" : e < 0.6 ? "0.4-0.6" : e < 0.8 ? "0.6-0.8" : "0.8-1.0";
    faixas[k]!++;
  }
  return faixas;
}

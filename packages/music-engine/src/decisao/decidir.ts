// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Music Decision Engine: função pura, sem relógio próprio, sem I/O e sem aleatoriedade. Mesma entrada,
// mesma decisão, sempre com um motivo do vocabulário fechado (MOTIVOS).
//
// Ordem das regras (a primeira que se aplica decide):
//   1. sem consentimento vigente → nada (o motor nem deveria ter sinal);
//   2. modo desligado, pausa ou faixa travada → a pessoa manda;
//   3. zona: a travada pela pessoa ou a do contexto; sinal perdido ou instável → manter/nada;
//   4. a faixa atual ainda serve (energia dentro da faixa da zona) → manter;
//   5. intervalo mínimo entre trocas automáticas → manter;
//   6. escolhe a faixa elegível de energia mais próxima do centro da faixa, evitando repetição.
//
// O que NÃO entra, de propósito (D31, design-around a ser confirmado pelo parecer da F0): humor ou
// estado psicológico, classificador aprendido, cadência de passada, BPM da faixa casado com o
// batimento ou com a passada, alteração de tempo ou de composição do áudio, sessão de grupo.

import type { Decisao, EntradaDecisao, FaixaCatalogo, Transicao, Zona } from "@obedient/music-contracts";
import { elegiveis, faixaDeEnergia } from "../preferencias/engine.ts";

/** Entre duas trocas automáticas. Pulo manual não conta. */
export const INTERVALO_MINIMO_TROCA_MS = 60_000;
/** Sinal perdido por mais que isto: o motor para de adaptar e a pessoa fica no manual. */
export const LIMITE_SINAL_PERDIDO_MS = 60_000;
/** Abaixo disto o contexto não basta para trocar música. */
export const CONFIANCA_MINIMA = 0.5;
/** Até onde procurar uma fronteira de frase na faixa atual para a troca soar natural. */
export const HORIZONTE_FRASE_MS = 30_000;
/** Quantas faixas recentes evitar repetir. */
export const JANELA_SEM_REPETICAO = 20;

export function decidir(e: EntradaDecisao): Decisao {
  if (!e.consentimentoVigente) return { tipo: "nenhuma", motivo: "sem_consentimento" };
  if (e.preferencias.modo === "desligada") return { tipo: "nenhuma", motivo: "adaptacao_desligada" };
  if (e.travas.pausado) return { tipo: "nenhuma", motivo: "pausado" };
  if (e.travas.faixaTravada !== null) return { tipo: "manter", motivo: "faixa_travada" };

  const tocando = e.tocando;
  const semAcao = (motivo: "sem_sinal" | "sinal_instavel" | "sem_faixa_compativel"): Decisao =>
    tocando ? { tipo: "manter", motivo } : { tipo: "nenhuma", motivo };

  let zona: Zona;
  if (e.travas.zonaTravada !== null) zona = e.travas.zonaTravada;
  else {
    const c = e.contexto;
    if (c.zona === null) return { tipo: "nenhuma", motivo: "sem_sinal" };
    if (c.sinalPerdidoDesde !== null)
      return e.agora - c.sinalPerdidoDesde > LIMITE_SINAL_PERDIDO_MS ? { tipo: "nenhuma", motivo: "sem_sinal" } : semAcao("sinal_instavel");
    if (c.confianca < CONFIANCA_MINIMA) return semAcao("sinal_instavel");
    zona = c.zona;
  }

  const faixa = faixaDeEnergia(zona, e.preferencias);
  const dentro = (f: FaixaCatalogo) => f.energia >= faixa.min && f.energia <= faixa.max;
  const candidatas = elegiveis(e.catalogo, e.preferencias, e.dataIso);
  const porId = new Map(e.catalogo.map((f) => [f.id, f]));

  let motivoTroca: "zona_mudou" | "faixa_atual_inelegivel" | "nada_tocando" = "nada_tocando";
  if (tocando) {
    const atual = candidatas.find((f) => f.id === tocando.faixaId);
    if (!atual) motivoTroca = "faixa_atual_inelegivel";
    else {
      if (dentro(atual)) return { tipo: "manter", motivo: "faixa_atual_adequada" };
      if (e.ultimaTrocaEm !== null && e.agora - e.ultimaTrocaEm < INTERVALO_MINIMO_TROCA_MS) return { tipo: "manter", motivo: "intervalo_minimo" };
      motivoTroca = "zona_mudou";
    }
  }

  const escolhida = escolher(candidatas.filter(dentro), (faixa.min + faixa.max) / 2, e.historico, tocando?.faixaId ?? null);
  if (!escolhida) return semAcao("sem_faixa_compativel");

  if (e.preferencias.modo === "so_sugestao") return { tipo: "sugerir", faixaId: escolhida.id, motivo: motivoTroca, zonaAlvo: zona };

  const atualNoCatalogo = tocando ? porId.get(tocando.faixaId) : undefined;
  const { emMs, transicao } = momentoDaTroca(e.agora, tocando, atualNoCatalogo, escolhida, motivoTroca);
  return { tipo: "trocar", faixaId: escolhida.id, emMs, transicao, motivo: motivoTroca, zonaAlvo: zona };
}

/** Menor distância ao centro; depois quem não tocou recentemente (ou tocou há mais tempo); depois o id. */
function escolher(dentro: readonly FaixaCatalogo[], centro: number, historico: readonly string[], atual: string | null): FaixaCatalogo | null {
  const recentes = historico.slice(-JANELA_SEM_REPETICAO);
  const idadeNoHistorico = (id: string) => {
    const i = recentes.lastIndexOf(id);
    return i === -1 ? Infinity : recentes.length - i; // maior = mais antiga
  };
  const opcoes = dentro.filter((f) => f.id !== atual);
  if (!opcoes.length) return null;
  const novas = opcoes.filter((f) => idadeNoHistorico(f.id) === Infinity);
  const ordenar = (lista: FaixaCatalogo[], porIdade: boolean) =>
    [...lista].sort(
      (a, b) =>
        (porIdade ? idadeNoHistorico(b.id) - idadeNoHistorico(a.id) : 0) ||
        Math.abs(a.energia - centro) - Math.abs(b.energia - centro) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  return novas.length ? ordenar(novas, false)[0]! : ordenar(opcoes, true)[0]!;
}

/**
 * Troca na próxima fronteira de frase da faixa atual (até o horizonte); sem fronteira por perto, ou
 * com a faixa atual inelegível (licença venceu, foi bloqueada), troca já. Crossfade só se as DUAS
 * licenças permitirem; senão corte.
 */
function momentoDaTroca(
  agora: number,
  tocando: EntradaDecisao["tocando"],
  atual: FaixaCatalogo | undefined,
  nova: FaixaCatalogo,
  motivo: "zona_mudou" | "faixa_atual_inelegivel" | "nada_tocando",
): { emMs: number; transicao: Transicao } {
  if (!tocando || !atual || motivo === "faixa_atual_inelegivel") return { emMs: agora, transicao: "corte" };
  const transicao: Transicao = atual.licenca.permiteCrossfade && nova.licenca.permiteCrossfade ? "crossfade" : "corte";
  const proxima = atual.fronteirasMs.find((b) => b > tocando.posicaoMs && b - tocando.posicaoMs <= HORIZONTE_FRASE_MS);
  return { emMs: proxima === undefined ? agora : agora + (proxima - tocando.posicaoMs), transicao };
}

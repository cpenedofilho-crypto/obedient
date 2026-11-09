// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// A tela como o agente vê: o que o adaptador leu vira uma observação mascarada e com hash.
//
//   • campo de senha nunca tem o texto lido; e-mail e sequência longa de dígitos (código de
//     verificação, cartão, CPF, telefone) viram marcadores antes de chegar ao modelo;
//   • o agente vê id e texto de cada elemento, nunca coordenada: o toque é pedido por id, e a
//     coordenada sai daqui;
//   • o hash da tela é calculado sobre a tela BRUTA, ANTES da máscara (app, textos, posições
//     arredondadas e o hash da imagem, se houver): trocar o valor ou a chave PIX, que a máscara
//     esconde do modelo, muda o hash. Aprovar um toque é aprovar aquele toque naquela tela: se o hash
//     muda entre a aprovação e a execução, a ação não acontece. É um HMAC com chave do processo, para
//     o hash guardado no registro e na proposta não servir de oráculo do texto mascarado (um CPF
//     se acharia por força bruta num SHA-256 simples).
//
// O que a tela diz é dado de terceiros, nunca instrução: o motor não lê o texto para decidir nada,
// a não ser para SUBIR o risco de um toque (politica.ts).

import { createHmac, randomBytes } from "node:crypto";
import { canonicalJson } from "@obedient/core";
import type { Caixa, CapturaBruta, Elemento, ElementoBruto, Observacao } from "./tipos.ts";

export const MAX_ELEMENTOS = 200;
export const MAX_TEXTO_ELEMENTO = 200;
/** Arredondamento das posições no hash: um ou dois pixels de diferença não mudam a tela. */
const GRADE = 8;

const EMAIL = /[^\s@"']+@[^\s@"']+\.[a-z]{2,}/gi;
// Seis ou mais dígitos, com espaço, ponto, traço ou barra no meio (cartão, CPF, telefone, código).
const DIGITOS = /\d(?:[\s.\-/]?\d){5,}/g;

export function mascarar(texto: string): string {
  const t = texto.replace(/\s+/g, " ").trim().replace(EMAIL, "[e-mail]").replace(DIGITOS, "[número]");
  return t.length > MAX_TEXTO_ELEMENTO ? `${t.slice(0, MAX_TEXTO_ELEMENTO - 1)}…` : t;
}

/** Elemento como o motor guarda: o que o agente vê, mais a caixa para o toque. */
export interface ElementoInterno extends Elemento {
  caixa: Caixa;
}

export interface ObservacaoInterna extends Observacao {
  internos: ElementoInterno[];
}

const textoVisivel = (e: ElementoBruto) => (e.senha ? "[oculto]" : mascarar(e.texto));

/** Chave do HMAC da tela: aleatória por processo. Aprovação e execução acontecem no mesmo motor. */
const CHAVE_DO_PROCESSO = randomBytes(32);

export function montarObservacao(bruta: CapturaBruta, ids: { observationId: string; sessionId: string }, agora: Date, chave: Uint8Array = CHAVE_DO_PROCESSO): ObservacaoInterna {
  const brutos = bruta.elementos.slice(0, MAX_ELEMENTOS);
  const internos: ElementoInterno[] = brutos.map((e, i) => ({
    id: `e${i + 1}`,
    texto: textoVisivel(e),
    origem: e.origem,
    clicavel: e.clicavel,
    campo: Boolean(e.campo || e.senha),
    caixa: e.caixa,
  }));
  return {
    observationId: ids.observationId,
    sessionId: ids.sessionId,
    capturadaEm: agora.toISOString(),
    app: bruta.app,
    screenHash: hashDaTela(bruta.app, brutos, bruta.imagemHash, chave),
    elementos: internos.map(({ caixa: _caixa, ...visivel }) => visivel),
    internos,
  };
}

/** Sobre o texto bruto (só o espaço é normalizado; senha não tem texto lido). */
export function hashDaTela(app: string | null, elementos: readonly ElementoBruto[], imagemHash: string | undefined, chave: Uint8Array = CHAVE_DO_PROCESSO): string {
  const g = (n: number) => Math.round(n / GRADE);
  const texto = (e: ElementoBruto) => (e.senha ? "[oculto]" : e.texto.replace(/\s+/g, " ").trim());
  return createHmac("sha256", chave)
    .update(
      canonicalJson({
        app,
        imagem: imagemHash ?? null,
        elementos: elementos.map((e) => [texto(e), e.origem, e.clicavel, Boolean(e.campo || e.senha), g(e.caixa.x), g(e.caixa.y), g(e.caixa.w), g(e.caixa.h)]),
      }),
    )
    .digest("hex");
}

/** Centro do elemento: onde o toque acontece. */
export const centro = (c: Caixa) => ({ x: Math.round(c.x + c.w / 2), y: Math.round(c.y + c.h / 2) });

/** O que volta ao modelo: sem caixa, sem hash da imagem. */
export const paraModelo = (o: Observacao) => ({
  observation_id: o.observationId,
  app: o.app,
  elementos: o.elementos.map((e) => ({ id: e.id, texto: e.texto, origem: e.origem, clicavel: e.clicavel, campo: e.campo })),
});

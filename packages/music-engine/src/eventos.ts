// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Eventos do motor de música para o Event Bus. Só UM fato sai do aparelho: o resumo agregado da
// sessão, e só com o consentimento próprio de agregados. Nunca: frequência cardíaca, RR, zona por
// instante, faixa tocada, horário exato. A decisão em tempo real não passa pelo barramento.
//
// Além da rede de dado pessoal do barramento (regras.ts), este módulo recusa chaves de dado de saúde.

import { criarVocabulario, type NovoEvento, validarEvento } from "@obedient/event-bus";
import type { ResumoSessao } from "@obedient/music-contracts";

export const VOCABULARIO_MUSICA = criarVocabulario({
  fontes: ["music-engine"],
  entidades: ["music_session"],
  entidadesInternas: [],
  tipos: [
    {
      tipo: "music.session.ended",
      entidades: ["music_session"],
      fontes: ["music-engine"],
      descricao: "Sessão de música adaptativa terminou; só contagens agregadas, sem sinal de saúde.",
    },
  ],
});

/** Chaves que denunciam dado de saúde ou de escuta individual. */
const CHAVES_PROIBIDAS = /(^|_)(bpm|fc|hr|rr|hrv|heart|batimento|frequencia|zona|zone|faixa|track|musica_id|horario|timestamp)(_|$)/i;

export function chaveDeSaude(payload: Record<string, unknown>): string | null {
  for (const k of Object.keys(payload)) if (CHAVES_PROIBIDAS.test(k)) return k;
  return null;
}

export class ErroEventoMusica extends Error {
  constructor(readonly codigo: "sem_consentimento_agregados" | "chave_de_saude" | "resumo_invalido", mensagem: string) {
    super(mensagem);
    this.name = "ErroEventoMusica";
  }
}

/**
 * Monta o evento do resumo. `sessaoRef` é um identificador opaco da sessão gerado no aparelho
 * (não deriva do usuário nem do horário). Arredonda tudo para não carregar precisão desnecessária.
 */
export function eventoResumoSessao(resumo: ResumoSessao, sessaoRef: string, agregadosPermitidos: boolean): NovoEvento {
  if (!agregadosPermitidos) throw new ErroEventoMusica("sem_consentimento_agregados", "a pessoa não autorizou enviar o resumo da sessão");
  const valido =
    Number.isFinite(resumo.duracaoS) &&
    resumo.duracaoS >= 0 &&
    Number.isInteger(resumo.trocasAutomaticas) &&
    resumo.trocasAutomaticas >= 0 &&
    Number.isInteger(resumo.pulosManuais) &&
    resumo.pulosManuais >= 0 &&
    resumo.percentualAdaptado >= 0 &&
    resumo.percentualAdaptado <= 100;
  if (!valido) throw new ErroEventoMusica("resumo_invalido", "resumo de sessão fora do formato");

  const payload = {
    duracao_min: Math.round(resumo.duracaoS / 60),
    trocas_automaticas: resumo.trocasAutomaticas,
    pulos_manuais: resumo.pulosManuais,
    percentual_adaptado: Math.round(resumo.percentualAdaptado),
    versao_motor: resumo.versaoMotor,
  };
  const proibida = chaveDeSaude(payload);
  if (proibida) throw new ErroEventoMusica("chave_de_saude", `chave proibida no resumo: ${proibida}`);

  const evento: NovoEvento = {
    type: "music.session.ended",
    entityType: "music_session",
    entityExternalId: sessaoRef,
    payload,
    idempotencyKey: `music.session.ended:${sessaoRef}`,
  };
  validarEvento(evento, VOCABULARIO_MUSICA, 0, "music-engine");
  return evento;
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Limite de taxa em memória, por processo (o servidor roda num processo só; ver agendador.ts).
// Janela deslizante: guarda os instantes dos últimos pedidos de cada chave e recusa quando a
// janela já tem o máximo. Não é barreira de segurança contra quem controla muitos endereços: é
// freio de custo (cada missão pode gastar até o teto no modelo) e de abuso do convite e da entrada.
//
// O que tira poder do agente nunca passa por aqui: parar, revogar, desconectar e apagar tudo
// (api.ts). Um limite que atrasasse a parada de emergência seria pior que nenhum.

import type { Clock } from "@obedient/core";

export interface Regra {
  maximo: number;
  janelaMs: number;
}

export class LimiteDeTaxa {
  private readonly vistos = new Map<string, number[]>();

  constructor(private readonly clock: Clock) {}

  /** Conta o pedido e diz se ele cabe. Quando não cabe, devolve em quantos segundos tentar de novo. */
  tentar(chave: string, regra: Regra): { ok: true } | { ok: false; tentarEmS: number } {
    const agora = this.clock.now().getTime();
    const desde = agora - regra.janelaMs;
    const lista = (this.vistos.get(chave) ?? []).filter((t) => t > desde);
    if (lista.length >= regra.maximo) {
      this.vistos.set(chave, lista);
      return { ok: false, tentarEmS: Math.max(1, Math.ceil((lista[0]! + regra.janelaMs - agora) / 1000)) };
    }
    lista.push(agora);
    this.vistos.set(chave, lista);
    // Memória limitada: chaves velhas saem quando o mapa cresce.
    if (this.vistos.size > 10_000) for (const [k, v] of this.vistos) if (!v.some((t) => t > desde)) this.vistos.delete(k);
    return { ok: true };
  }
}

/** Padrões. Entrada é global (o servidor não confia no IP que o proxy repassa); o resto, por pessoa. */
export const LIMITES_PADRAO = {
  /** convite e entrada por passkey, somados, no servidor inteiro */
  entrada: { maximo: 60, janelaMs: 60_000 },
  /** qualquer ação de uma pessoa (a fila do aparelho reenvia quando recebe 429) */
  acoes: { maximo: 120, janelaMs: 60_000 },
  /** pedir missão ou mandar tentar de novo: o que gasta modelo */
  missoes: { maximo: 20, janelaMs: 3_600_000 },
} satisfies Record<string, Regra>;

export type Limites = typeof LIMITES_PADRAO;

/** Ações que só tiram poder do agente: nunca limitadas. */
export const ACOES_SEM_LIMITE: ReadonlySet<string> = new Set(["parar", "revogar", "desconectar", "apagar_tudo", "esquecer", "desligar_aprendizado", "cancelar_missao", "recusar"]);
export const ACOES_QUE_GASTAM: ReadonlySet<string> = new Set(["criar_missao", "tentar_de_novo"]);

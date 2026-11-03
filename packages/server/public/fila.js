// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
// @ts-check
//
// Fila de ações do aparelho (padrão do Ronda). Toda ação é gravada AQUI primeiro e a tela segue sem
// esperar a rede; depois a fila envia, na ordem:
//   1. parar e liberar (a parada é o que mais importa chegar);
//   2. o resto, do mais antigo para o mais novo.
// Cada ação leva um opId gerado no aparelho: reenviar é inofensivo, o servidor devolve o resultado
// que já tinha (obedient.client_ops).
//
// A lógica não conhece o IndexedDB: recebe um armazém com quatro métodos. No navegador é o
// IndexedDB (armazem-idb.js); nos testes, um Map.

/**
 * @typedef {{ tipo: "aprovar", propostaId: string, hash: string } | { tipo: "recusar", propostaId: string } | { tipo: "parar" } | { tipo: "liberar" }
 *   | { tipo: "revogar", autorizacaoId: string } | { tipo: "ligar_aprendizado", categoria: string, especifico?: boolean }
 *   | { tipo: "desligar_aprendizado", categoria: string } | { tipo: "esquecer", licaoId: string }
 *   | { tipo: "contestar", seq: number, motivo: string } | { tipo: "apagar_tudo" }
 *   | { tipo: "criar_missao", objetivo: string, tetoCentavos?: number } | { tipo: "cancelar_missao", missaoId: string }
 *   | { tipo: "tentar_de_novo", missaoId: string, novoTetoCentavos?: number } | { tipo: "identificacao", texto: string }} Acao
 */
/** @typedef {{ ok: true, tipo: string } | { ok: false, tipo: string, codigo: string, mensagem: string }} Resultado */
/**
 * @typedef {{
 *   opId: string,
 *   acao: Acao,
 *   criadaEm: number,
 *   estado: "pendente" | "feita" | "recusada",
 *   tentativas: number,
 *   resultado?: Resultado,
 *   resolvidaEm?: number
 * }} Op
 */
/** @typedef {{ get(id: string): Promise<Op | undefined>, put(op: Op): Promise<void>, all(): Promise<Op[]>, delete(id: string): Promise<void> }} Armazem */
/** @typedef {{ tipo: "resultado", resultado: Resultado } | { tipo: "temporaria" } | { tipo: "sessao" }} Envio */

/** @type {Record<Acao["tipo"], number>} */
export const PRIORIDADE = {
  parar: 0,
  liberar: 0,
  // Tirar poder do agente vem antes de dar: desligar, apagar e revogar passam na frente.
  revogar: 1,
  desligar_aprendizado: 1,
  esquecer: 1,
  apagar_tudo: 1,
  cancelar_missao: 1,
  aprovar: 2,
  recusar: 2,
  contestar: 2,
  ligar_aprendizado: 2,
  criar_missao: 2,
  tentar_de_novo: 2,
  identificacao: 2,
};

/** Id da ação, gerado no aparelho: 22 caracteres base64url (128 bits). */
export function novoOpId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class Fila {
  /** @type {Promise<{ enviadas: number, parouPor: "fim" | "rede" | "sessao" }> | null} */
  #drenando = null;

  /**
   * @param {Armazem} armazem
   * @param {(op: Op) => Promise<Envio>} enviar
   * @param {() => number} [agora]
   */
  constructor(armazem, enviar, agora = () => Date.now()) {
    this.armazem = armazem;
    this.enviar = enviar;
    this.agora = agora;
  }

  /** Grava a ação no aparelho. Não espera a rede: quem chama dispara `drenar()` sem aguardar. */
  async registrar(/** @type {Acao} */ acao) {
    /** @type {Op} */
    const op = { opId: novoOpId(), acao, criadaEm: this.agora(), estado: "pendente", tentativas: 0 };
    await this.armazem.put(op);
    return op;
  }

  /** Envia o que está pendente. Duas chamadas ao mesmo tempo viram uma só. */
  drenar() {
    if (!this.#drenando) this.#drenando = this.#drenar().finally(() => (this.#drenando = null));
    return this.#drenando;
  }

  async #drenar() {
    let enviadas = 0;
    const pendentes = (await this.armazem.all())
      .filter((o) => o.estado === "pendente")
      .sort((a, b) => PRIORIDADE[a.acao.tipo] - PRIORIDADE[b.acao.tipo] || a.criadaEm - b.criadaEm);
    for (const op of pendentes) {
      /** @type {Envio} */
      let r;
      try {
        r = await this.enviar(op);
      } catch {
        r = { tipo: "temporaria" };
      }
      if (r.tipo === "resultado") {
        await this.armazem.put({ ...op, estado: r.resultado.ok ? "feita" : "recusada", resultado: r.resultado, resolvidaEm: this.agora() });
        enviadas++;
        continue;
      }
      // Sem rede ou sem sessão: para aqui e tenta de novo depois, sem perder nada.
      await this.armazem.put({ ...op, tentativas: op.tentativas + 1 });
      return { enviadas, parouPor: r.tipo === "sessao" ? /** @type {const} */ ("sessao") : /** @type {const} */ ("rede") };
    }
    return { enviadas, parouPor: /** @type {const} */ ("fim") };
  }

  /** O que ainda não chegou ao servidor. */
  async pendentes() {
    return (await this.armazem.all()).filter((o) => o.estado === "pendente");
  }

  /** O que já tem resposta, para a tela mostrar o desfecho (inclusive recusas). */
  async resolvidas() {
    return (await this.armazem.all()).filter((o) => o.estado !== "pendente");
  }

  /** Apaga desfechos antigos. Pendente nunca é apagado. */
  async limpar(idadeMs = 24 * 3600 * 1000) {
    const limite = this.agora() - idadeMs;
    for (const o of await this.armazem.all()) if (o.estado !== "pendente" && (o.resolvidaEm ?? o.criadaEm) < limite) await this.armazem.delete(o.opId);
  }
}

/** Armazém em memória (testes, ou navegador sem IndexedDB). */
export class ArmazemEmMemoria {
  /** @type {Map<string, Op>} */
  #m = new Map();
  async get(/** @type {string} */ id) {
    const o = this.#m.get(id);
    return o ? structuredClone(o) : undefined;
  }
  async put(/** @type {Op} */ op) {
    this.#m.set(op.opId, structuredClone(op));
  }
  async all() {
    return [...this.#m.values()].map((o) => structuredClone(o));
  }
  async delete(/** @type {string} */ id) {
    this.#m.delete(id);
  }
}

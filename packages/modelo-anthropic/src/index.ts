// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// O adaptador do modelo para o laço do agente (ModeloAgente, @obedient/agent-orchestrator), pela
// Messages API da Anthropic com o SDK oficial.
//
//   • o conteúdo da resposta volta ao laço como veio (raciocínio e marcas de fallback incluídos),
//     e o laço o devolve sem editar: a conversa só cresce no fim;
//   • o esforço vai em output_config.effort; o raciocínio fica no modo do modelo (adaptativo);
//   • com fallbacks "default", uma recusa dos classificadores de segurança é refeita no servidor
//     num modelo que a Anthropic indica para aquela categoria. Desligável (fallbacks: false);
//   • erro transitório (rede, 408, 409, 429, 5xx, 529) vira ErroModelo transitório: a missão tenta
//     de novo mais tarde. O SDK já repete algumas vezes antes de desistir;
//   • o gasto de cada resposta é somado em dólares, por modelo que de fato respondeu (cada tentativa
//     de fallback é cobrada pela tabela do modelo dela). Modelo fora da tabela: o adaptador não
//     sobe, porque sem preço não há como respeitar o teto de custo da missão (Art. 7º).

import Anthropic from "@anthropic-ai/sdk";
import { type Esforco, ErroModelo, type BlocoModelo, type ModeloAgente, type PedidoModelo, type RespostaModelo } from "@obedient/agent-orchestrator";

export const MODELO_PADRAO = "claude-opus-5-5";

/** Dólares por milhão de tokens (tabela pública da Anthropic, outubro de 2026). */
export interface Preco {
  entrada: number;
  saida: number;
  leituraDeCache: number;
}
export const PRECOS: Readonly<Record<string, Preco>> = {
  "claude-fable-5-1": { entrada: 10, saida: 50, leituraDeCache: 0.25 },
  "claude-opus-5-5": { entrada: 4, saida: 20, leituraDeCache: 0.2 },
  "claude-opus-5": { entrada: 5, saida: 25, leituraDeCache: 0.5 },
  "claude-opus-4-8": { entrada: 5, saida: 25, leituraDeCache: 0.5 },
  "claude-sonnet-5-5": { entrada: 2, saida: 10, leituraDeCache: 0.2 },
  // Haiku 5.5 custa mais acima de 100 mil tokens de entrada; a tabela usa o preço maior.
  "claude-haiku-5-5": { entrada: 0.5, saida: 2.5, leituraDeCache: 0.05 },
};
/** Gravar no cache custa 1,25 vez a entrada (cache de 5 minutos). */
const FATOR_ESCRITA_DE_CACHE = 1.25;
/** Modelo que respondeu e não está na tabela (um fallback novo): cobra pelo mais caro. */
const PRECO_MAIS_ALTO: Preco = Object.values(PRECOS).reduce((a, b) => (b.saida > a.saida ? b : a));

/** Modelos em que a Anthropic oferece o fallback "default" no servidor. */
const COM_FALLBACK = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5"]);
const BETA_FALLBACK = "server-side-fallback-2026-07-01";

export interface Uso {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function custoEmDolares(modelo: string, u: Uso): number {
  const p = PRECOS[modelo] ?? PRECO_MAIS_ALTO;
  const m = 1_000_000;
  return (
    (u.input_tokens * p.entrada + u.output_tokens * p.saida + (u.cache_read_input_tokens ?? 0) * p.leituraDeCache + (u.cache_creation_input_tokens ?? 0) * p.entrada * FATOR_ESCRITA_DE_CACHE) / m
  );
}

export interface OpcoesModelo {
  cliente: Anthropic;
  modelo?: string;
  esforco?: Esforco;
  /** Refazer no servidor o que os classificadores recusarem (padrão: sim, onde existe). */
  fallbacks?: boolean;
}

type Mensagem = Anthropic.Beta.BetaMessage;

export class ModeloAnthropic implements ModeloAgente {
  readonly modelo: string;
  private readonly esforco: Esforco;
  private readonly fallbacks: boolean;
  /** Gasto somado de todas as respostas deste adaptador, em dólares. */
  gastoEmDolares = 0;

  constructor(private readonly o: OpcoesModelo) {
    this.modelo = o.modelo ?? MODELO_PADRAO;
    if (!PRECOS[this.modelo]) throw new Error(`modelo sem preço conhecido: ${this.modelo}. Sem preço, o teto de custo das missões não vale.`);
    this.esforco = o.esforco ?? "high";
    this.fallbacks = (o.fallbacks ?? true) && COM_FALLBACK.has(this.modelo);
  }

  async responder(p: PedidoModelo): Promise<RespostaModelo> {
    let r: Mensagem;
    try {
      r = await this.o.cliente.beta.messages.create(
        {
          model: this.modelo,
          max_tokens: p.maxTokens,
          system: p.system,
          // A conversa vai como o laço guardou: o mesmo formato da Messages API.
          messages: p.messages as unknown as Anthropic.Beta.BetaMessageParam[],
          tools: p.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as Anthropic.Beta.BetaTool.InputSchema })),
          output_config: { effort: this.esforco },
          // Cache automático: no laço, cada volta repete o começo da conversa.
          cache_control: { type: "ephemeral" },
          ...(this.fallbacks ? { betas: [BETA_FALLBACK], fallbacks: "default" as const } : {}),
        },
        { signal: p.signal },
      );
    } catch (e) {
      throw paraErroModelo(e);
    }
    this.gastoEmDolares += gastoDa(r);
    return {
      content: r.content as unknown as BlocoModelo[],
      stopReason: r.stop_reason,
      model: r.model,
      usage: {
        input: r.usage.input_tokens,
        output: r.usage.output_tokens,
        cacheRead: r.usage.cache_read_input_tokens ?? 0,
        cacheWrite: r.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

/** Com fallback, `usage.iterations` traz cada tentativa (e o modelo de cada uma); sem, vale o uso do topo. */
function gastoDa(r: Mensagem): number {
  const iteracoes = (r.usage.iterations ?? []) as unknown as (Uso & { model?: string })[];
  if (iteracoes.length) return iteracoes.reduce((s, i) => s + custoEmDolares(i.model ?? r.model, i), 0);
  return custoEmDolares(r.model, r.usage);
}

export function paraErroModelo(e: unknown): ErroModelo {
  if (e instanceof ErroModelo) return e;
  // O laço aborta no fim do prazo do run.
  if (e instanceof Anthropic.APIUserAbortError) return new ErroModelo("timeout", "o prazo da tentativa acabou durante a chamada ao modelo", false);
  // Rede (inclui o tempo de uma chamada esgotado): passa.
  if (e instanceof Anthropic.APIConnectionError) return new ErroModelo("rede", "não foi possível falar com o modelo", true);
  if (e instanceof Anthropic.APIError) {
    const s = e.status ?? 0;
    if (s === 429) return new ErroModelo("limite_de_uso", "o provedor do modelo pediu para esperar (limite de uso)", true);
    if (s === 408 || s === 409 || s >= 500) return new ErroModelo("indisponivel", `o provedor do modelo está indisponível (${s})`, true);
    if (s === 401 || s === 403) return new ErroModelo("credencial", "a chave do provedor do modelo foi recusada", false);
    if (s === 402) return new ErroModelo("sem_credito", "a conta do provedor do modelo está sem crédito", false);
    return new ErroModelo("pedido_recusado", `o provedor do modelo recusou o pedido (${s}): ${e.message.slice(0, 300)}`, false);
  }
  return new ErroModelo("modelo", e instanceof Error ? e.message : String(e), false);
}

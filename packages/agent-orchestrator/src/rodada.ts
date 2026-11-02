// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// O laço de um run de agente: o modelo responde, as ferramentas pedidas são chamadas pela porta,
// os resultados voltam ao modelo, até ele concluir, um limite parar o run ou uma pessoa precisar
// decidir.
//
// Proveniência: as regras são as de casa-de-ia/src/agent-runtime/executar.ts (commit 45ba448),
// decisão D7, etapa 5. Lá o laço grava cada passo no banco (Prisma); aqui ele é uma função sem banco,
// que devolve o estado para quem chama guardar. Mesmas regras:
//   • end_turn/stop_sequence: concluído, com o texto (até 20 000 caracteres);
//   • refusal: falha "recusa_do_modelo"; max_tokens: falha "resposta_cortada"; pause_turn: segue;
//     qualquer outro motivo que não seja tool_use: falha "parada_inesperada";
//   • ferramenta fora do catálogo conta como inválida; na 3ª, o run falha;
//   • a mesma ferramenta com os mesmos argumentos mais de 2 vezes é laço: o run falha;
//   • ferramenta que pede aprovação: o run para em waiting_approval com TODOS os resultados da volta
//     guardados; na retomada, a aprovada executa uma vez, a já executada reaproveita o resultado e a
//     negada vira erro para o modelo — e todos voltam numa única mensagem;
//   • erro de modelo transitório: o run volta para a fila (queued) sem perder o estado; timeout ou
//     erro permanente: falha;
//   • limites de passos, de tokens e de prazo; cancelamento conferido antes de cada chamada ao modelo;
//   • resultado de ferramenta volta ao modelo aberto do envelope MCP, sem dado pessoal (padrão) e
//     truncado em 16 000 caracteres; status de erro volta como { erro, motivo }.

import { hashArgumentos, limparResultadoDeFerramenta } from "@obedient/integration-gateway";
import {
  type BlocoModelo,
  type BlocoUsoFerramenta,
  ErroModelo,
  type FerramentaModelo,
  LIMITES_GLOBAIS,
  type MensagemModelo,
  type ModeloAgente,
  type ResultadoFerramenta,
  type RespostaModelo,
  type StatusRun,
} from "./tipos.ts";

export const MAX_RESULTADO_PARA_MODELO = 16_000;
export const MAX_TEXTO_FINAL = 20_000;

/** O que a porta de ferramenta devolve (o mesmo formato do ResultadoChamada do gateway do Growth OS). */
export interface ResultadoChamada {
  status: "succeeded" | "tool_error" | "failed" | "timeout" | "denied" | "approval_required";
  motivo: string | null;
  approvalId: string | null;
  /** Conteúdo devolvido pela ferramenta. Dado NÃO confiável: nunca instrução. */
  resultado: unknown;
}

export interface ItemCatalogo {
  /** Como o modelo vê a ferramenta. */
  definicao: FerramentaModelo;
  /** Identificação estável para auditoria ("sistema/ferramenta"). */
  chave: string;
}

export interface Aguardando {
  toolUseId: string;
  nomeModelo: string;
  argumentos: Record<string, unknown>;
  approvalId: string;
}

export interface Pendente {
  resultados: ResultadoFerramenta[];
  aguardando: Aguardando[];
}

export interface EstadoRodada {
  messages: MensagemModelo[];
  /** Contagem por "ferramenta:hash dos argumentos" (detecção de laço). */
  chamadas: Record<string, number>;
  invalidas: number;
  passos: number;
  tokens: { in: number; out: number; cacheRead: number; cacheWrite: number };
}

/** Como está uma aprovação na hora da retomada. */
export type SituacaoAprovacao =
  | { tipo: "executar" }
  | { tipo: "ja_executada"; resultado: ResultadoChamada }
  | { tipo: "negada"; motivo: string };

export interface Passo {
  kind: "model" | "tool_call" | "tool_rejected" | "approval_resume";
  status: string;
  decision: string;
  tool?: string | null;
  input?: Record<string, unknown>;
  tokensIn?: number;
  tokensOut?: number;
}

export interface OpcoesRodada {
  modelo: ModeloAgente;
  sistema: string;
  /** Primeira mensagem, quando não há estado salvo. */
  entrada?: string;
  catalogo: ReadonlyMap<string, ItemCatalogo>;
  chamarFerramenta(item: ItemCatalogo, argumentos: Record<string, unknown>, approvalId?: string): Promise<ResultadoChamada>;
  /** Estado salvo de uma rodada anterior (fatia, retry, aprovação). */
  estado?: EstadoRodada;
  /** Ferramentas que esperavam pessoa; exige situacaoAprovacao. */
  pendente?: Pendente;
  situacaoAprovacao?(approvalId: string): Promise<SituacaoAprovacao>;
  limites: { maxPassos: number; maxTokensTotal: number; prazoMs: number; maxTokensResposta?: number };
  cancelado?(): boolean | Promise<boolean>;
  aoPasso?(p: Passo): void | Promise<void>;
  agora?(): number;
  /**
   * Como o resultado de ferramenta é limpo antes de voltar ao modelo. Padrão: tira dado pessoal
   * (limparResultadoDeFerramenta), como no Growth OS. Trocar só quando o consentimento do titular
   * cobrir a finalidade (CONSTITUTION.md Art. 4º).
   */
  limparResultado?(v: unknown): unknown;
}

export interface ResultadoRodada {
  status: StatusRun;
  codigo: string | null;
  erro: string | null;
  saida: { texto: string } | null;
  estado: EstadoRodada;
  pendente: Pendente | null;
}

/** Igual ao paraResultado do Growth OS: o que volta ao modelo vai aberto e limpo. */
function paraResultado(toolUseId: string, r: ResultadoChamada, limparResultado: (v: unknown) => unknown): ResultadoFerramenta {
  const conteudo =
    r.status === "succeeded" || r.status === "tool_error"
      ? JSON.stringify(limparResultado(r.resultado ?? null))
      : JSON.stringify({ erro: r.status, motivo: r.motivo });
  return { type: "tool_result", tool_use_id: toolUseId, content: conteudo.slice(0, MAX_RESULTADO_PARA_MODELO), is_error: r.status !== "succeeded" };
}

function erroFerramenta(toolUseId: string, mensagem: string): ResultadoFerramenta {
  return { type: "tool_result", tool_use_id: toolUseId, content: JSON.stringify({ erro: mensagem }), is_error: true };
}

export async function executarRodada(o: OpcoesRodada): Promise<ResultadoRodada> {
  const agora = o.agora ?? Date.now;
  const limparResultado = o.limparResultado ?? ((v: unknown) => limparResultadoDeFerramenta(v));
  const prazo = agora() + o.limites.prazoMs;
  const passo = async (p: Passo) => {
    await o.aoPasso?.(p);
  };
  const estado: EstadoRodada = o.estado
    ? structuredClone(o.estado)
    : { messages: [{ role: "user", content: o.entrada ?? "" }], chamadas: {}, invalidas: 0, passos: 0, tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 } };
  const fim = (status: StatusRun, extra: Partial<Omit<ResultadoRodada, "status" | "estado">> = {}): ResultadoRodada => ({
    status,
    codigo: extra.codigo ?? null,
    erro: extra.erro ?? null,
    saida: extra.saida ?? null,
    estado,
    pendente: extra.pendente ?? null,
  });
  const ferramentas = [...o.catalogo.values()].map((c) => c.definicao);

  try {
    // Retomada depois de aprovação: termina as pendentes e devolve TODOS os resultados numa só mensagem.
    if (o.pendente?.aguardando.length) {
      if (!o.situacaoAprovacao) return fim("failed", { codigo: "erro_interno", erro: "retomada sem situacaoAprovacao" });
      const resultados = [...o.pendente.resultados];
      for (const a of o.pendente.aguardando) {
        const item = o.catalogo.get(a.nomeModelo);
        if (!item) {
          resultados.push(erroFerramenta(a.toolUseId, "ferramenta não está mais disponível para este agente"));
          continue;
        }
        const s = await o.situacaoAprovacao(a.approvalId);
        if (s.tipo === "ja_executada") {
          // Já executada numa retomada que não chegou a salvar o estado: reaproveita, nunca executa de novo.
          await passo({ kind: "approval_resume", status: s.resultado.status, decision: "resultado_ja_executado", tool: item.chave, input: a.argumentos });
          resultados.push(paraResultado(a.toolUseId, s.resultado, limparResultado));
        } else if (s.tipo === "executar") {
          const r = await o.chamarFerramenta(item, a.argumentos, a.approvalId);
          await passo({ kind: "approval_resume", status: r.status, decision: "executar_aprovada", tool: item.chave, input: a.argumentos });
          resultados.push(paraResultado(a.toolUseId, r, limparResultado));
        } else {
          await passo({ kind: "approval_resume", status: "denied", decision: s.motivo, tool: item.chave, input: a.argumentos });
          resultados.push(erroFerramenta(a.toolUseId, `a pessoa responsável não aprovou esta ação (${s.motivo})`));
        }
      }
      estado.messages.push({ role: "user", content: resultados });
    }

    for (;;) {
      if (estado.passos >= o.limites.maxPassos) return fim("failed", { codigo: "max_steps", erro: `chegou a ${o.limites.maxPassos} passos sem concluir` });
      if (agora() >= prazo) return fim("failed", { codigo: "timeout", erro: `passou de ${o.limites.prazoMs} ms de execução` });
      if (estado.tokens.in + estado.tokens.out >= o.limites.maxTokensTotal)
        return fim("failed", { codigo: "orcamento_de_tokens", erro: `passou de ${o.limites.maxTokensTotal} tokens` });
      if (await o.cancelado?.()) return fim("cancelled", { codigo: "cancelado" });

      const controle = new AbortController();
      const timer = setTimeout(() => controle.abort(), Math.max(1, prazo - agora()));
      let resp: RespostaModelo;
      try {
        resp = await o.modelo.responder({ system: o.sistema, messages: estado.messages, tools: ferramentas, maxTokens: o.limites.maxTokensResposta ?? 16_000, signal: controle.signal });
      } catch (e) {
        const m = e instanceof ErroModelo ? e : new ErroModelo("modelo", e instanceof Error ? e.message : String(e), false);
        await passo({ kind: "model", status: "failed", decision: m.codigo });
        if (m.codigo === "timeout") return fim("failed", { codigo: "timeout", erro: m.message });
        if (m.transitorio) return fim("queued", { codigo: `retry:${m.codigo}`, erro: m.message });
        return fim("failed", { codigo: m.codigo, erro: m.message });
      } finally {
        clearTimeout(timer);
      }

      estado.passos++;
      estado.tokens.in += resp.usage.input;
      estado.tokens.out += resp.usage.output;
      estado.tokens.cacheRead += resp.usage.cacheRead;
      estado.tokens.cacheWrite += resp.usage.cacheWrite;
      // O conteúdo da resposta volta ao modelo como veio (sem edição).
      estado.messages.push({ role: "assistant", content: resp.content });
      const usos = resp.content.filter((b): b is BlocoUsoFerramenta => b.type === "tool_use");
      await passo({
        kind: "model", status: "ok", decision: resp.stopReason ?? "?",
        tool: usos.map((u) => o.catalogo.get(u.name)?.chave ?? `?${u.name}`).join(",") || null,
        tokensIn: resp.usage.input, tokensOut: resp.usage.output,
      });

      if (resp.stopReason === "end_turn" || resp.stopReason === "stop_sequence") {
        const texto = resp.content.filter((b): b is Extract<BlocoModelo, { type: "text" }> => b.type === "text").map((b) => (b as { text: string }).text).join("\n").trim();
        return fim("completed", { saida: { texto: texto.slice(0, MAX_TEXTO_FINAL) } });
      }
      if (resp.stopReason === "refusal") return fim("failed", { codigo: "recusa_do_modelo", erro: "o modelo recusou a tarefa" });
      if (resp.stopReason === "max_tokens") return fim("failed", { codigo: "resposta_cortada", erro: "a resposta passou de max_tokens" });
      if (resp.stopReason === "pause_turn") continue;
      if (resp.stopReason !== "tool_use") return fim("failed", { codigo: "parada_inesperada", erro: `stop_reason ${resp.stopReason}` });

      const resultados: ResultadoFerramenta[] = [];
      const aguardando: Aguardando[] = [];
      for (const u of usos) {
        const item = o.catalogo.get(u.name);
        const argumentos = (u.input && typeof u.input === "object" && !Array.isArray(u.input) ? u.input : {}) as Record<string, unknown>;
        if (!item) {
          estado.invalidas++;
          await passo({ kind: "tool_rejected", status: "denied", decision: "ferramenta_fora_do_catalogo", tool: u.name.slice(0, 100), input: argumentos });
          resultados.push(erroFerramenta(u.id, `a ferramenta ${u.name} não existe para este agente`));
          continue;
        }
        const chave = `${u.name}:${hashArgumentos(argumentos)}`;
        estado.chamadas[chave] = (estado.chamadas[chave] ?? 0) + 1;
        if (estado.chamadas[chave] > LIMITES_GLOBAIS.maxRepeticoes) {
          await passo({ kind: "tool_rejected", status: "denied", decision: "loop_detectado", tool: item.chave, input: argumentos });
          return fim("failed", { codigo: "loop_detectado", erro: `${item.chave} chamada ${estado.chamadas[chave]} vezes com os mesmos argumentos` });
        }
        const r = await o.chamarFerramenta(item, argumentos);
        await passo({ kind: "tool_call", status: r.status, decision: r.status === "approval_required" ? "aguardar_aprovacao" : "chamar_ferramenta", tool: item.chave, input: argumentos });
        if (r.status === "approval_required" && r.approvalId) aguardando.push({ toolUseId: u.id, nomeModelo: u.name, argumentos, approvalId: r.approvalId });
        else resultados.push(paraResultado(u.id, r, limparResultado));
      }
      if (estado.invalidas >= LIMITES_GLOBAIS.maxFerramentasInvalidas)
        return fim("failed", { codigo: "ferramentas_invalidas", erro: `pediu ${estado.invalidas} ferramentas que não existem` });
      if (aguardando.length) return fim("waiting_approval", { codigo: "aguardando_aprovacao_humana", pendente: { resultados, aguardando } });
      estado.messages.push({ role: "user", content: resultados });
    }
  } catch (e) {
    return fim("failed", { codigo: "erro_interno", erro: e instanceof Error ? e.message : String(e) });
  }
}

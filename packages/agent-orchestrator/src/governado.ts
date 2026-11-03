// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// A ligação do laço com o Ethics Engine do OBEDIENT. No Growth OS esse papel é do MCP Gateway com as
// políticas da organização; aqui é a Constituição (Arts. 1º, 3º, 4º, 6º e 12):
//
//   • toda ferramenta passa por engine.authorize(): sem grant, negada; acima da autonomia do grant,
//     proposta; o modelo nunca decide nada disso;
//   • proposta pendente para o run (waiting_approval); só a PESSOA aprova, no cartão;
//   • na retomada, executa uma vez, com o payload exato aprovado (hash). Argumento diferente do
//     aprovado é recusado, mesmo com o id da aprovação certo;
//   • o que a ferramenta devolve vai marcado como conteúdo externo: é dado, nunca instrução.

import { ObedientError, payloadHash, type RiskLevel, type ToolCategory } from "@obedient/core";
import type { EthicsEngine } from "@obedient/ethics-engine";
import type { ItemCatalogo, ResultadoChamada, SituacaoAprovacao } from "./rodada.ts";

/** Ferramenta com o que o registro diz dela (nunca o modelo): sistema, risco, categoria, dados pessoais. */
export interface ItemGovernado extends ItemCatalogo {
  sistema: string;
  ferramenta: string;
  risco: RiskLevel;
  categoria: ToolCategory;
  dadosPessoais?: readonly string[];
  /** Finalidade própria da ferramenta para o consentimento (ex.: "integracao:google_agenda"); vale sobre a da missão. */
  finalidade?: string;
}

export interface Quem {
  userId: string;
  agentId: string;
  /** Finalidade da missão, para conferir consentimento quando a ferramenta toca dado pessoal. */
  finalidade?: string;
  correlationId?: string;
}

export type Executor = (sistema: string, ferramenta: string, argumentos: Record<string, unknown>) => Promise<unknown>;

const externo = (v: unknown) => ({ conteudo_externo: v });

function ehGovernado(item: ItemCatalogo): item is ItemGovernado {
  const i = item as Partial<ItemGovernado>;
  return typeof i.sistema === "string" && typeof i.ferramenta === "string" && typeof i.risco === "string" && typeof i.categoria === "string";
}

/**
 * Como abrir o motor para uma etapa. Em memória: o mesmo motor sempre. No servidor: uma transação
 * curta por etapa (autorizar; reivindicar; concluir), para a chamada ao sistema de destino, que pode
 * demorar, acontecer FORA de qualquer transação do banco.
 */
export type AbrirMotor = <T>(fn: (engine: EthicsEngine) => Promise<T>) => Promise<T>;

/** Porta chamarFerramenta da rodada, governada pelo Ethics Engine. */
export function chamarComEthics(engine: EthicsEngine, quem: Quem, executor: Executor) {
  return chamarComEthicsEmEtapas((fn) => fn(engine), quem, executor);
}

/** Igual a chamarComEthics, com cada etapa de banco aberta por `abrir` e a execução fora delas. */
export function chamarComEthicsEmEtapas(abrir: AbrirMotor, quem: Quem, executor: Executor) {
  return async (item: ItemCatalogo, argumentos: Record<string, unknown>, approvalId?: string): Promise<ResultadoChamada> => {
    // Ferramenta sem registro completo não roda: na dúvida, não age (Art. 6º).
    if (!ehGovernado(item)) return { status: "denied", motivo: "ferramenta_sem_registro_de_risco", approvalId: null, resultado: null };

    if (approvalId) {
      // Etapa 1: confere dono e payload, e reivindica a execução (uma vez só).
      const reivindicada = await abrir(async (engine) => {
        const p = await engine.approvals.get(approvalId);
        if (!p || p.userId !== quem.userId) return { negado: "aprovacao_inexistente" } as const;
        // O id certo não basta: o payload tem de ser o que a pessoa viu.
        if (payloadHash({ systemId: item.sistema, tool: item.ferramenta, args: argumentos }) !== p.payloadHash) return { negado: "payload_diferente_do_aprovado" } as const;
        try {
          return { payload: await engine.claimApproved(approvalId, p.payloadHash), hash: p.payloadHash } as const;
        } catch (e) {
          if (e instanceof ObedientError) return { negado: e.code } as const;
          throw e;
        }
      });
      if ("negado" in reivindicada) return { status: "denied", motivo: reivindicada.negado ?? "negado", approvalId, resultado: null };
      // Etapa 2: executa, fora de transação.
      let resultado: unknown;
      let falha: string | null = null;
      try {
        resultado = await executor(reivindicada.payload.systemId, reivindicada.payload.tool, reivindicada.payload.args);
      } catch (e) {
        falha = e instanceof Error ? e.message : String(e);
      }
      // Etapa 3: registra o desfecho.
      await abrir((engine) => engine.completeApproved(approvalId, reivindicada.hash, falha === null, falha ?? undefined));
      return falha === null ? { status: "succeeded", motivo: null, approvalId, resultado: externo(resultado) } : { status: "tool_error", motivo: falha, approvalId, resultado: null };
    }

    const a = await abrir((engine) =>
      engine.authorize({
        userId: quem.userId,
        agentId: quem.agentId,
        systemId: item.sistema,
        tool: item.ferramenta,
        risk: item.risco,
        category: item.categoria,
        args: argumentos,
        ...(item.dadosPessoais?.length ? { dataCategories: item.dadosPessoais } : {}),
        ...((item.finalidade ?? quem.finalidade) ? { purpose: item.finalidade ?? quem.finalidade } : {}),
        ...(quem.correlationId ? { correlationId: quem.correlationId } : {}),
      }),
    );
    if (a.outcome === "denied") return { status: "denied", motivo: a.reasons.join("; "), approvalId: null, resultado: null };
    if (a.outcome === "approval_required") return { status: "approval_required", motivo: a.decision.reason, approvalId: a.proposal.id, resultado: null };
    try {
      return { status: "succeeded", motivo: null, approvalId: null, resultado: externo(await executor(item.sistema, item.ferramenta, argumentos)) };
    } catch (e) {
      return { status: "tool_error", motivo: e instanceof Error ? e.message : String(e), approvalId: null, resultado: null };
    }
  };
}

/** Porta situacaoAprovacao da rodada, lida das propostas do Ethics Engine. */
export function situacaoPeloEthics(engine: EthicsEngine) {
  return situacaoPeloEthicsEmEtapas((fn) => fn(engine));
}

export function situacaoPeloEthicsEmEtapas(abrir: AbrirMotor) {
  return async (approvalId: string): Promise<SituacaoAprovacao> => {
    const p = await abrir((engine) => engine.approvals.get(approvalId));
    if (!p) return { tipo: "negada", motivo: "aprovacao_inexistente" };
    if (p.status === "approved") return { tipo: "executar" };
    // Já executada numa retomada que não salvou o estado: nunca executa de novo.
    if (p.status === "executed" || p.status === "executing" || p.status === "failed")
      return { tipo: "ja_executada", resultado: { status: "failed", motivo: "aprovacao_usada_sem_registro", approvalId, resultado: null } };
    // Ainda pendente na retomada = a pessoa não decidiu a tempo (mesma leitura do Growth OS).
    return { tipo: "negada", motivo: p.status === "pending" ? "aprovacao_vencida" : `aprovacao_${p.status}` };
  };
}

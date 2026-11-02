// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// DOTS adapter — fase 3: SÓ LEITURA.
//
// O DOTS (o supervisor do fundador) existe em dois sistemas: o Dot Recupera, que conversa com o
// MCP do Recupera OS, e o Dot do Motor de Triagem, uma identidade no MCP V2 do Motor. Este pacote NÃO
// importa código de nenhum dos dois: fala o protocolo MCP com os servidores que já existem, com a
// identidade que cada um já conhece. Três travas, em ordem:
//
//   1. allowlist estrutural de ferramentas de leitura por sistema (não existe método de escrita;
//      ferramenta fora da lista é recusada antes de chegar à rede);
//   2. Ethics Engine do OBEDIENT (grant do usuário para o agente "dots", parada, auditoria);
//   3. a política do próprio servidor de destino (perfil SUPERVISOR no Recupera, `dot` no Motor).
//
// O OBEDIENT só estreita o DOTS: nunca amplia o que o destino recusa.
// O resultado volta marcado como conteúdo externo: é dado, não instrução (Art. 6º).

import { ObedientError } from "@obedient/core";
import type { EthicsEngine } from "@obedient/ethics-engine";

/** O mínimo de um cliente MCP de que o adaptador precisa (o SDK oficial cumpre isto). */
export interface McpClientLike {
  callTool(req: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
}

export const DOTS_AGENT_ID = "dots";

/**
 * Ferramentas de leitura conhecidas, por sistema, com o nome REAL do servidor (com ponto; o cliente
 * do claude.ai mostra com sublinhado). Conferidas no código-fonte em 02/11/2026: todas com
 * category READ e risco LOW no registro do servidor —
 *   recupera-mcp/src/agentic/tools/contexto.ts (minhas_capacidades, gerar_resumo_executivo),
 *   aprovacoes.ts (listar_decisoes_pendentes), dot.ts (dot_decisoes_recentes, dot_eventos_novos),
 *   planilha.ts (dot_retornos_pendentes), leitura.ts (listar_excecoes);
 *   motor-triagem-iga/mcp/tools/automation/index.ts (quem_sou_eu), management/index.ts
 *   (listar_excecoes, listar_leads_sla_estourado), events/index.ts (listar_eventos_desde).
 * Acrescentar uma é PR com teste e com a referência ao registro do servidor.
 */
export const READ_ONLY_TOOLS = {
  recupera: [
    "recupera.minhas_capacidades",
    "recupera.listar_decisoes_pendentes",
    "recupera.dot_decisoes_recentes",
    "recupera.dot_eventos_novos",
    "recupera.dot_retornos_pendentes",
    "recupera.listar_excecoes",
    "recupera.gerar_resumo_executivo",
  ],
  motor: ["motor.quem_sou_eu", "motor.listar_excecoes", "motor.listar_eventos_desde", "motor.listar_leads_sla_estourado"],
} as const satisfies Record<string, readonly string[]>;

export type DotsSystem = keyof typeof READ_ONLY_TOOLS;

export interface ExternalContent {
  /** Sempre true: o que vem do DOTS é dado de outro sistema, não ordem para o OBEDIENT. */
  untrusted: true;
  system: DotsSystem;
  tool: string;
  data: unknown;
}

export type DotsReadResult =
  | { ok: true; content: ExternalContent }
  | { ok: false; reason: "denied" | "approval_required"; detail: string[] };

export interface DotsAdapterOptions {
  engine: EthicsEngine;
  clients: Partial<Record<DotsSystem, McpClientLike>>;
  /**
   * Chamado quando a parada de emergência é acionada para o usuário: o integrador revoga o token
   * OAuth do DOTS no servidor de destino (o Recupera impede que token revogado caia em outro perfil).
   */
  revokeRemoteToken?: (system: DotsSystem, userId: string) => Promise<void>;
}

export class DotsAdapter {
  constructor(private readonly opts: DotsAdapterOptions) {
    opts.engine.stop.onEngage(async (scope) => {
      if (scope.kind !== "user" || !opts.revokeRemoteToken) return;
      for (const system of Object.keys(opts.clients) as DotsSystem[]) await opts.revokeRemoteToken(system, scope.userId);
    });
  }

  isReadOnly(system: string, tool: string): boolean {
    const list = (READ_ONLY_TOOLS as Record<string, readonly string[]>)[system];
    return !!list && list.includes(tool);
  }

  async read(userId: string, system: DotsSystem, tool: string, args: Record<string, unknown> = {}): Promise<DotsReadResult> {
    // Trava 1: estrutural, antes do motor e antes da rede.
    if (!this.isReadOnly(system, tool)) throw new ObedientError("NOT_READ_ONLY", `${system}.${tool} não está na lista de leitura do DOTS`);
    const client = this.opts.clients[system];
    if (!client) throw new ObedientError("NOT_READ_ONLY", `sem cliente configurado para ${system}`);

    // Trava 2: Ethics Engine.
    const auth = this.opts.engine.authorize({
      userId,
      agentId: DOTS_AGENT_ID,
      systemId: system,
      tool,
      risk: "LOW",
      category: "READ",
      args,
      context: { entity_type: "dots_read" },
    });
    if (auth.outcome === "denied") return { ok: false, reason: "denied", detail: auth.reasons };
    // Leitura nunca deveria pedir aprovação; se uma política do usuário exigir, respeita e não chama.
    if (auth.outcome === "approval_required") return { ok: false, reason: "approval_required", detail: [auth.decision.reason] };

    // Trava 3 é do servidor de destino.
    const data = await client.callTool({ name: tool, arguments: args });
    return { ok: true, content: { untrusted: true, system, tool, data } };
  }
}

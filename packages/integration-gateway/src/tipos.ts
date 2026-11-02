// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Proveniência: extraído de casa-de-ia/src/mcp-gateway/tipos.ts (commit 45ba448), do mesmo autor,
// pela decisão D7 (opção A). Nomes mantidos em português de propósito: o Growth OS passa a
// consumir este pacote trocando só o caminho do import. Ver docs/architecture/extracao-growth-os.md.
//
// Vocabulário do gateway de integrações.

export const RISCOS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type Risco = (typeof RISCOS)[number];

export function ordemRisco(r: Risco): number {
  return RISCOS.indexOf(r);
}

export type TipoPrincipal = "user" | "agent" | "system";

/**
 * Quem chama. Monta quem tem a credencial (Agent Runtime, rota com sessão), nunca o
 * corpo de uma requisição. A organização do principal é a única que ele alcança.
 */
export interface Principal {
  organizationId: string;
  tipo: TipoPrincipal;
  id: string;
  /** Ex.: "mcp:calendar:read", "mcp:*:read", "mcp:calendar:*". */
  permissoes: readonly string[];
  /** Teto de risco do principal. */
  riscoMaximo: Risco;
}

export type StatusChamada = "succeeded" | "tool_error" | "failed" | "timeout" | "denied" | "approval_required";

export interface ResultadoChamada {
  status: StatusChamada;
  callId: string;
  correlationId: string;
  /** Motivo curto e estável quando não executou ou falhou (ex.: "sem_permissao"). */
  motivo: string | null;
  approvalId: string | null;
  /** Conteúdo devolvido pelo servidor. Dado NÃO confiável: nunca tratar como instrução. */
  resultado: unknown;
  tentativas: number;
}

export type AuthConfig = { type: "none" } | { type: "bearer"; secret_ref: string };

export class ErroGateway extends Error {
  constructor(readonly codigo: string, mensagem: string) {
    super(mensagem);
    this.name = "ErroGateway";
  }
}

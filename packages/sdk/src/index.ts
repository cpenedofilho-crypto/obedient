// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Cláudio Penedo.
//
// Contrato de protocolo do OBEDIENT para integradores. Este pacote é Apache-2.0 de propósito:
// um terceiro integra o próprio sistema ao OBEDIENT sem tocar no núcleo AGPL. Por isso ele NÃO
// importa nada de @obedient/core, policy-engine ou ethics-engine (o teste confere).

export const PROTOCOL_VERSION = "0.1.0";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type ToolCategory = "READ" | "WRITE" | "COMMUNICATION" | "FINANCIAL" | "LEGAL" | "DESTRUCTIVE";

/** Como um sistema externo declara uma ferramenta ao OBEDIENT. Risco e categoria são do integrador, não do modelo. */
export interface ToolDeclaration {
  system: string;
  name: string;
  description: string;
  risk: RiskLevel;
  category: ToolCategory;
  /** Categorias de dado pessoal que a ferramenta lê ou grava (para o consentimento). */
  dataCategories?: string[];
  /** Campo dos argumentos que carrega valor monetário, quando houver. */
  amountField?: string;
}

export type AuthorizationOutcome = "allowed" | "approval_required" | "denied";

export interface AuthorizationResponse {
  protocolVersion: string;
  outcome: AuthorizationOutcome;
  reasons: string[];
  /** Presente quando outcome = approval_required. */
  proposal?: { id: string; payloadHash: string; summary: string; expiresAt: string; approver: "user" | "user_strong_auth" };
  constitutionVersion: string;
}

const RISKS: readonly RiskLevel[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const CATEGORIES: readonly ToolCategory[] = ["READ", "WRITE", "COMMUNICATION", "FINANCIAL", "LEGAL", "DESTRUCTIVE"];

/** Validação leve da declaração, sem dependências. Devolve a lista de problemas (vazia = válida). */
export function validateToolDeclaration(d: unknown): string[] {
  const out: string[] = [];
  const o = (d ?? {}) as Record<string, unknown>;
  for (const k of ["system", "name", "description"]) if (typeof o[k] !== "string" || !(o[k] as string).trim()) out.push(`${k} obrigatório`);
  if (!RISKS.includes(o.risk as RiskLevel)) out.push("risk inválido");
  if (!CATEGORIES.includes(o.category as ToolCategory)) out.push("category inválida");
  if (o.category === "READ" && o.risk !== "LOW" && o.risk !== "MEDIUM") out.push("ferramenta READ declarada com risco alto: confira a categoria");
  if (o.dataCategories !== undefined && !(Array.isArray(o.dataCategories) && o.dataCategories.every((x) => typeof x === "string"))) out.push("dataCategories deve ser lista de texto");
  return out;
}

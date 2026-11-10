// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Tipos e utilidades compartilhados por todos os pacotes do OBEDIENT.
// Nada aqui decide nada: decisão mora no policy-engine e no ethics-engine.

import { createHash, randomUUID } from "node:crypto";

export const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** Ordem de risco: LOW < MEDIUM < HIGH < CRITICAL. */
export function riskRank(r: RiskLevel): number {
  return RISK_LEVELS.indexOf(r);
}

/** Categorias estruturais de ferramenta. A categoria vem do registro da ferramenta, nunca do modelo. */
export const TOOL_CATEGORIES = [
  "READ",
  "WRITE",
  "COMMUNICATION",
  "FINANCIAL",
  "LEGAL",
  "DESTRUCTIVE",
] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

/** Relógio injetável: nenhum pacote lê `new Date()` sem passar por aqui (testes determinísticos). */
export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

/** Relógio controlado para testes. */
export class ManualClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current.getTime());
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export type IdFactory = () => string;
export const uuid: IdFactory = () => randomUUID();

/**
 * JSON canônico (chaves ordenadas, sem espaço). Base do hash de payload: aprovar um
 * pedido é aprovar EXATAMENTE estes bytes, não "algo parecido".
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new ObedientError("INVALID_PAYLOAD", "número não finito no payload");
    if (value === undefined) return "null";
    return JSON.stringify(value);
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function payloadHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export type ErrorCode =
  | "INVALID_PAYLOAD"
  | "INVALID_GRANT"
  | "GRANT_NOT_FOUND"
  | "DELEGATION_EXCEEDS_PARENT"
  | "PROPOSAL_NOT_FOUND"
  | "PROPOSAL_NOT_PENDING"
  | "PROPOSAL_EXPIRED"
  | "PAYLOAD_MISMATCH"
  | "SELF_APPROVAL"
  | "APPROVER_NOT_HUMAN"
  | "APPROVER_NOT_OWNER"
  | "STRONG_AUTH_REQUIRED"
  | "ALREADY_EXECUTED"
  | "EMERGENCY_STOP"
  | "NOT_READ_ONLY"
  | "AUDIT_TAMPERED"
  | "UNAUTHENTICATED"
  | "CONSENT_REQUIRED"
  | "NO_LONGER_AUTHORIZED";

export class ObedientError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ObedientError";
  }
}

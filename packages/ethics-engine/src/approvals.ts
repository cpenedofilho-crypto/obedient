// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Human Approval Gateway (CONSTITUTION.md Art. 1º e 12). Junta dois padrões já provados:
//   • Ronda (lib/assistente/acoes.ts): o modelo nunca executa; ele grava uma PROPOSTA, e quem
//     executa é o toque da pessoa, uma vez só, dentro do prazo;
//   • Recupera (migration 60): gerar ≠ aprovar ≠ executar; quem pede não decide; executa o
//     payload EXATO aprovado (hash).
//
// Ciclo: pending → approved → executing → executed | failed ; pending → rejected | expired.

import { type Clock, type IdFactory, ObedientError, payloadHash, systemClock, uuid } from "@obedient/core";
import type { Approver, Decision } from "@obedient/policy-engine";

export type ProposalStatus = "pending" | "approved" | "rejected" | "expired" | "executing" | "executed" | "failed";

export interface ProposalPayload {
  systemId: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface Proposal {
  id: string;
  userId: string;
  requestedBy: string;
  payload: ProposalPayload;
  payloadHash: string;
  /** Resumo para o cartão, montado a partir dos DADOS (não do texto do modelo). */
  summary: string;
  approver: Approver;
  reason: string;
  grantId: string | null;
  createdAt: Date;
  expiresAt: Date;
  status: ProposalStatus;
  decidedBy: string | null;
  decidedAt: Date | null;
  executedAt: Date | null;
}

export interface ApproverIdentity {
  id: string;
  kind: "user" | "agent" | "system";
  /** Reautenticação recente (biometria, senha, passkey). */
  strongAuth: boolean;
}

/** Prazo padrão: 30 min, como o cartão do Ronda. Máximo: 72 h, como o Recupera (migration 60). */
export const DEFAULT_TTL_MS = 30 * 60 * 1000;
export const MAX_TTL_MS = 72 * 60 * 60 * 1000;

export function summarize(p: ProposalPayload): string {
  const keys = Object.keys(p.args).sort();
  const shown = keys
    .slice(0, 6)
    .map((k) => `${k}=${JSON.stringify(p.args[k])}`.slice(0, 80))
    .join(", ");
  return `${p.systemId}.${p.tool}(${shown}${keys.length > 6 ? ", …" : ""})`;
}

export class ApprovalGateway {
  private readonly rows = new Map<string, Proposal>();

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly newId: IdFactory = uuid,
  ) {}

  propose(input: {
    userId: string;
    requestedBy: string;
    payload: ProposalPayload;
    decision: Decision;
    grantId: string | null;
    ttlMs?: number;
  }): Proposal {
    const approver = input.decision.approver;
    if (!approver) throw new ObedientError("INVALID_PAYLOAD", "decisão não exige aprovação");
    const ttl = Math.min(Math.max(input.ttlMs ?? DEFAULT_TTL_MS, 60_000), MAX_TTL_MS);
    const now = this.clock.now();
    const p: Proposal = {
      id: this.newId(),
      userId: input.userId,
      requestedBy: input.requestedBy,
      payload: structuredClone(input.payload),
      payloadHash: payloadHash(input.payload),
      summary: summarize(input.payload),
      approver,
      reason: input.decision.reason,
      grantId: input.grantId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttl),
      status: "pending",
      decidedBy: null,
      decidedAt: null,
      executedAt: null,
    };
    this.rows.set(p.id, p);
    return structuredClone(p);
  }

  get(id: string): Proposal | undefined {
    const p = this.rows.get(id);
    if (!p) return undefined;
    this.expireIfDue(p);
    return structuredClone(p);
  }

  pending(userId: string): Proposal[] {
    return [...this.rows.values()].filter((p) => (this.expireIfDue(p), p.userId === userId && p.status === "pending")).map((p) => structuredClone(p));
  }

  /** Aprovar exige o hash que o cartão mostrou: aprova-se o que se viu, não o que mudou depois. */
  approve(id: string, who: ApproverIdentity, shownHash: string): Proposal {
    const p = this.mustPending(id);
    if (who.kind !== "user") throw new ObedientError("APPROVER_NOT_HUMAN", "só pessoa aprova");
    if (who.id === p.requestedBy) throw new ObedientError("SELF_APPROVAL", "quem pede não aprova");
    if (who.id !== p.userId) throw new ObedientError("APPROVER_NOT_OWNER", "só o dono da instância aprova");
    if (p.approver === "user_strong_auth" && !who.strongAuth) throw new ObedientError("STRONG_AUTH_REQUIRED", "esta ação exige reautenticação");
    if (shownHash !== p.payloadHash) throw new ObedientError("PAYLOAD_MISMATCH", "o payload mudou depois do cartão");
    p.status = "approved";
    p.decidedBy = who.id;
    p.decidedAt = this.clock.now();
    return structuredClone(p);
  }

  reject(id: string, who: ApproverIdentity): Proposal {
    const p = this.mustPending(id);
    if (who.kind !== "user" || who.id !== p.userId) throw new ObedientError("APPROVER_NOT_OWNER", "só o dono rejeita");
    p.status = "rejected";
    p.decidedBy = who.id;
    p.decidedAt = this.clock.now();
    return structuredClone(p);
  }

  /**
   * Reivindica a execução UMA vez. Quem executa recebe o payload aprovado e devolve o resultado
   * com `complete()`. Segunda chamada falha com ALREADY_EXECUTED (idempotência por construção).
   */
  claim(id: string, hash: string): ProposalPayload {
    const p = this.rows.get(id);
    if (!p) throw new ObedientError("PROPOSAL_NOT_FOUND", "proposta inexistente");
    if (p.status === "executing" || p.status === "executed" || p.status === "failed") throw new ObedientError("ALREADY_EXECUTED", "já executada");
    if (p.status !== "approved") throw new ObedientError("PROPOSAL_NOT_PENDING", `proposta em ${p.status}`);
    if (this.clock.now() >= p.expiresAt) {
      p.status = "expired";
      throw new ObedientError("PROPOSAL_EXPIRED", "prazo de execução vencido");
    }
    if (hash !== p.payloadHash) throw new ObedientError("PAYLOAD_MISMATCH", "payload diferente do aprovado");
    p.status = "executing";
    return structuredClone(p.payload);
  }

  complete(id: string, ok: boolean): Proposal {
    const p = this.rows.get(id);
    if (!p || p.status !== "executing") throw new ObedientError("PROPOSAL_NOT_PENDING", "nada em execução");
    p.status = ok ? "executed" : "failed";
    p.executedAt = this.clock.now();
    return structuredClone(p);
  }

  /** Cancela tudo que está pendente/aprovado de um usuário (parada de emergência). */
  cancelAll(userId: string): number {
    let n = 0;
    for (const p of this.rows.values())
      if (p.userId === userId && (p.status === "pending" || p.status === "approved")) {
        p.status = "rejected";
        p.decidedBy = "emergency-stop";
        p.decidedAt = this.clock.now();
        n++;
      }
    return n;
  }

  private mustPending(id: string): Proposal {
    const p = this.rows.get(id);
    if (!p) throw new ObedientError("PROPOSAL_NOT_FOUND", "proposta inexistente");
    this.expireIfDue(p);
    if (p.status === "expired") throw new ObedientError("PROPOSAL_EXPIRED", "proposta vencida");
    if (p.status !== "pending") throw new ObedientError("PROPOSAL_NOT_PENDING", `proposta em ${p.status}`);
    return p;
  }

  private expireIfDue(p: Proposal): void {
    if ((p.status === "pending" || p.status === "approved") && this.clock.now() >= p.expiresAt) p.status = "expired";
  }
}

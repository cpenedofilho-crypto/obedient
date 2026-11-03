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

/**
 * Onde as propostas ficam. `transition` é a troca de estado ATÔMICA (compare-and-set): só grava se
 * a proposta ainda estiver num dos estados `from`. É ela que garante, num banco com vários
 * processos, que duas pessoas ou dois workers não aprovem nem executem a mesma proposta duas vezes.
 */
export interface ProposalStore {
  insert(p: Proposal): Promise<void>;
  get(id: string): Promise<Proposal | undefined>;
  listByUser(userId: string): Promise<Proposal[]>;
  transition(id: string, from: readonly ProposalStatus[], patch: Partial<Pick<Proposal, "status" | "decidedBy" | "decidedAt" | "executedAt">>): Promise<Proposal | null>;
}

export class InMemoryProposalStore implements ProposalStore {
  private readonly rows = new Map<string, Proposal>();
  async insert(p: Proposal): Promise<void> {
    this.rows.set(p.id, structuredClone(p));
  }
  async get(id: string): Promise<Proposal | undefined> {
    const p = this.rows.get(id);
    return p ? structuredClone(p) : undefined;
  }
  async listByUser(userId: string): Promise<Proposal[]> {
    return [...this.rows.values()].filter((p) => p.userId === userId).map((p) => structuredClone(p));
  }
  async transition(id: string, from: readonly ProposalStatus[], patch: Partial<Proposal>): Promise<Proposal | null> {
    const p = this.rows.get(id);
    if (!p || !from.includes(p.status)) return null;
    Object.assign(p, patch);
    return structuredClone(p);
  }
}

export class ApprovalGateway {
  constructor(
    private readonly clock: Clock = systemClock,
    private readonly newId: IdFactory = uuid,
    private readonly store: ProposalStore = new InMemoryProposalStore(),
  ) {}

  async propose(input: {
    userId: string;
    requestedBy: string;
    payload: ProposalPayload;
    decision: Decision;
    grantId: string | null;
    ttlMs?: number;
  }): Promise<Proposal> {
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
    await this.store.insert(p);
    return structuredClone(p);
  }

  async get(id: string): Promise<Proposal | undefined> {
    const p = await this.store.get(id);
    return p ? this.expireIfDue(p) : undefined;
  }

  async pending(userId: string): Promise<Proposal[]> {
    const out: Proposal[] = [];
    for (const p of await this.store.listByUser(userId)) {
      const q = await this.expireIfDue(p);
      if (q.status === "pending") out.push(q);
    }
    return out;
  }

  /** Aprovar exige o hash que o cartão mostrou: aprova-se o que se viu, não o que mudou depois. */
  async approve(id: string, who: ApproverIdentity, shownHash: string): Promise<Proposal> {
    const p = await this.mustPending(id);
    if (who.kind !== "user") throw new ObedientError("APPROVER_NOT_HUMAN", "só pessoa aprova");
    if (who.id === p.requestedBy) throw new ObedientError("SELF_APPROVAL", "quem pede não aprova");
    if (who.id !== p.userId) throw new ObedientError("APPROVER_NOT_OWNER", "só o dono da instância aprova");
    if (p.approver === "user_strong_auth" && !who.strongAuth) throw new ObedientError("STRONG_AUTH_REQUIRED", "esta ação exige reautenticação");
    if (shownHash !== p.payloadHash) throw new ObedientError("PAYLOAD_MISMATCH", "o payload mudou depois do cartão");
    return this.decide(id, "approved", who.id);
  }

  async reject(id: string, who: ApproverIdentity): Promise<Proposal> {
    const p = await this.mustPending(id);
    if (who.kind !== "user" || who.id !== p.userId) throw new ObedientError("APPROVER_NOT_OWNER", "só o dono rejeita");
    return this.decide(id, "rejected", who.id);
  }

  /**
   * Reivindica a execução UMA vez. Quem executa recebe o payload aprovado e devolve o resultado
   * com `complete()`. Segunda chamada falha com ALREADY_EXECUTED (idempotência por construção).
   */
  async claim(id: string, hash: string): Promise<ProposalPayload> {
    const p = await this.store.get(id);
    if (!p) throw new ObedientError("PROPOSAL_NOT_FOUND", "proposta inexistente");
    if (p.status === "executing" || p.status === "executed" || p.status === "failed") throw new ObedientError("ALREADY_EXECUTED", "já executada");
    if (p.status !== "approved") throw new ObedientError("PROPOSAL_NOT_PENDING", `proposta em ${p.status}`);
    if (this.clock.now() >= p.expiresAt) {
      await this.store.transition(id, ["approved"], { status: "expired" });
      throw new ObedientError("PROPOSAL_EXPIRED", "prazo de execução vencido");
    }
    if (hash !== p.payloadHash) throw new ObedientError("PAYLOAD_MISMATCH", "payload diferente do aprovado");
    // Só um chega aqui: o outro encontra a proposta já em "executing".
    const won = await this.store.transition(id, ["approved"], { status: "executing" });
    if (!won) throw new ObedientError("ALREADY_EXECUTED", "já executada");
    return structuredClone(won.payload);
  }

  async complete(id: string, ok: boolean): Promise<Proposal> {
    const p = await this.store.transition(id, ["executing"], { status: ok ? "executed" : "failed", executedAt: this.clock.now() });
    if (!p) throw new ObedientError("PROPOSAL_NOT_PENDING", "nada em execução");
    return p;
  }

  /** Cancela tudo que está pendente/aprovado de um usuário (parada de emergência). */
  async cancelAll(userId: string): Promise<number> {
    let n = 0;
    for (const p of await this.store.listByUser(userId))
      if (p.status === "pending" || p.status === "approved")
        if (await this.store.transition(p.id, ["pending", "approved"], { status: "rejected", decidedBy: "emergency-stop", decidedAt: this.clock.now() })) n++;
    return n;
  }

  private async decide(id: string, status: "approved" | "rejected", by: string): Promise<Proposal> {
    const p = await this.store.transition(id, ["pending"], { status, decidedBy: by, decidedAt: this.clock.now() });
    // Outra decisão chegou primeiro (ou a proposta venceu entre a leitura e a gravação).
    if (!p) throw new ObedientError("PROPOSAL_NOT_PENDING", "a proposta já foi decidida");
    return p;
  }

  private async mustPending(id: string): Promise<Proposal> {
    const p = await this.get(id);
    if (!p) throw new ObedientError("PROPOSAL_NOT_FOUND", "proposta inexistente");
    if (p.status === "expired") throw new ObedientError("PROPOSAL_EXPIRED", "proposta vencida");
    if (p.status !== "pending") throw new ObedientError("PROPOSAL_NOT_PENDING", `proposta em ${p.status}`);
    return p;
  }

  private async expireIfDue(p: Proposal): Promise<Proposal> {
    if ((p.status === "pending" || p.status === "approved") && this.clock.now() >= p.expiresAt) {
      const q = await this.store.transition(p.id, ["pending", "approved"], { status: "expired" });
      return q ?? ((await this.store.get(p.id)) as Proposal);
    }
    return p;
  }
}

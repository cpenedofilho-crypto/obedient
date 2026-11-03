// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Audit Trail (CONSTITUTION.md Art. 8º e 11). Append-only: não existe método de editar nem de
// apagar, e cada entrada carrega o hash da anterior, então mexer numa linha quebra a cadeia e
// `verify()` acusa. Correção se faz com uma entrada nova que referencia a antiga (padrão das
// `interacoes` do Recupera OS).
//
// A cadeia é POR USUÁRIO (seq e prevHash contam dentro do usuário). Assim cada pessoa confere a
// própria trilha sem precisar ler a dos outros, o que é obrigatório quando o banco aplica RLS. O
// que não é de usuário nenhum (parada global) fica na cadeia de userId "*".

import { type Clock, ObedientError, canonicalJson, sha256Hex, systemClock } from "@obedient/core";

export interface AuditInput {
  userId: string;
  actor: string;
  event: string;
  outcome: "allowed" | "executed" | "failed" | "approval_required" | "denied" | "approved" | "rejected" | "revoked" | "stopped" | "released" | "info";
  systemId?: string;
  tool?: string;
  grantId?: string | null;
  proposalId?: string | null;
  policyId?: string | null;
  constitutionVersion?: string;
  inputHash?: string;
  reasons?: string[];
  correlationId?: string;
}

export interface AuditEntry extends AuditInput {
  /** Posição na cadeia do usuário, começando em 1. */
  seq: number;
  at: string;
  prevHash: string;
  hash: string;
}

export const AUDIT_GENESIS = "0".repeat(64);

export interface AuditHead {
  seq: number;
  hash: string;
}

/**
 * Onde a trilha fica. `append` recebe o construtor da entrada e precisa chamá-lo com a cabeça
 * ATUAL da cadeia do usuário e gravar o resultado sem que outra gravação do mesmo usuário passe
 * no meio (num banco: trava da cabeça na mesma transação).
 */
export interface AuditSink {
  append(userId: string, build: (head: AuditHead | null) => AuditEntry): Promise<AuditEntry>;
  /** Entradas do usuário, na ordem da cadeia. */
  entries(userId: string): Promise<readonly AuditEntry[]>;
}

export class InMemoryAuditSink implements AuditSink {
  private readonly rows = new Map<string, AuditEntry[]>();
  /** Ordem global de gravação, só para inspeção em teste. */
  private readonly order: AuditEntry[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  append(userId: string, build: (head: AuditHead | null) => AuditEntry): Promise<AuditEntry> {
    const run = this.queue.then(() => {
      const list = this.rows.get(userId) ?? [];
      const last = list[list.length - 1];
      const e = Object.freeze({ ...build(last ? { seq: last.seq, hash: last.hash } : null) });
      if (e.reasons) Object.freeze(e.reasons);
      list.push(e);
      this.rows.set(userId, list);
      this.order.push(e);
      return e;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async entries(userId: string): Promise<readonly AuditEntry[]> {
    return this.rows.get(userId) ?? [];
  }

  /** Todas as entradas, na ordem em que foram gravadas (só existe em memória). */
  all(): readonly AuditEntry[] {
    return this.order;
  }
}

export function auditEntryHash(e: Omit<AuditEntry, "hash">): string {
  return sha256Hex(canonicalJson(e));
}

/** Confere uma cadeia. Lança AUDIT_TAMPERED na primeira entrada adulterada. */
export function verifyChain(entries: readonly AuditEntry[]): true {
  let prev = AUDIT_GENESIS;
  let seq = 0;
  for (const e of entries) {
    const { hash, ...rest } = e;
    if (e.seq !== seq + 1 || e.prevHash !== prev || auditEntryHash(rest) !== hash) throw new ObedientError("AUDIT_TAMPERED", `cadeia quebrada na entrada ${e.seq}`);
    prev = hash;
    seq = e.seq;
  }
  return true;
}

export class AuditTrail {
  constructor(
    private readonly sink: AuditSink = new InMemoryAuditSink(),
    private readonly clock: Clock = systemClock,
  ) {}

  record(input: AuditInput): Promise<AuditEntry> {
    const at = this.clock.now().toISOString();
    return this.sink.append(input.userId, (head) => {
      const base: Omit<AuditEntry, "hash"> = {
        ...input,
        ...(input.reasons ? { reasons: [...input.reasons] } : {}),
        seq: (head?.seq ?? 0) + 1,
        at,
        prevHash: head?.hash ?? AUDIT_GENESIS,
      };
      return { ...base, hash: auditEntryHash(base) };
    });
  }

  forUser(userId: string): Promise<readonly AuditEntry[]> {
    return this.sink.entries(userId);
  }

  /** Confere a cadeia inteira do usuário. */
  async verify(userId: string): Promise<true> {
    return verifyChain(await this.sink.entries(userId));
  }
}

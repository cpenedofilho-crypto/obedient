// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Audit Trail (CONSTITUTION.md Art. 8º e 11). Append-only: não existe método de editar nem de
// apagar, e cada entrada carrega o hash da anterior, então mexer numa linha quebra a cadeia e
// `verify()` acusa. Correção se faz com uma entrada nova que referencia a antiga (padrão das
// `interacoes` do Recupera OS).

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
  seq: number;
  at: string;
  prevHash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);

export interface AuditSink {
  append(e: AuditEntry): void;
  entries(): readonly AuditEntry[];
}

export class InMemoryAuditSink implements AuditSink {
  private readonly rows: AuditEntry[] = [];
  append(e: AuditEntry): void {
    this.rows.push(Object.freeze({ ...e, reasons: e.reasons ? Object.freeze([...e.reasons]) as string[] : undefined }) as AuditEntry);
  }
  entries(): readonly AuditEntry[] {
    return this.rows;
  }
}

function entryHash(e: Omit<AuditEntry, "hash">): string {
  return sha256Hex(canonicalJson(e));
}

export class AuditTrail {
  constructor(
    private readonly sink: AuditSink = new InMemoryAuditSink(),
    private readonly clock: Clock = systemClock,
  ) {}

  record(input: AuditInput): AuditEntry {
    const rows = this.sink.entries();
    const last = rows[rows.length - 1];
    const base: Omit<AuditEntry, "hash"> = {
      ...input,
      seq: rows.length + 1,
      at: this.clock.now().toISOString(),
      prevHash: last ? last.hash : GENESIS,
    };
    const entry: AuditEntry = { ...base, hash: entryHash(base) };
    this.sink.append(entry);
    return entry;
  }

  forUser(userId: string): AuditEntry[] {
    return this.sink.entries().filter((e) => e.userId === userId);
  }

  all(): readonly AuditEntry[] {
    return this.sink.entries();
  }

  /** Confere a cadeia inteira. Lança AUDIT_TAMPERED na primeira entrada adulterada. */
  verify(): true {
    let prev = GENESIS;
    for (const e of this.sink.entries()) {
      const { hash, ...rest } = e;
      if (e.prevHash !== prev || entryHash(rest) !== hash) throw new ObedientError("AUDIT_TAMPERED", `cadeia quebrada na entrada ${e.seq}`);
      prev = hash;
    }
    return true;
  }
}

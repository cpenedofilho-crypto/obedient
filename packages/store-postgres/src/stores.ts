// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// As portas do Ethics Engine sobre Postgres. Cada store recebe a TRANSAÇÃO da sessão (src/sessao.ts),
// na qual o papel e o usuário já estão fixados: a RLS decide o que cada consulta enxerga. Nenhuma
// consulta aqui filtra por usuário "para ajudar": se o filtro por usuário existir, é a regra do motor
// (listByUser), e a RLS o repete por baixo.

import type {
  AuditEntry,
  AuditHead,
  AuditSink,
  ConsentRecord,
  ConsentStore,
  Grant,
  GrantStore,
  Proposal,
  ProposalStatus,
  ProposalStore,
  StopScope,
  StopState,
  StopStore,
} from "@obedient/ethics-engine";
import { ObedientError } from "@obedient/core";
import type { Executor } from "./db.ts";

const data = (v: unknown): Date | null => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v)));
const dataObrigatoria = (v: unknown): Date => data(v) as Date;

// ------------------------------------------------------------------------------------------- grants

interface LinhaGrant {
  id: string;
  user_id: string;
  agent_id: string;
  system_id: string | null;
  capability: string;
  purpose: string;
  limits: Grant["limits"];
  expires_at: unknown;
  granted_at: unknown;
  granted_by: string;
  revoked_at: unknown;
  revoked_by: string | null;
  parent_id: string | null;
  constitution_version: string;
}

const paraGrant = (r: LinhaGrant): Grant => ({
  id: r.id,
  userId: r.user_id,
  agentId: r.agent_id,
  systemId: r.system_id,
  capability: r.capability,
  purpose: r.purpose,
  limits: { ...r.limits },
  expiresAt: dataObrigatoria(r.expires_at),
  grantedAt: dataObrigatoria(r.granted_at),
  grantedBy: r.granted_by,
  revokedAt: data(r.revoked_at),
  revokedBy: r.revoked_by,
  parentId: r.parent_id,
  constitutionVersion: r.constitution_version,
});

export class PgGrantStore implements GrantStore {
  constructor(private readonly tx: Executor) {}
  async insert(g: Grant): Promise<void> {
    await this.tx.query(
      `insert into obedient.grants (id, user_id, agent_id, system_id, capability, purpose, limits, expires_at, granted_at, granted_by, revoked_at, revoked_by, parent_id, constitution_version)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14)`,
      [g.id, g.userId, g.agentId, g.systemId, g.capability, g.purpose, JSON.stringify(g.limits), g.expiresAt, g.grantedAt, g.grantedBy, g.revokedAt, g.revokedBy, g.parentId, g.constitutionVersion],
    );
  }
  async get(id: string): Promise<Grant | undefined> {
    const { rows } = await this.tx.query<LinhaGrant>("select * from obedient.grants where id = $1", [id]);
    return rows[0] ? paraGrant(rows[0]) : undefined;
  }
  /** Só revogação muda um grant (o papel do app só tem UPDATE nessas duas colunas). */
  async update(g: Grant): Promise<void> {
    await this.tx.query("update obedient.grants set revoked_at = $2, revoked_by = $3 where id = $1", [g.id, g.revokedAt, g.revokedBy]);
  }
  async listByUser(userId: string): Promise<Grant[]> {
    const { rows } = await this.tx.query<LinhaGrant>("select * from obedient.grants where user_id = $1 order by granted_at, id", [userId]);
    return rows.map(paraGrant);
  }
}

// ----------------------------------------------------------------------------------------- consents

interface LinhaConsent {
  id: string;
  user_id: string;
  purpose: string;
  category: string;
  given_at: unknown;
  specific: boolean;
  expires_at: unknown;
  revoked_at: unknown;
}

export class PgConsentStore implements ConsentStore {
  constructor(private readonly tx: Executor) {}
  async insert(r: ConsentRecord): Promise<void> {
    await this.tx.query(
      "insert into obedient.consents (id, user_id, purpose, category, given_at, specific, expires_at, revoked_at) values ($1,$2,$3,$4,$5,$6,$7,$8)",
      [r.id, r.userId, r.purpose, r.category, r.givenAt, r.specific, r.expiresAt, r.revokedAt],
    );
  }
  async listByUser(userId: string): Promise<ConsentRecord[]> {
    const { rows } = await this.tx.query<LinhaConsent>("select * from obedient.consents where user_id = $1 order by given_at, id", [userId]);
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      purpose: r.purpose,
      category: r.category,
      givenAt: dataObrigatoria(r.given_at),
      specific: r.specific,
      expiresAt: data(r.expires_at),
      revokedAt: data(r.revoked_at),
    }));
  }
  async revokeWhere(userId: string, purpose: string, category: string | null, at: Date): Promise<number> {
    const { rows } = await this.tx.query(
      `update obedient.consents set revoked_at = $4
        where user_id = $1 and purpose = $2 and ($3::text is null or category = $3) and revoked_at is null
        returning id`,
      [userId, purpose, category, at],
    );
    return rows.length;
  }
}

// ---------------------------------------------------------------------------------------- proposals

interface LinhaProposta {
  id: string;
  user_id: string;
  requested_by: string;
  payload: Proposal["payload"];
  payload_hash: string;
  summary: string;
  approver: Proposal["approver"];
  reason: string;
  grant_id: string | null;
  created_at: unknown;
  expires_at: unknown;
  status: ProposalStatus;
  decided_by: string | null;
  decided_at: unknown;
  executed_at: unknown;
}

const paraProposta = (r: LinhaProposta): Proposal => ({
  id: r.id,
  userId: r.user_id,
  requestedBy: r.requested_by,
  payload: r.payload,
  payloadHash: r.payload_hash,
  summary: r.summary,
  approver: r.approver,
  reason: r.reason,
  grantId: r.grant_id,
  createdAt: dataObrigatoria(r.created_at),
  expiresAt: dataObrigatoria(r.expires_at),
  status: r.status,
  decidedBy: r.decided_by,
  decidedAt: data(r.decided_at),
  executedAt: data(r.executed_at),
});

const COLUNAS_TRANSICAO = { status: "status", decidedBy: "decided_by", decidedAt: "decided_at", executedAt: "executed_at" } as const;

export class PgProposalStore implements ProposalStore {
  constructor(private readonly tx: Executor) {}
  async insert(p: Proposal): Promise<void> {
    await this.tx.query(
      `insert into obedient.proposals (id, user_id, requested_by, payload, payload_hash, summary, approver, reason, grant_id, created_at, expires_at, status, decided_by, decided_at, executed_at)
       values ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [p.id, p.userId, p.requestedBy, JSON.stringify(p.payload), p.payloadHash, p.summary, p.approver, p.reason, p.grantId, p.createdAt, p.expiresAt, p.status, p.decidedBy, p.decidedAt, p.executedAt],
    );
  }
  async get(id: string): Promise<Proposal | undefined> {
    const { rows } = await this.tx.query<LinhaProposta>("select * from obedient.proposals where id = $1", [id]);
    return rows[0] ? paraProposta(rows[0]) : undefined;
  }
  async listByUser(userId: string): Promise<Proposal[]> {
    const { rows } = await this.tx.query<LinhaProposta>("select * from obedient.proposals where user_id = $1 order by created_at, id", [userId]);
    return rows.map(paraProposta);
  }
  /** Compare-and-set num único UPDATE: com duas transações ao mesmo tempo, só uma encontra o estado antigo. */
  async transition(id: string, from: readonly ProposalStatus[], patch: Partial<Pick<Proposal, "status" | "decidedBy" | "decidedAt" | "executedAt">>): Promise<Proposal | null> {
    const sets: string[] = [];
    const params: unknown[] = [id, [...from]];
    for (const [k, col] of Object.entries(COLUNAS_TRANSICAO) as [keyof typeof COLUNAS_TRANSICAO, string][])
      if (k in patch) {
        params.push(patch[k] ?? null);
        sets.push(`${col} = $${params.length}`);
      }
    if (!sets.length) throw new Error("transição sem mudança");
    const { rows } = await this.tx.query<LinhaProposta>(`update obedient.proposals set ${sets.join(", ")} where id = $1 and status = any($2::text[]) returning *`, params);
    return rows[0] ? paraProposta(rows[0]) : null;
  }
}

// ------------------------------------------------------------------------------------------- parada

const chave = (s: StopScope) => (s.kind === "global" ? "global" : `user:${s.userId}`);

export class PgStopStore implements StopStore {
  constructor(private readonly tx: Executor) {}
  async get(scope: StopScope): Promise<StopState | null> {
    const { rows } = await this.tx.query<{ engaged_at: unknown; engaged_by: string; reason: string }>(
      "select engaged_at, engaged_by, reason from obedient.emergency_stops where scope_key = $1",
      [chave(scope)],
    );
    const r = rows[0];
    return r ? { engagedAt: dataObrigatoria(r.engaged_at), engagedBy: r.engaged_by, reason: r.reason } : null;
  }
  async set(scope: StopScope, state: StopState): Promise<void> {
    await this.tx.query(
      `insert into obedient.emergency_stops (scope_key, user_id, engaged_at, engaged_by, reason) values ($1,$2,$3,$4,$5)
       on conflict (scope_key) do update set engaged_at = excluded.engaged_at, engaged_by = excluded.engaged_by, reason = excluded.reason`,
      [chave(scope), scope.kind === "global" ? null : scope.userId, state.engagedAt, state.engagedBy, state.reason],
    );
  }
  async clear(scope: StopScope): Promise<void> {
    await this.tx.query("delete from obedient.emergency_stops where scope_key = $1", [chave(scope)]);
  }
}

// ------------------------------------------------------------------------------------------ auditoria

export class PgAuditSink implements AuditSink {
  constructor(private readonly tx: Executor) {}

  /**
   * Trava a cadeia do usuário, lê a cabeça, monta a entrada e grava, tudo na mesma transação. O
   * gatilho do banco confere de novo que a entrada continua a cadeia (e recusa se não continuar).
   */
  async append(userId: string, build: (head: AuditHead | null) => AuditEntry): Promise<AuditEntry> {
    // Pedido em nome de outro usuário dentro desta sessão: recusa clara antes de tocar a cadeia (a
    // RLS recusaria de qualquer jeito, mas com um erro que não diz o que aconteceu).
    const { rows: quem } = await this.tx.query<{ u: string | null }>("select obedient.current_user_id() as u");
    const dono = quem[0]?.u ?? "*";
    if (dono !== userId) throw new ObedientError("UNAUTHENTICATED", `registro de ${userId} numa sessão de ${dono}`);
    await this.tx.query("select obedient.audit_lock($1)", [userId]);
    const { rows } = await this.tx.query<{ seq: number; hash: string }>("select seq, hash from obedient.audit_heads where user_id = $1", [userId]);
    const e = build(rows[0] ? { seq: rows[0].seq, hash: rows[0].hash } : null);
    if (e.userId !== userId) throw new Error("entrada de auditoria de outro usuário");
    await this.tx.query("insert into obedient.audit_log (user_id, seq, prev_hash, hash, entry) values ($1,$2,$3,$4,$5::jsonb)", [userId, e.seq, e.prevHash, e.hash, JSON.stringify(e)]);
    return e;
  }

  async entries(userId: string): Promise<readonly AuditEntry[]> {
    const { rows } = await this.tx.query<{ entry: AuditEntry }>("select entry from obedient.audit_log where user_id = $1 order by seq", [userId]);
    return rows.map((r) => r.entry);
  }
}

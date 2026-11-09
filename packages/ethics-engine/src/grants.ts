// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Delegated Authority Registry (CONSTITUTION.md Art. 3º).
//
// Um grant é a única forma de um agente agir em nome do usuário. Ele é:
//   • específico   — capacidade nomeada (ferramenta ou prefixo), nunca "*" sozinho;
//   • proporcional — limite de risco, de valor e de autonomia;
//   • transparente — finalidade obrigatória, legível pelo usuário;
//   • revogável    — revogação vale na próxima chamada e desce para toda subdelegação;
//   • temporário   — expires_at obrigatório.
// Subdelegação (OBEDIENT → DOTS → subagente) só ESTREITA: a autoridade do filho é a
// interseção com a do pai, nunca a união.

import { type Clock, type IdFactory, ObedientError, type RiskLevel, riskRank, systemClock, uuid } from "@obedient/core";
import { CONSTITUTION_VERSION } from "./constitution.ts";

export interface GrantLimits {
  /** Risco máximo que o grant cobre. Acima disso, a ação é negada. */
  maxRisk: RiskLevel;
  /** Até que risco o agente executa sem perguntar. Nunca vale para CRITICAL (regra fixa do policy-engine). */
  autonomousUpTo: RiskLevel | null;
  /** Valor máximo por ação, quando a ferramenta tem valor (campo em `amountField`). */
  maxAmount: number | null;
  amountField: string | null;
}

export interface GrantSpec {
  userId: string;
  agentId: string;
  /** Sistema de destino; null = qualquer sistema (só permitido com capacidade específica). */
  systemId: string | null;
  /** Ferramenta exata ou prefixo terminado em "*" (ex.: "calendar_read_*"). */
  capability: string;
  purpose: string;
  limits: GrantLimits;
  expiresAt: Date;
}

export interface Grant extends GrantSpec {
  id: string;
  grantedAt: Date;
  grantedBy: string;
  revokedAt: Date | null;
  revokedBy: string | null;
  parentId: string | null;
  constitutionVersion: string;
}

/** O padrão `child` só cobre nomes que o padrão `parent` também cobre? */
export function capabilityWithin(child: string, parent: string): boolean {
  if (parent === child) return true;
  if (!parent.endsWith("*")) return false;
  const parentPrefix = parent.slice(0, -1);
  const childPrefix = child.endsWith("*") ? child.slice(0, -1) : child;
  return childPrefix.startsWith(parentPrefix);
}

export function capabilityMatches(capability: string, tool: string): boolean {
  return capability.endsWith("*") ? tool.startsWith(capability.slice(0, -1)) : capability === tool;
}

function validateSpec(spec: GrantSpec, now: Date): void {
  const fail = (m: string): never => {
    throw new ObedientError("INVALID_GRANT", m);
  };
  if (!spec.userId || !spec.agentId) fail("grant precisa de userId e agentId");
  if (spec.userId === spec.agentId) fail("agente não recebe grant de si mesmo");
  const cap = spec.capability.trim();
  // Art. 3º: sem grant curinga. "*" ou um prefixo vazio equivalem a "tudo".
  if (cap === "" || cap === "*" || cap.replace(/\*+$/, "").length < 3) fail("capacidade genérica demais: nomeie a ferramenta ou um prefixo específico");
  if (!spec.purpose || spec.purpose.trim().length < 5) fail("finalidade obrigatória e legível");
  if (!(spec.expiresAt instanceof Date) || Number.isNaN(spec.expiresAt.getTime())) fail("expiresAt obrigatório");
  if (spec.expiresAt <= now) fail("expiresAt precisa estar no futuro");
  const { limits } = spec;
  if (limits.autonomousUpTo && riskRank(limits.autonomousUpTo) > riskRank(limits.maxRisk)) fail("autonomia acima do risco máximo do grant");
  if (limits.autonomousUpTo === "CRITICAL") fail("CRITICAL nunca é autônomo");
  if ((limits.maxAmount === null) !== (limits.amountField === null)) fail("maxAmount e amountField andam juntos");
  if (limits.maxAmount !== null && !(limits.maxAmount >= 0)) fail("maxAmount inválido");
}

/**
 * Onde os grants ficam. Assíncrono para caber num banco (Postgres com RLS: @obedient/store-postgres).
 * Toda leitura é POR USUÁRIO: o motor nunca pede a lista de todos, para que a RLS possa filtrar.
 */
export interface GrantStore {
  insert(g: Grant): Promise<void>;
  get(id: string): Promise<Grant | undefined>;
  update(g: Grant): Promise<void>;
  listByUser(userId: string): Promise<Grant[]>;
}

export class InMemoryGrantStore implements GrantStore {
  private readonly rows = new Map<string, Grant>();
  async insert(g: Grant): Promise<void> {
    if (this.rows.has(g.id)) throw new ObedientError("INVALID_GRANT", "id repetido");
    this.rows.set(g.id, structuredClone(g));
  }
  async get(id: string): Promise<Grant | undefined> {
    const g = this.rows.get(id);
    return g ? structuredClone(g) : undefined;
  }
  async update(g: Grant): Promise<void> {
    this.rows.set(g.id, structuredClone(g));
  }
  async listByUser(userId: string): Promise<Grant[]> {
    return [...this.rows.values()].filter((g) => g.userId === userId).map((g) => structuredClone(g));
  }
}

export class GrantRegistry {
  constructor(
    private readonly store: GrantStore = new InMemoryGrantStore(),
    private readonly clock: Clock = systemClock,
    private readonly newId: IdFactory = uuid,
  ) {}

  /** Concessão direta pelo usuário. `grantedBy` precisa ser o próprio usuário. */
  async grant(spec: GrantSpec, grantedBy: string): Promise<Grant> {
    if (grantedBy !== spec.userId) throw new ObedientError("INVALID_GRANT", "só o próprio usuário concede autoridade direta");
    validateSpec(spec, this.clock.now());
    return this.persist(spec, grantedBy, null);
  }

  /**
   * Subdelegação: um agente que tem `parentId` repassa PARTE da autoridade a outro agente.
   * Tudo no filho precisa caber no pai.
   */
  async delegate(parentId: string, child: Omit<GrantSpec, "userId">, delegatedBy: string): Promise<Grant> {
    const now = this.clock.now();
    const parent = await this.store.get(parentId);
    if (!parent || !this.isActive(parent, now)) throw new ObedientError("GRANT_NOT_FOUND", "grant pai inexistente, revogado ou vencido");
    if (delegatedBy !== parent.agentId) throw new ObedientError("DELEGATION_EXCEEDS_PARENT", "só o titular do grant pai delega");
    const spec: GrantSpec = { ...child, userId: parent.userId };
    validateSpec(spec, now);
    const exceeds = (m: string): never => {
      throw new ObedientError("DELEGATION_EXCEEDS_PARENT", m);
    };
    if (!capabilityWithin(spec.capability, parent.capability)) exceeds("capacidade fora da do grant pai");
    if (parent.systemId !== null && spec.systemId !== parent.systemId) exceeds("sistema diferente do grant pai");
    if (spec.expiresAt > parent.expiresAt) exceeds("prazo maior que o do grant pai");
    if (riskRank(spec.limits.maxRisk) > riskRank(parent.limits.maxRisk)) exceeds("risco máximo maior que o do pai");
    const pAuto = parent.limits.autonomousUpTo;
    const cAuto = spec.limits.autonomousUpTo;
    if (cAuto && (!pAuto || riskRank(cAuto) > riskRank(pAuto))) exceeds("autonomia maior que a do pai");
    if (parent.limits.maxAmount !== null) {
      if (spec.limits.maxAmount === null || spec.limits.maxAmount > parent.limits.maxAmount || spec.limits.amountField !== parent.limits.amountField)
        exceeds("limite de valor maior que o do pai");
    }
    return this.persist(spec, delegatedBy, parent.id);
  }

  /** Revoga e desce em cascata para toda subdelegação. Só o usuário revoga. */
  async revoke(id: string, revokedBy: string): Promise<Grant[]> {
    const g = await this.store.get(id);
    if (!g) throw new ObedientError("GRANT_NOT_FOUND", "grant inexistente");
    if (revokedBy !== g.userId) throw new ObedientError("INVALID_GRANT", "só o usuário revoga");
    return this.revokeTree(g.userId, g.id, revokedBy, this.clock.now());
  }

  /** Revoga todos os grants de um agente (usado pela parada de emergência). */
  async revokeAgent(userId: string, agentId: string, revokedBy: string): Promise<Grant[]> {
    const now = this.clock.now();
    const out: Grant[] = [];
    for (const g of await this.store.listByUser(userId))
      if (g.agentId === agentId && !g.revokedAt) out.push(...(await this.revokeTree(g.userId, g.id, revokedBy, now)));
    return out;
  }

  get(id: string): Promise<Grant | undefined> {
    return this.store.get(id);
  }

  list(userId: string): Promise<Grant[]> {
    return this.store.listByUser(userId);
  }

  /**
   * Grant vigente que cobre a ferramenta. Lido do store a CADA chamada: não há cache,
   * então revogação vale na próxima (Art. 2º). Entre vários, o mais específico.
   * Um grant filho só vale se toda a cadeia de pais ainda estiver ativa.
   */
  async findCovering(userId: string, agentId: string, systemId: string, tool: string): Promise<Grant | null> {
    const now = this.clock.now();
    const doUsuario = await this.store.listByUser(userId);
    const porId = new Map(doUsuario.map((g) => [g.id, g]));
    const candidates = doUsuario.filter(
      (g) =>
        g.userId === userId &&
        g.agentId === agentId &&
        (g.systemId === null || g.systemId === systemId) &&
        capabilityMatches(g.capability, tool) &&
        this.chainActive(g, now, porId),
    );
    candidates.sort((a, b) => b.capability.length - a.capability.length);
    return candidates[0] ?? null;
  }

  /** O grant, se ele e toda a cadeia de pais ainda estiverem vigentes. Sem substituto: outro grant não vale por ele. */
  async inForce(userId: string, grantId: string): Promise<Grant | null> {
    const doUsuario = await this.store.listByUser(userId);
    const porId = new Map(doUsuario.map((g) => [g.id, g]));
    const g = porId.get(grantId);
    return g && g.userId === userId && this.chainActive(g, this.clock.now(), porId) ? g : null;
  }

  private isActive(g: Grant, now: Date): boolean {
    return !g.revokedAt && g.expiresAt > now;
  }

  /** A cadeia de pais é toda do mesmo usuário, então a lista dele basta (e a RLS não esconde nada que importe). */
  private chainActive(g: Grant, now: Date, porId: ReadonlyMap<string, Grant>): boolean {
    const seen = new Set<string>();
    let cur: Grant = g;
    for (;;) {
      if (seen.has(cur.id) || !this.isActive(cur, now)) return false;
      seen.add(cur.id);
      if (!cur.parentId) return true;
      const parent = porId.get(cur.parentId);
      if (!parent) return false; // pai sumiu: o filho não vale sozinho
      cur = parent;
    }
  }

  private async revokeTree(userId: string, rootId: string, by: string, now: Date): Promise<Grant[]> {
    const all = await this.store.listByUser(userId);
    const out: Grant[] = [];
    const queue = [rootId];
    while (queue.length) {
      const id = queue.shift()!;
      const g = all.find((x) => x.id === id);
      if (!g) continue;
      if (!g.revokedAt) {
        g.revokedAt = now;
        g.revokedBy = by;
        await this.store.update(g);
        out.push(g);
      }
      for (const child of all) if (child.parentId === id) queue.push(child.id);
    }
    return out;
  }

  private async persist(spec: GrantSpec, by: string, parentId: string | null): Promise<Grant> {
    const g: Grant = {
      ...spec,
      capability: spec.capability.trim(),
      limits: { ...spec.limits },
      id: this.newId(),
      grantedAt: this.clock.now(),
      grantedBy: by,
      revokedAt: null,
      revokedBy: null,
      parentId,
      constitutionVersion: CONSTITUTION_VERSION,
    };
    await this.store.insert(g);
    return structuredClone(g);
  }
}

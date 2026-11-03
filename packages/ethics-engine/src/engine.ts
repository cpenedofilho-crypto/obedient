// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Ethics Engine: o único caminho entre "o modelo escolheu uma ferramenta" e "a ferramenta roda".
//
//   parada de emergência → grant que cobre → limites do grant → consentimento
//     → risco efetivo → Policy Engine → allow | approval_required | denied → auditoria
//
// Nada aqui lê texto do modelo. Agente, sistema, ferramenta, categoria e risco chegam do
// registro de ferramentas e da autenticação; o modelo só escolhe QUAL ferramenta e com quais
// argumentos. Qualquer exceção vira negação (fail-closed, Art. 6º).
//
// O sistema de destino (Recupera, Motor, calendário...) continua aplicando a PRÓPRIA política
// depois disto: o OBEDIENT pode restringir um agente, nunca ampliar o que o destino recusa.

import { type Clock, ObedientError, type RiskLevel, payloadHash, riskRank, systemClock } from "@obedient/core";
import { type Action, type Decision, type Defaults, type Policy, SYSTEM_DEFAULTS, amountOf, decide, effectiveRisk } from "@obedient/policy-engine";
import { ApprovalGateway, type ApproverIdentity, type Proposal, type ProposalPayload } from "./approvals.ts";
import { AuditTrail } from "./audit.ts";
import { ConsentManager } from "./consent.ts";
import { CONSTITUTION_VERSION } from "./constitution.ts";
import { EmergencyStop } from "./emergency-stop.ts";
import { type Grant, GrantRegistry } from "./grants.ts";

export interface ActionRequest {
  userId: string;
  agentId: string;
  systemId: string;
  tool: string;
  /** Do registro da ferramenta. */
  risk: RiskLevel;
  category?: string;
  args: Record<string, unknown>;
  context?: Action["context"];
  /** Categorias de dado pessoal que a ferramenta toca (do registro). */
  dataCategories?: readonly string[];
  /** Finalidade declarada da missão, para conferir consentimento. */
  purpose?: string;
  correlationId?: string;
}

export type Authorization =
  | { outcome: "allowed"; grantId: string; decision: Decision; inputHash: string }
  | { outcome: "approval_required"; grantId: string; decision: Decision; proposal: Proposal }
  | { outcome: "denied"; reasons: string[]; decision: Decision | null; grantId: string | null };

export interface EthicsEngineDeps {
  grants?: GrantRegistry;
  consent?: ConsentManager;
  approvals?: ApprovalGateway;
  stop?: EmergencyStop;
  audit?: AuditTrail;
  clock?: Clock;
  /** Políticas do usuário (dados). Lidas a cada chamada. */
  policiesFor?: (userId: string) => readonly Policy[];
  defaultsFor?: (userId: string) => Defaults;
}

const RISKS_UP_TO = (r: RiskLevel): RiskLevel[] => (["LOW", "MEDIUM", "HIGH", "CRITICAL"] as RiskLevel[]).filter((x) => riskRank(x) <= riskRank(r));

/** A autonomia que o usuário deu no grant vira política de dados (nunca alcança CRITICAL: regra fixa). */
function autonomyPolicy(g: Grant): Policy | null {
  if (!g.limits.autonomousUpTo) return null;
  return {
    id: `grant:${g.id}:autonomy`,
    effect: "allow_autonomous",
    systemId: g.systemId,
    toolPattern: g.capability,
    principalId: g.agentId,
    riskLevels: RISKS_UP_TO(g.limits.autonomousUpTo),
    eventTypes: null,
    entityTypes: null,
    roles: null,
    contextMatch: null,
    amountField: null,
    amountAbove: null,
    expiresAt: g.expiresAt,
    active: true,
  };
}

export class EthicsEngine {
  readonly grants: GrantRegistry;
  readonly consent: ConsentManager;
  readonly approvals: ApprovalGateway;
  readonly stop: EmergencyStop;
  readonly audit: AuditTrail;
  private readonly clock: Clock;
  private readonly policiesFor: (userId: string) => readonly Policy[];
  private readonly defaultsFor: (userId: string) => Defaults;

  constructor(deps: EthicsEngineDeps = {}) {
    this.clock = deps.clock ?? systemClock;
    this.grants = deps.grants ?? new GrantRegistry(undefined, this.clock);
    this.consent = deps.consent ?? new ConsentManager(this.clock);
    this.approvals = deps.approvals ?? new ApprovalGateway(this.clock);
    this.stop = deps.stop ?? new EmergencyStop(this.clock);
    this.audit = deps.audit ?? new AuditTrail(undefined, this.clock);
    this.policiesFor = deps.policiesFor ?? (() => []);
    this.defaultsFor = deps.defaultsFor ?? (() => SYSTEM_DEFAULTS);

    // Parada de emergência cancela o que estava esperando aprovação e fica registrada.
    this.stop.onEngage(async (scope, state) => {
      if (scope.kind === "user") await this.approvals.cancelAll(scope.userId);
      await this.audit.record({
        userId: scope.kind === "user" ? scope.userId : "*",
        actor: state.engagedBy,
        event: "emergency_stop.engaged",
        outcome: "stopped",
        reasons: [state.reason],
        constitutionVersion: CONSTITUTION_VERSION,
      });
    });
  }

  async authorize(req: ActionRequest): Promise<Authorization> {
    const inputHash = safeHash(req);
    const base = {
      userId: req.userId,
      actor: `agent:${req.agentId}`,
      event: "action.authorize",
      systemId: req.systemId,
      tool: req.tool,
      inputHash,
      constitutionVersion: CONSTITUTION_VERSION,
      ...(req.correlationId ? { correlationId: req.correlationId } : {}),
    };
    const deny = async (reasons: string[], decision: Decision | null, grantId: string | null): Promise<Authorization> => {
      await this.audit.record({ ...base, outcome: "denied", reasons, grantId, policyId: decision?.policyId ?? null });
      return { outcome: "denied", reasons, decision, grantId };
    };

    try {
      if (req.agentId === req.userId) return deny(["o agente não pode se apresentar como o usuário"], null, null);

      const stopped = await this.stop.blocking(req.userId);
      if (stopped) return deny([`parada de emergência acionada: ${stopped.reason}`], null, null);

      const grant = await this.grants.findCovering(req.userId, req.agentId, req.systemId, req.tool);
      if (!grant) return deny(["nenhum grant vigente cobre esta ferramenta (Art. 3º)"], null, null);

      const risk = effectiveRisk(req.risk, req.category);
      if (riskRank(risk) > riskRank(grant.limits.maxRisk))
        return deny([`risco ${risk} acima do máximo do grant (${grant.limits.maxRisk})`], null, grant.id);

      if (grant.limits.maxAmount !== null && grant.limits.amountField) {
        const v = amountOf(req.args, grant.limits.amountField);
        if (v === null) return deny([`valor ilegível em ${grant.limits.amountField}: sem valor, sem limite conferível`], null, grant.id);
        if (v > grant.limits.maxAmount) return deny([`valor ${v} acima do limite do grant (${grant.limits.maxAmount})`], null, grant.id);
      }

      if (req.dataCategories?.length) {
        if (!req.purpose) return deny(["ação toca dado pessoal sem finalidade declarada (Art. 4º)"], null, grant.id);
        const c = await this.consent.check(req.userId, req.purpose, req.dataCategories);
        if (!c.ok) return deny([`sem consentimento para: ${c.missing.join(", ")} (finalidade ${req.purpose})`], null, grant.id);
      }

      const auto = autonomyPolicy(grant);
      const policies = [...this.policiesFor(req.userId), ...(auto ? [auto] : [])];
      const action: Action = {
        systemId: req.systemId,
        tool: req.tool,
        risk: req.risk,
        ...(req.category ? { category: req.category } : {}),
        principal: { kind: "agent", id: req.agentId, role: null },
        args: req.args,
        context: req.context ?? {},
      };
      const decision = decide(action, policies, this.defaultsFor(req.userId), this.clock.now());

      if (decision.effect === "deny") return deny([decision.reason], decision, grant.id);

      if (decision.effect === "allow") {
        await this.audit.record({ ...base, outcome: "allowed", grantId: grant.id, policyId: decision.policyId, reasons: [decision.reason] });
        return { outcome: "allowed", grantId: grant.id, decision, inputHash };
      }

      const proposal = await this.approvals.propose({
        userId: req.userId,
        requestedBy: `agent:${req.agentId}`,
        payload: { systemId: req.systemId, tool: req.tool, args: req.args },
        decision,
        grantId: grant.id,
      });
      await this.audit.record({
        ...base,
        outcome: "approval_required",
        grantId: grant.id,
        policyId: decision.policyId,
        proposalId: proposal.id,
        reasons: [decision.reason],
      });
      return { outcome: "approval_required", grantId: grant.id, decision, proposal };
    } catch (e) {
      return deny([`erro na avaliação, ação negada (fail-closed): ${e instanceof Error ? e.message : String(e)}`], null, null);
    }
  }

  async approve(proposalId: string, who: ApproverIdentity, shownHash: string): Promise<Proposal> {
    try {
      const p = await this.approvals.approve(proposalId, who, shownHash);
      await this.audit.record({ userId: p.userId, actor: `${who.kind}:${who.id}`, event: "proposal.approve", outcome: "approved", proposalId, tool: p.payload.tool, systemId: p.payload.systemId, constitutionVersion: CONSTITUTION_VERSION });
      return p;
    } catch (e) {
      // A recusa fica na trilha do dono da proposta (ou de quem tentou, se a proposta não existe para
      // ele). Se nem isso puder ser gravado, o erro que vale é o da aprovação, não o da trilha.
      try {
        const p = await this.approvals.get(proposalId);
        await this.audit.record({ userId: p?.userId ?? who.id, actor: `${who.kind}:${who.id}`, event: "proposal.approve", outcome: "denied", proposalId, reasons: [e instanceof Error ? e.message : String(e)] });
      } catch {
        // segue para o throw abaixo
      }
      throw e;
    }
  }

  async reject(proposalId: string, who: ApproverIdentity): Promise<Proposal> {
    const p = await this.approvals.reject(proposalId, who);
    await this.audit.record({ userId: p.userId, actor: `${who.kind}:${who.id}`, event: "proposal.reject", outcome: "rejected", proposalId });
    return p;
  }

  /**
   * Executa uma proposta aprovada. Antes de reivindicar, confere DE NOVO a parada de emergência
   * e o grant: revogar depois de aprovar ainda impede a execução (Art. 2º).
   */
  async executeApproved<T>(proposalId: string, hash: string, executor: (payload: ProposalPayload) => Promise<T>): Promise<T> {
    const p = await this.approvals.get(proposalId);
    if (!p) throw new ObedientError("PROPOSAL_NOT_FOUND", "proposta inexistente");
    const audit = async (outcome: "executed" | "failed" | "denied", reasons?: string[]) =>
      this.audit.record({ userId: p.userId, actor: p.requestedBy, event: "proposal.execute", outcome, proposalId, grantId: p.grantId, systemId: p.payload.systemId, tool: p.payload.tool, inputHash: hash, constitutionVersion: CONSTITUTION_VERSION, ...(reasons ? { reasons } : {}) });
    const stopped = await this.stop.blocking(p.userId);
    if (stopped) {
      await audit("denied", ["parada de emergência acionada"]);
      throw new ObedientError("EMERGENCY_STOP", stopped.reason);
    }
    if (p.grantId) {
      const g = await this.grants.get(p.grantId);
      const agentId = p.requestedBy.replace(/^agent:/, "");
      const still = await this.grants.findCovering(p.userId, agentId, p.payload.systemId, p.payload.tool);
      if (!g || !still) {
        await audit("denied", ["grant revogado ou vencido depois da aprovação"]);
        throw new ObedientError("GRANT_NOT_FOUND", "grant revogado ou vencido depois da aprovação");
      }
    }
    const payload = await this.approvals.claim(proposalId, hash);
    let out: T;
    try {
      out = await executor(payload);
    } catch (e) {
      await this.approvals.complete(proposalId, false);
      await audit("failed", [e instanceof Error ? e.message : String(e)]);
      throw e;
    }
    await this.approvals.complete(proposalId, true);
    await audit("executed");
    return out;
  }
}

function safeHash(req: ActionRequest): string {
  try {
    return payloadHash({ systemId: req.systemId, tool: req.tool, args: req.args });
  } catch {
    return "unhashable";
  }
}

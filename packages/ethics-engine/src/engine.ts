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
import { type Grant, GrantRegistry, capabilityMatches } from "./grants.ts";

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

/**
 * O que a execução de uma proposta aprovada precisa saber da ferramenta para reconferir tudo: o
 * mesmo registro (risco, categoria, dados pessoais, finalidade) que foi ao authorize. Sistema,
 * ferramenta, argumentos e agente vêm da própria proposta.
 */
export type ApprovedExecution = Pick<ActionRequest, "risk" | "category" | "context" | "dataCategories" | "purpose">;

type Conferencia = { negado: string[]; decision: Decision | null } | { negado: null; decision: Decision };

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
  /**
   * Art. 5º: a identificação que a pessoa configurou para mensagens enviadas em nome dela. Com esta
   * função, ferramenta de categoria COMMUNICATION só passa se `args.identificacao` for exatamente
   * esse texto; sem identificação configurada, não passa. Sem a função, a regra fica desligada (uso
   * do motor fora do servidor).
   */
  identificacaoDe?: (userId: string) => Promise<string | null> | string | null;
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
  private readonly identificacaoDe: EthicsEngineDeps["identificacaoDe"];

  constructor(deps: EthicsEngineDeps = {}) {
    this.clock = deps.clock ?? systemClock;
    this.grants = deps.grants ?? new GrantRegistry(undefined, this.clock);
    this.consent = deps.consent ?? new ConsentManager(this.clock);
    this.approvals = deps.approvals ?? new ApprovalGateway(this.clock);
    this.stop = deps.stop ?? new EmergencyStop(this.clock);
    this.audit = deps.audit ?? new AuditTrail(undefined, this.clock);
    this.policiesFor = deps.policiesFor ?? (() => []);
    this.defaultsFor = deps.defaultsFor ?? (() => SYSTEM_DEFAULTS);
    this.identificacaoDe = deps.identificacaoDe;

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

      const c = await this.conferir(req, grant);
      if (c.negado) return deny(c.negado, c.decision, grant.id);
      const { decision } = c;

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

  /**
   * Tudo o que o grant, a pessoa e as políticas exigem, com o grant já escolhido. Roda no authorize e
   * de novo na execução de proposta aprovada: o que deixou de valer depois da aprovação (limite do
   * grant, consentimento, identificação, política que nega) impede a execução (Arts. 2º, 4º e 5º).
   */
  private async conferir(req: ActionRequest, grant: Grant): Promise<Conferencia> {
    const nega = (motivo: string, decision: Decision | null = null): Conferencia => ({ negado: [motivo], decision });
    const risk = effectiveRisk(req.risk, req.category);
    if (riskRank(risk) > riskRank(grant.limits.maxRisk)) return nega(`risco ${risk} acima do máximo do grant (${grant.limits.maxRisk})`);

    if (grant.limits.maxAmount !== null && grant.limits.amountField) {
      const v = amountOf(req.args, grant.limits.amountField);
      if (v === null) return nega(`valor ilegível em ${grant.limits.amountField}: sem valor, sem limite conferível`);
      if (v > grant.limits.maxAmount) return nega(`valor ${v} acima do limite do grant (${grant.limits.maxAmount})`);
    }

    // Art. 5º: mensagem em nome da pessoa leva a identificação que ela configurou, exatamente.
    if (req.category === "COMMUNICATION" && this.identificacaoDe) {
      const id = await this.identificacaoDe(req.userId);
      if (!id) return nega("configure como as mensagens enviadas em seu nome se identificam (Art. 5º)");
      if (req.args.identificacao !== id) return nega("mensagem sem a identificação que você configurou (Art. 5º)");
    }

    if (req.dataCategories?.length) {
      if (!req.purpose) return nega("ação toca dado pessoal sem finalidade declarada (Art. 4º)");
      const c = await this.consent.check(req.userId, req.purpose, req.dataCategories);
      if (!c.ok) return nega(`sem consentimento para: ${c.missing.join(", ")} (finalidade ${req.purpose})`);
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
    if (decision.effect === "deny") return nega(decision.reason, decision);
    return { negado: null, decision };
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
   * Executa uma proposta aprovada. Antes de reivindicar, confere DE NOVO a parada de emergência, o
   * grant da proposta e tudo o que o authorize confere: revogar depois de aprovar ainda impede a
   * execução (Arts. 2º e 4º).
   */
  async executeApproved<T>(proposalId: string, hash: string, exec: ApprovedExecution, executor: (payload: ProposalPayload) => Promise<T>): Promise<T> {
    const payload = await this.claimApproved(proposalId, hash, exec);
    let out: T;
    try {
      out = await executor(payload);
    } catch (e) {
      await this.completeApproved(proposalId, hash, false, e instanceof Error ? e.message : String(e));
      throw e;
    }
    await this.completeApproved(proposalId, hash, true);
    return out;
  }

  /**
   * Primeira metade de executeApproved: confere a parada, o grant e o resto DE NOVO e reivindica a
   * execução (uma vez só). Separada para quem precisa executar FORA da transação do banco (o
   * servidor: a chamada ao sistema de destino pode demorar) e concluir noutra transação.
   *
   * O grant que vale é o da proposta, vigente com toda a cadeia de pais. Outro grant que cubra a
   * mesma ferramenta não o substitui: a pessoa aprovou sob aquele.
   */
  async claimApproved(proposalId: string, hash: string, exec: ApprovedExecution): Promise<ProposalPayload> {
    const p = await this.approvals.get(proposalId);
    if (!p) throw new ObedientError("PROPOSAL_NOT_FOUND", "proposta inexistente");
    const stopped = await this.stop.blocking(p.userId);
    if (stopped) {
      await this.auditExecution(p, hash, "denied", ["parada de emergência acionada"]);
      throw new ObedientError("EMERGENCY_STOP", stopped.reason);
    }
    const agentId = p.requestedBy.replace(/^agent:/, "");
    const g = p.grantId ? await this.grants.inForce(p.userId, p.grantId) : null;
    if (!g || g.agentId !== agentId || (g.systemId !== null && g.systemId !== p.payload.systemId) || !capabilityMatches(g.capability, p.payload.tool)) {
      await this.auditExecution(p, hash, "denied", ["grant revogado ou vencido depois da aprovação"]);
      throw new ObedientError("GRANT_NOT_FOUND", "grant revogado ou vencido depois da aprovação");
    }
    const c = await this.conferir({ ...exec, userId: p.userId, agentId, systemId: p.payload.systemId, tool: p.payload.tool, args: p.payload.args }, g);
    if (c.negado) {
      await this.auditExecution(p, hash, "denied", c.negado);
      throw new ObedientError("NO_LONGER_AUTHORIZED", `deixou de valer depois da aprovação: ${c.negado.join("; ")}`);
    }
    return this.approvals.claim(proposalId, hash);
  }

  /** Segunda metade: registra o desfecho da execução reivindicada. */
  async completeApproved(proposalId: string, hash: string, ok: boolean, erro?: string): Promise<void> {
    const p = await this.approvals.complete(proposalId, ok);
    await this.auditExecution(p, hash, ok ? "executed" : "failed", ok ? undefined : [erro ?? "falhou"]);
  }

  private auditExecution(p: Proposal, hash: string, outcome: "executed" | "failed" | "denied", reasons?: string[]) {
    return this.audit.record({ userId: p.userId, actor: p.requestedBy, event: "proposal.execute", outcome, proposalId: p.id, grantId: p.grantId, systemId: p.payload.systemId, tool: p.payload.tool, inputHash: hash, constitutionVersion: CONSTITUTION_VERSION, ...(reasons ? { reasons } : {}) });
  }

}

function safeHash(req: ActionRequest): string {
  try {
    return payloadHash({ systemId: req.systemId, tool: req.tool, args: req.args });
  } catch {
    return "unhashable";
  }
}

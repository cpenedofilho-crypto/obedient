// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Proveniência: adaptado de casa-de-ia/src/governanca/motor-de-politicas.ts (commit 224c960),
// do mesmo autor. Ver docs/licensing/PROVENANCE.md. A semântica foi mantida; os nomes passaram
// para inglês e o aprovador deixou de ser papel de organização (manager/org_admin) para ser o
// próprio usuário, com ou sem autenticação forte.
//
// Policy Engine: decide o que acontece com uma ação de agente ANTES dela existir.
// Função pura (sem banco, sem relógio implícito): quem chama carrega as políticas e o contexto.
//
//   ação → risco efetivo → políticas → padrão por risco → efeito
//
// Efeitos, do mais forte para o mais fraco:
//   deny > require_privileged_approval > require_approval > allow
//
// Regras fixas (não configuráveis, CONSTITUTION.md Art. 6º e 12):
//   • deny sempre vence;
//   • CRITICAL nunca roda sozinha: no mínimo aprovação privilegiada, ou bloqueio;
//   • allow_autonomous só derruba o PADRÃO, nunca uma exigência de outra política;
//   • política com condição de valor casa quando o valor é maior que o limite; com o valor presente
//     mas ilegível ou ambíguo, a que restringe casa e a que libera não;
//   • categoria FINANCIAL, LEGAL ou DESTRUCTIVE conta como CRITICAL, qualquer que seja o risco
//     informado.

import { RISK_LEVELS, type RiskLevel } from "@obedient/core";

export const EFFECTS = ["allow", "require_approval", "require_privileged_approval", "deny"] as const;
export type Effect = (typeof EFFECTS)[number];
export const effectRank = (e: Effect): number => EFFECTS.indexOf(e);

/** Efeito padrão por risco, sem política. */
export type Defaults = Record<RiskLevel, Effect>;
export const SYSTEM_DEFAULTS: Readonly<Defaults> = Object.freeze({
  LOW: "allow",
  MEDIUM: "allow",
  HIGH: "require_approval",
  CRITICAL: "require_privileged_approval",
});

export type PolicyEffect = "deny" | "allow_autonomous" | "require_approval" | "require_privileged_approval";

/** Política como DADO. Campo nulo = qualquer valor. */
export interface Policy {
  id: string;
  effect: PolicyEffect;
  /** Sistema de destino (ex.: "recupera", "motor", "calendar"). */
  systemId: string | null;
  /** "*" ou prefixo terminado em "*" ou nome exato. */
  toolPattern: string;
  /** "*" ou id exato do agente/usuário. */
  principalId: string;
  riskLevels: RiskLevel[] | null;
  categories?: string[] | null;
  eventTypes: string[] | null;
  entityTypes: string[] | null;
  roles: string[] | null;
  contextMatch: Record<string, unknown> | null;
  amountField: string | null;
  amountAbove: number | null;
  expiresAt: Date | null;
  active: boolean;
}

export interface Principal {
  kind: "user" | "agent" | "system";
  id: string;
  role: string | null;
}

/** Tudo que o motor considera sobre a ação. */
export interface Action {
  systemId: string;
  tool: string;
  risk: RiskLevel;
  /** Categoria estrutural da ferramenta. Ausente = desconhecida (nenhuma política de categoria casa). */
  category?: string;
  principal: Principal;
  args: Record<string, unknown>;
  context: { event_type?: string | null; entity_type?: string | null; [k: string]: unknown };
}

export type Approver = "user" | "user_strong_auth";

export interface Decision {
  effect: Effect;
  /** Quem precisa decidir, quando exige aprovação. */
  approver: Approver | null;
  /** Política que determinou o efeito; null quando veio do padrão. */
  policyId: string | null;
  source: "policy" | "default" | "fixed_rule";
  /** Frase operacional: por que este efeito. Vai para o pedido de aprovação e para a auditoria. */
  reason: string;
  /** Todas as políticas que casaram (auditoria). */
  matched: string[];
  /** Risco depois do piso por categoria. */
  effectiveRisk: RiskLevel;
}

function matchPattern(pattern: string, name: string): boolean {
  if (pattern === "*") return true;
  return pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : pattern === name;
}

function matchEvent(patterns: string[], type: string): boolean {
  return patterns.some((p) => p === "*" || p === type || (p.endsWith(".*") && type.startsWith(p.slice(0, -1))));
}

function path(obj: unknown, dotted: string): unknown {
  return dotted
    .split(".")
    .reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

// Formatos aceitos para valor em texto. Qualquer outro (notação científica, hexadecimal, "1,000.50",
// texto no meio) é ilegível: o limite não pode ser conferido e quem confere nega.
const MOEDA = /^(?:R\$|US\$|\$|€)\s*/;
const COM_PONTO = /^-?\d+(?:\.\d+)?$/; // 1234.56
const BR_MILHAR = /^-?\d{1,3}(?:\.\d{3})+(?:,\d+)?$/; // 1.234 ou 1.234,56
const BR_VIRGULA = /^-?\d+,\d+$/; // 1234,56

/**
 * Valor numérico da ação no campo indicado. Aceita número finito, "1234.56", "1.234,56", "1234,56" e
 * "R$ 1.234,56". Texto que dá dois valores diferentes conforme o formato ("1.000": mil ou um?) é
 * ambíguo e volta null, como o ilegível e o ausente. Quem confere um limite trata null como negação.
 */
export function amountOf(args: Record<string, unknown>, field: string): number | null {
  const v = path(args, field);
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim().replace(MOEDA, "");
  const comPonto = COM_PONTO.test(s) ? Number(s) : null;
  const brasileiro = BR_MILHAR.test(s) || BR_VIRGULA.test(s) ? Number(s.replace(/\./g, "").replace(",", ".")) : null;
  if (comPonto !== null && brasileiro !== null && comPonto !== brasileiro) return null;
  const n = comPonto ?? brasileiro;
  return n !== null && Number.isFinite(n) ? n : null;
}

/** O campo de valor veio preenchido (legível ou não)? */
function amountPresent(args: Record<string, unknown>, field: string): boolean {
  const v = path(args, field);
  return v !== undefined && v !== null && v !== "";
}

function contains(context: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([k, v]) => {
    const actual = context[k];
    if (v && typeof v === "object" && !Array.isArray(v))
      return actual !== null && typeof actual === "object" && contains(actual as Record<string, unknown>, v as Record<string, unknown>);
    return JSON.stringify(actual) === JSON.stringify(v);
  });
}

/** A política casa com a ação? Todas as condições preenchidas precisam casar. */
export function matches(p: Policy, a: Action, now: Date): boolean {
  if (!p.active || (p.expiresAt && p.expiresAt <= now)) return false;
  if (p.systemId && p.systemId !== a.systemId) return false;
  if (!matchPattern(p.toolPattern, a.tool)) return false;
  if (p.principalId !== "*" && p.principalId !== a.principal.id) return false;
  if (p.riskLevels?.length && !p.riskLevels.includes(a.risk)) return false;
  if (p.categories?.length && !(a.category && p.categories.includes(a.category))) return false;
  if (p.eventTypes?.length && !(a.context.event_type && matchEvent(p.eventTypes, a.context.event_type))) return false;
  if (p.entityTypes?.length && !(a.context.entity_type && p.entityTypes.includes(a.context.entity_type))) return false;
  if (p.roles?.length) {
    const role = a.principal.kind === "user" ? a.principal.role : a.principal.kind;
    if (!role || !p.roles.includes(role)) return false;
  }
  if (p.contextMatch && !contains(a.context, p.contextMatch)) return false;
  if (p.amountField && p.amountAbove !== null) {
    const v = amountOf(a.args, p.amountField);
    // Valor presente mas ilegível ou ambíguo: a política que restringe casa (não dá para provar que
    // está abaixo do limite); a que libera não casa.
    if (v === null) {
      if (!amountPresent(a.args, p.amountField) || p.effect === "allow_autonomous") return false;
    } else if (!(v > p.amountAbove)) return false;
  }
  return true;
}

const EFFECT_OF: Record<PolicyEffect, Effect> = {
  deny: "deny",
  require_privileged_approval: "require_privileged_approval",
  require_approval: "require_approval",
  allow_autonomous: "allow",
};

/** Categorias que nunca ficam abaixo de CRITICAL. */
export const ALWAYS_CRITICAL_CATEGORIES = ["FINANCIAL", "LEGAL", "DESTRUCTIVE"] as const;

/** Risco efetivo: o informado, ou CRITICAL quando a categoria exige. */
export function effectiveRisk(risk: RiskLevel, category?: string): RiskLevel {
  return category && (ALWAYS_CRITICAL_CATEGORIES as readonly string[]).includes(category) ? "CRITICAL" : risk;
}

export function decide(
  action: Action,
  policies: readonly Policy[],
  defaults: Defaults = SYSTEM_DEFAULTS,
  now: Date = new Date(),
): Decision {
  const risk = effectiveRisk(action.risk, action.category);
  const categoryFloor = risk !== action.risk;
  const a: Action = categoryFloor ? { ...action, risk } : action;
  const matched = policies.filter((p) => matches(p, a, now));
  const ids = matched.map((p) => p.id);
  const result = (effect: Effect, source: Decision["source"], policyId: string | null, reason: string): Decision => ({
    effect,
    source,
    policyId,
    reason,
    matched: ids,
    effectiveRisk: a.risk,
    approver: effect === "require_approval" ? "user" : effect === "require_privileged_approval" ? "user_strong_auth" : null,
  });

  const denied = matched.find((p) => p.effect === "deny");
  if (denied) return result("deny", "policy", denied.id, `policy ${denied.id} blocks this action`);

  const requirements = matched
    .filter((p) => p.effect === "require_approval" || p.effect === "require_privileged_approval")
    .sort((x, y) => effectRank(EFFECT_OF[y.effect]) - effectRank(EFFECT_OF[x.effect]));
  const autonomous = matched.find((p) => p.effect === "allow_autonomous");
  const fallback = defaults[a.risk] ?? SYSTEM_DEFAULTS[a.risk];

  let chosen: Decision;
  const strongest = requirements[0];
  if (strongest) {
    const amountNote = strongest.amountField ? ` (amount in ${strongest.amountField} above ${strongest.amountAbove})` : "";
    chosen = result(
      EFFECT_OF[strongest.effect],
      "policy",
      strongest.id,
      `policy ${strongest.id} requires ${strongest.effect === "require_privileged_approval" ? "privileged approval" : "approval"}${amountNote}`,
    );
    // Nunca abaixo do padrão do risco.
    if (effectRank(fallback) > effectRank(chosen.effect)) chosen = result(fallback, "default", null, `risk ${a.risk}: default is ${fallback}`);
  } else if (autonomous) {
    chosen = result("allow", "policy", autonomous.id, `policy ${autonomous.id} allows autonomous execution`);
  } else {
    chosen = result(fallback, "default", null, `risk ${a.risk}: default is ${fallback}`);
  }

  // Regra fixa: CRITICAL nunca roda sem a pessoa, com autenticação forte.
  if (a.risk === "CRITICAL" && effectRank(chosen.effect) < effectRank("require_privileged_approval")) {
    const reason = categoryFloor
      ? `category ${a.category} counts as CRITICAL and always requires privileged approval (fixed rule)`
      : "risk CRITICAL always requires privileged approval (fixed rule)";
    return result("require_privileged_approval", "fixed_rule", chosen.policyId, reason);
  }
  return chosen;
}

/**
 * Padrões configurados pelo usuário, validados. CRITICAL só aceita
 * require_privileged_approval ou deny. Valor inválido cai no padrão do sistema.
 */
export function validateDefaults(raw: unknown): Defaults {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Defaults = { ...SYSTEM_DEFAULTS };
  for (const r of RISK_LEVELS) {
    const v = input[r];
    if (typeof v !== "string" || !(EFFECTS as readonly string[]).includes(v)) continue;
    if (r === "CRITICAL" && v !== "deny" && v !== "require_privileged_approval") continue;
    out[r] = v as Effect;
  }
  return out;
}

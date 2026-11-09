// SPDX-License-Identifier: AGPL-3.0-only
// Testes portados de casa-de-ia/src/governanca/motor-de-politicas.test.ts (commit 224c960),
// de vitest para node:test. Os casos são os mesmos; os nomes estão em inglês.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { amountOf, decide, SYSTEM_DEFAULTS, validateDefaults, type Action, type Policy } from "./index.ts";

const S = "sys-1";
const action = (extra: Partial<Action> = {}): Action => ({
  systemId: S,
  tool: "register_payment",
  risk: "HIGH",
  principal: { kind: "agent", id: "agent-billing", role: null },
  args: { amount: 300 },
  context: { event_type: "payment.overdue", entity_type: "payment", trigger: "event" },
  ...extra,
});
let n = 0;
const pol = (extra: Partial<Policy>): Policy => ({
  id: `p${++n}`,
  effect: "require_approval",
  systemId: null,
  toolPattern: "*",
  principalId: "*",
  riskLevels: null,
  eventTypes: null,
  entityTypes: null,
  roles: null,
  contextMatch: null,
  amountField: null,
  amountAbove: null,
  expiresAt: null,
  active: true,
  ...extra,
});

describe("default by risk", () => {
  it("LOW and MEDIUM run, HIGH asks the user, CRITICAL asks with strong auth", () => {
    assert.equal(decide(action({ risk: "LOW" }), []).effect, "allow");
    assert.equal(decide(action({ risk: "MEDIUM" }), []).effect, "allow");
    const high = decide(action({ risk: "HIGH" }), []);
    assert.equal(high.effect, "require_approval");
    assert.equal(high.approver, "user");
    assert.equal(high.source, "default");
    const crit = decide(action({ risk: "CRITICAL" }), []);
    assert.equal(crit.effect, "require_privileged_approval");
    assert.equal(crit.approver, "user_strong_auth");
  });

  it("the user may tighten defaults, but CRITICAL only accepts privileged approval or deny", () => {
    const d = validateDefaults({ MEDIUM: "require_approval", CRITICAL: "allow", HIGH: "invented" });
    assert.deepEqual(d, { ...SYSTEM_DEFAULTS, MEDIUM: "require_approval" });
    assert.equal(decide(action({ risk: "MEDIUM" }), [], d).effect, "require_approval");
    assert.equal(validateDefaults({ CRITICAL: "deny" }).CRITICAL, "deny");
    assert.deepEqual(validateDefaults(null), SYSTEM_DEFAULTS);
  });
});

describe("precedence", () => {
  it("deny beats everything", () => {
    const d = decide(action({ risk: "LOW" }), [pol({ effect: "allow_autonomous" }), pol({ effect: "deny", id: "block" })]);
    assert.equal(d.effect, "deny");
    assert.equal(d.policyId, "block");
  });

  it("allow_autonomous lowers the MEDIUM default, but never another policy's requirement", () => {
    const pede = { ...SYSTEM_DEFAULTS, MEDIUM: "require_approval" as const };
    assert.equal(decide(action({ risk: "MEDIUM" }), [pol({ effect: "allow_autonomous" })], pede).effect, "allow");
    const d = decide(action({ risk: "MEDIUM" }), [pol({ effect: "allow_autonomous" }), pol({ effect: "require_privileged_approval", id: "hard" })], pede);
    assert.equal(d.effect, "require_privileged_approval");
    assert.equal(d.policyId, "hard");
  });

  it("a policy requirement never falls below the default", () => {
    assert.equal(decide(action({ risk: "CRITICAL" }), [pol({ effect: "require_approval" })]).effect, "require_privileged_approval");
  });

  it("CRITICAL never becomes autonomous (fixed rule)", () => {
    const d = decide(action({ risk: "CRITICAL" }), [pol({ effect: "allow_autonomous" })]);
    assert.equal(d.effect, "require_privileged_approval");
    assert.equal(d.source, "fixed_rule");
  });

  it("HIGH never becomes autonomous (fixed rule, Art. 1º)", () => {
    const d = decide(action({ risk: "HIGH" }), [pol({ effect: "allow_autonomous" })]);
    assert.equal(d.effect, "require_approval");
    assert.equal(d.source, "fixed_rule");
    // Nem com um padrão HIGH=allow que não passou por validateDefaults.
    assert.equal(decide(action({ risk: "HIGH" }), [], { ...SYSTEM_DEFAULTS, HIGH: "allow" }).effect, "require_approval");
    // Exigência maior que aprovação continua valendo.
    assert.equal(decide(action({ risk: "HIGH" }), [pol({ effect: "deny" })]).effect, "deny");
  });

  it("validateDefaults ignores allow for HIGH", () => {
    assert.equal(validateDefaults({ HIGH: "allow" }).HIGH, SYSTEM_DEFAULTS.HIGH);
    assert.equal(validateDefaults({ HIGH: "require_privileged_approval" }).HIGH, "require_privileged_approval");
  });

  it("FINANCIAL/LEGAL/DESTRUCTIVE count as CRITICAL whatever risk is declared", () => {
    for (const category of ["FINANCIAL", "LEGAL", "DESTRUCTIVE"]) {
      const d = decide(action({ risk: "LOW", category }), [pol({ effect: "allow_autonomous" })]);
      assert.equal(d.effect, "require_privileged_approval", category);
      assert.equal(d.effectiveRisk, "CRITICAL");
    }
  });
});

describe("conditions", () => {
  const requires = (extra: Partial<Policy>) => [pol({ effect: "require_privileged_approval", id: "target", ...extra })];
  const hit = (a: Action, ps: Policy[]) => decide(a, ps).policyId === "target";

  it("system: the policy only applies to its system", () => {
    assert.equal(hit(action(), requires({ systemId: S })), true);
    assert.equal(hit(action(), requires({ systemId: "other" })), false);
  });

  it("principal and tool", () => {
    assert.equal(hit(action(), requires({ principalId: "agent-billing", toolPattern: "register_*" })), true);
    assert.equal(hit(action(), requires({ principalId: "other-agent" })), false);
    assert.equal(hit(action(), requires({ toolPattern: "refund_*" })), false);
  });

  it("event and entity", () => {
    assert.equal(hit(action(), requires({ eventTypes: ["payment.*"], entityTypes: ["payment"] })), true);
    assert.equal(hit(action(), requires({ eventTypes: ["case.*"] })), false);
    assert.equal(hit(action({ context: {} }), requires({ eventTypes: ["payment.*"] })), false);
  });

  it("risk", () => {
    assert.equal(hit(action(), requires({ riskLevels: ["HIGH", "CRITICAL"] })), true);
    assert.equal(hit(action(), requires({ riskLevels: ["LOW"] })), false);
  });

  it("amount: only above the limit, and only when the amount exists", () => {
    assert.equal(hit(action({ args: { amount: 300 } }), requires({ amountField: "amount", amountAbove: 200 })), true);
    assert.equal(hit(action({ args: { amount: 150 } }), requires({ amountField: "amount", amountAbove: 200 })), false);
    assert.equal(hit(action({ args: { payment: { total: "1.250,00" } } }), requires({ amountField: "payment.total", amountAbove: 1000 })), true);
    assert.equal(hit(action({ args: {} }), requires({ amountField: "amount", amountAbove: 0 })), false);
    assert.match(decide(action(), requires({ amountField: "amount", amountAbove: 200 })).reason, /amount in amount above 200/);
  });

  it("context (contains)", () => {
    assert.equal(hit(action(), requires({ contextMatch: { trigger: "event" } })), true);
    assert.equal(hit(action(), requires({ contextMatch: { trigger: "manual" } })), false);
  });

  it("role: a person by role; agent and system by kind", () => {
    const person = action({ principal: { kind: "user", id: "u1", role: "owner" } });
    assert.equal(hit(person, requires({ roles: ["owner"] })), true);
    assert.equal(hit(person, requires({ roles: ["admin"] })), false);
    assert.equal(hit(action(), requires({ roles: ["agent"] })), true);
  });

  it("inactive or expired does not match", () => {
    assert.equal(hit(action(), requires({ active: false })), false);
    assert.equal(hit(action(), requires({ expiresAt: new Date(Date.now() - 1000) })), false);
  });

  it("every condition must match", () => {
    assert.equal(hit(action(), requires({ eventTypes: ["payment.*"], amountField: "amount", amountAbove: 1000 })), false);
  });
});

describe("amountOf", () => {
  it("reads numbers and Brazilian or US formatted text", () => {
    assert.equal(amountOf({ v: 10 }, "v"), 10);
    assert.equal(amountOf({ v: "R$ 1.234,56" }, "v"), 1234.56);
    assert.equal(amountOf({ v: "1234.56" }, "v"), 1234.56);
    assert.equal(amountOf({ v: "abc" }, "v"), null);
    assert.equal(amountOf({}, "v"), null);
  });
});

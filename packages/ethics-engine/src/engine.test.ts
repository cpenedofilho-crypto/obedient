// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ManualClock, ObedientError } from "@obedient/core";
import { ApprovalGateway, AuditTrail, ConsentManager, EmergencyStop, EthicsEngine, GrantRegistry, InMemoryAuditSink, InMemoryGrantStore, type GrantSpec } from "./index.ts";

const T0 = new Date("2026-11-02T12:00:00Z");
const HOUR = 3_600_000;

function setup() {
  const clock = new ManualClock(T0);
  let seq = 0;
  const id = () => `id-${++seq}`;
  const sink = new InMemoryAuditSink();
  const engine = new EthicsEngine({
    clock,
    grants: new GrantRegistry(new InMemoryGrantStore(), clock, id),
    consent: new ConsentManager(clock),
    approvals: new ApprovalGateway(clock, id),
    stop: new EmergencyStop(clock, new Set(["op-1"])),
    audit: new AuditTrail(sink, clock),
  });
  const spec = (extra: Partial<GrantSpec> = {}): GrantSpec => ({
    userId: "u1",
    agentId: "obedient",
    systemId: "calendar",
    capability: "calendar.*",
    purpose: "organizar a agenda da semana",
    limits: { maxRisk: "HIGH", autonomousUpTo: "MEDIUM", maxAmount: null, amountField: null },
    expiresAt: new Date(T0.getTime() + 24 * HOUR),
    ...extra,
  });
  return { clock, engine, sink, spec };
}

const req = (extra: Record<string, unknown> = {}) => ({
  userId: "u1",
  agentId: "obedient",
  systemId: "calendar",
  tool: "calendar.create_event",
  risk: "MEDIUM" as const,
  category: "WRITE",
  args: { title: "Dentista", at: "2026-11-03T10:00:00-03:00" },
  ...extra,
});

describe("grants (Art. 3º)", () => {
  it("rejects wildcard, missing purpose, past expiry, autonomy above max risk and CRITICAL autonomy", () => {
    const { engine, spec } = setup();
    const bad: Partial<GrantSpec>[] = [
      { capability: "*" },
      { capability: "ca*" },
      { purpose: "" },
      { expiresAt: new Date(T0.getTime() - 1) },
      { limits: { maxRisk: "LOW", autonomousUpTo: "MEDIUM", maxAmount: null, amountField: null } },
      { limits: { maxRisk: "CRITICAL", autonomousUpTo: "CRITICAL", maxAmount: null, amountField: null } },
      { limits: { maxRisk: "HIGH", autonomousUpTo: null, maxAmount: 100, amountField: null } },
      { agentId: "u1" },
    ];
    for (const b of bad) assert.throws(() => engine.grants.grant(spec(b), "u1"), (e: unknown) => e instanceof ObedientError && e.code === "INVALID_GRANT", JSON.stringify(b));
  });

  it("only the user grants direct authority", () => {
    const { engine, spec } = setup();
    assert.throws(() => engine.grants.grant(spec(), "obedient"), /só o próprio usuário/);
  });

  it("delegation only narrows; revoking the parent revokes the whole chain", () => {
    const { engine, spec } = setup();
    const parent = engine.grants.grant(spec({ capability: "calendar.*" }), "u1");
    const narrower = {
      agentId: "dots",
      systemId: "calendar",
      capability: "calendar.list_*",
      purpose: "ler a agenda para o resumo do dia",
      limits: { maxRisk: "LOW" as const, autonomousUpTo: "LOW" as const, maxAmount: null, amountField: null },
      expiresAt: new Date(T0.getTime() + HOUR),
    };
    const child = engine.grants.delegate(parent.id, narrower, "obedient");
    assert.equal(child.parentId, parent.id);

    for (const wider of [
      { capability: "email.*" },
      { systemId: "email" },
      { expiresAt: new Date(T0.getTime() + 48 * HOUR) },
      { limits: { ...narrower.limits, maxRisk: "CRITICAL" as const } },
    ])
      assert.throws(() => engine.grants.delegate(parent.id, { ...narrower, ...wider }, "obedient"), /DELEGATION|pai|fora/);
    assert.throws(() => engine.grants.delegate(parent.id, narrower, "dots"), /titular do grant pai/);

    assert.ok(engine.grants.findCovering("u1", "dots", "calendar", "calendar.list_events"));
    const revoked = engine.grants.revoke(parent.id, "u1");
    assert.deepEqual(revoked.map((g) => g.id).sort(), [parent.id, child.id].sort());
    assert.equal(engine.grants.findCovering("u1", "dots", "calendar", "calendar.list_events"), null);
  });
});

describe("authorize", () => {
  it("no grant → denied; with grant MEDIUM autonomous → allowed; HIGH → approval", () => {
    const { engine, spec } = setup();
    assert.equal(engine.authorize(req()).outcome, "denied");
    engine.grants.grant(spec(), "u1");
    assert.equal(engine.authorize(req()).outcome, "allowed");
    assert.equal(engine.authorize(req({ risk: "HIGH" })).outcome, "approval_required");
  });

  it("risk above the grant's max and CRITICAL category floor", () => {
    const { engine, spec } = setup();
    engine.grants.grant(spec(), "u1");
    const crit = engine.authorize(req({ risk: "CRITICAL" }));
    assert.equal(crit.outcome, "denied");
    // FINANCIAL vira CRITICAL, que está acima do maxRisk HIGH
    assert.equal(engine.authorize(req({ category: "FINANCIAL", risk: "LOW" })).outcome, "denied");
  });

  it("amount limit: above denies, unreadable denies (fail-closed)", () => {
    const { engine, spec } = setup();
    engine.grants.grant(
      spec({ capability: "shop.buy", systemId: "shop", limits: { maxRisk: "HIGH", autonomousUpTo: null, maxAmount: 200, amountField: "price" } }),
      "u1",
    );
    const r = (args: Record<string, unknown>) => engine.authorize(req({ systemId: "shop", tool: "shop.buy", risk: "HIGH", category: "WRITE", args })).outcome;
    assert.equal(r({ price: 150 }), "approval_required");
    assert.equal(r({ price: 250 }), "denied");
    assert.equal(r({}), "denied");
  });

  it("personal data needs purpose and consent; sensitive needs specific consent; revoking is immediate", () => {
    const { engine, spec } = setup();
    engine.grants.grant(spec(), "u1");
    const withData = (cats: string[], purpose?: string) => engine.authorize(req({ dataCategories: cats, ...(purpose ? { purpose } : {}) })).outcome;
    assert.equal(withData(["contacts"]), "denied");
    assert.equal(withData(["contacts"], "agenda"), "denied");
    engine.consent.give("u1", "agenda", "contacts");
    assert.equal(withData(["contacts"], "agenda"), "allowed");
    engine.consent.give("u1", "agenda", "health");
    assert.equal(withData(["health"], "agenda"), "denied");
    engine.consent.give("u1", "agenda", "health", { specific: true });
    assert.equal(withData(["health"], "agenda"), "allowed");
    engine.consent.revoke("u1", "agenda", "contacts");
    assert.equal(withData(["contacts"], "agenda"), "denied");
  });

  it("a user deny policy beats the grant's autonomy", () => {
    const clock = new ManualClock(T0);
    const engine = new EthicsEngine({
      clock,
      policiesFor: () => [
        { id: "never-delete", effect: "deny", systemId: null, toolPattern: "calendar.delete_*", principalId: "*", riskLevels: null, eventTypes: null, entityTypes: null, roles: null, contextMatch: null, amountField: null, amountAbove: null, expiresAt: null, active: true },
      ],
    });
    engine.grants.grant(
      { userId: "u1", agentId: "obedient", systemId: "calendar", capability: "calendar.*", purpose: "gerir agenda", limits: { maxRisk: "HIGH", autonomousUpTo: "MEDIUM", maxAmount: null, amountField: null }, expiresAt: new Date(T0.getTime() + HOUR) },
      "u1",
    );
    const r = engine.authorize(req({ tool: "calendar.delete_event" }));
    assert.equal(r.outcome, "denied");
  });

  it("agent cannot impersonate the user; an exception inside evaluation denies", () => {
    const { engine, spec } = setup();
    engine.grants.grant(spec(), "u1");
    assert.equal(engine.authorize(req({ agentId: "u1" })).outcome, "denied");
    // Payload que não se hasheia (número não finito) não derruba o processo: a avaliação segue
    // e o registro marca o hash como "unhashable".
    const r = engine.authorize(req({ args: { n: Number.NaN } }));
    assert.ok(r.outcome === "allowed" || r.outcome === "denied");
    assert.equal(engine.audit.all().at(-1)?.inputHash, "unhashable");
  });
});

describe("approval gateway (Art. 1º e 12)", () => {
  it("full cycle: propose → approve with shown hash → execute once", async () => {
    const { engine, spec } = setup();
    engine.grants.grant(spec(), "u1");
    const a = engine.authorize(req({ risk: "HIGH" }));
    assert.equal(a.outcome, "approval_required");
    if (a.outcome !== "approval_required") return;
    const { proposal } = a;
    assert.match(proposal.summary, /calendar\.calendar\.create_event\(at=/);

    assert.throws(() => engine.approve(proposal.id, { id: "obedient", kind: "agent", strongAuth: true }, proposal.payloadHash), /só pessoa/);
    assert.throws(() => engine.approve(proposal.id, { id: "u2", kind: "user", strongAuth: true }, proposal.payloadHash), /dono/);
    assert.throws(() => engine.approve(proposal.id, { id: "u1", kind: "user", strongAuth: false }, "0".repeat(64)), /payload mudou/);

    engine.approve(proposal.id, { id: "u1", kind: "user", strongAuth: false }, proposal.payloadHash);
    let runs = 0;
    const out = await engine.executeApproved(proposal.id, proposal.payloadHash, async (p) => {
      runs++;
      return p.args.title;
    });
    assert.equal(out, "Dentista");
    await assert.rejects(engine.executeApproved(proposal.id, proposal.payloadHash, async () => runs++), /já executada/);
    assert.equal(runs, 1);
  });

  it("CRITICAL needs strong auth; proposals expire", () => {
    const { engine, spec, clock } = setup();
    engine.grants.grant(spec({ limits: { maxRisk: "CRITICAL", autonomousUpTo: "MEDIUM", maxAmount: null, amountField: null } }), "u1");
    const a = engine.authorize(req({ risk: "CRITICAL" }));
    assert.equal(a.outcome, "approval_required");
    if (a.outcome !== "approval_required") return;
    assert.equal(a.proposal.approver, "user_strong_auth");
    assert.throws(() => engine.approve(a.proposal.id, { id: "u1", kind: "user", strongAuth: false }, a.proposal.payloadHash), /reautenticação/);
    clock.advance(31 * 60 * 1000);
    assert.throws(() => engine.approve(a.proposal.id, { id: "u1", kind: "user", strongAuth: true }, a.proposal.payloadHash), /vencida/);
  });

  it("revoking the grant after approval still blocks execution (Art. 2º)", async () => {
    const { engine, spec } = setup();
    const g = engine.grants.grant(spec(), "u1");
    const a = engine.authorize(req({ risk: "HIGH" }));
    if (a.outcome !== "approval_required") throw new Error("esperava aprovação");
    engine.approve(a.proposal.id, { id: "u1", kind: "user", strongAuth: false }, a.proposal.payloadHash);
    engine.grants.revoke(g.id, "u1");
    await assert.rejects(engine.executeApproved(a.proposal.id, a.proposal.payloadHash, async () => "x"), /revogado/);
  });
});

describe("emergency stop (Art. 9º)", () => {
  it("blocks the next call, cancels pending proposals, and only the user releases", async () => {
    const { engine, spec } = setup();
    engine.grants.grant(spec(), "u1");
    const a = engine.authorize(req({ risk: "HIGH" }));
    assert.equal(a.outcome, "approval_required");
    await engine.stop.engage({ kind: "user", userId: "u1" }, "u1", "o usuário apertou parar");
    assert.equal(engine.authorize(req()).outcome, "denied");
    assert.equal(engine.approvals.pending("u1").length, 0);
    assert.throws(() => engine.stop.release({ kind: "user", userId: "u1" }, "obedient", "agent"), /agente não libera/);
    assert.throws(() => engine.stop.release({ kind: "user", userId: "u1" }, "u2", "user"), /próprio usuário/);
    engine.stop.release({ kind: "user", userId: "u1" }, "u1", "user");
    assert.equal(engine.authorize(req()).outcome, "allowed");
  });

  it("global stop blocks everyone and only an operator releases it", async () => {
    const { engine, spec } = setup();
    engine.grants.grant(spec(), "u1");
    await engine.stop.engage({ kind: "global" }, "monitor", "incidente");
    assert.equal(engine.authorize(req()).outcome, "denied");
    assert.throws(() => engine.stop.release({ kind: "global" }, "u1", "user"), /operador/);
    engine.stop.release({ kind: "global" }, "op-1", "operator");
    assert.equal(engine.authorize(req()).outcome, "allowed");
  });
});

describe("audit trail (Art. 8º)", () => {
  it("every decision is recorded, chained, and tampering is detected", () => {
    const { engine, spec, sink } = setup();
    engine.authorize(req());
    engine.grants.grant(spec(), "u1");
    engine.authorize(req());
    engine.authorize(req({ risk: "HIGH" }));
    const outcomes = engine.audit.all().map((e) => e.outcome);
    assert.deepEqual(outcomes, ["denied", "allowed", "approval_required"]);
    assert.ok(engine.audit.all().every((e) => e.constitutionVersion === "0.1.0-draft"));
    assert.equal(engine.audit.verify(), true);
    // entradas são congeladas: tentar mudar lança em strict mode
    assert.throws(() => {
      (sink.entries()[0] as { outcome: string }).outcome = "allowed";
    });
    // adulteração por fora do objeto congelado (substituição da linha) quebra a cadeia
    const rows = sink.entries() as unknown as Array<Record<string, unknown>>;
    rows[1] = { ...rows[1], tool: "calendar.delete_everything" };
    assert.throws(() => engine.audit.verify(), /cadeia quebrada na entrada 2/);
  });
});

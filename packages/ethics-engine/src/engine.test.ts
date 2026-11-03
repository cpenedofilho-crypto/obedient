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
  it("rejects wildcard, missing purpose, past expiry, autonomy above max risk and CRITICAL autonomy", async () => {
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
    for (const b of bad) await assert.rejects(() => engine.grants.grant(spec(b), "u1"), (e: unknown) => e instanceof ObedientError && e.code === "INVALID_GRANT", JSON.stringify(b));
  });

  it("only the user grants direct authority", async () => {
    const { engine, spec } = setup();
    await assert.rejects(() => engine.grants.grant(spec(), "obedient"), /só o próprio usuário/);
  });

  it("delegation only narrows; revoking the parent revokes the whole chain", async () => {
    const { engine, spec } = setup();
    const parent = await engine.grants.grant(spec({ capability: "calendar.*" }), "u1");
    const narrower = {
      agentId: "dots",
      systemId: "calendar",
      capability: "calendar.list_*",
      purpose: "ler a agenda para o resumo do dia",
      limits: { maxRisk: "LOW" as const, autonomousUpTo: "LOW" as const, maxAmount: null, amountField: null },
      expiresAt: new Date(T0.getTime() + HOUR),
    };
    const child = await engine.grants.delegate(parent.id, narrower, "obedient");
    assert.equal(child.parentId, parent.id);

    for (const wider of [
      { capability: "email.*" },
      { systemId: "email" },
      { expiresAt: new Date(T0.getTime() + 48 * HOUR) },
      { limits: { ...narrower.limits, maxRisk: "CRITICAL" as const } },
    ])
      await assert.rejects(() => engine.grants.delegate(parent.id, { ...narrower, ...wider }, "obedient"), /DELEGATION|pai|fora/);
    await assert.rejects(() => engine.grants.delegate(parent.id, narrower, "dots"), /titular do grant pai/);

    assert.ok(await engine.grants.findCovering("u1", "dots", "calendar", "calendar.list_events"));
    const revoked = await engine.grants.revoke(parent.id, "u1");
    assert.deepEqual(revoked.map((g) => g.id).sort(), [parent.id, child.id].sort());
    assert.equal(await engine.grants.findCovering("u1", "dots", "calendar", "calendar.list_events"), null);
  });
});

describe("authorize", () => {
  it("no grant → denied; with grant MEDIUM autonomous → allowed; HIGH → approval", async () => {
    const { engine, spec } = setup();
    assert.equal((await engine.authorize(req())).outcome, "denied");
    await engine.grants.grant(spec(), "u1");
    assert.equal((await engine.authorize(req())).outcome, "allowed");
    assert.equal((await engine.authorize(req({ risk: "HIGH" }))).outcome, "approval_required");
  });

  it("risk above the grant's max and CRITICAL category floor", async () => {
    const { engine, spec } = setup();
    await engine.grants.grant(spec(), "u1");
    const crit = await engine.authorize(req({ risk: "CRITICAL" }));
    assert.equal(crit.outcome, "denied");
    // FINANCIAL vira CRITICAL, que está acima do maxRisk HIGH
    assert.equal((await engine.authorize(req({ category: "FINANCIAL", risk: "LOW" }))).outcome, "denied");
  });

  it("amount limit: above denies, unreadable denies (fail-closed)", async () => {
    const { engine, spec } = setup();
    await engine.grants.grant(
      spec({ capability: "shop.buy", systemId: "shop", limits: { maxRisk: "HIGH", autonomousUpTo: null, maxAmount: 200, amountField: "price" } }),
      "u1",
    );
    const r = async (args: Record<string, unknown>) => (await engine.authorize(req({ systemId: "shop", tool: "shop.buy", risk: "HIGH", category: "WRITE", args }))).outcome;
    assert.equal(await r({ price: 150 }), "approval_required");
    assert.equal(await r({ price: 250 }), "denied");
    assert.equal(await r({}), "denied");
  });

  it("personal data needs purpose and consent; sensitive needs specific consent; revoking is immediate", async () => {
    const { engine, spec } = setup();
    await engine.grants.grant(spec(), "u1");
    const withData = async (cats: string[], purpose?: string) => (await engine.authorize(req({ dataCategories: cats, ...(purpose ? { purpose } : {}) }))).outcome;
    assert.equal(await withData(["contacts"]), "denied");
    assert.equal(await withData(["contacts"], "agenda"), "denied");
    await engine.consent.give("u1", "agenda", "contacts");
    assert.equal(await withData(["contacts"], "agenda"), "allowed");
    await engine.consent.give("u1", "agenda", "health");
    assert.equal(await withData(["health"], "agenda"), "denied");
    await engine.consent.give("u1", "agenda", "health", { specific: true });
    assert.equal(await withData(["health"], "agenda"), "allowed");
    await engine.consent.revoke("u1", "agenda", "contacts");
    assert.equal(await withData(["contacts"], "agenda"), "denied");
  });

  it("a user deny policy beats the grant's autonomy", async () => {
    const clock = new ManualClock(T0);
    const engine = new EthicsEngine({
      clock,
      policiesFor: () => [
        { id: "never-delete", effect: "deny", systemId: null, toolPattern: "calendar.delete_*", principalId: "*", riskLevels: null, eventTypes: null, entityTypes: null, roles: null, contextMatch: null, amountField: null, amountAbove: null, expiresAt: null, active: true },
      ],
    });
    await engine.grants.grant(
      { userId: "u1", agentId: "obedient", systemId: "calendar", capability: "calendar.*", purpose: "gerir agenda", limits: { maxRisk: "HIGH", autonomousUpTo: "MEDIUM", maxAmount: null, amountField: null }, expiresAt: new Date(T0.getTime() + HOUR) },
      "u1",
    );
    const r = await engine.authorize(req({ tool: "calendar.delete_event" }));
    assert.equal(r.outcome, "denied");
  });

  it("agent cannot impersonate the user; an exception inside evaluation denies", async () => {
    const { engine, spec } = setup();
    await engine.grants.grant(spec(), "u1");
    assert.equal((await engine.authorize(req({ agentId: "u1" }))).outcome, "denied");
    // Payload que não se hasheia (número não finito) não derruba o processo: a avaliação segue
    // e o registro marca o hash como "unhashable".
    const r = await engine.authorize(req({ args: { n: Number.NaN } }));
    assert.ok(r.outcome === "allowed" || r.outcome === "denied");
    assert.equal((await engine.audit.forUser("u1")).at(-1)?.inputHash, "unhashable");
  });
});

describe("approval gateway (Art. 1º e 12)", () => {
  it("full cycle: propose → approve with shown hash → execute once", async () => {
    const { engine, spec } = setup();
    await engine.grants.grant(spec(), "u1");
    const a = await engine.authorize(req({ risk: "HIGH" }));
    assert.equal(a.outcome, "approval_required");
    if (a.outcome !== "approval_required") return;
    const { proposal } = a;
    assert.match(proposal.summary, /calendar\.calendar\.create_event\(at=/);

    await assert.rejects(() => engine.approve(proposal.id, { id: "obedient", kind: "agent", strongAuth: true }, proposal.payloadHash), /só pessoa/);
    await assert.rejects(() => engine.approve(proposal.id, { id: "u2", kind: "user", strongAuth: true }, proposal.payloadHash), /dono/);
    await assert.rejects(() => engine.approve(proposal.id, { id: "u1", kind: "user", strongAuth: false }, "0".repeat(64)), /payload mudou/);

    await engine.approve(proposal.id, { id: "u1", kind: "user", strongAuth: false }, proposal.payloadHash);
    let runs = 0;
    const out = await engine.executeApproved(proposal.id, proposal.payloadHash, async (p) => {
      runs++;
      return p.args.title;
    });
    assert.equal(out, "Dentista");
    await assert.rejects(engine.executeApproved(proposal.id, proposal.payloadHash, async () => runs++), /já executada/);
    assert.equal(runs, 1);
  });

  it("CRITICAL needs strong auth; proposals expire", async () => {
    const { engine, spec, clock } = setup();
    await engine.grants.grant(spec({ limits: { maxRisk: "CRITICAL", autonomousUpTo: "MEDIUM", maxAmount: null, amountField: null } }), "u1");
    const a = await engine.authorize(req({ risk: "CRITICAL" }));
    assert.equal(a.outcome, "approval_required");
    if (a.outcome !== "approval_required") return;
    assert.equal(a.proposal.approver, "user_strong_auth");
    await assert.rejects(() => engine.approve(a.proposal.id, { id: "u1", kind: "user", strongAuth: false }, a.proposal.payloadHash), /reautenticação/);
    clock.advance(31 * 60 * 1000);
    await assert.rejects(() => engine.approve(a.proposal.id, { id: "u1", kind: "user", strongAuth: true }, a.proposal.payloadHash), /vencida/);
  });

  it("revoking the grant after approval still blocks execution (Art. 2º)", async () => {
    const { engine, spec } = setup();
    const g = await engine.grants.grant(spec(), "u1");
    const a = await engine.authorize(req({ risk: "HIGH" }));
    if (a.outcome !== "approval_required") throw new Error("esperava aprovação");
    await engine.approve(a.proposal.id, { id: "u1", kind: "user", strongAuth: false }, a.proposal.payloadHash);
    await engine.grants.revoke(g.id, "u1");
    await assert.rejects(engine.executeApproved(a.proposal.id, a.proposal.payloadHash, async () => "x"), /revogado/);
  });
});

describe("emergency stop (Art. 9º)", () => {
  it("blocks the next call, cancels pending proposals, and only the user releases", async () => {
    const { engine, spec } = setup();
    await engine.grants.grant(spec(), "u1");
    const a = await engine.authorize(req({ risk: "HIGH" }));
    assert.equal(a.outcome, "approval_required");
    await engine.stop.engage({ kind: "user", userId: "u1" }, "u1", "o usuário apertou parar");
    assert.equal((await engine.authorize(req())).outcome, "denied");
    assert.equal((await engine.approvals.pending("u1")).length, 0);
    await assert.rejects(() => engine.stop.release({ kind: "user", userId: "u1" }, "obedient", "agent"), /agente não libera/);
    await assert.rejects(() => engine.stop.release({ kind: "user", userId: "u1" }, "u2", "user"), /próprio usuário/);
    await engine.stop.release({ kind: "user", userId: "u1" }, "u1", "user");
    assert.equal((await engine.authorize(req())).outcome, "allowed");
  });

  it("global stop blocks everyone and only an operator releases it", async () => {
    const { engine, spec } = setup();
    await engine.grants.grant(spec(), "u1");
    await engine.stop.engage({ kind: "global" }, "monitor", "incidente");
    assert.equal((await engine.authorize(req())).outcome, "denied");
    await assert.rejects(() => engine.stop.release({ kind: "global" }, "u1", "user"), /operador/);
    await engine.stop.release({ kind: "global" }, "op-1", "operator");
    assert.equal((await engine.authorize(req())).outcome, "allowed");
  });
});

describe("audit trail (Art. 8º)", () => {
  it("every decision is recorded, chained, and tampering is detected", async () => {
    const { engine, spec, sink } = setup();
    await engine.authorize(req());
    await engine.grants.grant(spec(), "u1");
    await engine.authorize(req());
    await engine.authorize(req({ risk: "HIGH" }));
    const entries = await engine.audit.forUser("u1");
    assert.deepEqual(entries.map((e) => e.outcome), ["denied", "allowed", "approval_required"]);
    assert.deepEqual(entries.map((e) => e.seq), [1, 2, 3]);
    assert.ok(entries.every((e) => e.constitutionVersion === "0.1.0-draft"));
    assert.equal(await engine.audit.verify("u1"), true);
    // entradas são congeladas: tentar mudar lança em strict mode
    const first = (await sink.entries("u1"))[0];
    assert.throws(() => {
      (first as { outcome: string }).outcome = "allowed";
    });
    // adulteração por fora do objeto congelado (substituição da linha) quebra a cadeia
    const rows = (await sink.entries("u1")) as unknown as Array<Record<string, unknown>>;
    rows[1] = { ...rows[1], tool: "calendar.delete_everything" };
    await assert.rejects(() => engine.audit.verify("u1"), /cadeia quebrada na entrada 2/);
  });

  it("each user has their own chain; one user's entries never enter another's", async () => {
    const { engine, sink } = setup();
    await engine.authorize(req());
    await engine.authorize(req({ userId: "u2" }));
    await engine.authorize(req());
    assert.deepEqual((await engine.audit.forUser("u1")).map((e) => e.seq), [1, 2]);
    assert.deepEqual((await engine.audit.forUser("u2")).map((e) => [e.seq, e.userId]), [[1, "u2"]]);
    assert.equal(await engine.audit.verify("u2"), true);
    assert.equal(sink.all().length, 3);
  });

  it("concurrent records on the same user keep a valid chain", async () => {
    const { engine } = setup();
    await Promise.all(Array.from({ length: 20 }, () => engine.authorize(req())));
    const entries = await engine.audit.forUser("u1");
    assert.equal(entries.length, 20);
    assert.equal(await engine.audit.verify("u1"), true);
  });
});

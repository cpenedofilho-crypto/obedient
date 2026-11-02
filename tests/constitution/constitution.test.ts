// SPDX-License-Identifier: AGPL-3.0-only
//
// Suíte constitucional. Cada `it` cita o artigo cuja REGRA VERIFICÁVEL ele confere
// (CONSTITUTION.md, coluna "Regra verificável"). Artigo com regra nova = teste novo aqui.
// É também a base do programa "OBEDIENT Compatible" (TRADEMARKS.md): um fork que passa nesta
// suíte pode dizer que aplica a Constituição.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ManualClock } from "@obedient/core";
import { CONSTITUTION_VERSION, ENFORCED_ARTICLES, EthicsEngine, type GrantSpec } from "@obedient/ethics-engine";

const T0 = new Date("2026-11-02T12:00:00Z");
const H = 3_600_000;

function world() {
  const clock = new ManualClock(T0);
  const engine = new EthicsEngine({ clock });
  const grant = (extra: Partial<GrantSpec> = {}) =>
    engine.grants.grant(
      {
        userId: "ana",
        agentId: "obedient",
        systemId: "mail",
        capability: "mail.*",
        purpose: "responder e-mails de trabalho",
        limits: { maxRisk: "HIGH", autonomousUpTo: "LOW", maxAmount: null, amountField: null },
        expiresAt: new Date(T0.getTime() + 8 * H),
        ...extra,
      },
      "ana",
    );
  const ask = (tool: string, risk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL", category = "WRITE", extra: Record<string, unknown> = {}) =>
    engine.authorize({ userId: "ana", agentId: "obedient", systemId: "mail", tool, risk, category, args: { to: "x@example.org" }, ...extra });
  return { clock, engine, grant, ask };
}

describe(`Constituição ${CONSTITUTION_VERSION}`, () => {
  it("o código e o texto estão na mesma versão (Art. 14)", () => {
    const text = readFileSync(new URL("../../CONSTITUTION.md", import.meta.url), "utf8");
    assert.match(text, new RegExp(`Versão: ${CONSTITUTION_VERSION.replace(/\./g, "\\.")}`));
    for (const art of Object.keys(ENFORCED_ARTICLES)) assert.ok(art.startsWith("art"));
  });

  it("Art. 1º — ação HIGH ou acima nunca executa sozinha, mesmo com grant", () => {
    const { grant, ask } = world();
    grant({ limits: { maxRisk: "CRITICAL", autonomousUpTo: "MEDIUM", maxAmount: null, amountField: null } });
    assert.equal(ask("mail.send", "HIGH", "COMMUNICATION").outcome, "approval_required");
    assert.equal(ask("mail.send", "CRITICAL", "COMMUNICATION").outcome, "approval_required");
  });

  it("Art. 2º — revogação vale na próxima chamada", () => {
    const { engine, grant, ask } = world();
    const g = grant();
    assert.equal(ask("mail.list", "LOW", "READ").outcome, "allowed");
    engine.grants.revoke(g.id, "ana");
    assert.equal(ask("mail.list", "LOW", "READ").outcome, "denied");
  });

  it("Art. 3º — sem grant não há ação; grant curinga, sem prazo ou sem finalidade não existe", () => {
    const { grant, ask } = world();
    assert.equal(ask("mail.list", "LOW", "READ").outcome, "denied");
    assert.throws(() => grant({ capability: "*" }));
    assert.throws(() => grant({ purpose: "" }));
    assert.throws(() => grant({ expiresAt: new Date(T0.getTime() - 1) }));
  });

  it("Art. 3º — vencido o prazo, a autoridade acaba", () => {
    const { clock, grant, ask } = world();
    grant();
    clock.advance(9 * H);
    assert.equal(ask("mail.list", "LOW", "READ").outcome, "denied");
  });

  it("Art. 4º — dado pessoal só com consentimento para a finalidade", () => {
    const { engine, grant, ask } = world();
    grant();
    const r = () => ask("mail.list", "LOW", "READ", { dataCategories: ["contacts"], purpose: "responder e-mails" }).outcome;
    assert.equal(r(), "denied");
    engine.consent.give("ana", "responder e-mails", "contacts");
    assert.equal(r(), "allowed");
  });

  it("Art. 6º — categoria financeira, jurídica ou destrutiva nunca é tratada como risco baixo", () => {
    const { grant, ask } = world();
    grant({ limits: { maxRisk: "CRITICAL", autonomousUpTo: "MEDIUM", maxAmount: null, amountField: null } });
    for (const c of ["FINANCIAL", "LEGAL", "DESTRUCTIVE"]) {
      const a = ask("mail.delete_all", "LOW", c);
      assert.equal(a.outcome, "approval_required", c);
      if (a.outcome === "approval_required") assert.equal(a.proposal.approver, "user_strong_auth");
    }
  });

  it("Art. 8º — toda decisão fica registrada, com a versão da Constituição, numa cadeia verificável", () => {
    const { engine, grant, ask } = world();
    ask("mail.list", "LOW", "READ");
    grant();
    ask("mail.list", "LOW", "READ");
    ask("mail.send", "HIGH", "COMMUNICATION");
    assert.equal(engine.audit.all().length, 3);
    assert.ok(engine.audit.all().every((e) => e.constitutionVersion === CONSTITUTION_VERSION));
    assert.equal(engine.audit.verify(), true);
  });

  it("Art. 9º — parar é imediato e o agente não se libera", async () => {
    const { engine, grant, ask } = world();
    grant();
    await engine.stop.engage({ kind: "user", userId: "ana" }, "ana", "parar");
    assert.equal(ask("mail.list", "LOW", "READ").outcome, "denied");
    assert.throws(() => engine.stop.release({ kind: "user", userId: "ana" }, "obedient", "agent"));
  });

  it("Art. 12 — quem pede não aprova, e agente não aprova", () => {
    const { engine, grant, ask } = world();
    grant();
    const a = ask("mail.send", "HIGH", "COMMUNICATION");
    if (a.outcome !== "approval_required") throw new Error("esperava aprovação");
    assert.throws(() => engine.approve(a.proposal.id, { id: "obedient", kind: "agent", strongAuth: true }, a.proposal.payloadHash));
    assert.throws(() => engine.approve(a.proposal.id, { id: "agent:obedient", kind: "user", strongAuth: true }, a.proposal.payloadHash));
    assert.equal(engine.approve(a.proposal.id, { id: "ana", kind: "user", strongAuth: false }, a.proposal.payloadHash).status, "approved");
  });

  it("Art. 12 — subagente nunca recebe mais autoridade que quem delegou", () => {
    const { engine, grant } = world();
    const g = grant();
    assert.throws(() =>
      engine.grants.delegate(
        g.id,
        { agentId: "dots", systemId: "mail", capability: "mail.*", purpose: "ajudar a responder", limits: { maxRisk: "CRITICAL", autonomousUpTo: null, maxAmount: null, amountField: null }, expiresAt: new Date(T0.getTime() + H) },
        "obedient",
      ),
    );
  });
});

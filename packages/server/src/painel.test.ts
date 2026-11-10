// SPDX-License-Identifier: AGPL-3.0-only
//
// A tela fala português direto. Os motivos vêm do motor de políticas (inglês, porque é API) e são
// traduzidos aqui; este teste gera os motivos REAIS com decide() em todas as formas, para que um
// texto novo no motor não chegue cru à pessoa.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { type Action, type Policy, SYSTEM_DEFAULTS, decide, validateDefaults } from "@obedient/policy-engine";
import type { Proposal } from "@obedient/ethics-engine";
import { cartao, escopoParaPessoa, motivoParaPessoa, riscoEmPortugues } from "./painel.ts";

const INGLES = /\b(policy|risk|default|requires?|approval|privileged|allows?|blocks?|category|counts|amount|above|fixed rule)\b/i;
const agora = new Date("2026-11-03T12:00:00Z");

const acao = (risk: Action["risk"], category?: string, args: Record<string, unknown> = {}): Action => ({
  systemId: "email",
  tool: "email.enviar",
  risk,
  ...(category ? { category } : {}),
  principal: { kind: "agent", id: "obedient", role: null },
  args,
  context: {},
});
const politica = (effect: Policy["effect"], extra: Partial<Policy> = {}): Policy => ({
  id: `p-${effect}`,
  effect,
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

describe("painel em português", () => {
  it("todo motivo que o motor de políticas produz sai traduzido", () => {
    const casos: [Action, Policy[], ReturnType<typeof validateDefaults>][] = [];
    for (const r of ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const) casos.push([acao(r), [], SYSTEM_DEFAULTS]);
    for (const c of ["FINANCIAL", "LEGAL", "DESTRUCTIVE"]) casos.push([acao("LOW", c), [politica("allow_autonomous")], SYSTEM_DEFAULTS]);
    casos.push([acao("CRITICAL"), [politica("allow_autonomous")], SYSTEM_DEFAULTS]);
    casos.push([acao("LOW"), [politica("deny")], SYSTEM_DEFAULTS]);
    casos.push([acao("LOW"), [politica("allow_autonomous")], SYSTEM_DEFAULTS]);
    casos.push([acao("LOW"), [politica("require_approval")], SYSTEM_DEFAULTS]);
    casos.push([acao("LOW"), [politica("require_privileged_approval")], SYSTEM_DEFAULTS]);
    casos.push([acao("LOW", undefined, { valor: 900 }), [politica("require_approval", { amountField: "valor", amountAbove: 500 })], SYSTEM_DEFAULTS]);
    casos.push([acao("MEDIUM"), [], validateDefaults({ MEDIUM: "deny" })]);
    casos.push([acao("HIGH"), [], validateDefaults({ HIGH: "allow" })]);
    const vistos = new Set<string>();
    for (const [a, ps, d] of casos) {
      const motivo = decide(a, ps, d, agora).reason;
      const texto = motivoParaPessoa(motivo);
      vistos.add(motivo.split(" ")[0]!);
      assert.doesNotMatch(texto, INGLES, `${motivo} → ${texto}`);
      assert.ok(texto.length > 10);
    }
    assert.deepEqual([...vistos].sort(), ["category", "policy", "risk"]);
    assert.equal(
      motivoParaPessoa(decide(acao("LOW", undefined, { valor: 900 }), [politica("require_approval", { amountField: "valor", amountAbove: 500 })], SYSTEM_DEFAULTS, agora).reason),
      "Uma regra sua (p-require_approval) pede a sua aprovação, porque o valor em valor passa de 500.",
    );
  });

  it("motivo que já vem em português passa como está", () => {
    assert.equal(motivoParaPessoa("nenhum grant vigente cobre esta ferramenta (Art. 3º)"), "nenhum grant vigente cobre esta ferramenta (Art. 3º)");
  });

  it("risco e escopo como a pessoa lê", () => {
    assert.deepEqual(["LOW", "MEDIUM", "HIGH", "CRITICAL"].map(riscoEmPortugues), ["baixo", "médio", "alto", "crítico"]);
    assert.equal(escopoParaPessoa("email.*", "email"), "qualquer ação em email");
    assert.equal(escopoParaPessoa("agenda.ler_*", "agenda"), "as ações que começam com agenda.ler_ em agenda");
    assert.equal(escopoParaPessoa("email.enviar", null), "email.enviar");
  });
});

describe("cartão de aprovação", () => {
  const proposta = (args: Record<string, unknown>): Proposal => ({
    id: "p1",
    userId: "ana",
    requestedBy: "agent:obedient",
    payload: { systemId: "google_gmail", tool: "google_gmail.enviar_mensagem", args },
    payloadHash: "h".repeat(64),
    summary: "",
    approver: "user",
    reason: "risk HIGH: default is require_approval",
    grantId: "g1",
    createdAt: new Date("2026-11-09T12:00:00Z"),
    expiresAt: new Date("2026-11-09T12:30:00Z"),
    status: "pending",
    decidedBy: null,
    decidedAt: null,
    executedAt: null,
  });

  it("mostra o payload inteiro: destinatário comprido com o domínio à parte, corpo inteiro, todos os campos", () => {
    const para = "contabilidade.escritorio-silva.com.br.financeiro.relatorios-mensais.2026@atacante.example";
    const texto = `Oi, segue a confirmação. ${"Dados pessoais da Ana: … ".repeat(40)}FIM`;
    const args: Record<string, unknown> = { para, assunto: "Confirmação", texto, identificacao: "Enviada pelo assistente da Ana" };
    for (let i = 0; i < 10; i++) args[`extra${i}`] = i;
    const c = cartao(proposta(args));
    assert.equal(c.detalhes.length, 14, "todos os campos, não só os 8 primeiros");
    const campo = (k: string) => c.detalhes.find((d) => d.campo === k)!;
    assert.equal(campo("para").valor, para, "o endereço inteiro");
    assert.equal(campo("para").dominio, "atacante.example", "o domínio de verdade, em destaque");
    assert.equal(campo("texto").valor, texto, "o corpo inteiro, até o FIM");
    assert.equal(campo("assunto").dominio, undefined);
  });

  it("objeto aninhado aparece inteiro, formatado", () => {
    const c = cartao(proposta({ opcoes: { a: 1, b: "x".repeat(200) } }));
    assert.ok(c.detalhes[0]!.valor.includes("x".repeat(200)));
  });
});

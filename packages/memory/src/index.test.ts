// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ManualClock } from "@obedient/core";
import { AuditTrail, ConsentManager, InMemoryAuditSink } from "@obedient/ethics-engine";
import { FINALIDADE_TREINO_TERCEIRO, InMemoryMemoryStore, Memoria } from "./index.ts";

function setup() {
  const clock = new ManualClock(new Date("2026-11-03T12:00:00Z"));
  const consent = new ConsentManager(clock);
  const sink = new InMemoryAuditSink();
  const memoria = new Memoria(new InMemoryMemoryStore(), consent, new AuditTrail(sink, clock), clock);
  return { memoria, consent, sink };
}
const codigo = (e: unknown) => (e as { code?: string }).code;

describe("memória (Art. 10)", () => {
  it("sem a categoria ligada, o agente não guarda nada; ligada, guarda", async () => {
    const { memoria } = setup();
    await assert.rejects(memoria.lembrar("ana", "obedient", "preferencias", "prefere reunião de manhã"), (e) => codigo(e) === "CONSENT_REQUIRED");
    assert.deepEqual(await memoria.listar("ana"), []);
    await memoria.ligar("ana", "preferencias");
    const l = await memoria.lembrar("ana", "obedient", "preferencias", "  prefere   reunião de manhã ");
    assert.equal(l.texto, "prefere reunião de manhã");
    assert.equal((await memoria.listar("ana")).length, 1);
  });

  it("categoria sensível só com consentimento específico", async () => {
    const { memoria } = setup();
    await assert.rejects(memoria.ligar("ana", "health"), /específico/);
    await memoria.ligar("ana", "health", { especifico: true });
    assert.equal((await memoria.lembrar("ana", "obedient", "health", "tem consulta toda terça")).categoria, "health");
  });

  it("desligar apaga o que foi aprendido na categoria e só nela", async () => {
    const { memoria } = setup();
    await memoria.ligar("ana", "preferencias");
    await memoria.ligar("ana", "agenda");
    await memoria.lembrar("ana", "obedient", "preferencias", "gosta de resumo curto");
    await memoria.lembrar("ana", "obedient", "agenda", "academia às 7h");
    assert.equal(await memoria.desligar("ana", "preferencias"), 1);
    assert.deepEqual((await memoria.listar("ana")).map((l) => l.categoria), ["agenda"]);
    await assert.rejects(memoria.lembrar("ana", "obedient", "preferencias", "outra coisa"), (e) => codigo(e) === "CONSENT_REQUIRED");
  });

  it("toda lição pode ser vista e apagada; esquecer tudo desliga as categorias", async () => {
    const { memoria } = setup();
    await memoria.ligar("ana", "trabalho");
    const l = await memoria.lembrar("ana", "obedient", "trabalho", "o projeto se chama Taberna Ipê");
    assert.equal(await memoria.esquecer("ana", l.id), true);
    assert.equal(await memoria.esquecer("ana", l.id), false);
    await memoria.lembrar("ana", "obedient", "trabalho", "reunião semanal na segunda");
    assert.equal(await memoria.esquecerTudo("ana"), 1);
    assert.equal((await memoria.categorias("ana")).some((c) => c.ligada), false);
  });

  it("uma pessoa não apaga nem vê a memória de outra", async () => {
    const { memoria } = setup();
    await memoria.ligar("ana", "trabalho");
    const l = await memoria.lembrar("ana", "obedient", "trabalho", "cliente principal é a Casa Bertoldi");
    assert.equal(await memoria.esquecer("bia", l.id), false);
    assert.deepEqual(await memoria.listar("bia"), []);
    assert.equal((await memoria.listar("ana")).length, 1);
  });

  it("o contexto do agente só leva categorias ligadas", async () => {
    const { memoria, consent } = setup();
    await memoria.ligar("ana", "agenda");
    await memoria.lembrar("ana", "obedient", "agenda", "academia às 7h");
    // Revogação feita direto no consentimento (sem passar por desligar): a lição fica, mas não vai ao agente.
    await consent.revoke("ana", "aprendizado", "agenda");
    assert.deepEqual(await memoria.paraContexto("ana"), []);
  });

  it("ligar o aprendizado NÃO autoriza treinar modelo de terceiro", async () => {
    const { memoria, consent } = setup();
    for (const c of ["preferencias", "agenda", "contacts", "trabalho", "financas"]) await memoria.ligar("ana", c);
    assert.equal(await memoria.podeTreinarModeloDeTerceiro("ana"), false);
    await consent.give("ana", FINALIDADE_TREINO_TERCEIRO, "memoria");
    assert.equal(await memoria.podeTreinarModeloDeTerceiro("ana"), true);
  });

  it("a trilha registra categoria e agente, nunca o texto da lição", async () => {
    const { memoria, sink } = setup();
    await memoria.ligar("ana", "contacts");
    await memoria.lembrar("ana", "obedient", "contacts", "a irmã se chama Marta Souza");
    await assert.rejects(memoria.lembrar("ana", "obedient", "financas", "salário de 9 mil"));
    const trilha = JSON.stringify(sink.all());
    assert.doesNotMatch(trilha, /Marta|9 mil/);
    assert.deepEqual(
      sink.all().map((e) => [e.event, e.outcome]),
      [
        ["memory.opt_in", "info"],
        ["memory.learn", "info"],
        ["memory.learn", "denied"],
      ],
    );
  });

  it("entrada inválida é recusada", async () => {
    const { memoria } = setup();
    await memoria.ligar("ana", "agenda");
    await assert.rejects(memoria.lembrar("ana", "obedient", "astrologia", "x"), (e) => codigo(e) === "INVALID_PAYLOAD");
    await assert.rejects(memoria.lembrar("ana", "obedient", "agenda", "   "), (e) => codigo(e) === "INVALID_PAYLOAD");
    await assert.rejects(memoria.lembrar("ana", "obedient", "agenda", "x".repeat(501)), (e) => codigo(e) === "INVALID_PAYLOAD");
    await assert.rejects(memoria.lembrar("ana", "ana", "agenda", "eu mesma"), (e) => codigo(e) === "INVALID_PAYLOAD");
  });
});

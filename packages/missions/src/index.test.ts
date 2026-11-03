// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ManualClock } from "@obedient/core";
import { AuditTrail, EthicsEngine, InMemoryAuditSink } from "@obedient/ethics-engine";
import { type Executor, InMemoryMissionStore, Missoes, type ResultadoTentativa, intervaloDepois } from "./index.ts";

const T0 = new Date("2026-11-03T12:00:00Z");

function setup() {
  const clock = new ManualClock(T0);
  const sink = new InMemoryAuditSink();
  const motor = new EthicsEngine({ clock, audit: new AuditTrail(sink, clock) });
  const missoes = new Missoes(new InMemoryMissionStore(), motor, clock);
  return { clock, motor, missoes, sink };
}

/** Executor roteirizado: devolve os resultados na ordem e conta as chamadas. */
function roteiro(...rs: (ResultadoTentativa | Error)[]) {
  let i = 0;
  const exec: Executor & { chamadas: number } = Object.assign(
    async () => {
      exec.chamadas++;
      const r = rs[Math.min(i++, rs.length - 1)]!;
      if (r instanceof Error) throw r;
      return r;
    },
    { chamadas: 0 },
  );
  return exec;
}
const falha = (custoCentavos = 10): ResultadoTentativa => ({ tipo: "falha_temporaria", erro: "serviço fora do ar", custoCentavos });
const codigo = (e: unknown) => (e as { code?: string }).code;

describe("missões: persistência responsável (Art. 7º)", () => {
  it("intervalo crescente: 30 s, 1 min, 2 min, … até 1 h", () => {
    assert.deepEqual([1, 2, 3, 4, 8, 20].map(intervaloDepois), [30_000, 60_000, 120_000, 240_000, 3_600_000, 3_600_000]);
  });

  it("tenta de novo só depois do intervalo e para no teto, virando impedimento explicado", async () => {
    const { clock, missoes } = setup();
    const m = await missoes.criar("ana", "obedient", "Confirmar a reserva de quinta", { maxTentativas: 3 });
    const exec = roteiro(falha(), falha(), falha(), falha());
    await missoes.avancar(m.id, exec);
    assert.equal(exec.chamadas, 1);
    await missoes.avancar(m.id, exec); // ainda dentro do intervalo
    assert.equal(exec.chamadas, 1, "não tenta antes da hora");
    clock.advance(30_000);
    await missoes.avancar(m.id, exec);
    clock.advance(59_000);
    await missoes.avancar(m.id, exec);
    assert.equal(exec.chamadas, 2, "o segundo intervalo é maior");
    clock.advance(1_000);
    const fim = await missoes.avancar(m.id, exec);
    assert.equal(exec.chamadas, 3);
    assert.equal(fim.estado, "blocked");
    assert.match(fim.impedimento!, /Tentou 3 vez\(es\) e não conseguiu\. Último erro: serviço fora do ar/);
    clock.advance(10 * 3_600_000);
    await missoes.avancar(m.id, exec);
    assert.equal(exec.chamadas, 3, "impedida, não tenta mais sozinha (nada de laço)");
  });

  it("exceção do executor conta como falha temporária", async () => {
    const { missoes } = setup();
    const m = await missoes.criar("ana", "obedient", "x", { maxTentativas: 1 });
    const fim = await missoes.avancar(m.id, roteiro(new Error("timeout do modelo")));
    assert.equal(fim.estado, "blocked");
    assert.match(fim.impedimento!, /timeout do modelo/);
  });

  it("teto de custo: conferido antes e depois de cada tentativa", async () => {
    const { clock, missoes } = setup();
    const m = await missoes.criar("ana", "obedient", "Pesquisar fornecedores", { tetoCustoCentavos: 100, maxTentativas: 5 });
    const exec = roteiro(falha(60), falha(60), falha(60));
    await missoes.avancar(m.id, exec);
    clock.advance(30_000);
    const fim = await missoes.avancar(m.id, exec);
    assert.equal(fim.estado, "blocked");
    assert.equal(fim.custoCentavos, 120);
    assert.match(fim.impedimento!, /teto de custo \(R\$\s?1,00\)/);
    assert.equal(exec.chamadas, 2);
  });

  it("tentar de novo: zera as tentativas; com o teto estourado, só aumentando o teto", async () => {
    const { missoes } = setup();
    const m = await missoes.criar("ana", "obedient", "x", { tetoCustoCentavos: 50, maxTentativas: 1 });
    await missoes.avancar(m.id, roteiro(falha(80)));
    await assert.rejects(missoes.tentarDeNovo("ana", m.id), /aumente o teto/);
    await assert.rejects(missoes.tentarDeNovo("ana", m.id, { novoTetoCentavos: 40 }), (e) => codigo(e) === "INVALID_PAYLOAD");
    await assert.rejects(missoes.tentarDeNovo("bia", m.id, { novoTetoCentavos: 200 }), (e) => codigo(e) === "PROPOSAL_NOT_FOUND");
    const de_novo = await missoes.tentarDeNovo("ana", m.id, { novoTetoCentavos: 200 });
    assert.deepEqual([de_novo.estado, de_novo.tentativas, de_novo.tetoCustoCentavos], ["running", 0, 200]);
    const fim = await missoes.avancar(m.id, roteiro({ tipo: "feito", explicacao: "pronto", custoCentavos: 30 }));
    assert.equal(fim.estado, "completed");
  });

  it("limites na criação: objetivo, teto e tentativas", async () => {
    const { missoes } = setup();
    for (const [obj, o] of [
      ["", {}],
      ["x".repeat(2001), {}],
      ["ok", { tetoCustoCentavos: 0 }],
      ["ok", { tetoCustoCentavos: 10_001 }],
      ["ok", { maxTentativas: 6 }],
      ["ok", { maxTentativas: 0 }],
    ] as const)
      await assert.rejects(missoes.criar("ana", "obedient", obj, o), (e) => codigo(e) === "INVALID_PAYLOAD", JSON.stringify(o));
    await assert.rejects(missoes.criar("ana", "ana", "ok"), (e) => codigo(e) === "INVALID_PAYLOAD");
  });
});

describe("missões: honestidade (Art. 5º)", () => {
  it("'não sei' e 'não consegui' são desfechos, com a explicação guardada na missão", async () => {
    const { missoes, sink } = setup();
    const a = await missoes.criar("ana", "obedient", "Qual o horário do dentista?");
    const fa = await missoes.avancar(a.id, roteiro({ tipo: "nao_sei", explicacao: "Não achei o horário na agenda nem nos e-mails.", custoCentavos: 5 }));
    assert.deepEqual([fa.estado, fa.desfecho?.tipo], ["completed", "nao_sei"]);
    const b = await missoes.criar("ana", "obedient", "Pagar a conta de luz");
    const fb = await missoes.avancar(b.id, roteiro({ tipo: "nao_consegui", explicacao: "O site do banco pediu um código que só você recebe.", custoCentavos: 5 }));
    assert.deepEqual([fb.estado, fb.desfecho?.tipo], ["failed", "nao_consegui"]);
    const eventos = sink.all().map((e) => e.event);
    assert.ok(eventos.includes("mission.nao_sei") && eventos.includes("mission.nao_consegui"));
    // A explicação pode ter conteúdo da pessoa: fica na missão, não na trilha.
    assert.doesNotMatch(JSON.stringify(sink.all()), /dentista|banco pediu/);
  });
});

describe("missões: aprovação e parada", () => {
  it("espera a aprovação; aprovada, segue; recusada, vira impedimento", async () => {
    const { motor, missoes } = setup();
    await motor.grants.grant(
      { userId: "ana", agentId: "obedient", systemId: "email", capability: "email.*", purpose: "responder e-mails", limits: { maxRisk: "HIGH", autonomousUpTo: "LOW", maxAmount: null, amountField: null }, expiresAt: new Date(T0.getTime() + 3_600_000) },
      "ana",
    );
    const pedir = async () => {
      const a = await motor.authorize({ userId: "ana", agentId: "obedient", systemId: "email", tool: "email.enviar", risk: "HIGH", category: "WRITE", args: { para: "x@exemplo.org" } });
      if (a.outcome !== "approval_required") throw new Error("esperava pedido");
      return a.proposal;
    };
    const p1 = await pedir();
    const m = await missoes.criar("ana", "obedient", "Mandar o resumo");
    const exec = roteiro({ tipo: "aguardando_aprovacao", propostaId: p1.id, custoCentavos: 5 }, { tipo: "feito", explicacao: "enviado", custoCentavos: 5 });
    assert.equal((await missoes.avancar(m.id, exec)).estado, "waiting_approval");
    assert.equal((await missoes.avancar(m.id, exec)).estado, "waiting_approval", "a pessoa ainda não decidiu");
    await motor.approve(p1.id, { id: "ana", kind: "user", strongAuth: false }, p1.payloadHash);
    assert.equal((await missoes.avancar(m.id, exec)).estado, "completed");

    const p2 = await pedir();
    const m2 = await missoes.criar("ana", "obedient", "Mandar outro");
    await missoes.avancar(m2.id, roteiro({ tipo: "aguardando_aprovacao", propostaId: p2.id, custoCentavos: 5 }));
    await motor.reject(p2.id, { id: "ana", kind: "user", strongAuth: false });
    const fim = await missoes.avancar(m2.id, roteiro(falha()));
    assert.equal(fim.estado, "blocked");
    assert.match(fim.impedimento!, /Você recusou o pedido/);
  });

  it("parada de emergência cancela as missões abertas e nenhuma tentativa começa", async () => {
    const { motor, missoes } = setup();
    const a = await missoes.criar("ana", "obedient", "a");
    const b = await missoes.criar("ana", "obedient", "b", { maxTentativas: 1 });
    await missoes.avancar(b.id, roteiro(falha())); // b fica impedida
    const outra = await missoes.criar("bia", "obedient", "c");
    await motor.stop.engage({ kind: "user", userId: "ana" }, "ana", "parar tudo");
    assert.equal((await missoes.get(a.id))?.estado, "cancelled");
    assert.equal((await missoes.get(b.id))?.estado, "cancelled");
    assert.equal((await missoes.get(outra.id))?.estado, "running", "a parada da Ana não mexe na Bia");
    const exec = roteiro({ tipo: "feito", explicacao: "x", custoCentavos: 1 });
    const nova = await missoes.criar("ana", "obedient", "depois da parada");
    assert.equal((await missoes.avancar(nova.id, exec)).estado, "cancelled");
    assert.equal(exec.chamadas, 0);
  });

  it("a pessoa cancela; o que terminou não se cancela; uma pessoa não mexe na missão de outra", async () => {
    const { missoes } = setup();
    const m = await missoes.criar("ana", "obedient", "x");
    await assert.rejects(missoes.cancelarPelaPessoa("bia", m.id), (e) => codigo(e) === "PROPOSAL_NOT_FOUND");
    assert.equal((await missoes.cancelarPelaPessoa("ana", m.id)).estado, "cancelled");
    await assert.rejects(missoes.cancelarPelaPessoa("ana", m.id), (e) => codigo(e) === "PROPOSAL_NOT_PENDING");
  });

  it("cancelada no meio da tentativa: o resultado que chega depois é descartado e registrado", async () => {
    const { missoes, sink } = setup();
    const m = await missoes.criar("ana", "obedient", "x");
    const r = await missoes.reservar(m.id);
    assert.equal(r.reservada, true);
    await missoes.cancelarPelaPessoa("ana", m.id);
    const fim = await missoes.concluir(r.missao, { tipo: "feito", explicacao: "mandei o e-mail", custoCentavos: 3 });
    assert.equal(fim.estado, "cancelled");
    assert.equal(fim.desfecho, null);
    assert.equal(sink.all().at(-1)?.event, "mission.result_discarded");
  });

  it("a tentativa é reservada antes de executar: duas chamadas ao mesmo tempo executam uma vez", async () => {
    const { missoes } = setup();
    const m = await missoes.criar("ana", "obedient", "x");
    let liberar!: () => void;
    const segura = new Promise<void>((ok) => (liberar = ok));
    let chamadas = 0;
    const exec: Executor = async () => {
      chamadas++;
      await segura;
      return { tipo: "feito", explicacao: "ok", custoCentavos: 1 };
    };
    const a = missoes.avancar(m.id, exec);
    const b = missoes.avancar(m.id, exec);
    liberar();
    await Promise.all([a, b]);
    assert.equal(chamadas, 1);
  });
});

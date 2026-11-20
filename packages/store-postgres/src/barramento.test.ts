// SPDX-License-Identifier: AGPL-3.0-only
//
// Barramento de eventos em Postgres (D20, M7; G10): a semântica do barramento em memória (o contrato) no
// banco, com RLS por pessoa, reivindicação com trava e cerca, e as missões publicando na mesma transação.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ManualClock } from "@obedient/core";
import { ErroPermanente, RegistroDeConsumidores, VOCABULARIO_OBEDIENT } from "@obedient/event-bus";
import { bancoDeTeste, type BancoDeTeste } from "./banco-de-teste.ts";
import { apagarMeusDados, BarramentoPostgres, comoUsuario, despacharEventos, missoesNaTransacao, motorNaTransacao, pessoasComEntregaDevida } from "./index.ts";

const T0 = new Date("2026-11-20T12:00:00Z");
let banco: BancoDeTeste;
before(async () => {
  banco = await bancoDeTeste();
});
after(() => banco.fechar());

let n = 0;
const usuario = (nome: string) => `${nome}-bus${++n}`;
const vocab = VOCABULARIO_OBEDIENT;
const M1 = "0b7c2f4e-9a1d-4c3b-8e2f-1234567890ab";
const bus = <T>(u: string, clock: ManualClock, fn: (b: BarramentoPostgres) => Promise<T>) => comoUsuario(banco.db, u, (tx) => fn(new BarramentoPostgres(tx, vocab, clock)));
const ctx = (u: string) => ({ organizationId: u, source: "obedient", ator: { tipo: "system" as const } });
const evento = (extra: Record<string, unknown> = {}) => ({ type: "mission.created", entityType: "mission", entityId: M1, ...extra });

describe("barramento em Postgres: publicação (D20, M7)", () => {
  it("idempotente: mesma chave e conteúdo = duplicado; conteúdo diferente = conflito, e o lote não grava nada", async () => {
    const ana = usuario("ana");
    const clock = new ManualClock(T0);
    const [a] = await bus(ana, clock, (b) => b.publicar(ctx(ana), [evento({ idempotencyKey: "k1", payload: { estado: "created" } })]));
    const [b] = await bus(ana, clock, (x) => x.publicar(ctx(ana), [evento({ idempotencyKey: "k1", payload: { estado: "created" } })]));
    assert.deepEqual([b!.duplicate, b!.id], [true, a!.id]);
    await assert.rejects(bus(ana, clock, (x) => x.publicar(ctx(ana), [evento({ idempotencyKey: "k2" }), evento({ idempotencyKey: "k1", payload: { estado: "outro" } })])), /outro conteúdo/);
    const [c] = await bus(ana, clock, (x) => x.publicar(ctx(ana), [evento({ idempotencyKey: "k2" })]));
    assert.equal(c!.duplicate, false, "k2 não foi gravado junto com o conflito");
  });

  it("valida pelo vocabulário: tipo, fonte e dado pessoal recusados antes de gravar", async () => {
    const ana = usuario("ana");
    const clock = new ManualClock(T0);
    await assert.rejects(bus(ana, clock, (b) => b.publicar(ctx(ana), [evento({ type: "mission.inventado" })])));
    await assert.rejects(bus(ana, clock, (b) => b.publicar({ ...ctx(ana), source: "estranha" }, [evento()])), /fonte/);
    await assert.rejects(bus(ana, clock, (b) => b.publicar(ctx(ana), [evento({ payload: { email: "ana@exemplo.test" } })])));
  });

  it("RLS por pessoa: ninguém publica no nome de outra, nem vê os eventos dela; evento é só inserção", async () => {
    const ana = usuario("ana");
    const bia = usuario("bia");
    const clock = new ManualClock(T0);
    const [e] = await bus(ana, clock, (b) => b.publicar(ctx(ana), [evento()]));
    assert.equal(await bus(bia, clock, (b) => b.evento(e!.id)), undefined);
    await assert.rejects(bus(bia, clock, (b) => b.publicar(ctx(ana), [evento()])), /row-level security|violates/);
    await assert.rejects(comoUsuario(banco.db, ana, (tx) => tx.query("update obedient.events set type = 'mission.completed' where id = $1", [e!.id])), /permission denied/);
    await assert.rejects(comoUsuario(banco.db, ana, (tx) => tx.query("delete from obedient.events where id = $1", [e!.id])), /permission denied/);
  });
});

describe("barramento em Postgres: entrega (D20, M7)", () => {
  it("uma entrega por assinatura ATIVA cujo padrão casa; processada uma vez, com o evento como dado", async () => {
    const ana = usuario("ana");
    const clock = new ManualClock(T0);
    await bus(ana, clock, async (b) => {
      await b.assinar({ userId: ana, consumer: "painel", padroes: ["mission.*"] });
      await b.assinar({ userId: ana, consumer: "so-propostas", padroes: ["proposal.*"] });
      await b.assinar({ userId: ana, consumer: "desligado", padroes: ["*"] });
      await b.desativar("desligado");
    });
    await bus(ana, clock, (b) => b.publicar(ctx(ana), [evento()]));
    const vistos: string[] = [];
    const r = await despacharEventos(banco.db, ana, new RegistroDeConsumidores().registrar("painel", (e) => void vistos.push(e.type)), { vocab, clock });
    assert.deepEqual([r.reivindicadas, r.processadas, vistos], [1, 1, ["mission.created"]]);
    assert.deepEqual((await bus(ana, clock, (b) => b.entregas())).map((d) => [d.consumer, d.status]), [["painel", "processed"]]);
    assert.equal((await despacharEventos(banco.db, ana, new RegistroDeConsumidores().registrar("painel", () => {}), { vocab, clock })).reivindicadas, 0, "nada de novo");
  });

  it("falha volta com espera crescente; esgotada, dead_letter; ErroPermanente vai direto; reprocessar zera", async () => {
    const ana = usuario("ana");
    const clock = new ManualClock(T0);
    await bus(ana, clock, async (b) => {
      await b.assinar({ userId: ana, consumer: "instavel", padroes: ["mission.*"], maxAttempts: 2, backoffSeconds: 10 });
      await b.assinar({ userId: ana, consumer: "quebrado", padroes: ["mission.*"] });
    });
    await bus(ana, clock, (b) => b.publicar(ctx(ana), [evento()]));
    const registro = new RegistroDeConsumidores()
      .registrar("instavel", () => { throw new Error("fora do ar"); })
      .registrar("quebrado", () => { throw new ErroPermanente("dado inválido"); });
    const r1 = await despacharEventos(banco.db, ana, registro, { vocab, clock });
    assert.deepEqual([r1.falhas, r1.mortas], [1, 1]);
    const [instavel] = (await bus(ana, clock, (b) => b.entregas())).filter((d) => d.consumer === "instavel");
    assert.deepEqual([instavel!.status, instavel!.nextAttemptAt.getTime(), instavel!.lastError], ["failed", T0.getTime() + 10_000, "fora do ar"]);
    assert.equal((await despacharEventos(banco.db, ana, registro, { vocab, clock })).reivindicadas, 0, "antes da hora, nada");
    clock.advance(10_000);
    assert.equal((await despacharEventos(banco.db, ana, registro, { vocab, clock })).mortas, 1, "segunda falha esgota");
    const mortas = (await bus(ana, clock, (b) => b.entregas())).filter((d) => d.status === "dead_letter");
    assert.equal(mortas.length, 2);
    await bus(ana, clock, (b) => b.reprocessar(mortas[0]!.id));
    assert.equal((await bus(ana, clock, (b) => b.entregas())).find((d) => d.id === mortas[0]!.id)!.attempts, 0);
  });

  it("evento derivado herda a correlação e aponta a causa; consumidor desconhecido conta como falha", async () => {
    const ana = usuario("ana");
    const clock = new ManualClock(T0);
    await bus(ana, clock, async (b) => {
      await b.assinar({ userId: ana, consumer: "reator", padroes: ["mission.created"] });
      await b.assinar({ userId: ana, consumer: "fantasma", padroes: ["mission.created"] });
    });
    const [e] = await bus(ana, clock, (b) => b.publicar(ctx(ana), [evento({ correlationId: "corr-1" })]));
    let derivado = "";
    const r = await despacharEventos(banco.db, ana, new RegistroDeConsumidores().registrar("reator", async (_ev, c) => {
      derivado = (await c.publicar([{ type: "mission.blocked", entityType: "mission", entityId: M1 }]))[0]!.id;
    }), { vocab, clock });
    assert.deepEqual([r.processadas, r.falhas], [1, 1]);
    const d = await bus(ana, clock, (b) => b.evento(derivado));
    assert.deepEqual([d!.correlationId, d!.causationId], ["corr-1", e!.id]);
  });

  it("cerca: o despachante que perdeu a trava não grava o desfecho por cima de quem a pegou depois", async () => {
    const ana = usuario("ana");
    const clock = new ManualClock(T0);
    await bus(ana, clock, (b) => b.assinar({ userId: ana, consumer: "lento", padroes: ["mission.*"] }));
    await bus(ana, clock, (b) => b.publicar(ctx(ana), [evento()]));
    let chamadas = 0;
    let deB: Awaited<ReturnType<typeof despacharEventos>> | null = null;
    const registroB = new RegistroDeConsumidores().registrar("lento", () => { chamadas++; return { quem: "B" }; });
    const registroA = new RegistroDeConsumidores().registrar("lento", async () => {
      chamadas++;
      // Enquanto A trabalha, a trava vence e B pega a entrega.
      clock.advance(6 * 60_000);
      deB = await despacharEventos(banco.db, ana, registroB, { vocab, clock, worker: "B" });
      throw new Error("A falhou depois de perder a trava");
    });
    const deA = await despacharEventos(banco.db, ana, registroA, { vocab, clock, worker: "A" });
    assert.equal(chamadas, 2);
    assert.deepEqual([deA.travasPerdidas, deB!.processadas], [1, 1]);
    const [d] = await bus(ana, clock, (b) => b.entregas());
    assert.deepEqual([d!.status, d!.attempts, d!.lastError], ["processed", 2, null], "vale o desfecho de B");
  });

  it("o agendador vê só QUEM tem entrega devida", async () => {
    const ana = usuario("ana");
    const clock = new ManualClock(T0);
    await bus(ana, clock, (b) => b.assinar({ userId: ana, consumer: "painel", padroes: ["mission.*"] }));
    await bus(ana, clock, (b) => b.publicar(ctx(ana), [evento()]));
    assert.ok((await pessoasComEntregaDevida(banco.db, clock.now(), 1000)).includes(ana));
  });
});

describe("missões publicam no barramento, na mesma transação (D20, M7)", () => {
  it("criar e cancelar viram mission.created e mission.cancelled, só com id e estado (nunca o objetivo)", async () => {
    const ana = usuario("ana");
    const clock = new ManualClock(T0);
    const missoes = <T>(fn: (ms: ReturnType<typeof missoesNaTransacao>) => Promise<T>) => comoUsuario(banco.db, ana, (tx) => fn(missoesNaTransacao(tx, motorNaTransacao(tx, { clock }), clock)));
    const m = await missoes((ms) => ms.criar(ana, "obedient", "Objetivo secreto da Ana"));
    await missoes((ms) => ms.cancelarPelaPessoa(ana, m.id));
    const { rows } = await comoUsuario(banco.db, ana, (tx) => tx.query<{ type: string; entity_id: string; payload: unknown }>("select type, entity_id, payload from obedient.events where entity_id = $1 order by created_at, type", [m.id]));
    assert.deepEqual(rows.map((r) => r.type).sort(), ["mission.cancelled", "mission.created"]);
    assert.ok(!JSON.stringify(rows).includes("secreto"));
    assert.deepEqual((rows.find((r) => r.type === "mission.cancelled")!.payload as { estado: string }).estado, "cancelled");
  });

  it("a mudança que não grava não publica (a transação desfaz os dois)", async () => {
    const ana = usuario("ana");
    const clock = new ManualClock(T0);
    await assert.rejects(comoUsuario(banco.db, ana, async (tx) => {
      await missoesNaTransacao(tx, motorNaTransacao(tx, { clock }), clock).criar(ana, "obedient", "x");
      throw new Error("a transação cai depois");
    }));
    const { rows } = await comoUsuario(banco.db, ana, (tx) => tx.query("select 1 from obedient.events"));
    assert.equal(rows.length, 0);
  });

  it("apagar o que o OBEDIENT sabe apaga os eventos, as entregas e as assinaturas da pessoa", async () => {
    const ana = usuario("ana");
    const clock = new ManualClock(T0);
    await bus(ana, clock, (b) => b.assinar({ userId: ana, consumer: "painel", padroes: ["mission.*"] }));
    await comoUsuario(banco.db, ana, (tx) => missoesNaTransacao(tx, motorNaTransacao(tx, { clock }), clock).criar(ana, "obedient", "x"));
    const r = await comoUsuario(banco.db, ana, (tx) => apagarMeusDados(tx, motorNaTransacao(tx, { clock }).audit, ana, clock));
    assert.ok(r.eventos >= 1);
    const sobrou = await comoUsuario(banco.db, ana, async (tx) => [
      (await tx.query("select 1 from obedient.events")).rows.length,
      (await tx.query("select 1 from obedient.event_deliveries")).rows.length,
      (await tx.query("select 1 from obedient.event_subscriptions")).rows.length,
    ]);
    // apagar_meus_dados cancela as missões abertas, e o cancelamento é registrado depois: só o que veio depois sobra.
    assert.deepEqual(sobrou, [0, 0, 0]);
  });
});

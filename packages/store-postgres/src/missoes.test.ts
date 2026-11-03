// SPDX-License-Identifier: AGPL-3.0-only
//
// Missões e identificação sobre o banco (Arts. 5º e 7º): RLS por pessoa, limites no próprio banco,
// reserva da tentativa em transação curta (a execução fica fora do banco), identificação exigida.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ManualClock } from "@obedient/core";
import { bancoDeTeste, type BancoDeTeste } from "./banco-de-teste.ts";
import { PgMissionStore, apagarMeusDados, comoUsuario, gravarIdentificacao, missoesNaTransacao, motorNaTransacao, type Executor } from "./index.ts";

const T0 = new Date("2026-11-03T12:00:00Z");
let banco: BancoDeTeste;
const clock = new ManualClock(T0);
before(async () => {
  banco = await bancoDeTeste();
});
after(() => banco.fechar());

let n = 0;
const usuario = (nome: string) => `${nome}-m${++n}`;
type Motor = ReturnType<typeof motorNaTransacao>;
const missoes = <T>(u: string, fn: (ms: ReturnType<typeof missoesNaTransacao>, m: Motor, tx: Executor) => Promise<T>, opts = {}) =>
  comoUsuario(banco.db, u, (tx) => {
    const m = motorNaTransacao(tx, { clock, ...opts });
    return fn(missoesNaTransacao(tx, m, clock), m, tx);
  });

describe("missões no banco (Art. 7º)", () => {
  it("reserva e conclusão em transações separadas; falha marca a próxima tentativa; teto vira impedimento", async () => {
    const ana = usuario("ana");
    const m = await missoes(ana, (ms) => ms.criar(ana, "obedient", "Confirmar a reserva de quinta", { maxTentativas: 2 }));
    const r1 = await missoes(ana, (ms) => ms.reservar(m.id));
    assert.equal(r1.reservada, true);
    // A execução acontece aqui, fora de qualquer transação.
    const depois1 = await missoes(ana, (ms) => ms.concluir(r1.missao, { tipo: "falha_temporaria", erro: "fora do ar", custoCentavos: 10 }));
    assert.equal(depois1.proximaTentativaEm?.getTime(), T0.getTime() + 30_000);
    assert.equal((await missoes(ana, (ms) => ms.reservar(m.id))).reservada, false, "antes do intervalo, não reserva");
    clock.advance(30_000);
    const r2 = await missoes(ana, (ms) => ms.reservar(m.id));
    const fim = await missoes(ana, (ms) => ms.concluir(r2.missao, { tipo: "falha_temporaria", erro: "fora do ar", custoCentavos: 10 }));
    assert.equal(fim.estado, "blocked");
    assert.match(fim.impedimento!, /Tentou 2 vez/);
    assert.equal((await missoes(ana, (ms) => ms.get(m.id)))?.custoCentavos, 20);
  });

  it("duas reservas ao mesmo tempo: só uma conta (troca atômica pela versão)", async () => {
    const ana = usuario("ana");
    const m = await missoes(ana, (ms) => ms.criar(ana, "obedient", "x"));
    const rs = await Promise.all(Array.from({ length: 4 }, () => missoes(ana, (ms) => ms.reservar(m.id))));
    assert.equal(rs.filter((r) => r.reservada).length, 1, JSON.stringify(rs.map((r) => r.reservada)));
    assert.equal((await missoes(ana, (ms) => ms.get(m.id)))?.tentativas, 1);
  });

  it("corrida forçada: duas transações leem a mesma versão; só a primeira grava", async (t) => {
    // O PGlite tem uma conexão só: duas transações abertas ao mesmo tempo não existem nele.
    if (banco.tipo === "pglite") return t.skip("corrida real só no Postgres (job postgres do CI)");
    const ana = usuario("ana");
    const m = await missoes(ana, (ms) => ms.criar(ana, "obedient", "x"));
    let lerB!: () => void;
    const bLeu = new Promise<void>((ok) => (lerB = ok));
    let soltarA!: () => void;
    const aPode = new Promise<void>((ok) => (soltarA = ok));
    const gravar = (atraso: Promise<void>, sinal?: () => void) =>
      comoUsuario(banco.db, ana, async (tx) => {
        const store = new PgMissionStore(tx);
        const lida = (await store.get(m.id))!;
        sinal?.();
        await atraso;
        const v = lida.versao;
        lida.tentativas += 1;
        lida.versao = v + 1;
        return store.update(lida, v);
      });
    // B lê e espera; A lê depois de B ter lido, e as duas gravam.
    const b = gravar(aPode, lerB);
    await bLeu;
    const a = gravar(Promise.resolve());
    const ra = await a;
    soltarA();
    const rb = await b;
    assert.deepEqual([ra, rb].sort(), [false, true]);
    assert.equal((await missoes(ana, (ms) => ms.get(m.id)))?.tentativas, 1);
  });

  it("o banco recusa limite fora do Art. 7º mesmo se o código errar", async () => {
    const ana = usuario("ana");
    const m = await missoes(ana, (ms) => ms.criar(ana, "obedient", "x"));
    for (const sql of [
      "update obedient.missions set tentativas = 9 where id = $1",
      "update obedient.missions set teto_custo_centavos = 999999 where id = $1",
      "update obedient.missions set estado = 'blocked', impedimento = null where id = $1",
      "update obedient.missions set estado = 'completed' where id = $1",
    ])
      await assert.rejects(missoes(ana, (_ms, _m, tx) => tx.query(sql, [m.id])), /check constraint/, sql);
    await assert.rejects(missoes(ana, (_ms, _m, tx) => tx.query("update obedient.missions set objetivo = 'outro' where id = $1", [m.id])), /permission denied/);
  });

  it("uma pessoa não vê nem mexe na missão de outra", async () => {
    const ana = usuario("ana");
    const bia = usuario("bia");
    const m = await missoes(ana, (ms) => ms.criar(ana, "obedient", "segredo da Ana"));
    assert.equal(await missoes(bia, (ms) => ms.get(m.id)), undefined);
    await assert.rejects(missoes(bia, (ms) => ms.cancelarPelaPessoa(bia, m.id)));
    await assert.rejects(missoes(bia, (ms) => ms.reservar(m.id)));
    assert.equal((await missoes(ana, (ms) => ms.get(m.id)))?.estado, "running");
  });

  it("parar cancela as missões no mesmo commit", async () => {
    const ana = usuario("ana");
    const m = await missoes(ana, (ms) => ms.criar(ana, "obedient", "x"));
    await missoes(ana, (_ms, motor) => motor.stop.engage({ kind: "user", userId: ana }, ana, "parar"));
    assert.equal((await missoes(ana, (ms) => ms.get(m.id)))?.estado, "cancelled");
  });

  it("apagar o que o OBEDIENT sabe esvazia objetivo e explicação e cancela as abertas", async () => {
    const ana = usuario("ana");
    const aberta = await missoes(ana, (ms) => ms.criar(ana, "obedient", "marcar consulta com a Dra. Marta"));
    const feita = await missoes(ana, (ms) => ms.criar(ana, "obedient", "achar o telefone do encanador"));
    await missoes(ana, (ms) => ms.avancar(feita.id, async () => ({ tipo: "feito", explicacao: "é 21 99999-0000", custoCentavos: 1 })));
    const r = await missoes(ana, (_ms, m, tx) => apagarMeusDados(tx, m.audit, ana, clock));
    assert.equal(r.missoes, 2);
    const a = await missoes(ana, (ms) => ms.get(aberta.id));
    const f = await missoes(ana, (ms) => ms.get(feita.id));
    assert.deepEqual([a?.estado, a?.objetivo], ["cancelled", "(apagado a pedido da pessoa)"]);
    assert.deepEqual([f?.estado, f?.desfecho?.explicacao], ["completed", "(apagado a pedido da pessoa)"]);
  });
});

describe("identificação das mensagens (Art. 5º)", () => {
  it("com o servidor exigindo, mensagem só sai com a identificação configurada", async () => {
    const ana = usuario("ana");
    const exige = { exigirIdentificacao: true };
    await missoes(ana, (_ms, m) =>
      m.grants.grant({ userId: ana, agentId: "obedient", systemId: "email", capability: "email.*", purpose: "responder e-mails", limits: { maxRisk: "HIGH", autonomousUpTo: "MEDIUM", maxAmount: null, amountField: null }, expiresAt: new Date(T0.getTime() + 8 * 3_600_000) }, ana),
    );
    const enviar = (args: Record<string, unknown>) =>
      missoes(ana, async (_ms, m) => (await m.authorize({ userId: ana, agentId: "obedient", systemId: "email", tool: "email.enviar", risk: "MEDIUM", category: "COMMUNICATION", args })).outcome, exige);
    assert.equal(await enviar({ para: "x@exemplo.org" }), "denied");
    await assert.rejects(missoes(ana, (_ms, _m, tx) => gravarIdentificacao(tx, ana, "ab", clock)), /de 3 a 200/);
    const id = await missoes(ana, (_ms, _m, tx) => gravarIdentificacao(tx, ana, "  Enviada pelo   assistente da Ana ", clock));
    assert.equal(id, "Enviada pelo assistente da Ana");
    assert.equal(await enviar({ para: "x@exemplo.org" }), "denied");
    assert.equal(await enviar({ para: "x@exemplo.org", identificacao: id }), "allowed");
    // Sem a exigência ligada (motor fora do servidor), a regra fica de fora.
    assert.equal(await missoes(ana, async (_ms, m) => (await m.authorize({ userId: ana, agentId: "obedient", systemId: "email", tool: "email.enviar", risk: "MEDIUM", category: "COMMUNICATION", args: {} })).outcome), "allowed");
  });
});

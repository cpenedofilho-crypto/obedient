// SPDX-License-Identifier: AGPL-3.0-only
//
// Reservas com dono e cerca (D20, M5): a cerca sobe a cada reserva e nunca desce, o banco recusa
// passo gravado com cerca velha, e a reserva diz qual processo a tem.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ManualClock } from "@obedient/core";
import { PRAZO_RESERVA_MS } from "@obedient/missions";
import { bancoDeTeste, type BancoDeTeste } from "./banco-de-teste.ts";
import { comoUsuario, missoesNaTransacao, motorNaTransacao, passosNaTransacao } from "./index.ts";

const T0 = new Date("2026-11-19T12:00:00Z");
let banco: BancoDeTeste;
const clock = new ManualClock(T0);
before(async () => {
  banco = await bancoDeTeste();
});
after(() => banco.fechar());

let n = 0;
const usuario = (nome: string) => `${nome}-c${++n}`;
const missoes = <T>(u: string, fn: (ms: ReturnType<typeof missoesNaTransacao>) => Promise<T>) =>
  comoUsuario(banco.db, u, (tx) => fn(missoesNaTransacao(tx, motorNaTransacao(tx, { clock }), clock)));
const passo = (u: string, missionId: string, tentativa: number, cerca: number | null) =>
  comoUsuario(banco.db, u, (tx) => passosNaTransacao(tx).registrar({ missionId, userId: u, tentativa, cerca, tipo: "modelo", status: "ok", criadoEm: clock.now() }));

describe("reservas com dono e cerca no banco (D20, M5)", () => {
  it("a reserva grava o dono e sobe a cerca; terminar tira o dono", async () => {
    const ana = usuario("ana");
    const m = await missoes(ana, (ms) => ms.criar(ana, "obedient", "x"));
    assert.deepEqual([m.cerca, m.reservadaPor], [0, null]);
    const r = await missoes(ana, (ms) => ms.reservar(m.id, "maquina-a:1:abc"));
    assert.ok(r.reservada);
    const lida = await missoes(ana, (ms) => ms.get(m.id));
    assert.deepEqual([lida!.cerca, lida!.reservadaPor], [1, "maquina-a:1:abc"]);
    const fim = await missoes(ana, (ms) => ms.concluir(r.missao, { tipo: "nao_consegui", explicacao: "não", custoCentavos: 1 }));
    assert.deepEqual([fim.cerca, fim.reservadaPor], [1, null]);
  });

  it("passo com a cerca da reserva atual entra; com cerca velha, ou sem cerca, o banco recusa", async () => {
    const ana = usuario("ana");
    const m = await missoes(ana, (ms) => ms.criar(ana, "obedient", "x"));
    const a = await missoes(ana, (ms) => ms.reservar(m.id, "processo-a"));
    await passo(ana, m.id, 1, a.missao.cerca);
    // A reserva de A vence; B reserva por cima.
    clock.advance(PRAZO_RESERVA_MS + 1000);
    const b = await missoes(ana, (ms) => ms.reservar(m.id, "processo-b"));
    assert.ok(b.reservada);
    assert.equal(b.missao.cerca, a.missao.cerca + 1);
    await assert.rejects(passo(ana, m.id, 1, a.missao.cerca), /cerca velha/);
    await assert.rejects(passo(ana, m.id, 2, null), /cerca velha/);
    await passo(ana, m.id, 2, b.missao.cerca);
    // A conclusão de A também é descartada (troca pela versão).
    const descartada = await missoes(ana, (ms) => ms.concluir(a.missao, { tipo: "feito", explicacao: "ok", custoCentavos: 1 }));
    assert.equal(descartada.reservadaPor, "processo-b");
  });

  it("a cerca nunca desce, nem por UPDATE direto", async () => {
    const ana = usuario("ana");
    const m = await missoes(ana, (ms) => ms.criar(ana, "obedient", "x"));
    await missoes(ana, (ms) => ms.reservar(m.id));
    await assert.rejects(comoUsuario(banco.db, ana, (tx) => tx.query("update obedient.missions set cerca = 0 where id = $1", [m.id])), /não desce/);
  });
});

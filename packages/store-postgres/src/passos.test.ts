// SPDX-License-Identifier: AGPL-3.0-only
//
// O registro de passos no banco (D20, M1): RLS por pessoa, só inserção, chave gerada no início,
// início sem fim aparece como aberto, limites no próprio banco e "apagar o que o OBEDIENT sabe".

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ManualClock } from "@obedient/core";
import { bancoDeTeste, type BancoDeTeste } from "./banco-de-teste.ts";
import { apagarMeusDados, comoUsuario, missoesNaTransacao, motorNaTransacao, passosNaTransacao } from "./index.ts";

const T0 = new Date("2026-11-19T12:00:00Z");
let banco: BancoDeTeste;
const clock = new ManualClock(T0);
before(async () => {
  banco = await bancoDeTeste();
});
after(() => banco.fechar());

let n = 0;
const usuario = (nome: string) => `${nome}-p${++n}`;
const novaMissao = (u: string) => comoUsuario(banco.db, u, (tx) => missoesNaTransacao(tx, motorNaTransacao(tx, { clock }), clock).criar(u, "obedient", "Ver a agenda"));
const passos = <T>(u: string, fn: (p: ReturnType<typeof passosNaTransacao>) => Promise<T>) => comoUsuario(banco.db, u, (tx) => fn(passosNaTransacao(tx)));
const base = (missionId: string, userId: string) => ({ missionId, userId, tentativa: 1, cerca: 0, criadoEm: clock.now() });
const HASH = "a".repeat(64);

describe("registro de passos no banco (D20, M1)", () => {
  it("numera por tentativa, gera a chave do início e mostra como aberto o início sem fim", async () => {
    const ana = usuario("ana");
    const m = await novaMissao(ana);
    const r1 = await passos(ana, (p) => p.registrar({ ...base(m.id, ana), tipo: "modelo", status: "ok", decisao: "tool_use" }));
    const r2 = await passos(ana, (p) => p.registrar({ ...base(m.id, ana), tipo: "inicio", status: "chamando", ferramenta: "x/ler", categoria: "READ", hashArgumentos: HASH }));
    const r3 = await passos(ana, (p) => p.registrar({ ...base(m.id, ana), tipo: "inicio", status: "chamando", ferramenta: "x/apagar", categoria: "DESTRUCTIVE", hashArgumentos: HASH }));
    assert.deepEqual([r1, r2, r3], [{ seq: 1, chave: null }, { seq: 2, chave: `${m.id}:1:2` }, { seq: 3, chave: `${m.id}:1:3` }]);
    await passos(ana, (p) => p.registrar({ ...base(m.id, ana), tipo: "ferramenta", status: "succeeded", fecha: { tentativa: 1, seq: 2 } }));
    const abertos = await passos(ana, (p) => p.abertos(m.id));
    assert.deepEqual(abertos.map((a) => [a.seq, a.ferramenta, a.categoria]), [[3, "x/apagar", "DESTRUCTIVE"]]);
    // Outra tentativa recomeça a numeração.
    const r5 = await passos(ana, (p) => p.registrar({ ...base(m.id, ana), tentativa: 2, tipo: "incerto", status: "sem_resultado", fecha: { tentativa: 1, seq: 3 } }));
    assert.equal(r5.seq, 1);
    assert.deepEqual(await passos(ana, (p) => p.abertos(m.id)), []);
  });

  it("RLS por pessoa: outra pessoa não lê nem grava passos de uma missão que não é dela", async () => {
    const ana = usuario("ana");
    const bia = usuario("bia");
    const m = await novaMissao(ana);
    await passos(ana, (p) => p.registrar({ ...base(m.id, ana), tipo: "modelo", status: "ok" }));
    assert.deepEqual(await passos(bia, (p) => p.daMissao(m.id)), []);
    await assert.rejects(passos(bia, (p) => p.registrar({ ...base(m.id, ana), tipo: "modelo", status: "ok" })), /row-level security|violates/);
    assert.equal((await passos(ana, (p) => p.daMissao(m.id))).length, 1);
  });

  it("só inserção: o app não altera nem apaga passo", async () => {
    const ana = usuario("ana");
    const m = await novaMissao(ana);
    await passos(ana, (p) => p.registrar({ ...base(m.id, ana), tipo: "modelo", status: "ok" }));
    await assert.rejects(comoUsuario(banco.db, ana, (tx) => tx.query("update obedient.mission_steps set status = 'x' where mission_id = $1", [m.id])), /permission denied/);
    await assert.rejects(comoUsuario(banco.db, ana, (tx) => tx.query("delete from obedient.mission_steps where mission_id = $1", [m.id])), /permission denied/);
  });

  it("o banco recusa início sem categoria, hash fora do formato e incerto sem o passo que fecha", async () => {
    const ana = usuario("ana");
    const m = await novaMissao(ana);
    await assert.rejects(passos(ana, (p) => p.registrar({ ...base(m.id, ana), tipo: "inicio", status: "chamando", ferramenta: "x/ler" })), /check constraint/);
    await assert.rejects(passos(ana, (p) => p.registrar({ ...base(m.id, ana), tipo: "modelo", status: "ok", hashArgumentos: "nao-e-hash" })), /check constraint/);
    await assert.rejects(passos(ana, (p) => p.registrar({ ...base(m.id, ana), tipo: "incerto", status: "sem_resultado" })), /check constraint/);
    await assert.rejects(passos(ana, (p) => p.registrar({ ...base("missao-que-nao-existe", ana), tipo: "modelo", status: "ok" })), /foreign key/);
  });

  it("apagar o que o OBEDIENT sabe apaga os passos da pessoa, e só os dela", async () => {
    const ana = usuario("ana");
    const bia = usuario("bia");
    const ma = await novaMissao(ana);
    const mb = await novaMissao(bia);
    await passos(ana, (p) => p.registrar({ ...base(ma.id, ana), tipo: "modelo", status: "ok" }));
    await passos(ana, (p) => p.registrar({ ...base(ma.id, ana), tipo: "inicio", status: "chamando", ferramenta: "x/ler", categoria: "READ" }));
    await passos(bia, (p) => p.registrar({ ...base(mb.id, bia), tipo: "modelo", status: "ok" }));
    const r = await comoUsuario(banco.db, ana, (tx) => apagarMeusDados(tx, motorNaTransacao(tx, { clock }).audit, ana, clock));
    assert.equal(r.passos, 2);
    assert.deepEqual(await passos(ana, (p) => p.daMissao(ma.id)), []);
    assert.equal((await passos(bia, (p) => p.daMissao(mb.id))).length, 1);
  });
});

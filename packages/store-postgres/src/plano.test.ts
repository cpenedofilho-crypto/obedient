// SPDX-License-Identifier: AGPL-3.0-only
//
// O plano da missão no banco (D20, M5): tarefas e dependências por pessoa, feita só depois das
// dependências e para sempre, texto fixo, agendador que espera a aprovação, e "apagar".

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ManualClock } from "@obedient/core";
import { lerTarefas } from "@obedient/missions";
import { bancoDeTeste, type BancoDeTeste } from "./banco-de-teste.ts";
import { apagarMeusDados, comoOperador, comoUsuario, missoesNaTransacao, motorNaTransacao, pessoasComMissaoDevida } from "./index.ts";

const T0 = new Date("2026-11-19T12:00:00Z");
let banco: BancoDeTeste;
const clock = new ManualClock(T0);
before(async () => {
  banco = await bancoDeTeste();
});
after(() => banco.fechar());

let n = 0;
const usuario = (nome: string) => `${nome}-pl${++n}`;
const missoes = <T>(u: string, fn: (ms: ReturnType<typeof missoesNaTransacao>) => Promise<T>) =>
  comoUsuario(banco.db, u, (tx) => fn(missoesNaTransacao(tx, motorNaTransacao(tx, { clock }), clock)));
const tarefas = (v: unknown) => {
  const l = lerTarefas(v);
  if (!("tarefas" in l)) throw new Error(l.problemas.join("; "));
  return l.tarefas;
};
const PLANO = tarefas([{ chave: "ler", titulo: "Ler os e-mails", depende_de: [] }, { chave: "resumir", titulo: "Resumir", depende_de: ["ler"] }]);

/** Missão com plano proposto (esperando a pessoa). */
async function comPlano(u: string) {
  const m = await missoes(u, (ms) => ms.criar(u, "obedient", "Resumir os e-mails", { planejar: true }));
  return missoes(u, async (ms) => {
    const r = await ms.reservar(m.id);
    assert.equal(r.missao.estado, "planning");
    return ms.concluir(r.missao, { tipo: "plano", tarefas: PLANO, custoCentavos: 1 });
  });
}

describe("plano da missão no banco (D20, M5)", () => {
  it("o plano proposto fica gravado (tarefas, dependências, hash) e volta igual na leitura", async () => {
    const ana = usuario("ana");
    const m = await comPlano(ana);
    const lida = await missoes(ana, (ms) => ms.get(m.id));
    assert.equal(lida!.estado, "waiting_approval");
    assert.deepEqual(lida!.plano, m.plano);
    assert.deepEqual(lida!.plano!.tarefas, PLANO);
    assert.equal(lida!.planejar, true);
  });

  it("o agendador não pega missão esperando a aprovação do plano; aprovada, pega", async () => {
    const ana = usuario("ana");
    const m = await comPlano(ana);
    const devidas = () => comoOperador(banco.db, (tx) => pessoasComMissaoDevida(tx, clock.now(), 1000));
    assert.ok(!(await devidas()).includes(ana));
    await missoes(ana, (ms) => ms.aprovarPlano(ana, m.id, m.plano!.hash));
    assert.ok((await devidas()).includes(ana));
  });

  it("o banco recusa marcar feita com dependência pendente, desfazer feita e mudar o texto da tarefa", async () => {
    const ana = usuario("ana");
    const m = await comPlano(ana);
    const sql = (q: string) => comoUsuario(banco.db, ana, (tx) => tx.query(q, [m.id]));
    await assert.rejects(sql("update obedient.mission_tasks set estado = 'feita', feita_em = now() where mission_id = $1 and chave = 'resumir'"), /dependência pendente/);
    await sql("update obedient.mission_tasks set estado = 'feita', feita_em = now() where mission_id = $1 and chave = 'ler'");
    await assert.rejects(sql("update obedient.mission_tasks set estado = 'pendente', feita_em = null where mission_id = $1 and chave = 'ler'"), /não volta/);
    await assert.rejects(sql("update obedient.mission_tasks set titulo = 'Apagar tudo' where mission_id = $1"), /permission denied/);
    await assert.rejects(sql("delete from obedient.mission_tasks where mission_id = $1"), /permission denied/);
  });

  it("RLS: outra pessoa não vê nem grava tarefa de missão que não é dela", async () => {
    const ana = usuario("ana");
    const bia = usuario("bia");
    const m = await comPlano(ana);
    const { rows } = await comoUsuario(banco.db, bia, (tx) => tx.query("select * from obedient.mission_tasks where mission_id = $1", [m.id]));
    assert.deepEqual(rows, []);
    await assert.rejects(
      comoUsuario(banco.db, bia, (tx) => tx.query("insert into obedient.mission_tasks (mission_id, user_id, versao, chave, ordem, titulo, criado_em) values ($1, $2, 9, 'x', 0, 'Tarefa x', now())", [m.id, ana])),
      /row-level security|violates/,
    );
  });

  it("apagar o que o OBEDIENT sabe apaga as tarefas e tira o plano", async () => {
    const ana = usuario("ana");
    const m = await comPlano(ana);
    const r = await comoUsuario(banco.db, ana, (tx) => apagarMeusDados(tx, motorNaTransacao(tx, { clock }).audit, ana, clock));
    assert.equal(r.tarefas, 2);
    const lida = await missoes(ana, (ms) => ms.get(m.id));
    assert.deepEqual([lida!.estado, lida!.plano], ["cancelled", null]);
  });
});

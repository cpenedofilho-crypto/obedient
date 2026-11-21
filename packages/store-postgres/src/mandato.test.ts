// SPDX-License-Identifier: AGPL-3.0-only
//
// Mandato e gasto do mês no banco (D20, M4; D21): mandato fixo depois de criada a missão, lista com
// limite no próprio banco, gasto só de inserção e por pessoa, teto do mês somando as missões, e
// "apagar" que esvazia o mandato mas não zera o teto.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ManualClock } from "@obedient/core";
import { TETO_MENSAL_CENTAVOS } from "@obedient/missions";
import { bancoDeTeste, type BancoDeTeste } from "./banco-de-teste.ts";
import { apagarMeusDados, comoUsuario, missoesNaTransacao, motorNaTransacao } from "./index.ts";

const T0 = new Date("2026-11-19T12:00:00Z");
let banco: BancoDeTeste;
const clock = new ManualClock(T0);
before(async () => {
  banco = await bancoDeTeste();
});
after(() => banco.fechar());

let n = 0;
const usuario = (nome: string) => `${nome}-md${++n}`;
const missoes = <T>(u: string, fn: (ms: ReturnType<typeof missoesNaTransacao>) => Promise<T>) =>
  comoUsuario(banco.db, u, (tx) => fn(missoesNaTransacao(tx, motorNaTransacao(tx, { clock }), clock)));
const MANDATO = { ferramentas: ["google_agenda/*"], prazoFinalEm: new Date(T0.getTime() + 24 * 3_600_000), ambientes: ["homologacao" as const] };

describe("mandato e gasto do mês no banco (D20, M4; D21)", () => {
  it("o mandato fica na missão e o app não o altera depois", async () => {
    const ana = usuario("ana");
    const m = await missoes(ana, (ms) => ms.criar(ana, "obedient", "x", { mandato: MANDATO }));
    assert.deepEqual((await missoes(ana, (ms) => ms.get(m.id)))?.mandato, MANDATO);
    await assert.rejects(comoUsuario(banco.db, ana, (tx) => tx.query("update obedient.missions set mandato_ferramentas = null where id = $1", [m.id])), /permission denied/);
    await assert.rejects(comoUsuario(banco.db, ana, (tx) => tx.query("update obedient.missions set prazo_final_em = null where id = $1", [m.id])), /permission denied/);
    await assert.rejects(comoUsuario(banco.db, ana, (tx) => tx.query("update obedient.missions set mandato_ambientes = null where id = $1", [m.id])), /permission denied/);
  });

  it("sem mandato, a missão lê como livre (null, null)", async () => {
    const ana = usuario("ana");
    const m = await missoes(ana, (ms) => ms.criar(ana, "obedient", "x"));
    assert.deepEqual((await missoes(ana, (ms) => ms.get(m.id)))?.mandato, { ferramentas: null, prazoFinalEm: null, ambientes: null });
  });

  it("o banco recusa mandato que não seja lista, vazio ou com mais de 30", async () => {
    const ana = usuario("ana");
    for (const lista of ["{}", "[]", JSON.stringify(Array.from({ length: 31 }, (_, i) => `gmail/f${i}`))])
      await assert.rejects(
        comoUsuario(banco.db, ana, (tx) =>
          tx.query(
            `insert into obedient.missions (id, user_id, agente, objetivo, estado, tentativas, max_tentativas, proxima_tentativa_em, custo_centavos, teto_custo_centavos, criada_em, atualizada_em, versao, mandato_ferramentas)
             values ($1, $2, 'obedient', 'x', 'created', 0, 3, $3, 0, 500, $3, $3, 1, $4::jsonb)`,
            [`md-${++n}`, ana, T0, lista],
          ),
        ),
        /check constraint/,
        lista.slice(0, 20),
      );
  });

  it("o banco recusa ambiente fora da lista fechada (M5)", async () => {
    const ana = usuario("ana");
    await assert.rejects(
      comoUsuario(banco.db, ana, (tx) =>
        tx.query(
          `insert into obedient.missions (id, user_id, agente, objetivo, estado, tentativas, max_tentativas, proxima_tentativa_em, custo_centavos, teto_custo_centavos, criada_em, atualizada_em, versao, mandato_ambientes)
           values ($1, $2, 'obedient', 'x', 'created', 0, 3, $3, 0, 500, $3, $3, 1, '["prod"]'::jsonb)`,
          [`md-${++n}`, ana, T0],
        ),
      ),
      /check constraint/,
    );
  });

  it("gasto: soma do mês por pessoa, RLS, só inserção e centavos positivos", async () => {
    const ana = usuario("ana");
    const bia = usuario("bia");
    const m = await missoes(ana, (ms) => ms.criar(ana, "obedient", "x"));
    await missoes(ana, async (ms) => {
      const r = await ms.reservar(m.id);
      return ms.concluir(r.missao, { tipo: "nao_consegui", explicacao: "não deu", custoCentavos: 120 });
    });
    assert.equal(await missoes(ana, (ms) => ms.gastoDoMes(ana)), 120);
    assert.equal(await missoes(bia, (ms) => ms.gastoDoMes(bia)), 0);
    const { rows } = await comoUsuario(banco.db, bia, (tx) => tx.query("select * from obedient.mission_spend where mission_id = $1", [m.id]));
    assert.deepEqual(rows, [], "a outra pessoa não vê");
    await assert.rejects(comoUsuario(banco.db, ana, (tx) => tx.query("update obedient.mission_spend set centavos = 1 where mission_id = $1", [m.id])), /permission denied/);
    await assert.rejects(comoUsuario(banco.db, ana, (tx) => tx.query("delete from obedient.mission_spend where mission_id = $1", [m.id])), /permission denied/);
    await assert.rejects(comoUsuario(banco.db, ana, (tx) => tx.query("insert into obedient.mission_spend (user_id, mission_id, tentativa, centavos, em) values ($1, $2, 1, 0, $3)", [ana, m.id, T0])), /check constraint/);
    await assert.rejects(comoUsuario(banco.db, bia, (tx) => tx.query("insert into obedient.mission_spend (user_id, mission_id, tentativa, centavos, em) values ($1, $2, 1, 5, $3)", [ana, m.id, T0])), /row-level security|violates/);
  });

  it("teto do mês: com o teto gasto, a próxima missão para antes de tentar (created → blocked)", async () => {
    const ana = usuario("ana");
    const cara = await missoes(ana, (ms) => ms.criar(ana, "obedient", "cara", { tetoCustoCentavos: 10_000 }));
    await comoUsuario(banco.db, ana, (tx) => tx.query("insert into obedient.mission_spend (user_id, mission_id, tentativa, centavos, em) values ($1, $2, 1, $3, $4)", [ana, cara.id, TETO_MENSAL_CENTAVOS, T0]));
    const outra = await missoes(ana, (ms) => ms.criar(ana, "obedient", "outra"));
    const r = await missoes(ana, (ms) => ms.reservar(outra.id));
    assert.equal(r.missao.estado, "blocked");
    assert.match(r.missao.impedimento!, /teto do mês/);
  });

  it("apagar esvazia o mandato e o objetivo, mas não o gasto (o teto do mês não zera)", async () => {
    const ana = usuario("ana");
    const m = await missoes(ana, (ms) => ms.criar(ana, "obedient", "x", { mandato: MANDATO }));
    await missoes(ana, async (ms) => {
      const r = await ms.reservar(m.id);
      return ms.concluir(r.missao, { tipo: "nao_consegui", explicacao: "não deu", custoCentavos: 77 });
    });
    await comoUsuario(banco.db, ana, (tx) => apagarMeusDados(tx, motorNaTransacao(tx, { clock }).audit, ana, clock));
    assert.equal((await missoes(ana, (ms) => ms.get(m.id)))?.mandato.ferramentas, null);
    assert.equal(await missoes(ana, (ms) => ms.gastoDoMes(ana)), 77);
  });
});

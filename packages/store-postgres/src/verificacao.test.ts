// SPDX-License-Identifier: AGPL-3.0-only
//
// Critérios e evidências no banco (D20, M3): RLS por pessoa, evidência só de inserção, critérios fixos
// depois de criada a missão, limites no próprio banco, terminar só por verifying e "apagar".

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ManualClock } from "@obedient/core";
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
const usuario = (nome: string) => `${nome}-v${++n}`;
const missoes = <T>(u: string, fn: (ms: ReturnType<typeof missoesNaTransacao>) => Promise<T>) =>
  comoUsuario(banco.db, u, (tx) => fn(missoesNaTransacao(tx, motorNaTransacao(tx, { clock }), clock)));
const CRITERIO = [{ tipo: "ferramenta_ok" as const, ferramenta: "gmail/*" }];

/** Missão terminada pela verificação (sem critério), com uma evidência gravada. */
async function terminada(u: string) {
  const m = await missoes(u, (ms) => ms.criar(u, "obedient", "x"));
  await missoes(u, async (ms) => {
    const r = await ms.reservar(m.id);
    return ms.concluir(r.missao, { tipo: "feito", explicacao: "ok", custoCentavos: 1 });
  });
  return m;
}

describe("critérios e evidências no banco (D20, M3)", () => {
  it("os critérios ficam na missão e o app não os altera depois", async () => {
    const ana = usuario("ana");
    const m = await missoes(ana, (ms) => ms.criar(ana, "obedient", "x", { criterios: CRITERIO }));
    assert.deepEqual((await missoes(ana, (ms) => ms.get(m.id)))?.criterios, CRITERIO);
    await assert.rejects(comoUsuario(banco.db, ana, (tx) => tx.query("update obedient.missions set criterios = '[]' where id = $1", [m.id])), /permission denied/);
  });

  it("o banco recusa critérios que não sejam lista, ou mais de 10", async () => {
    const ana = usuario("ana");
    const m = await missoes(ana, (ms) => ms.criar(ana, "obedient", "x"));
    await assert.rejects(
      comoUsuario(banco.db, ana, (tx) =>
        tx.query(
          `insert into obedient.missions (id, user_id, agente, objetivo, estado, tentativas, max_tentativas, proxima_tentativa_em, custo_centavos, teto_custo_centavos, criada_em, atualizada_em, versao, criterios)
           values ($1, $2, 'obedient', 'x', 'created', 0, 3, $3, 0, 500, $3, $3, 1, $4::jsonb)`,
          [`${m.id}-2`, ana, T0, JSON.stringify(Array.from({ length: 11 }, () => CRITERIO[0]))],
        ),
      ),
      /check constraint/,
    );
  });

  it("terminar passa por verifying: o banco recusa running → completed direto", async () => {
    const ana = usuario("ana");
    const m = await missoes(ana, (ms) => ms.criar(ana, "obedient", "x"));
    await missoes(ana, (ms) => ms.reservar(m.id));
    await assert.rejects(
      comoUsuario(banco.db, ana, (tx) => tx.query("update obedient.missions set estado = 'completed', desfecho_tipo = 'feito' where id = $1", [m.id])),
      /running → completed/,
    );
  });

  it("evidência: RLS por pessoa, só inserção e CHECKs", async () => {
    const ana = usuario("ana");
    const bia = usuario("bia");
    const m = await terminada(ana);
    assert.equal((await missoes(ana, (ms) => ms.evidencias(m.id))).length, 1);
    assert.deepEqual(await missoes(bia, (ms) => ms.evidencias(m.id)), []);
    await assert.rejects(comoUsuario(banco.db, ana, (tx) => tx.query("update obedient.mission_evidence set ok = false where mission_id = $1", [m.id])), /permission denied/);
    await assert.rejects(comoUsuario(banco.db, ana, (tx) => tx.query("delete from obedient.mission_evidence where mission_id = $1", [m.id])), /permission denied/);
    const inserir = (criterio: number | null, tipo: string) =>
      comoUsuario(banco.db, ana, (tx) =>
        tx.query("insert into obedient.mission_evidence (mission_id, user_id, tentativa, seq, criterio, tipo, ok, detalhe, criado_em) values ($1, $2, 1, 99, $3, $4, true, 'x', $5)", [m.id, ana, criterio, tipo, T0]),
      );
    await assert.rejects(inserir(0, "sem_criterio"), /check constraint/, "sem_criterio não aponta critério");
    await assert.rejects(inserir(null, "ferramenta_ok"), /check constraint/, "ferramenta_ok aponta um critério");
    await assert.rejects(inserir(0, "o_agente_disse"), /check constraint/);
    await assert.rejects(
      comoUsuario(banco.db, bia, (tx) =>
        tx.query("insert into obedient.mission_evidence (mission_id, user_id, tentativa, seq, criterio, tipo, ok, detalhe, criado_em) values ($1, $2, 1, 98, null, 'sem_criterio', true, 'x', $3)", [m.id, ana, T0]),
      ),
      /row-level security|violates/,
    );
  });

  it("apagar o que o OBEDIENT sabe apaga as evidências e esvazia os critérios", async () => {
    const ana = usuario("ana");
    const m = await terminada(ana);
    const c = await missoes(ana, (ms) => ms.criar(ana, "obedient", "y", { criterios: CRITERIO }));
    const r = await comoUsuario(banco.db, ana, (tx) => apagarMeusDados(tx, motorNaTransacao(tx, { clock }).audit, ana, clock));
    assert.equal(r.evidencias, 1);
    assert.deepEqual(await missoes(ana, (ms) => ms.evidencias(m.id)), []);
    assert.deepEqual((await missoes(ana, (ms) => ms.get(c.id)))?.criterios, []);
  });
});

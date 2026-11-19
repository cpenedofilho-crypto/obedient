// SPDX-License-Identifier: AGPL-3.0-only
//
// Estados da missão no banco (D20, M2): a tabela de transições do banco é a mesma do código, o gatilho
// recusa o que estiver fora dela (e missão que não nasce created), e a migration leva as missões que
// já existiam ao estado certo.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { ManualClock } from "@obedient/core";
import { TRANSICOES } from "@obedient/missions";
import { bancoDeTeste, dePglite, type BancoDeTeste } from "./banco-de-teste.ts";
import { migrate, migrations } from "./migrate.ts";
import { comoOperador, comoUsuario, missoesNaTransacao, motorNaTransacao, pessoasComMissaoDevida } from "./index.ts";

const T0 = new Date("2026-11-19T12:00:00Z");
let banco: BancoDeTeste;
const clock = new ManualClock(T0);
before(async () => {
  banco = await bancoDeTeste();
});
after(() => banco.fechar());

let n = 0;
const usuario = (nome: string) => `${nome}-e${++n}`;
const missoes = <T>(u: string, fn: (ms: ReturnType<typeof missoesNaTransacao>) => Promise<T>) =>
  comoUsuario(banco.db, u, (tx) => fn(missoesNaTransacao(tx, motorNaTransacao(tx, { clock }), clock)));

describe("estados da missão no banco (D20, M2)", () => {
  it("a tabela de transições do banco é exatamente a do código (TRANSICOES)", async () => {
    const u = usuario("ana");
    const { rows } = await comoUsuario(banco.db, u, (tx) => tx.query<{ de: string; para: string }>("select de, para from obedient.mission_transitions order by de, para"));
    const doBanco = rows.map((r) => `${r.de}→${r.para}`).sort();
    const doCodigo = Object.entries(TRANSICOES).flatMap(([de, ps]) => ps.map((p) => `${de}→${p}`)).sort();
    assert.deepEqual(doBanco, doCodigo);
  });

  it("o gatilho recusa transição fora da tabela, mesmo se o código errar, e aceita a que está nela", async () => {
    const u = usuario("ana");
    const m = await missoes(u, (ms) => ms.criar(u, "obedient", "x"));
    assert.equal(m.estado, "created");
    for (const para of ["completed", "waiting_approval", "verifying", "retrying"])
      await assert.rejects(comoUsuario(banco.db, u, (tx) => tx.query("update obedient.missions set estado = $2, desfecho_tipo = 'feito' where id = $1", [m.id, para])), /transição de estado não permitida: created → /, para);
    await comoUsuario(banco.db, u, (tx) => tx.query("update obedient.missions set estado = 'cancelled' where id = $1", [m.id]));
    await assert.rejects(comoUsuario(banco.db, u, (tx) => tx.query("update obedient.missions set estado = 'created' where id = $1", [m.id])), /cancelled → created/, "terminal não sai");
  });

  it("missão nasce created: o banco recusa inserir em outro estado", async () => {
    const u = usuario("ana");
    await assert.rejects(
      comoUsuario(banco.db, u, (tx) =>
        tx.query(
          `insert into obedient.missions (id, user_id, agente, objetivo, estado, tentativas, max_tentativas, proxima_tentativa_em, custo_centavos, teto_custo_centavos, criada_em, atualizada_em, versao)
           values ('direto', $1, 'obedient', 'x', 'running', 0, 3, $2, 0, 500, $2, $2, 1)`,
          [u, T0],
        ),
      ),
      /missão nasce created/,
    );
  });

  it("created e retrying são devidas para o agendador quando a hora chega", async () => {
    const u = usuario("ana");
    await missoes(u, (ms) => ms.criar(u, "obedient", "x"));
    const devidas = await comoOperador(banco.db, (tx) => pessoasComMissaoDevida(tx, T0, 1000));
    assert.ok(devidas.includes(u));
  });

  it("a migration leva as missões que já existiam ao estado certo", async () => {
    const lite = new PGlite();
    const db = dePglite(lite);
    try {
      const todas = migrations();
      const ate = todas.findIndex((x) => x.name.startsWith("0009_"));
      assert.ok(ate > 0, "existe a 0009");
      await db.exec(`create schema if not exists obedient;
        create table if not exists obedient.schema_migrations (name text primary key, hash text not null, applied_at timestamptz not null default now())`);
      for (const x of todas.slice(0, ate)) {
        await db.exec(x.sql);
        await db.query("insert into obedient.schema_migrations (name, hash) values ($1, $2)", [x.name, x.hash]);
      }
      const inserir = (id: string, tentativas: number, reservadaAte: Date | null) =>
        db.query(
          `insert into obedient.missions (id, user_id, agente, objetivo, estado, tentativas, max_tentativas, proxima_tentativa_em, reservada_ate, custo_centavos, teto_custo_centavos, criada_em, atualizada_em, versao)
           values ($1, 'ana-legado', 'obedient', 'x', 'running', $2, 3, $3, $4, 0, 500, $3, $3, 1)`,
          [id, tentativas, T0, reservadaAte],
        );
      await inserir("nova", 0, null);
      await inserir("tentou", 2, null);
      await inserir("rodando", 1, new Date(T0.getTime() + 60_000));
      assert.deepEqual(await migrate(db), todas.slice(ate).map((x) => x.name));
      const { rows } = await db.query<{ id: string; estado: string }>("select id, estado from obedient.missions order by id");
      assert.deepEqual(rows.map((r) => [r.id, r.estado]), [["nova", "created"], ["rodando", "running"], ["tentou", "retrying"]]);
    } finally {
      await lite.close();
    }
  });
});

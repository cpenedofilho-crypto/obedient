// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// As migrations rodando como papel que NÃO é superusuário (como no Supabase, onde `postgres` só tem
// CREATEROLE). Fora de superusuário, `alter function ... owner to X` exige que X tenha CREATE no
// schema; o migrate dá esse CREATE só durante cada migration e tira no fim.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { dePglite } from "./banco-de-teste.ts";
import { migrate, migrations } from "./migrate.ts";
import type { Database } from "./db.ts";

let lite: PGlite;
let db: Database;
before(async () => {
  lite = new PGlite();
  await lite.exec(`create role migrador login createrole nosuperuser;
    grant create on database postgres to migrador;
    set role migrador`);
  db = dePglite(lite);
});
after(async () => {
  await lite.close();
});

const DONOS_DE_FUNCAO = ["obedient_eraser", "obedient_scheduler"];

describe("migrate: papel dono sem superusuário", () => {
  it("o papel que roda não é superusuário", async () => {
    const r = await lite.query<{ super: boolean }>("select rolsuper as super from pg_roles where rolname = current_user");
    assert.equal(r.rows[0]?.super, false);
  });

  it("aplica todas as migrations", async () => {
    assert.deepEqual(await migrate(db), migrations().map((m) => m.name));
    assert.deepEqual(await migrate(db), []);
  });

  it("as funções ficam com o dono certo", async () => {
    const r = await lite.query<{ nome: string; dono: string }>(
      `select p.proname as nome, pg_get_userbyid(p.proowner) as dono from pg_proc p
       where p.pronamespace = 'obedient'::regnamespace and p.proname in ('apagar_meus_dados', 'pessoas_com_missao_devida')
       order by 1`,
    );
    assert.deepEqual(r.rows, [
      { nome: "apagar_meus_dados", dono: "obedient_eraser" },
      { nome: "pessoas_com_missao_devida", dono: "obedient_scheduler" },
    ]);
  });

  it("os donos de função não ficam com CREATE no schema", async () => {
    for (const papel of DONOS_DE_FUNCAO) {
      const r = await lite.query<{ cria: boolean; usa: boolean }>(
        "select has_schema_privilege($1, 'obedient', 'CREATE') as cria, has_schema_privilege($1, 'obedient', 'USAGE') as usa",
        [papel],
      );
      assert.deepEqual(r.rows[0], { cria: false, usa: true }, papel);
    }
  });
});

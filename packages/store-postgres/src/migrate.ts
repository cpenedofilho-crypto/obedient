// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Aplica as migrations de sql/ em ordem e registra cada uma. Roda com o papel DONO do schema
// (nunca com o papel de login do servidor). As migrations são idempotentes; o registro só evita
// trabalho repetido e mostra o que está aplicado.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { sha256Hex } from "@obedient/core";
import type { Database } from "./db.ts";

const PASTA = fileURLToPath(new URL("../sql/", import.meta.url));

// Papéis que viram donos de função SECURITY DEFINER (`alter function ... owner to`). Fora de
// superusuário (ex.: Supabase, onde `postgres` só tem CREATEROLE), o Postgres exige que o novo dono
// tenha CREATE no schema. As migrations já aplicadas não podem mudar (o hash é conferido), então o
// CREATE é dado aqui, só durante cada migration e na mesma transação, e tirado antes do commit: os
// papéis nunca ficam com CREATE. Criados antes (se não existem) para o grant ter a quem se dirigir;
// as migrations que os criam usam `if not exists`.
const DONOS_DE_FUNCAO = ["obedient_eraser", "obedient_scheduler"] as const;

const ANTES = `do $$
begin
${DONOS_DE_FUNCAO.map((r) => `  if not exists (select from pg_roles where rolname = '${r}') then create role ${r} nologin; end if;`).join("\n")}
end $$;
grant create on schema obedient to ${DONOS_DE_FUNCAO.join(", ")}`;
const DEPOIS = `revoke create on schema obedient from ${DONOS_DE_FUNCAO.join(", ")}`;

export interface Migration {
  name: string;
  sql: string;
  hash: string;
}

export function migrations(): Migration[] {
  return readdirSync(PASTA)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(PASTA, name), "utf8");
      return { name, sql, hash: sha256Hex(sql) };
    });
}

/** Devolve os nomes aplicados nesta chamada. Migration já aplicada com conteúdo diferente é erro. */
export async function migrate(db: Database): Promise<string[]> {
  await db.exec(`create schema if not exists obedient;
    create table if not exists obedient.schema_migrations (name text primary key, hash text not null, applied_at timestamptz not null default now())`);
  const feitas = new Map((await db.query<{ name: string; hash: string }>("select name, hash from obedient.schema_migrations")).rows.map((r) => [r.name, r.hash]));
  const aplicadas: string[] = [];
  for (const m of migrations()) {
    const anterior = feitas.get(m.name);
    if (anterior === m.hash) continue;
    if (anterior) throw new Error(`migration ${m.name} já aplicada com outro conteúdo: crie uma migration nova em vez de editar`);
    await db.transaction(async (tx) => {
      await tx.exec(ANTES);
      await tx.exec(m.sql);
      await tx.exec(DEPOIS);
      await tx.query("insert into obedient.schema_migrations (name, hash) values ($1, $2)", [m.name, m.hash]);
    });
    aplicadas.push(m.name);
  }
  return aplicadas;
}

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
      await tx.exec(m.sql);
      await tx.query("insert into obedient.schema_migrations (name, hash) values ($1, $2)", [m.name, m.hash]);
    });
    aplicadas.push(m.name);
  }
  return aplicadas;
}

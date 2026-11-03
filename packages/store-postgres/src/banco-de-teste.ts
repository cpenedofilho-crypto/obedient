// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Banco para os testes. Sem variável de ambiente: PGlite (Postgres 17 em WebAssembly, em memória),
// que aplica papéis e RLS de verdade. Com OBEDIENT_TEST_DATABASE_URL: um Postgres real (no CI, um
// serviço descartável), onde as transações concorrem de fato. O schema é recriado a cada banco.
// Só para teste: recusa endereço que não seja local.

import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { type Database, fromPgPool } from "./db.ts";
import { migrate } from "./migrate.ts";

export interface BancoDeTeste {
  db: Database;
  tipo: "pglite" | "postgres";
  fechar(): Promise<void>;
}

export async function bancoDeTeste(): Promise<BancoDeTeste> {
  const url = process.env.OBEDIENT_TEST_DATABASE_URL?.trim();
  if (url) {
    const host = new URL(url).hostname;
    if (!["localhost", "127.0.0.1", "::1", "postgres"].includes(host)) throw new Error(`banco de teste precisa ser local, não ${host}`);
    const pool = new pg.Pool({ connectionString: url, max: 8 });
    await pool.query("drop schema if exists obedient cascade");
    const db = fromPgPool(pool);
    await migrate(db);
    return { db, tipo: "postgres", fechar: () => pool.end() };
  }
  const lite = new PGlite();
  const db: Database = {
    query: async <R>(sql: string, params?: unknown[]) => (await lite.query(sql, params)) as unknown as { rows: R[] },
    exec: (sql: string) => lite.exec(sql),
    transaction: <T>(fn: Parameters<Database["transaction"]>[0]) =>
      lite.transaction(async (tx) =>
        fn({
          query: async <R>(sql: string, params?: unknown[]) => (await tx.query(sql, params)) as unknown as { rows: R[] },
          exec: (sql: string) => tx.exec(sql),
        }),
      ) as Promise<T>,
  };
  await migrate(db);
  return { db, tipo: "pglite", fechar: () => lite.close() };
}

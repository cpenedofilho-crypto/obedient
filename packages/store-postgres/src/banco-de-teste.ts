// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Banco para os testes. Sem variável de ambiente: PGlite (Postgres 17 em WebAssembly, em memória),
// que aplica papéis e RLS de verdade. Com OBEDIENT_TEST_DATABASE_URL: um Postgres real (no CI, um
// serviço descartável), onde as transações concorrem de fato. Cada processo cria e apaga o próprio banco.
// Só para teste: recusa endereço que não seja local.

import { randomBytes } from "node:crypto";
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
    // Cada processo de teste ganha um banco só dele (os arquivos de teste rodam em paralelo). Os
    // papéis são do cluster inteiro: a migration roda sob uma trava no banco administrativo, para
    // dois processos não criarem o mesmo papel ao mesmo tempo.
    const nome = `obedient_t_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`create database ${nome}`);
    const u = new URL(url);
    u.pathname = `/${nome}`;
    const pool = new pg.Pool({ connectionString: u.toString(), max: 8 });
    // Conexão ociosa derrubada quando o banco é apagado no fim: esperado, não é falha de teste.
    pool.on("error", () => {});
    const db = fromPgPool(pool);
    await admin.query("select pg_advisory_lock(424242)");
    try {
      await migrate(db);
    } finally {
      await admin.query("select pg_advisory_unlock(424242)");
    }
    return {
      db,
      tipo: "postgres",
      fechar: async () => {
        await pool.end();
        await admin.query(`drop database if exists ${nome} with (force)`);
        await admin.end();
      },
    };
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

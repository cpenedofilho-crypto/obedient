// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// O mínimo que o pacote precisa de um banco: rodar SQL parametrizado e abrir transação. O pacote não
// depende de driver: `fromPgPool` adapta o `pg` (produção) e o PGlite já tem esse formato (testes).

export interface Executor {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
  /** Script com vários comandos e sem parâmetro (migrations). */
  exec(sql: string): Promise<unknown>;
}

export interface Database extends Executor {
  transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T>;
}

/** O que usamos de um `pg.Pool`, sem importar o `pg`. */
export interface PgPoolLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  connect(): Promise<{
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
    release(err?: Error | boolean): void;
  }>;
}

export function fromPgPool(pool: PgPoolLike): Database {
  return {
    query: async <R>(sql: string, params?: unknown[]) => (await pool.query(sql, params)) as { rows: R[] },
    // Sem parâmetro, o pg usa o protocolo simples, que aceita vários comandos.
    exec: (sql: string) => pool.query(sql),
    async transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const tx: Executor = {
          query: async <R>(sql: string, params?: unknown[]) => (await client.query(sql, params)) as { rows: R[] },
          exec: (sql: string) => client.query(sql),
        };
        const out = await fn(tx);
        await client.query("commit");
        client.release();
        return out;
      } catch (e) {
        try {
          await client.query("rollback");
          client.release();
        } catch {
          // Conexão quebrada: descarta, para não voltar ao pool com transação aberta.
          client.release(true);
        }
        throw e;
      }
    },
  };
}

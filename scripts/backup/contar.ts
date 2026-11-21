// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Conta as linhas de cada tabela do schema obedient e confere as migrations (A4, backup).
// Só números e nomes de tabela: nenhum conteúdo sai daqui.
//
//   node --import tsx scripts/backup/contar.ts <url>                 imprime {tabela: linhas}
//   node --import tsx scripts/backup/contar.ts <url> <contagem.json>  confere contra a do backup
//
// A conexão precisa ver todas as linhas (superusuário ou BYPASSRLS): as tabelas têm RLS forçada.

import { readFileSync } from "node:fs";
import pg from "pg";
import { conferirMigracoes, fromPgPool } from "@obedient/store-postgres";

async function main() {
  const [url, esperadoArq] = process.argv.slice(2);
  if (!url) throw new Error("uso: contar.ts <url> [contagem.json]");
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  try {
    const c = await pool.connect();
    try {
      await c.query("set row_security = off");
      const { rows } = await c.query<{ t: string }>("select tablename as t from pg_tables where schemaname = 'obedient' order by tablename");
      const contagem: Record<string, number> = {};
      for (const { t } of rows) {
        const r = await c.query<{ n: string }>(`select count(*)::text as n from obedient.${pg.escapeIdentifier(t)}`);
        contagem[t] = Number(r.rows[0]!.n);
      }
      if (!esperadoArq) {
        process.stdout.write(`${JSON.stringify(contagem, null, 2)}\n`);
        return;
      }
      const esperado = JSON.parse(readFileSync(esperadoArq, "utf8")) as Record<string, number>;
      const diferencas = [...new Set([...Object.keys(esperado), ...Object.keys(contagem)])]
        .filter((t) => esperado[t] !== contagem[t])
        .map((t) => `${t}: backup ${esperado[t] ?? "ausente"}, restaurado ${contagem[t] ?? "ausente"}`);
      const { pendentes, divergentes } = await conferirMigracoes(fromPgPool(pool));
      if (pendentes.length || divergentes.length) diferencas.push(`migrations pendentes: ${pendentes.join(", ") || "-"}; divergentes: ${divergentes.join(", ") || "-"}`);
      if (diferencas.length) {
        console.error(`restauração NÃO confere:\n  ${diferencas.join("\n  ")}`);
        process.exitCode = 1;
        return;
      }
      console.log(`restauração confere: ${Object.keys(contagem).length} tabelas, ${Object.values(contagem).reduce((a, b) => a + b, 0)} linhas, migrations em dia`);
    } finally {
      c.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

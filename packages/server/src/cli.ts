// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Linha de comando do dono do servidor.
//
//   node --import tsx packages/server/src/cli.ts migrar
//   node --import tsx packages/server/src/cli.ts convite <usuario>
//   node --import tsx packages/server/src/cli.ts servir
//
// Variáveis:
//   OBEDIENT_DATABASE_URL        conexão do SERVIDOR (papel de login membro de obedient_app/_operator/_auth)
//   OBEDIENT_OWNER_DATABASE_URL  conexão do DONO do schema (só migrar e convite)
//   OBEDIENT_ORIGIN              origem exata do app, ex.: https://obedient.exemplo.org
//   OBEDIENT_RP_ID               domínio das passkeys, ex.: obedient.exemplo.org (padrão: o host da origem)
//   OBEDIENT_PORT                porta (padrão 3010)

import pg from "pg";
import { fromPgPool, migrate } from "@obedient/store-postgres";
import { criarApi } from "./api.ts";
import { servidorHttp } from "./http.ts";
import { Passkeys } from "./passkeys.ts";

const env = (k: string) => process.env[k]?.trim() || undefined;

function banco(variavel: string) {
  const url = env(variavel);
  if (!url) throw new Error(`defina ${variavel}`);
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  // Conexão ociosa que o Postgres derruba (reinício, failover) emite erro no pool. Sem ouvinte, o
  // processo inteiro cai; com ele, o pool abre outra conexão no próximo pedido.
  pool.on("error", (e) => console.error(JSON.stringify({ evento: "banco.conexao_perdida", erro: e.message })));
  return { db: fromPgPool(pool), fechar: () => pool.end() };
}

async function main(argv: string[]) {
  const [comando, ...resto] = argv;
  if (comando === "migrar") {
    const { db, fechar } = banco("OBEDIENT_OWNER_DATABASE_URL");
    const feitas = await migrate(db);
    console.log(feitas.length ? `aplicadas: ${feitas.join(", ")}` : "nada a aplicar");
    return fechar();
  }
  if (comando === "convite") {
    const usuario = resto[0];
    if (!usuario) throw new Error("uso: convite <usuario>");
    const { db, fechar } = banco("OBEDIENT_OWNER_DATABASE_URL");
    const { codigo, venceEm } = await Passkeys.criarConvite(db, usuario);
    console.log(`convite para ${usuario}: ${codigo} (vale até ${venceEm.toISOString()}, uma vez só)`);
    return fechar();
  }
  if (comando === "servir") {
    const origin = env("OBEDIENT_ORIGIN");
    if (!origin) throw new Error("defina OBEDIENT_ORIGIN");
    const rpId = env("OBEDIENT_RP_ID") ?? new URL(origin).hostname;
    const { db } = banco("OBEDIENT_DATABASE_URL");
    const porta = Number(env("OBEDIENT_PORT") ?? 3010);
    servidorHttp(criarApi(db, { rpName: "OBEDIENT", rpId, origin })).listen(porta, () => console.log(`OBEDIENT em ${origin} (porta ${porta})`));
    return;
  }
  throw new Error("comandos: migrar | convite <usuario> | servir");
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

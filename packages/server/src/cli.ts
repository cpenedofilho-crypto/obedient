// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Linha de comando do dono do servidor.
//
//   node --import tsx packages/server/src/cli.ts migrar
//   node --import tsx packages/server/src/cli.ts convite <usuario>
//   node --import tsx packages/server/src/cli.ts servir
//   node --import tsx packages/server/src/cli.ts chave       (gera uma chave nova para o cofre)
//   node --import tsx packages/server/src/cli.ts growth-os conceder|retirar <usuario>
//   node --import tsx packages/server/src/cli.ts mcp conceder|retirar <servidor> <usuario>
//
// Variáveis:
//   OBEDIENT_DATABASE_URL        conexão do SERVIDOR (papel de login membro de obedient_app/_operator/_auth)
//   OBEDIENT_OWNER_DATABASE_URL  conexão do DONO do schema (só migrar e convite)
//   OBEDIENT_ORIGIN              origem exata do app, ex.: https://obedient.exemplo.org
//   OBEDIENT_RP_ID               domínio das passkeys, ex.: obedient.exemplo.org (padrão: o host da origem)
//   OBEDIENT_PORT                porta (padrão 3010)
//   OBEDIENT_GOOGLE_CLIENT_ID     } cliente OAuth do Google (opcional: sem eles, as integrações ficam desligadas).
//   OBEDIENT_GOOGLE_CLIENT_SECRET }   Redirect cadastrado no Google: <OBEDIENT_ORIGIN>/api/conexoes/retorno
//   OBEDIENT_CHAVES_COFRE        chaves do cofre de credenciais, "id:base64,…" (gere com: cli.ts chave)
//   OBEDIENT_AGENTE              "ligado" para o servidor executar as missões com o modelo (padrão: desligado).
//                                A credencial da Anthropic vem do ambiente, como o SDK lê (ANTHROPIC_API_KEY).
//   OBEDIENT_MODELO              modelo (padrão claude-opus-5-5; precisa estar na tabela de preços)
//   OBEDIENT_ESFORCO             low | medium | high | xhigh | max (padrão high)
//   OBEDIENT_FALLBACK            "desligado" para não refazer no servidor o que os classificadores recusarem
//   OBEDIENT_CENTAVOS_POR_DOLAR  câmbio para o teto de custo das missões (padrão 600, isto é, R$ 6,00: a mais)
//   OBEDIENT_FUSO                fuso das pessoas (padrão America/Sao_Paulo)
//   OBEDIENT_GROWTH_OS_*         Growth OS por A2A (growth-os.ts), todas ou nenhuma:
//     _CARD_URL                  https://<growth-os>/.well-known/agent-card.json
//     _TOKEN_URL                 token endpoint do WorkOS (client_credentials)
//     _CLIENT_ID                 client_id da aplicação M2M (não é segredo)
//     _SEGREDO                   client secret da aplicação M2M (segredo do ambiente; nunca no repositório)
//     _USUARIOS                  quem pode receber a autoridade, ids separados por vírgula
//   OBEDIENT_MCP_SERVIDORES      servidores MCP de fora, em JSON (mcp-servidores.ts):
//                                [{"id":"motor_iga","nome":"Motor IGA","url":"https://…/mcp",
//                                  "token_env":"OBEDIENT_MCP_MOTOR_IGA_TOKEN","usuarios":["Juca"],
//                                  "ferramentas":["motor_quem_sou_eu", …]}]
//   OBEDIENT_MCP_<…>_TOKEN       o token de cada servidor (segredo do ambiente; o JSON só diz o NOME)

import pg from "pg";
import Anthropic from "@anthropic-ai/sdk";
import { systemClock } from "@obedient/core";
import type { Esforco } from "@obedient/agent-orchestrator";
import { ModeloAnthropic } from "@obedient/modelo-anthropic";
import { fromPgPool, migrate } from "@obedient/store-postgres";
import { agendarMissoes } from "./agendador.ts";
import { executorDeMissoes } from "./executor.ts";
import { criarApi } from "./api.ts";
import { servidorHttp } from "./http.ts";
import { Passkeys } from "./passkeys.ts";
import { Cofre, Conexoes, lerChaves } from "@obedient/integrations";
import { comoUsuario, motorNaTransacao } from "@obedient/store-postgres";
import { clienteGrowthOs, concederGrowthOs, configGrowthOsDoAmbiente, retirarGrowthOs } from "./growth-os.ts";
import { type ServidorMcp, concederMcp, conexaoMcp, retirarMcp, servidoresMcpDoAmbiente, tokenDoAmbiente } from "./mcp-servidores.ts";
import { ConexoesMcp, comOAuth } from "./mcp-oauth.ts";

const ESFORCOS: readonly Esforco[] = ["low", "medium", "high", "xhigh", "max"];

/** O executor das missões, se o dono ligou. Erro de configuração para o servidor na subida, não depois. */
function agente(db: ReturnType<typeof banco>["db"], conexoes: Conexoes | null, servidoresMcp: ServidorMcp[], conexoesMcp: ConexoesMcp | null) {
  if (env("OBEDIENT_AGENTE") !== "ligado") {
    console.log("executor das missões desligado (OBEDIENT_AGENTE=ligado para ligar)");
    return;
  }
  const esforco = (env("OBEDIENT_ESFORCO") ?? "high") as Esforco;
  if (!ESFORCOS.includes(esforco)) throw new Error(`OBEDIENT_ESFORCO precisa ser ${ESFORCOS.join(" | ")}`);
  const centavosPorDolar = Number(env("OBEDIENT_CENTAVOS_POR_DOLAR") ?? 600);
  if (!Number.isFinite(centavosPorDolar) || centavosPorDolar <= 0) throw new Error("OBEDIENT_CENTAVOS_POR_DOLAR precisa ser um número positivo");
  const cliente = new Anthropic();
  const modelo = env("OBEDIENT_MODELO");
  const fallbacks = env("OBEDIENT_FALLBACK") !== "desligado";
  // Confere o modelo agora (sem preço conhecido, não sobe).
  const teste = new ModeloAnthropic({ cliente, ...(modelo ? { modelo } : {}), esforco, fallbacks });
  const growth = configGrowthOsDoAmbiente();
  console.log(growth ? `Growth OS por A2A ligado para ${growth.usuarios.size} pessoa(s)` : "Growth OS desligado (sem OBEDIENT_GROWTH_OS_*)");
  if (servidoresMcp.length) console.log(`servidores MCP: ${servidoresMcp.map((s) => `${s.id} (${s.ferramentas.length} ferramentas${comOAuth(s) ? ", OAuth da pessoa" : ""})`).join(", ")}`);
  // Token de máquina (variável de ambiente) ou o da PESSOA, conectado no app (mcp-oauth.ts).
  const tokenDe = (s: ServidorMcp, u: string) => (comOAuth(s) ? async () => (conexoesMcp ? conexoesMcp.tokenDeAcesso(u, s.id) : null) : tokenDoAmbiente(s));
  const executar = executorDeMissoes({
    db,
    conexoes,
    mcp: servidoresMcp.length ? { servidores: servidoresMcp, conexao: (s, u) => conexaoMcp(s, tokenDe(s, u)) } : null,
    log: (e) => console.log(JSON.stringify(e)),
    growthOs: growth ? { cliente: clienteGrowthOs(growth), usuarios: growth.usuarios } : null,
    novoModelo: () => new ModeloAnthropic({ cliente, modelo: teste.modelo, esforco, fallbacks }),
    centavosPorDolar,
    clock: systemClock,
    ...(env("OBEDIENT_FUSO") ? { fuso: env("OBEDIENT_FUSO")! } : {}),
  });
  agendarMissoes({ db, executar, clock: systemClock });
  console.log(`executor das missões ligado (${teste.modelo}, esforço ${esforco}${fallbacks ? ", com fallback" : ""})`);
}

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
  if (comando === "chave") {
    console.log(`k${new Date().toISOString().slice(0, 10).replace(/-/g, "")}:${Cofre.novaChave()}`);
    return;
  }
  if (comando === "growth-os") {
    const [acao, usuario] = resto;
    if ((acao !== "conceder" && acao !== "retirar") || !usuario) throw new Error("uso: growth-os conceder|retirar <usuario>");
    const cfg = configGrowthOsDoAmbiente();
    if (!cfg) throw new Error("Growth OS desligado: defina as OBEDIENT_GROWTH_OS_*");
    const { db, fechar } = banco("OBEDIENT_DATABASE_URL");
    await comoUsuario(db, usuario, async (tx) => {
      const motor = motorNaTransacao(tx, { clock: systemClock });
      if (acao === "conceder") await concederGrowthOs(motor, cfg, usuario, systemClock.now());
      else await retirarGrowthOs(motor, usuario);
    });
    console.log(acao === "conceder" ? `${usuario}: o agente pode ler o Growth OS por 30 dias (aparece no app e pode ser tirado)` : `${usuario}: autoridade no Growth OS retirada`);
    return fechar();
  }
  if (comando === "mcp") {
    const [acao, servidor, usuario] = resto;
    if ((acao !== "conceder" && acao !== "retirar") || !servidor || !usuario) throw new Error("uso: mcp conceder|retirar <servidor> <usuario>");
    const s = servidoresMcpDoAmbiente().find((x) => x.id === servidor);
    if (!s) throw new Error(`servidor MCP ${servidor} não está em OBEDIENT_MCP_SERVIDORES`);
    const { db, fechar } = banco("OBEDIENT_DATABASE_URL");
    await comoUsuario(db, usuario, async (tx) => {
      const motor = motorNaTransacao(tx, { clock: systemClock });
      if (acao === "conceder") await concederMcp(motor, s, usuario, systemClock.now());
      else await retirarMcp(motor, s.id, usuario);
    });
    console.log(acao === "conceder" ? `${usuario}: o agente pode ler ${s.nome} por 30 dias (${s.ferramentas.length} ferramentas; aparece no app e pode ser tirado)` : `${usuario}: autoridade em ${s.nome} retirada`);
    return fechar();
  }
  if (comando === "servir") {
    const origin = env("OBEDIENT_ORIGIN");
    if (!origin) throw new Error("defina OBEDIENT_ORIGIN");
    const rpId = env("OBEDIENT_RP_ID") ?? new URL(origin).hostname;
    const { db } = banco("OBEDIENT_DATABASE_URL");
    const porta = Number(env("OBEDIENT_PORT") ?? 3010);
    const idGoogle = env("OBEDIENT_GOOGLE_CLIENT_ID");
    const segredoGoogle = env("OBEDIENT_GOOGLE_CLIENT_SECRET");
    const google =
      idGoogle && segredoGoogle
        ? { cliente: { clientId: idGoogle, clientSecret: segredoGoogle, redirectUri: `${origin}/api/conexoes/retorno` }, cofre: new Cofre(lerChaves(env("OBEDIENT_CHAVES_COFRE"))) }
        : undefined;
    if (!google) console.log("integrações com o Google desligadas (sem OBEDIENT_GOOGLE_CLIENT_ID/SECRET)");
    const servidoresMcp = servidoresMcpDoAmbiente();
    const comOAuthDaPessoa = servidoresMcp.filter(comOAuth);
    if (comOAuthDaPessoa.length && !env("OBEDIENT_CHAVES_COFRE")) throw new Error("servidor MCP com oauth exige OBEDIENT_CHAVES_COFRE (a credencial da pessoa é guardada cifrada)");
    const conexoesMcp = comOAuthDaPessoa.length ? new ConexoesMcp(db, google?.cofre ?? new Cofre(lerChaves(env("OBEDIENT_CHAVES_COFRE"))), servidoresMcp, origin) : null;
    agente(db, google ? new Conexoes(db, google.cofre, google.cliente, fetch, systemClock) : null, servidoresMcp, conexoesMcp);
    servidorHttp(criarApi(db, { rpName: "OBEDIENT", rpId, origin, ...(google ? { google } : {}), ...(conexoesMcp ? { mcp: { conexoes: conexoesMcp, servidores: servidoresMcp } } : {}) })).listen(porta, () => console.log(`OBEDIENT em ${origin} (porta ${porta})`));
    return;
  }
  throw new Error("comandos: migrar | convite <usuario> | chave | growth-os conceder|retirar <usuario> | mcp conceder|retirar <servidor> <usuario> | servir");
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

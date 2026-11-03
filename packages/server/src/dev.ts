// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Servidor de DESENVOLVIMENTO: banco em memória (PGlite), um usuário fictício com uma autorização e
// dois pedidos esperando, e um convite impresso no terminal. Nada aqui toca banco real. Também é a
// base dos testes de ponta a ponta (e2e/).
//
//   node --import tsx packages/server/src/dev.ts            → http://localhost:3010
//
// Dados fictícios: "Ana Praça", "Casa Bertoldi". Nunca dado de cliente.

import type { AddressInfo } from "node:net";
import { systemClock } from "@obedient/core";
import type { Server } from "node:http";
import type { Executor as ExecutorDeMissao } from "@obedient/missions";
import { comoUsuario, gravarIdentificacao, lerIdentificacao, memoriaNaTransacao, motorNaTransacao } from "@obedient/store-postgres";
import { processarMissoes } from "./processador.ts";
import { Cofre, lerChaves } from "@obedient/integrations";
import { GoogleFalso } from "../../integrations/src/google-falso.ts";
import { bancoDeTeste } from "../../store-postgres/src/banco-de-teste.ts";
import { criarApi } from "./api.ts";
import { servidorHttp } from "./http.ts";
import { Passkeys } from "./passkeys.ts";

export interface Dev {
  url: string;
  convite: string;
  usuario: string;
  /** O agente pede uma ação (para o teste criar pedidos novos). */
  pedir(tool: string, risk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL", category: string, args: Record<string, unknown>): Promise<string>;
  /** O agente tenta aprender algo (só guarda se a pessoa ligou a categoria). */
  lembrar(categoria: string, texto: string): Promise<"guardou" | "recusado">;
  /** O Google falso: no teste, faz o papel da tela de autorização (o navegador nunca sai para a internet). */
  google: GoogleFalso;
  /** Roda uma tentativa de cada missão devida, com o resultado que o teste escolher. */
  processar(executar: ExecutorDeMissao): Promise<void>;
  fechar(): Promise<void>;
}

export async function subirDev(porta = 3010, usuario = "ana.praca"): Promise<Dev> {
  const banco = await bancoDeTeste();
  // A origem depende da porta real (porta 0 = o sistema escolhe), então a API nasce depois do listen.
  let api: ReturnType<typeof criarApi> | null = null;
  const motor = <T>(fn: (m: ReturnType<typeof motorNaTransacao>) => Promise<T>) => comoUsuario(banco.db, usuario, (tx) => fn(motorNaTransacao(tx)));

  const em8h = new Date(Date.now() + 8 * 3600_000);
  await motor((m) =>
    m.grants.grant(
      { userId: usuario, agentId: "obedient", systemId: "email", capability: "email.*", purpose: "responder e-mails da Casa Bertoldi", limits: { maxRisk: "CRITICAL", autonomousUpTo: "LOW", maxAmount: null, amountField: null }, expiresAt: em8h },
      usuario,
    ),
  );
  await motor((m) =>
    m.grants.grant(
      { userId: usuario, agentId: "obedient", systemId: "agenda", capability: "agenda.ler_*", purpose: "montar o resumo do dia", limits: { maxRisk: "LOW", autonomousUpTo: "LOW", maxAmount: null, amountField: null }, expiresAt: em8h },
      usuario,
    ),
  );
  await comoUsuario(banco.db, usuario, (tx) => gravarIdentificacao(tx, usuario, "Enviada pelo assistente da Ana Praça"));
  // O agente de desenvolvimento faz o que o runtime fará: põe a identificação da pessoa em toda mensagem.
  const pedir: Dev["pedir"] = async (tool, risk, category, args) => {
    const identificacao = category === "COMMUNICATION" ? await comoUsuario(banco.db, usuario, (tx) => lerIdentificacao(tx, usuario)) : null;
    // Identificação explícita nos argumentos é respeitada (o teste usa para mandar uma errada).
    const comId = identificacao && !("identificacao" in args) ? { ...args, identificacao } : args;
    const a = await comoUsuario(banco.db, usuario, (tx) =>
      motorNaTransacao(tx, { exigirIdentificacao: true }).authorize({ userId: usuario, agentId: "obedient", systemId: tool.split(".")[0]!, tool, risk, category, args: comId }),
    );
    return a.outcome === "approval_required" ? a.proposal.id : a.outcome;
  };
  await pedir("agenda.ler_semana", "LOW", "READ", {});
  await pedir("email.enviar", "HIGH", "COMMUNICATION", { para: "fornecedor@exemplo.org", assunto: "Pedido de quinta", texto: "Confirmo 12 caixas para quinta." });
  await pedir("email.apagar_pasta", "LOW", "DESTRUCTIVE", { pasta: "Promoções" });

  const { codigo } = await Passkeys.criarConvite(banco.db, usuario);
  const srv: Server = servidorHttp((p) => api!(p));
  await new Promise<void>((ok) => srv.listen(porta, "127.0.0.1", ok));
  const url = `http://localhost:${(srv.address() as AddressInfo).port}`;
  const google = new GoogleFalso("segredo-de-desenvolvimento");
  api = criarApi(banco.db, {
    rpName: "OBEDIENT (desenvolvimento)",
    rpId: "localhost",
    origin: url,
    google: {
      cofre: new Cofre(lerChaves(`dev:${Cofre.novaChave()}`)),
      cliente: { clientId: "desenvolvimento.apps.googleusercontent.com", clientSecret: "segredo-de-desenvolvimento", redirectUri: `${url}/api/conexoes/retorno` },
      fetch: google.fetch as typeof fetch,
    },
  });
  return {
    url,
    convite: codigo,
    usuario,
    pedir,
    google,
    lembrar: (categoria, texto) =>
      comoUsuario(banco.db, usuario, async (tx) => {
        try {
          await memoriaNaTransacao(tx, motorNaTransacao(tx)).lembrar(usuario, "obedient", categoria, texto);
          return "guardou" as const;
        } catch {
          return "recusado" as const;
        }
      }),
    processar: async (executar) => {
      await processarMissoes(banco.db, usuario, executar, {}, systemClock);
    },
    fechar: async () => {
      await new Promise((ok) => srv.close(ok));
      await banco.fechar();
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const d = await subirDev(Number(process.env.OBEDIENT_PORT ?? 3010));
  console.log(`OBEDIENT (desenvolvimento) em ${d.url}\nconvite para ${d.usuario}: ${d.convite}`);
}

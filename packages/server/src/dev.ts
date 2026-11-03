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
import type { Server } from "node:http";
import { comoUsuario, memoriaNaTransacao, motorNaTransacao } from "@obedient/store-postgres";
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
  const pedir: Dev["pedir"] = async (tool, risk, category, args) => {
    const a = await motor((m) => m.authorize({ userId: usuario, agentId: "obedient", systemId: tool.split(".")[0]!, tool, risk, category, args }));
    return a.outcome === "approval_required" ? a.proposal.id : a.outcome;
  };
  await pedir("agenda.ler_semana", "LOW", "READ", {});
  await pedir("email.enviar", "HIGH", "COMMUNICATION", { para: "fornecedor@exemplo.org", assunto: "Pedido de quinta", texto: "Confirmo 12 caixas para quinta." });
  await pedir("email.apagar_pasta", "LOW", "DESTRUCTIVE", { pasta: "Promoções" });

  const { codigo } = await Passkeys.criarConvite(banco.db, usuario);
  const srv: Server = servidorHttp((p) => api!(p));
  await new Promise<void>((ok) => srv.listen(porta, "127.0.0.1", ok));
  const url = `http://localhost:${(srv.address() as AddressInfo).port}`;
  api = criarApi(banco.db, { rpName: "OBEDIENT (desenvolvimento)", rpId: "localhost", origin: url });
  return {
    url,
    convite: codigo,
    usuario,
    pedir,
    lembrar: (categoria, texto) =>
      comoUsuario(banco.db, usuario, async (tx) => {
        try {
          await memoriaNaTransacao(tx, motorNaTransacao(tx)).lembrar(usuario, "obedient", categoria, texto);
          return "guardou" as const;
        } catch {
          return "recusado" as const;
        }
      }),
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

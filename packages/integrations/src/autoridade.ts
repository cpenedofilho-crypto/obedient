// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// O que conectar uma integração CONCEDE e o que desconectar RETIRA (Arts. 3º e 4º).
//
// Conectar é o ato explícito da pessoa, depois de ler a explicação da integração. Ele cria:
//   • um grant para o agente, só com as ferramentas daquela integração ("google_agenda.*"), com
//     finalidade escrita (a explicação), prazo de 30 dias e autonomia só até risco baixo;
//   • o consentimento para as categorias de dado que as ferramentas declaram, com a finalidade
//     "integracao:<id>".
// Os dois aparecem no app e podem ser tirados um a um. Desconectar, parar e apagar retiram os dois.
//
// O que roda é o executor: só depois de o Ethics Engine autorizar (ou a pessoa aprovar), com o
// token da conexão da pessoa.

import type { EthicsEngine } from "@obedient/ethics-engine";
import type { ItemGovernado } from "@obedient/agent-orchestrator";
import { INTEGRACOES, integracao } from "./catalogo.ts";
import type { Conexoes } from "./conexoes.ts";
import { FERRAMENTAS, executar } from "./ferramentas.ts";

/** O agente que usa as integrações (o próprio OBEDIENT). */
export const AGENTE = "obedient";
export const PRAZO_DO_GRANT_MS = 30 * 24 * 3600 * 1000;
export const finalidadeDa = (id: string) => `integracao:${id}`;

/** Nome que o modelo vê (a API de modelos aceita só letras, números, _ e -). */
export const nomeParaModelo = (ferramenta: string) => ferramenta.replace(/\./g, "__");

export async function concederAoConectar(motor: EthicsEngine, userId: string, id: string, agora: Date): Promise<void> {
  const i = integracao(id);
  // Reconectar substitui a autorização anterior (sem acumular grants da mesma integração).
  await retirarAutoridade(motor, userId, id);
  await motor.grants.grant(
    {
      userId,
      agentId: AGENTE,
      systemId: i.id,
      capability: `${i.id}.*`,
      purpose: i.explicacao,
      limits: { maxRisk: "CRITICAL", autonomousUpTo: "LOW", maxAmount: null, amountField: null },
      expiresAt: new Date(agora.getTime() + PRAZO_DO_GRANT_MS),
    },
    userId,
  );
  const categorias = [...new Set(i.ferramentas.flatMap((f) => f.dataCategories ?? []))];
  for (const c of categorias) await motor.consent.give(userId, finalidadeDa(i.id), c);
}

/** Desconectar, parar, apagar: revoga o grant do agente naquela integração e o consentimento dela. */
export async function retirarAutoridade(motor: EthicsEngine, userId: string, id: string): Promise<void> {
  for (const g of await motor.grants.list(userId)) if (g.agentId === AGENTE && g.systemId === id && !g.revokedAt) await motor.grants.revoke(g.id, userId);
  await motor.consent.revokePurpose(userId, finalidadeDa(id));
}

/** As ferramentas que o agente pode pedir, das integrações conectadas, como o laço do agente as quer. */
export function itensGovernados(conectadas: readonly string[]): ItemGovernado[] {
  return INTEGRACOES.filter((i) => conectadas.includes(i.id)).flatMap((i) =>
    i.ferramentas.map((f) => {
      const def = FERRAMENTAS.find((x) => x.nome === f.name)!;
      return {
        definicao: { name: nomeParaModelo(f.name), description: f.description, input_schema: def.esquema as unknown as Record<string, unknown> },
        chave: `${i.id}/${f.name}`,
        sistema: i.id,
        ferramenta: f.name,
        risco: f.risk,
        categoria: f.category,
        ...(f.dataCategories?.length ? { dadosPessoais: f.dataCategories } : {}),
        finalidade: finalidadeDa(i.id),
      };
    }),
  );
}

/** O executor que o Ethics Engine chama depois de autorizar: a ferramenta, com o token da pessoa. */
export function executorGoogle(conexoes: Conexoes, userId: string, http: typeof fetch = fetch) {
  return (_sistema: string, ferramenta: string, args: Record<string, unknown>) => executar(ferramenta, args, (id) => conexoes.tokenDeAcesso(userId, id), http);
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// O Growth OS como ferramenta das missões, por A2A (auditoria A2A de 06/11/2026, fase 3: orquestração).
//
// O Growth OS é o servidor A2A da casa. O OBEDIENT é cliente dele com uma credencial de MÁQUINA
// (client_credentials no WorkOS), cadastrada lá por uma pessoa e presa a uma organização e a uma lista
// fechada de skills. Por isso, aqui:
//   • só as pessoas listadas pelo dono do servidor (OBEDIENT_GROWTH_OS_USUARIOS) podem receber a
//     autoridade; a credencial vê a operação de uma organização, não é de qualquer pessoa do servidor;
//   • a autoridade é um grant do Ethics Engine como o de qualquer integração: concedido por ato
//     explícito (cli.ts growth-os <usuario>), com finalidade escrita, prazo de 30 dias e autonomia só
//     até risco baixo. Aparece no app e pode ser tirado. Sem grant vigente, a ferramenta nem é oferecida;
//   • a ferramenta é só leitura (risco LOW) e devolve números sem dado pessoal (a projeção é do Growth OS);
//   • o resultado volta ao modelo como conteúdo externo, nunca como instrução;
//   • a saída é pelo fetchSeguro do @obedient/a2a-client: card na mesma origem, sem redirect, IP
//     conferido na conexão.
// O segredo vem do ambiente do servidor (OBEDIENT_GROWTH_OS_SEGREDO), é lido na hora do token e nunca
// vai para log, banco ou conversa.

import { randomUUID } from "node:crypto";
import { ClienteA2A, fonteClientCredentials, type Tarefa } from "@obedient/a2a-client";
import type { Executor, ItemGovernado } from "@obedient/agent-orchestrator";
import type { EthicsEngine } from "@obedient/ethics-engine";
import { AGENTE, PRAZO_DO_GRANT_MS, nomeParaModelo } from "@obedient/integrations";

export const SISTEMA_GROWTH_OS = "growth_os";
const SKILLS = { "growth_os.resumo_operacional": "resumo_operacional" } as const;
type Ferramenta = keyof typeof SKILLS;

export const FINALIDADE_GROWTH_OS = `integracao:${SISTEMA_GROWTH_OS}`;
export const EXPLICACAO_GROWTH_OS =
  "Ler, no Growth OS, os números da operação da organização nas últimas 24 horas (agentes, execuções, eventos, aprovações e desempenho). Só leitura, sem dado pessoal.";

export interface ConfigGrowthOs {
  cardUrl: string;
  tokenUrl: string;
  clientId: string;
  /** Quem pode receber a autoridade (ids de usuário do OBEDIENT). */
  usuarios: ReadonlySet<string>;
  /** Lido na hora do token; nunca guardado aqui. */
  segredo(): Promise<string>;
}

const https = (v: string | undefined) => {
  if (!v) return false;
  try { return new URL(v).protocol === "https:"; } catch { return false; }
};

/**
 * Tudo ou nada: sem nenhuma variável, a integração fica desligada (null); com parte delas, o servidor
 * não sobe (erro de configuração aparece na subida, não numa missão).
 */
export function configGrowthOsDoAmbiente(env: Record<string, string | undefined> = process.env): ConfigGrowthOs | null {
  const v = (k: string) => env[k]?.trim() || undefined;
  const nomes = ["OBEDIENT_GROWTH_OS_CARD_URL", "OBEDIENT_GROWTH_OS_TOKEN_URL", "OBEDIENT_GROWTH_OS_CLIENT_ID", "OBEDIENT_GROWTH_OS_SEGREDO", "OBEDIENT_GROWTH_OS_USUARIOS"];
  const presentes = nomes.filter((k) => v(k));
  if (!presentes.length) return null;
  const faltam = nomes.filter((k) => !v(k));
  if (faltam.length) throw new Error(`Growth OS: falta ${faltam.join(", ")} (ou tire todas as OBEDIENT_GROWTH_OS_* para desligar)`);
  if (!https(v("OBEDIENT_GROWTH_OS_CARD_URL")) || !https(v("OBEDIENT_GROWTH_OS_TOKEN_URL"))) throw new Error("Growth OS: card e token precisam ser https");
  const usuarios = new Set(v("OBEDIENT_GROWTH_OS_USUARIOS")!.split(",").map((s) => s.trim()).filter(Boolean));
  return {
    cardUrl: v("OBEDIENT_GROWTH_OS_CARD_URL")!,
    tokenUrl: v("OBEDIENT_GROWTH_OS_TOKEN_URL")!,
    clientId: v("OBEDIENT_GROWTH_OS_CLIENT_ID")!,
    usuarios,
    // Relido do ambiente a cada token: trocar o segredo e reiniciar não exige mudar código.
    segredo: async () => {
      const s = env.OBEDIENT_GROWTH_OS_SEGREDO?.trim();
      if (!s) throw new Error("Growth OS: segredo ausente");
      return s;
    },
  };
}

export function clienteGrowthOs(cfg: ConfigGrowthOs, http?: typeof fetch): ClienteA2A {
  return new ClienteA2A({
    cardUrl: cfg.cardUrl,
    token: fonteClientCredentials({ tokenUrl: cfg.tokenUrl, clientId: cfg.clientId, segredo: cfg.segredo, ...(http ? { fetch: http } : {}) }),
    ...(http ? { fetch: http } : {}),
  });
}

/** As ferramentas do Growth OS, como o laço do agente as quer. Só leitura. */
export function itensGrowthOs(): ItemGovernado[] {
  return [{
    definicao: {
      name: nomeParaModelo("growth_os.resumo_operacional"),
      description: "Números da operação no Growth OS nas últimas 24 horas: agentes ativos, pausados e falhando; execuções por estado; eventos; aprovações; desempenho. Cada bloco traz a fonte. Sem dado pessoal.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    },
    chave: `${SISTEMA_GROWTH_OS}/growth_os.resumo_operacional`,
    sistema: SISTEMA_GROWTH_OS,
    ferramenta: "growth_os.resumo_operacional",
    risco: "LOW",
    categoria: "READ",
    finalidade: FINALIDADE_GROWTH_OS,
  }];
}

/** O que volta ao modelo: só o estado e os dados das partes estruturadas. Nem id de tarefa, nem texto livre. */
function paraModelo(t: Tarefa) {
  if (t.estado !== "TASK_STATE_COMPLETED") return { estado: t.estado, dados: null };
  return { estado: t.estado, dados: t.artefatos.flatMap((a) => a.partes.filter((p) => p.data !== undefined).map((p) => p.data)) };
}

/** O executor que o Ethics Engine chama depois de autorizar: a skill A2A correspondente, nada além. */
export function executorGrowthOs(cliente: ClienteA2A): Executor {
  return async (sistema, ferramenta) => {
    if (sistema !== SISTEMA_GROWTH_OS || !(ferramenta in SKILLS)) throw new Error("ferramenta do Growth OS desconhecida");
    // Os argumentos do modelo não chegam ao Growth OS: a skill é escolhida aqui, pela ferramenta autorizada.
    return paraModelo(await cliente.enviar(SKILLS[ferramenta as Ferramenta], { messageId: `obedient-${randomUUID()}` }));
  };
}

/**
 * Concede à pessoa a autoridade do agente no Growth OS (ato explícito do dono do servidor, pela linha de
 * comando). Só para quem está em OBEDIENT_GROWTH_OS_USUARIOS. Conceder de novo substitui a anterior.
 */
export async function concederGrowthOs(motor: EthicsEngine, cfg: ConfigGrowthOs, userId: string, agora: Date): Promise<void> {
  if (!cfg.usuarios.has(userId)) throw new Error("essa pessoa não está em OBEDIENT_GROWTH_OS_USUARIOS");
  await retirarGrowthOs(motor, userId);
  await motor.grants.grant(
    {
      userId,
      agentId: AGENTE,
      systemId: SISTEMA_GROWTH_OS,
      capability: `${SISTEMA_GROWTH_OS}.*`,
      purpose: EXPLICACAO_GROWTH_OS,
      limits: { maxRisk: "LOW", autonomousUpTo: "LOW", maxAmount: null, amountField: null },
      expiresAt: new Date(agora.getTime() + PRAZO_DO_GRANT_MS),
    },
    userId,
  );
}

export async function retirarGrowthOs(motor: EthicsEngine, userId: string): Promise<void> {
  for (const g of await motor.grants.list(userId)) if (g.agentId === AGENTE && g.systemId === SISTEMA_GROWTH_OS && !g.revokedAt) await motor.grants.revoke(g.id, userId);
}

/** A pessoa tem autoridade vigente no Growth OS? (Sem ela, a ferramenta nem é oferecida ao modelo.) */
export async function temGrowthOs(motor: EthicsEngine, userId: string, agora: Date): Promise<boolean> {
  return (await motor.grants.list(userId)).some((g) => g.agentId === AGENTE && g.systemId === SISTEMA_GROWTH_OS && !g.revokedAt && g.expiresAt > agora);
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Proveniência: extraído de casa-de-ia/src/equipes/tipos.ts (commit 45ba448), decisão D7, etapa 4.
// Nomes mantidos em português para o Growth OS trocar só o import.
// Ficaram no Growth OS as listas do negócio dele: tipos de artefato, produtos, origem de métrica,
// escopos de orçamento e de memória por organização.
//
// Vocabulário de missões e equipes de agentes.
//
// Uma MISSÃO é trabalho delegado a uma equipe: um dono (pessoa ou sistema), um objetivo, um
// plano de TAREFAS com dependências e os ARTEFATOS que a equipe produz. Cada tarefa executa,
// como uma execução comum de agente: gateway, políticas, aprovação, limites e auditoria
// continuam valendo sem nada paralelo.

/** planning: missão aceita, plano ainda não aprovado (o Chief propõe; uma pessoa aprova). */
export const STATUS_MISSAO = ["planning", "pending", "running", "waiting_approval", "blocked", "completed", "failed", "cancelled"] as const;
export type StatusMissao = (typeof STATUS_MISSAO)[number];

export const STATUS_TAREFA = ["pending", "ready", "running", "waiting_approval", "blocked", "completed", "failed", "cancelled"] as const;
export type StatusTarefa = (typeof STATUS_TAREFA)[number];

export const TERMINAIS: readonly string[] = ["completed", "failed", "cancelled"];

/** none: a saída libera as seguintes ao concluir · output: só depois de uma pessoa aprovar a saída. */
export const PORTOES = ["none", "output"] as const;
export type Portao = (typeof PORTOES)[number];

export const STATUS_REVISAO = ["pendente", "aprovado", "rejeitado", "nao_exige"] as const;
export type StatusRevisao = (typeof STATUS_REVISAO)[number];

/** Planejamento da missão em 'planning' (0021). */
export const STATUS_PLANO = ["aguardando_run", "executando", "aguardando_revisao", "aprovado", "rejeitado", "falhou"] as const;
export type StatusPlano = (typeof STATUS_PLANO)[number];

/** O que acontece quando a missão chega no teto de gasto. */
export const POLITICAS_ORCAMENTO = ["pause", "fail"] as const;
export type PoliticaOrcamento = (typeof POLITICAS_ORCAMENTO)[number];

/**
 * Níveis de autonomia (Master Prompt 2.0, §12). Nenhum nível é permissão universal: a decisão ainda
 * passa por identidade, tenant, ferramenta e parâmetros no gateway e no Policy Engine. A
 * autonomia só RESTRINGE o que a política já permite; nunca afrouxa (autonomia.ts).
 */
export const NIVEIS_AUTONOMIA = [
  { nivel: 0, nome: "observacao", descricao: "só leitura e análise" },
  { nivel: 1, nome: "preparacao", descricao: "cria propostas e artefatos na missão, sem efeito externo" },
  { nivel: 2, nome: "execucao_controlada", descricao: "executa ação reversível já autorizada por política" },
  { nivel: 3, nome: "aprovacao_obrigatoria", descricao: "ação sensível só com aprovação humana específica" },
  { nivel: 4, nome: "operacao_critica", descricao: "ação irreversível ou de alto impacto: aprovação privilegiada" },
] as const;
export type NivelAutonomia = 0 | 1 | 2 | 3 | 4;

/** Limites que nenhuma missão ultrapassa (os da missão ficam abaixo, nos CHECKs da 0019). */
export const LIMITES_EQUIPE = {
  maxTarefas: 30,
  maxDependenciasPorTarefa: 10,
  /** Mesmo teto de profundidade da cadeia de agentes (LIMITES_GLOBAIS.maxProfundidade). */
  maxProfundidade: 3,
  maxDelegacoes: 50,
  maxTentativas: 5,
  /** Bytes de JSON da entrada de uma tarefa e do conteúdo de um artefato. */
  maxBytesEntrada: 50_000,
  maxBytesArtefato: 200_000,
  maxCriterios: 20,
  maxMembrosEquipe: 20,
} as const;

/** Ator de uma escrita de missão. Agente entra só como autor de artefato (Fase 2), nunca como dono. */
export interface Ator { tipo: "user" | "system" | "agent"; id: string }

/** "<tipo>:<id>", o formato de created_by e reviewed_by (os CHECKs comparam esse texto). */
export const refAtor = (a: Ator) => `${a.tipo}:${a.id}`;

export class ErroEquipe extends Error {
  override name = "ErroEquipe";
  constructor(readonly codigo: string, mensagem: string) {
    super(mensagem);
  }
}

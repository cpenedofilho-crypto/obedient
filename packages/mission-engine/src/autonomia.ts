// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Proveniência: extraído de casa-de-ia/src/equipes/autonomia.ts (commit 45ba448), decisão D7, etapa 4.
// Nomes mantidos em português para o Growth OS trocar só o import. Importa risco e permissão do
// @obedient/integration-gateway, que é o mesmo código do mcp-gateway do Growth OS.
//
// Autonomia e delegação: funções puras.
//
// Princípio: a autonomia só RESTRINGE. Uma ação que o Policy Engine bloqueia continua bloqueada em
// qualquer nível; uma ação HIGH continua exigindo aprovação humana mesmo no nível 4. O nível diz o
// máximo que o agente pode TENTAR; a política diz se e como executa.
import { ordemRisco, satisfaz, type Categoria, type Risco } from "@obedient/integration-gateway";
import type { NivelAutonomia } from "./tipos.ts";

/** O que a ação pede: uma ferramenta (risco e categoria do gateway) ou um artefato da própria missão. */
export type AcaoAutonomia = { tipo: "ferramenta"; risco: Risco; categoria: Categoria | null } | { tipo: "artefato" };

/** Nível mínimo de autonomia que a ação exige. */
export function nivelExigido(a: AcaoAutonomia): NivelAutonomia {
  if (a.tipo === "artefato") return 1;
  if (a.risco === "CRITICAL" || a.categoria === "DESTRUCTIVE" || a.categoria === "FINANCIAL" || a.categoria === "LEGAL") return 4;
  if (a.risco === "HIGH" || a.categoria === "COMMUNICATION") return 3;
  if (a.risco === "MEDIUM" || a.categoria === "WRITE") return 2;
  return 0;
}

/** O teto de risco do agente (max_risk_level) limita a autonomia que ele pode receber numa equipe. */
export function nivelMaximoDoAgente(maxRiskLevel: string): NivelAutonomia {
  return ({ LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 } as Record<string, NivelAutonomia>)[maxRiskLevel] ?? 0;
}

/** Autonomia efetiva: o menor dos tetos (missão, membro na equipe, agente, coordenador que delegou). */
export function nivelEfetivo(...tetos: (NivelAutonomia | null | undefined)[]): NivelAutonomia {
  const validos = tetos.filter((t): t is NivelAutonomia => t != null);
  return (validos.length ? Math.min(...validos) : 0) as NivelAutonomia;
}

export type DecisaoAutonomia = "permitido" | "exige_aprovacao" | "exige_aprovacao_privilegiada" | "negado";

/**
 * Nível 0 a 2: permitido se o efetivo alcança o exigido. Nível 3: nunca autônomo, vai a aprovação.
 * Nível 4: aprovação privilegiada. Abaixo do exigido: negado, sem abrir pedido de aprovação.
 */
export function decidirAutonomia(efetivo: NivelAutonomia, acao: AcaoAutonomia): DecisaoAutonomia {
  const exigido = nivelExigido(acao);
  if (efetivo < exigido) return "negado";
  if (exigido === 4) return "exige_aprovacao_privilegiada";
  if (exigido === 3) return "exige_aprovacao";
  return "permitido";
}

/** O que um agente pode usar: o recorte que a delegação herda. */
export interface Capacidade {
  ferramentas: readonly string[];
  permissoes: readonly string[];
  riscoMaximo: Risco;
  autonomia: NivelAutonomia;
}

/**
 * Teto de quem é convocado: a INTERSEÇÃO com quem convocou. O coordenador não concede ferramenta,
 * permissão, risco nem autonomia que ele próprio não tem; delegar nunca eleva privilégio.
 */
export function tetoDelegado(pai: Capacidade, filho: Capacidade): Capacidade {
  const doPai = new Set(pai.ferramentas);
  // Permissão com curinga ("mcp:x:*"): fica a do filho que o pai cobre e a do pai que o filho cobre,
  // ou seja, a mais estreita dos dois em cada caso.
  const permissoes = [...new Set([
    ...filho.permissoes.filter((p) => pai.permissoes.some((c) => satisfaz(c, p))),
    ...pai.permissoes.filter((p) => filho.permissoes.some((c) => satisfaz(c, p))),
  ])];
  return {
    ferramentas: filho.ferramentas.filter((f) => doPai.has(f)),
    permissoes,
    riscoMaximo: ordemRisco(filho.riscoMaximo) <= ordemRisco(pai.riscoMaximo) ? filho.riscoMaximo : pai.riscoMaximo,
    autonomia: nivelEfetivo(pai.autonomia, filho.autonomia),
  };
}

/** Recusa de delegação por limite da missão (profundidade e convocações), ou null se pode. */
export function recusaDeDelegacao(p: { profundidadeAtual: number; maxProfundidade: number; delegacoesUsadas: number; maxDelegacoes: number; podeDelegar: boolean }): string | null {
  if (!p.podeDelegar) return "agente_nao_delega";
  if (p.profundidadeAtual + 1 > p.maxProfundidade) return "profundidade_maxima";
  if (p.delegacoesUsadas + 1 > p.maxDelegacoes) return "delegacoes_esgotadas";
  return null;
}

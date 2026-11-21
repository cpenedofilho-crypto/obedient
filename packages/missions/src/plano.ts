// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// O plano da missão (decisão D20, marco M5; G5). Opcional: só a missão criada com "planejar antes"
// passa por ele.
//
//   • planning: um modelo SEM ferramenta nenhuma propõe as tarefas, com dependências (DAG). O plano
//     é conferido por validarPlano (mission-engine): sem ciclo, sem dependência desconhecida, até 30
//     tarefas e 10 dependências por tarefa;
//   • waiting_approval: a pessoa vê o plano e aprova pelo HASH dele (aprova exatamente o que viu) ou
//     recusa. Aprovar o plano não autoriza ação nenhuma: cada escrita continua pedindo aprovação
//     (D18, D22);
//   • running: o agente trabalha tarefa a tarefa e marca cada uma feita; o banco recusa marcar feita
//     uma tarefa cuja dependência não está feita. "Feito" na missão só com todas as tarefas feitas
//     (evidência plano_completo, conferida pelo código).
// O texto das tarefas é do modelo: é DADO, mostrado à pessoa e ao agente, nunca instrução de sistema.

import { payloadHash } from "@obedient/core";
import { ErroEquipe, LIMITES_EQUIPE, validarPlano } from "@obedient/mission-engine";

export const CHAVE_TAREFA = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const MAX_TITULO_TAREFA = 200;

export interface TarefaDoPlano {
  chave: string;
  titulo: string;
  dependeDe: string[];
}

export interface PlanoDaMissao {
  /** Sobe a cada plano novo da missão (recusar e planejar de novo não reaproveita tarefa). */
  versao: number;
  /** payloadHash das tarefas: é o que a pessoa aprova. */
  hash: string;
  aprovadoEm: Date | null;
  tarefas: TarefaDoPlano[];
}

const ehObjeto = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Lê as tarefas como o modelo as mandou (snake ou camel); devolve os problemas ou as tarefas. */
export function lerTarefas(v: unknown): { tarefas: TarefaDoPlano[] } | { problemas: string[] } {
  if (!Array.isArray(v)) return { problemas: ["tarefas precisa ser uma lista"] };
  const problemas: string[] = [];
  const tarefas: TarefaDoPlano[] = [];
  v.forEach((t, i) => {
    if (!ehObjeto(t)) return void problemas.push(`tarefa ${i + 1}: precisa ser objeto`);
    const chave = typeof t.chave === "string" ? t.chave.trim() : "";
    const titulo = typeof t.titulo === "string" ? t.titulo.trim() : "";
    const deps = t.depende_de ?? t.dependeDe ?? [];
    if (!CHAVE_TAREFA.test(chave)) problemas.push(`tarefa ${i + 1}: chave de 1 a 40 caracteres, minúsculas, números, _ ou -`);
    if (titulo.length < 3 || titulo.length > MAX_TITULO_TAREFA) problemas.push(`tarefa ${i + 1}: título de 3 a ${MAX_TITULO_TAREFA} caracteres`);
    if (!Array.isArray(deps) || deps.some((d) => typeof d !== "string")) problemas.push(`tarefa ${i + 1}: depende_de precisa ser lista de chaves`);
    if (Object.keys(t).some((k) => !["chave", "titulo", "depende_de", "dependeDe"].includes(k))) problemas.push(`tarefa ${i + 1}: campo não previsto`);
    tarefas.push({ chave, titulo, dependeDe: Array.isArray(deps) ? deps.map((d) => String(d).trim()) : [] });
  });
  if (problemas.length) return { problemas };
  try {
    validarPlano(tarefas.map((t) => ({ chave: t.chave, depende_de: t.dependeDe })));
  } catch (e) {
    if (e instanceof ErroEquipe) return { problemas: [e.message] };
    throw e;
  }
  return { tarefas };
}

export const hashDoPlano = (tarefas: readonly TarefaDoPlano[]) => payloadHash(tarefas.map((t) => ({ chave: t.chave, titulo: t.titulo, dependeDe: [...t.dependeDe] })));

/** Tarefas prontas: não feitas, com todas as dependências feitas. Na ordem do plano. */
export function tarefasProntas(plano: PlanoDaMissao, feitas: ReadonlySet<string>): TarefaDoPlano[] {
  return plano.tarefas.filter((t) => !feitas.has(t.chave) && t.dependeDe.every((d) => feitas.has(d)));
}

export const MAX_TAREFAS = LIMITES_EQUIPE.maxTarefas;

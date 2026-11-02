// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Proveniência: extraído de casa-de-ia/src/equipes/plano.ts (commit 45ba448), decisão D7, etapa 4.
// Nomes mantidos em português para o Growth OS trocar só o import.
//
// Validação do plano da missão: função pura. O banco garante que tarefa e dependência são da
// mesma missão e recusa a aresta de um nó (CHECK); ciclo de dois ou mais nós só o código vê.
// Devolve também as CAMADAS: tarefas da mesma camada não dependem uma da outra e podem rodar em
// paralelo (Fase 2).
import { LIMITES_EQUIPE, ErroEquipe } from "./tipos.ts";

export interface NoPlano { chave: string; depende_de: readonly string[] }

export interface PlanoValidado {
  /** Ordem topológica estável (empate pela ordem em que a tarefa veio). */
  ordem: string[];
  /** camadas[0] não tem dependência; camadas[n] depende só de camadas anteriores. */
  camadas: string[][];
}

export function validarPlano(tarefas: readonly NoPlano[]): PlanoValidado {
  if (!tarefas.length) throw new ErroEquipe("plano_vazio", "o plano precisa de ao menos uma tarefa");
  if (tarefas.length > LIMITES_EQUIPE.maxTarefas) throw new ErroEquipe("plano_grande_demais", `no máximo ${LIMITES_EQUIPE.maxTarefas} tarefas`);
  const posicao = new Map<string, number>();
  tarefas.forEach((t, i) => {
    if (posicao.has(t.chave)) throw new ErroEquipe("chave_duplicada", `tarefa "${t.chave}" aparece mais de uma vez`);
    posicao.set(t.chave, i);
  });
  const deps = new Map<string, Set<string>>();
  for (const t of tarefas) {
    const d = new Set(t.depende_de);
    if (d.size > LIMITES_EQUIPE.maxDependenciasPorTarefa) throw new ErroEquipe("dependencias_demais", `"${t.chave}" tem mais de ${LIMITES_EQUIPE.maxDependenciasPorTarefa} dependências`);
    for (const x of d) {
      if (x === t.chave) throw new ErroEquipe("dependencia_de_si_mesma", `"${t.chave}" depende de si mesma`);
      if (!posicao.has(x)) throw new ErroEquipe("dependencia_desconhecida", `"${t.chave}" depende de "${x}", que não está no plano`);
    }
    deps.set(t.chave, d);
  }

  // Kahn por camadas: tira, a cada volta, tudo o que não tem dependência pendente.
  const pendentes = new Map([...deps].map(([k, d]) => [k, new Set(d)]));
  const ordem: string[] = [];
  const camadas: string[][] = [];
  while (pendentes.size) {
    const livres = [...pendentes].filter(([, d]) => d.size === 0).map(([k]) => k).sort((a, b) => posicao.get(a)! - posicao.get(b)!);
    if (!livres.length) {
      throw new ErroEquipe("ciclo_no_plano", `ciclo de dependências entre (ou antes de) ${[...pendentes.keys()].sort().join(", ")}`);
    }
    for (const k of livres) pendentes.delete(k);
    for (const d of pendentes.values()) for (const k of livres) d.delete(k);
    ordem.push(...livres);
    camadas.push(livres);
  }
  return { ordem, camadas };
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Proveniência: extraído de casa-de-ia/src/equipes/transicoes.ts (commit 45ba448), decisão D7, etapa 4.
// Nomes mantidos em português para o Growth OS trocar só o import.
//
// Máquina de estados da missão e da tarefa. Função pura: o orquestrador (Fase 2) só grava uma
// passagem que esteja aqui, e grava condicionada ao estado anterior (UPDATE ... WHERE status = de),
// como o runtime e os criativos já fazem. Estado terminal não sai mais.
import { TERMINAIS, type StatusMissao, type StatusTarefa } from "./tipos.ts";

const MISSAO: Record<StatusMissao, readonly StatusMissao[]> = {
  // Plano aprovado por pessoa: pending. Nunca direto para running: começar é outra decisão.
  planning: ["pending", "failed", "cancelled"],
  pending: ["running", "failed", "cancelled"],
  running: ["waiting_approval", "blocked", "completed", "failed", "cancelled"],
  // Para completed: a saída aprovada era da última tarefa.
  waiting_approval: ["running", "blocked", "completed", "failed", "cancelled"],
  blocked: ["running", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

const TAREFA: Record<StatusTarefa, readonly StatusTarefa[]> = {
  // Esperando dependência. Dependência falhou ou artefato dela foi rejeitado: blocked.
  pending: ["ready", "blocked", "cancelled"],
  // Pode ir para a fila. Sem orçamento na hora de enfileirar: blocked.
  ready: ["running", "blocked", "cancelled"],
  // De volta a ready é a nova tentativa (até max_attempts), nunca um atalho para pular aprovação.
  running: ["waiting_approval", "completed", "failed", "ready", "blocked", "cancelled"],
  // Esperando pessoa: aprovação de ferramenta do run (volta a running) ou da saída (portão "output").
  // Para ready: o run falhou depois da aprovação e ainda há tentativa.
  waiting_approval: ["running", "ready", "completed", "blocked", "failed", "cancelled"],
  // Precisa de decisão de pessoa para seguir.
  blocked: ["ready", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function podeMissao(de: StatusMissao, para: StatusMissao): boolean {
  return MISSAO[de].includes(para);
}

export function podeTarefa(de: StatusTarefa, para: StatusTarefa): boolean {
  return TAREFA[de].includes(para);
}

export const terminal = (s: string) => TERMINAIS.includes(s);

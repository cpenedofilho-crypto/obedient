// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.

import type { ItemCatalogo, ResultadoChamada } from "@obedient/agent-orchestrator";
import { analisarJogo, type Jogo } from "@obedient/strategic-intelligence";

export const ANALISAR_JOGO = "analisar_jogo";
export const CHAVE_ANALISAR_JOGO = `obedient/${ANALISAR_JOGO}`;

/** Ferramenta interna e pura: não tem I/O, grants, chamadas externas ou efeitos colaterais. */
export const ferramentaAnalisarJogo: ItemCatalogo = {
  chave: CHAVE_ANALISAR_JOGO,
  definicao: {
    name: ANALISAR_JOGO,
    description: "Analisa um jogo finito em forma normal: Nash em estratégias puras, Pareto e eliminação iterativa por dominância estrita. Use apenas payoffs fornecidos ou hipóteses explicitamente rotuladas; nunca apresente hipóteses como fatos. Os índices começam em zero. Não executa a estratégia nem autoriza ações.",
    input_schema: {
      type: "object",
      properties: {
        jogadores: { type: "array", minItems: 2, maxItems: 4, items: { type: "object", properties: { nome: { type: "string" }, estrategias: { type: "array", minItems: 2, maxItems: 10, items: { type: "string" } } }, required: ["nome", "estrategias"], additionalProperties: false } },
        resultados: { type: "array", maxItems: 4096, items: { type: "object", properties: { perfil: { type: "array", items: { type: "integer" } }, payoffs: { type: "array", items: { type: "number" } } }, required: ["perfil", "payoffs"], additionalProperties: false } },
        origem: { type: "string", enum: ["dados_fornecidos", "hipotese"] },
      },
      required: ["jogadores", "resultados", "origem"],
      additionalProperties: false,
    },
  },
};

const objeto = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const chaves = (v: Record<string, unknown>, esperadas: string[]) =>
  Object.keys(v).every((k) => esperadas.includes(k));

function lerJogo(args: Record<string, unknown>): { jogo: Jogo; origem: string } {
  if (!chaves(args, ["jogadores", "resultados", "origem"]) ||
    (args.origem !== "dados_fornecidos" && args.origem !== "hipotese") ||
    !Array.isArray(args.jogadores) || args.jogadores.length < 2 || args.jogadores.length > 4 ||
    !Array.isArray(args.resultados) || args.resultados.length > 4096) throw new Error("Estrutura de jogo inválida");
  const jogadores: Jogo["jogadores"][number][] = args.jogadores.map((j: unknown) => {
    if (!objeto(j) || !chaves(j, ["nome", "estrategias"]) ||
      typeof j.nome !== "string" || j.nome.length > 100 ||
      !Array.isArray(j.estrategias) || j.estrategias.some((s: unknown) => typeof s !== "string" || s.length > 100))
      throw new Error("Jogador inválido");
    return { nome: j.nome, estrategias: j.estrategias as string[] };
  });
  const resultados: Jogo["resultados"][number][] = args.resultados.map((r: unknown) => {
    if (!objeto(r) || !chaves(r, ["perfil", "payoffs"]) || !Array.isArray(r.perfil) ||
      !Array.isArray(r.payoffs) || r.perfil.some((x: unknown) => !Number.isInteger(x)) ||
      r.payoffs.some((x: unknown) => typeof x !== "number" || !Number.isFinite(x)))
      throw new Error("Resultado inválido");
    return { perfil: r.perfil as number[], payoffs: r.payoffs as number[] };
  });
  return { jogo: { jogadores, resultados }, origem: args.origem };
}

export function executarAnaliseJogo(args: Record<string, unknown>): ResultadoChamada {
  try {
    const { jogo, origem } = lerJogo(args);
    const analise = analisarJogo(jogo);
    return {
      status: "succeeded", motivo: null, approvalId: null,
      resultado: {
        ...analise,
        origem,
        aviso: origem === "hipotese"
          ? "Cenário hipotético: a análise matemática não valida os payoffs nem prevê o comportamento real."
          : "Os payoffs foram declarados como fornecidos, mas sua exatidão não foi verificada pelo motor.",
        escopo: "Nash somente em estratégias puras; dominância estrita somente por estratégias puras.",
      },
    };
  } catch (e) {
    return { status: "tool_error", motivo: e instanceof Error ? e.message.slice(0, 200) : "Jogo inválido", approvalId: null, resultado: null };
  }
}

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
        referencias: {
          type: "array", maxItems: 12,
          description: "Referências declaradas pelo modelo/usuário, sem validação independente. Não inclua dados pessoais, tokens nem segredos.",
          items: { type: "object", properties: {
            tipo: { type: "string", enum: ["usuario", "integracao", "simulacao"] },
            descricao: { type: "string", maxLength: 200 },
            identificador: { type: "string", maxLength: 120 },
          }, required: ["tipo", "descricao", "identificador"], additionalProperties: false },
        },
        evidencias_payoffs: {
          type: "array", maxItems: 16384,
          description: "Vínculos exatos com números de leituras governadas nesta tentativa. Caminho JSON Pointer relativo ao resultado recebido; sem hipótese de que a fonte seja verdadeira.",
          items: { type: "object", properties: {
            perfil: { type: "array", items: { type: "integer" } },
            jogador: { type: "integer" },
            identificador: { type: "string", maxLength: 120 },
            caminho: { type: "string", maxLength: 300 },
          }, required: ["perfil", "jogador", "identificador", "caminho"], additionalProperties: false },
        },
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

interface Referencia {
  tipo: "usuario" | "integracao" | "simulacao";
  descricao: string;
  identificador: string;
}

/** Provas emitidas exclusivamente pelo executor após uma leitura governada bem-sucedida. */
export interface LeituraConfirmada {
  identificador: string;
  ferramenta: string;
  resultado?: unknown;
}

interface EvidenciaPayoff {
  perfil: number[];
  jogador: number;
  identificador: string;
  caminho: string;
}

/** JSON Pointer estrito: acessa só propriedades próprias e nunca executa getters ou protótipos. */
function lerCaminho(valor: unknown, caminho: string): unknown {
  if (!caminho.startsWith("/") || caminho.length > 300) return undefined;
  for (const parte of caminho.slice(1).split("/")) {
    if (!/^(?:[^~]|~[01])*$/.test(parte)) return undefined;
    const chave = parte.replace(/~1/g, "/").replace(/~0/g, "~");
    if (valor === null || typeof valor !== "object") return undefined;
    const propriedade = Object.getOwnPropertyDescriptor(valor, chave);
    if (!propriedade || !("value" in propriedade)) return undefined;
    valor = propriedade.value;
  }
  return valor;
}

function lerJogo(args: Record<string, unknown>): { jogo: Jogo; origem: string; referencias: Referencia[]; evidencias: EvidenciaPayoff[] } {
  if (!chaves(args, ["jogadores", "resultados", "origem", "referencias", "evidencias_payoffs"]) ||
    (args.origem !== "dados_fornecidos" && args.origem !== "hipotese") ||
    !Array.isArray(args.jogadores) || args.jogadores.length < 2 || args.jogadores.length > 4 ||
    !Array.isArray(args.resultados) || args.resultados.length > 4096 ||
    (args.referencias !== undefined && (!Array.isArray(args.referencias) || args.referencias.length > 12)) ||
    (args.evidencias_payoffs !== undefined && (!Array.isArray(args.evidencias_payoffs) || args.evidencias_payoffs.length > 16384))) throw new Error("Estrutura de jogo inválida");
  const referencias: Referencia[] = (args.referencias ?? [] as unknown[]) as Referencia[];
  if (referencias.some((r) => !objeto(r) || !chaves(r, ["tipo", "descricao", "identificador"]) ||
    !["usuario", "integracao", "simulacao"].includes(r.tipo) ||
    typeof r.descricao !== "string" || !r.descricao.trim() || r.descricao.length > 200 ||
    typeof r.identificador !== "string" || !r.identificador.trim() || r.identificador.length > 120))
    throw new Error("Referência inválida");
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
  const evidencias = (args.evidencias_payoffs ?? []) as EvidenciaPayoff[];
  if (evidencias.some((e) => !objeto(e) || !chaves(e, ["perfil", "jogador", "identificador", "caminho"]) ||
    !Array.isArray(e.perfil) || e.perfil.some((n: unknown) => !Number.isInteger(n)) ||
    !Number.isInteger(e.jogador) || typeof e.identificador !== "string" || e.identificador.length > 120 ||
    typeof e.caminho !== "string" || e.caminho.length > 300)) throw new Error("Evidência de payoff inválida");
  return { jogo: { jogadores, resultados }, origem: args.origem, referencias, evidencias };
}

export function executarAnaliseJogo(args: Record<string, unknown>, leituras: readonly LeituraConfirmada[] = []): ResultadoChamada {
  try {
    const { jogo, origem, referencias, evidencias } = lerJogo(args);
    const analise = analisarJogo(jogo);
    const ids = new Set(leituras.map((l) => l.identificador));
    const referenciasConferidas = referencias.filter((r) => r.tipo === "integracao" && ids.has(r.identificador)).map((r) => ({
      identificador: r.identificador,
      ferramenta: leituras.find((l) => l.identificador === r.identificador)!.ferramenta,
      status: "execucao_de_leitura_confirmada" as const,
    }));
    const referenciasValidas = new Set(referenciasConferidas.map((r) => r.identificador));
    const resultados = new Map(jogo.resultados.map((r) => [r.perfil.join(","), r.payoffs]));
    const conferidos = new Set<string>();
    for (const e of evidencias) {
      if (!referenciasValidas.has(e.identificador) || e.perfil.length !== jogo.jogadores.length ||
        e.jogador < 0 || e.jogador >= jogo.jogadores.length) continue;
      const payoffs = resultados.get(e.perfil.join(","));
      const leitura = leituras.find((l) => l.identificador === e.identificador);
      if (payoffs && leitura && typeof lerCaminho(leitura.resultado, e.caminho) === "number" &&
        lerCaminho(leitura.resultado, e.caminho) === payoffs[e.jogador]) conferidos.add(`${e.perfil.join(",")}:${e.jogador}`);
    }
    const total = jogo.resultados.length * jogo.jogadores.length;
    const cobertura = { conferidos: conferidos.size, total, completa: conferidos.size === total };
    return {
      status: "succeeded", motivo: null, approvalId: null,
      resultado: {
        ...analise,
        origem,
        referencias,
        verificacao: cobertura.completa && origem === "dados_fornecidos" ? "payoffs_conferidos_com_resultado_da_leitura" : referenciasConferidas.length ? "execucao_de_leitura_confirmada_conteudo_nao_validado" : "referencias_declaradas_nao_verificadas",
        referencias_conferidas: referenciasConferidas,
        cobertura_payoffs: cobertura,
        aviso: origem === "hipotese"
          ? "Cenário hipotético: a análise matemática não valida os payoffs nem prevê o comportamento real."
          : "A exatidão não foi verificada independentemente: a conferência apenas compara números à resposta da integração, não verifica a veracidade da fonte, a interpretação econômica nem a qualidade da decisão.",
        escopo: "Nash somente em estratégias puras; dominância estrita somente por estratégias puras.",
      },
    };
  } catch (e) {
    return { status: "tool_error", motivo: e instanceof Error ? e.message.slice(0, 200) : "Jogo inválido", approvalId: null, resultado: null };
  }
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Proveniência: casa-de-ia/src/agent-runtime/tipos.ts (commit 45ba448), decisão D7, etapa 5.
// O que mudou: as mensagens e ferramentas do modelo deixaram de ser os tipos do SDK da Anthropic e
// viraram tipos estruturais próprios, com o MESMO formato da Messages API. O pacote não depende de
// SDK nenhum; o adaptador de produção (como o modelo-anthropic.ts do Growth OS) cumpre ModeloAgente.

export const STATUS_RUN = ["queued", "running", "waiting_approval", "completed", "failed", "cancelled"] as const;
export type StatusRun = (typeof STATUS_RUN)[number];
export const TERMINAIS: readonly StatusRun[] = ["completed", "failed", "cancelled"];

export type Esforco = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Perfil de tarefa. O agente diz que TIPO de trabalho faz; qual modelo atende cada perfil é
 * configuração (MODELOS_POR_PERFIL), não código.
 */
export const PERFIS_MODELO = ["rapido", "equilibrado", "raciocinio"] as const;
export type PerfilModelo = (typeof PERFIS_MODELO)[number];

export interface ConfigModelo {
  provider: "anthropic";
  model: string;
  perfil?: PerfilModelo;
  effort?: Esforco;
  max_tokens?: number;
}

// ---- formato das mensagens (o mesmo da Messages API) ------------------------------------------

export interface BlocoTexto {
  type: "text";
  text: string;
}
export interface BlocoUsoFerramenta {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
export interface ResultadoFerramenta {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error: boolean;
}
/** Outros blocos (raciocínio, etc.) voltam ao modelo como vieram, sem o runtime olhar dentro. */
export interface BlocoOutro {
  type: string;
  [k: string]: unknown;
}
export type BlocoModelo = BlocoTexto | BlocoUsoFerramenta | BlocoOutro;

export interface MensagemModelo {
  role: "user" | "assistant";
  content: string | (BlocoModelo | ResultadoFerramenta)[];
}

export interface FerramentaModelo {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface PedidoModelo {
  system: string;
  messages: MensagemModelo[];
  tools: FerramentaModelo[];
  maxTokens: number;
  signal: AbortSignal;
}

export interface RespostaModelo {
  content: BlocoModelo[];
  stopReason: string | null;
  model: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** Porta do modelo. Produção: adaptador do provedor. Nos testes, um modelo roteirizado. */
export interface ModeloAgente {
  responder(p: PedidoModelo): Promise<RespostaModelo>;
}

export class ErroModelo extends Error {
  constructor(
    readonly codigo: string,
    mensagem: string,
    readonly transitorio: boolean,
  ) {
    super(mensagem);
    this.name = "ErroModelo";
  }
}

export class ErroRuntime extends Error {
  constructor(
    readonly codigo: string,
    mensagem: string,
  ) {
    super(mensagem);
    this.name = "ErroRuntime";
  }
}

/** Limites que não dependem do agente: a cadeia de agentes não cresce sem fim. */
export const LIMITES_GLOBAIS = {
  /** Runs por correlation_id (um evento que dispara agente que dispara agente...). */
  maxRunsPorCadeia: 10,
  /** Runs por missão: 30 tarefas × 5 tentativas. */
  maxRunsPorMissao: 150,
  /** Profundidade: agente disparado por evento de outro agente. */
  maxProfundidade: 3,
  /** Chamadas de ferramenta com nome inexistente antes de encerrar o run. */
  maxFerramentasInvalidas: 3,
  /** Chamadas idênticas (mesma ferramenta, mesmos argumentos) num run. */
  maxRepeticoes: 2,
} as const;

// ---- roteamento de modelo (puro; do modelo-anthropic.ts do Growth OS) --------------------------

export interface ModeloResolvido {
  modelo: string;
  /** perfil: veio de MODELOS_POR_PERFIL; agente: do model_config; padrao: o padrão informado. */
  origem: "perfil" | "agente" | "padrao";
  perfil: PerfilModelo | null;
  aviso: "perfil_sem_mapeamento" | "mapeamento_invalido" | null;
}

/**
 * Qual modelo atende o agente. Sem perfil, vale o `model` do agente. Com perfil, vale
 * MODELOS_POR_PERFIL[perfil]; se o mapa não existe ou não tem o perfil, cai no `model` com aviso.
 * Trocar de modelo é mudar configuração, não código.
 */
export function resolverModelo(
  cfg: Pick<ConfigModelo, "model" | "perfil">,
  env: Record<string, string | undefined>,
  modeloPadrao: string,
): ModeloResolvido {
  const doAgente = (aviso: ModeloResolvido["aviso"]): ModeloResolvido => ({
    modelo: cfg.model || modeloPadrao,
    origem: cfg.model ? "agente" : "padrao",
    perfil: cfg.perfil ?? null,
    aviso,
  });
  if (!cfg.perfil) return doAgente(null);
  const bruto = env.MODELOS_POR_PERFIL?.trim();
  if (!bruto) return doAgente("perfil_sem_mapeamento");
  let mapa: unknown;
  try {
    mapa = JSON.parse(bruto);
  } catch {
    return doAgente("mapeamento_invalido");
  }
  if (!mapa || typeof mapa !== "object" || Array.isArray(mapa)) return doAgente("mapeamento_invalido");
  const m = mapa as Record<string, unknown>;
  if (Object.keys(m).some((k) => !PERFIS_MODELO.includes(k as PerfilModelo)) || Object.values(m).some((v) => typeof v !== "string" || !v.trim())) {
    return doAgente("mapeamento_invalido");
  }
  const escolhido = m[cfg.perfil] as string | undefined;
  return escolhido ? { modelo: escolhido.trim(), origem: "perfil", perfil: cfg.perfil, aviso: null } : doAgente("perfil_sem_mapeamento");
}

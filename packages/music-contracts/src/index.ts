// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Contratos do Music Intelligence Engine (decisão D31, plano em docs/architecture/music-engine.md).
//
// O motor escolhe a próxima faixa de um CATÁLOGO PRÓPRIO ou licenciado a partir de sinais que nunca
// saem do aparelho (frequência cardíaca, intervalos RR). Três escolhas de desenho moram nestes tipos
// e não devem ser afrouxadas sem nova decisão e novo parecer (F0):
//
// 1. Não há "humor", "estado psicológico" nem classificador aprendido em nenhum tipo. O contexto é só
//    fisiológico e calculado por regra explicável (zona por frequência de reserva). Ver o quadro de
//    reivindicações em docs/governance/music-engine-f0.md.
// 2. A origem de faixa é só "proprio" ou "licenciado": Spotify e Apple Music ficam fora (D31).
// 3. A decisão nunca altera o áudio (sem mudar tempo, sem recompor). A transição é corte ou
//    crossfade, e crossfade só se a licença da faixa permitir.
//
// Sem dependências, de propósito: o app do aparelho e o servidor consomem os mesmos tipos.

/** De onde vem uma amostra. Health Connect e HealthKit são só histórico (não têm tempo real). */
export const FONTES_SINAL = ["ble_hrs", "polar_sdk", "relogio_espelhado", "simulado"] as const;
export type FonteSinal = (typeof FONTES_SINAL)[number];

export const QUALIDADES = ["boa", "duvidosa", "descartada"] as const;
export type Qualidade = (typeof QUALIDADES)[number];

/** Limites fisiológicos aceitos. Fora disso a amostra é descartada, nunca "corrigida". */
export const BPM_MINIMO = 25;
export const BPM_MAXIMO = 250;
export const RR_MINIMO_MS = 240; // 250 bpm
export const RR_MAXIMO_MS = 2400; // 25 bpm

export interface AmostraSinal {
  /** Instante em ms (relógio do aparelho, monotônico dentro da sessão). */
  readonly t: number;
  readonly fonte: FonteSinal;
  readonly bpm?: number;
  readonly rrMs?: readonly number[];
  /** Contato do sensor com a pele, quando o sensor informa. */
  readonly contato?: boolean;
}

/** Amostra depois do filtro de artefatos. */
export interface AmostraFiltrada extends AmostraSinal {
  readonly qualidade: Qualidade;
}

/** Porta do aparelho: quem lê o sensor de verdade (BLE no app) implementa isto. */
export interface SensorAdapter {
  readonly id: string;
  readonly fonte: FonteSinal;
  amostras(sinal: AbortSignal): AsyncIterable<AmostraSinal>;
}

export const ZONAS = ["repouso", "z1", "z2", "z3", "z4", "z5"] as const;
export type Zona = (typeof ZONAS)[number];

export const FASES = ["aquecimento", "esforco", "recuperacao"] as const;
export type Fase = (typeof FASES)[number];

/** Parâmetros que a PRÓPRIA pessoa informa. O motor não estima FC máxima pela idade. */
export interface ParametrosFisiologicos {
  readonly fcRepouso: number;
  readonly fcMaxima: number;
}

export interface ConfigContexto extends ParametrosFisiologicos {
  /** Margem de bpm para sair de uma zona (evita troca a cada batida). Padrão 3. */
  readonly histereseBpm?: number;
  /** Tempo mínimo numa zona nova antes de valer. Padrão 20 s. */
  readonly permanenciaMinimaMs?: number;
  /** Peso da média exponencial por amostra (0 < alfa ≤ 1). Padrão 0,2. */
  readonly alfa?: number;
}

export interface Contexto {
  readonly t: number;
  readonly bpmSuavizado: number | null;
  readonly zona: Zona | null;
  readonly fase: Fase;
  /** Fração das amostras recentes com qualidade "boa" (0 a 1). */
  readonly confianca: number;
  /** Desde quando não chega amostra boa (null = sinal presente). */
  readonly sinalPerdidoDesde: number | null;
}

/** Energia é um número de 0 a 1 que vem do catálogo (anotada na ingestão), não do sinal. */
export interface FaixaEnergia {
  readonly min: number;
  readonly max: number;
}

export const MODOS_ADAPTACAO = ["ligada", "so_sugestao", "desligada"] as const;
export type ModoAdaptacao = (typeof MODOS_ADAPTACAO)[number];

/** Preferências DECLARADAS pela pessoa. Nada aqui é inferido. */
export interface Preferencias {
  readonly generos: readonly string[];
  readonly energiaPorZona: Readonly<Partial<Record<Zona, FaixaEnergia>>>;
  readonly bloqueadas: readonly string[];
  readonly permiteExplicito: boolean;
  readonly modo: ModoAdaptacao;
}

export const ORIGENS_FAIXA = ["proprio", "licenciado"] as const;
export type OrigemFaixa = (typeof ORIGENS_FAIXA)[number];

export interface LicencaFaixa {
  /** Identificador do instrumento (contrato de encomenda, licença da biblioteca). */
  readonly instrumento: string;
  readonly permiteComercial: boolean;
  readonly permiteCrossfade: boolean;
  readonly permiteCacheOffline: boolean;
  /** Onde está a prova (documento interno). Obrigatória. */
  readonly evidencia: string;
  /** Fim da licença (ISO 8601), ou null se perpétua. */
  readonly validaAte: string | null;
}

export interface FaixaCatalogo {
  readonly id: string;
  readonly origem: OrigemFaixa;
  readonly genero: string;
  readonly explicita: boolean;
  /** 0 a 1, anotada na ingestão por análise própria. */
  readonly energia: number;
  readonly duracaoMs: number;
  /** Fronteiras de frase musical em ms, em ordem crescente (onde trocar soa natural). */
  readonly fronteirasMs: readonly number[];
  readonly licenca: LicencaFaixa;
}

export interface TravasManuais {
  readonly pausado: boolean;
  readonly faixaTravada: string | null;
  readonly zonaTravada: Zona | null;
}

export const TRAVAS_LIVRES: TravasManuais = { pausado: false, faixaTravada: null, zonaTravada: null };

export interface Tocando {
  readonly faixaId: string;
  readonly posicaoMs: number;
  /** Quando esta faixa começou (ms, mesmo relógio do contexto). */
  readonly desde: number;
}

/** Por que o motor decidiu o que decidiu. Fechado: a tela e os testes dependem destes códigos. */
export const MOTIVOS = [
  "sem_consentimento",
  "adaptacao_desligada",
  "pausado",
  "faixa_travada",
  "sem_sinal",
  "sinal_instavel",
  "faixa_atual_adequada",
  "intervalo_minimo",
  "sem_faixa_compativel",
  "zona_mudou",
  "faixa_atual_inelegivel",
  "nada_tocando",
] as const;
export type Motivo = (typeof MOTIVOS)[number];

export type Transicao = "corte" | "crossfade";

export type Decisao =
  | { readonly tipo: "manter"; readonly motivo: Motivo }
  | { readonly tipo: "nenhuma"; readonly motivo: Motivo }
  | { readonly tipo: "trocar"; readonly faixaId: string; readonly emMs: number; readonly transicao: Transicao; readonly motivo: Motivo; readonly zonaAlvo: Zona }
  | { readonly tipo: "sugerir"; readonly faixaId: string; readonly motivo: Motivo; readonly zonaAlvo: Zona };

export interface EntradaDecisao {
  /** Instante em ms no mesmo relógio das amostras. */
  readonly agora: number;
  /** Data e hora de parede (ISO 8601), só para conferir a validade das licenças. */
  readonly dataIso: string;
  readonly consentimentoVigente: boolean;
  readonly contexto: Contexto;
  readonly preferencias: Preferencias;
  readonly travas: TravasManuais;
  readonly tocando: Tocando | null;
  /** Ids das últimas faixas tocadas, mais recente por último. */
  readonly historico: readonly string[];
  /** Instante da última troca automática (null = nenhuma ainda). */
  readonly ultimaTrocaEm: number | null;
  readonly catalogo: readonly FaixaCatalogo[];
}

export type ResultadoReproducao = { readonly ok: true } | { readonly ok: false; readonly codigo: "nao_suportado" | "licenca_invalida" | "faixa_desconhecida" | "erro_player" };

/** Porta do player. O app implementa sobre o player nativo; os testes usam um falso. */
export interface PlaybackAdapter {
  readonly capacidades: { readonly crossfade: boolean };
  aplicar(decisao: Decisao): Promise<ResultadoReproducao>;
  parar(): Promise<void>;
}

/** Finalidade e categorias do consentimento (LGPD art. 11, I; CONSTITUTION.md Art. 4º). */
export const FINALIDADE_ADAPTACAO = "adaptacao_musical";
export const CATEGORIAS_SINAL = ["health", "biometric"] as const;

/**
 * Resumo de sessão: o ÚNICO dado do motor que pode sair do aparelho, e só com consentimento próprio
 * de agregados. Não leva frequência cardíaca, zona por instante, faixa tocada nem horário exato.
 */
export interface ResumoSessao {
  readonly duracaoS: number;
  readonly trocasAutomaticas: number;
  readonly pulosManuais: number;
  readonly percentualAdaptado: number;
  readonly versaoMotor: string;
}

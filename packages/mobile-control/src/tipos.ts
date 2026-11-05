// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Contratos do Mobile Control Engine (decisão D17): o que o agente pode pedir a um celular, como a
// tela chega até ele e o que um adaptador de aparelho precisa saber fazer.
//
// O vocabulário de operações foi desenhado com o do phone-harness (MIT, Shawn Pana,
// github.com/phone-harness/phone-harness, transport.py) como referência: operações nomeadas pelo
// que significam, não por como cada plataforma as faz, e cada texto marcado com a ORIGEM (árvore
// de acessibilidade, exata; ou pixels, reconhecida). Nenhum código foi copiado.
//
// Fica FORA do vocabulário, de propósito: shell/comando livre, instalar app, abrir URL qualquer,
// enviar arquivo, ler a área de transferência. Nenhum adaptador expõe essas coisas ao agente.

export const PLATAFORMAS = ["android", "ios"] as const;
export type Plataforma = (typeof PLATAFORMAS)[number];

export const PROVEDORES = ["android_local", "ios_mirroring", "phone_harness_cloud"] as const;
export type Provedor = (typeof PROVEDORES)[number];

/** Onde o aparelho está: isolado (emulador sem conta), teste (aparelho dedicado), real. */
export const AMBIENTES = ["isolado", "teste", "real"] as const;
export type Ambiente = (typeof AMBIENTES)[number];

export type Origem = "tree" | "pixels";

/** O que um pedido de ação pode ser. A observação é uma ferramenta própria. */
export const OPERACOES = ["input.tap_element", "input.text", "input.swipe", "nav.home", "nav.back", "apps.launch"] as const;
export type Operacao = (typeof OPERACOES)[number];

export type Direcao = "up" | "down" | "left" | "right";

export interface Dispositivo {
  id: string;
  /** Dono: o usuário no OBEDIENT; a organização no Growth OS. */
  tenantId: string;
  rotulo: string;
  plataforma: Plataforma;
  provedor: Provedor;
  ambiente: Ambiente;
  /** Ids de pacote que o agente pode abrir. Vazio = nenhum. */
  appsPermitidos: readonly string[];
  /** Nunca, mesmo que estejam na lista acima. Somados aos negados de sempre (politica.ts). */
  appsNegados: readonly string[];
  /** Digitar ou enviar em app de mensagem. Desligado por padrão (as réguas de envio ficam no servidor). */
  permiteMensagens: boolean;
  /** NOME da variável de ambiente com a credencial do provedor, nunca o valor. */
  credencialRef: string | null;
  ativo: boolean;
}

/** Um elemento da tela como o agente vê: texto já mascarado, sem coordenada. */
export interface Elemento {
  id: string;
  texto: string;
  origem: Origem;
  clicavel: boolean;
  campo: boolean;
}

export interface Observacao {
  observationId: string;
  sessionId: string;
  capturadaEm: string;
  app: string | null;
  /** Hash da tela já mascarada: a aprovação de um toque vale só para esta tela. */
  screenHash: string;
  elementos: Elemento[];
}

// ---- o lado do adaptador -----------------------------------------------------------------------

export interface Caixa {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** O que o adaptador lê do aparelho, antes de qualquer máscara. Nunca sai do motor assim. */
export interface ElementoBruto {
  texto: string;
  origem: Origem;
  caixa: Caixa;
  clicavel: boolean;
  /** Campo de texto editável. */
  campo?: boolean;
  /** Campo de senha: o texto nunca é lido. */
  senha?: boolean;
}

export interface CapturaBruta {
  app: string | null;
  elementos: ElementoBruto[];
  /** Hash da imagem, se o adaptador tiver; entra no hash da tela. */
  imagemHash?: string;
}

/** O que o motor manda o adaptador fazer: coordenadas saem da observação do motor, nunca do modelo. */
export type Comando =
  | { tipo: "tocar"; x: number; y: number }
  | { tipo: "digitar"; texto: string }
  | { tipo: "deslizar"; direcao: Direcao }
  | { tipo: "inicio" }
  | { tipo: "voltar" }
  | { tipo: "abrir_app"; app: string };

/** Porta de um aparelho. Cada provedor implementa; o motor é o mesmo. */
export interface AdaptadorMovel {
  iniciar(dispositivoId: string): Promise<void>;
  capturar(dispositivoId: string): Promise<CapturaBruta>;
  executar(dispositivoId: string, comando: Comando): Promise<void>;
  encerrar(dispositivoId: string): Promise<void>;
}

// ---- sessão ------------------------------------------------------------------------------------

export const ESTADOS_SESSAO = ["active", "stopped", "expired", "killed"] as const;
export type EstadoSessao = (typeof ESTADOS_SESSAO)[number];
export const ABERTOS: readonly EstadoSessao[] = ["active"];

export interface Sessao {
  id: string;
  tenantId: string;
  dispositivoId: string;
  missionId: string | null;
  estado: EstadoSessao;
  criadaEm: Date;
  expiraEm: Date;
  passos: number;
  maxPassos: number;
  /** Só a observação mais recente vale para pedir ação. */
  ultimaObservacao: string | null;
  motivoFim: string | null;
}

/** Uma ação registrada: só hash dos argumentos, nunca o texto digitado ou o que a tela mostrava. */
export interface AcaoRegistrada {
  sessionId: string;
  seq: number;
  ferramenta: string;
  operacao: Operacao | "screen.observe" | "session.start" | "session.stop";
  risco: string;
  categoria: string;
  argsHash: string;
  desfecho: "executada" | "negada" | "aguardando_aprovacao" | "tela_mudou" | "falhou";
  motivo: string | null;
  screenHashAntes: string | null;
  screenHashDepois: string | null;
  em: Date;
}

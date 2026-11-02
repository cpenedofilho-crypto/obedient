// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Proveniência: extraído de casa-de-ia/src/event-bus/tipos.ts (commit 45ba448), decisão D7, etapa 3.
// O que mudou: fontes e tipos de entidade deixaram de ser listas fixas do Growth OS e passaram a vir
// do vocabulário (vocabulario.ts), que cada sistema declara. Nomes mantidos em português para o Growth
// OS trocar só o import. `organizationId` é o tenant: no Growth OS, a organização; no OBEDIENT, o
// usuário dono da instância.

export const STATUS_ENTREGA = ["pending", "processing", "processed", "failed", "dead_letter"] as const;
export type StatusEntrega = (typeof STATUS_ENTREGA)[number];

export type TipoAtor = "user" | "agent" | "system" | "connector";

/** Um evento como o consumidor recebe. Datas já convertidas. */
export interface EventoBus {
  id: string;
  organizationId: string;
  type: string;
  source: string;
  entityType: string;
  entityId: string;
  payload: unknown;
  metadata: unknown;
  correlationId: string | null;
  causationId: string | null;
  priority: number;
  occurredAt: Date;
  createdAt: Date;
  idempotencyKey: string | null;
}

/** Evento a publicar. A organização e a fonte NÃO entram aqui: vêm do contexto autenticado. */
export interface NovoEvento {
  type: string;
  entityType: string;
  /** Id interno (entidade com tabela no sistema). Exclusivo com entityExternalId. */
  entityId?: string;
  /** Id no sistema de origem. */
  entityExternalId?: string;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  /** Mesma chave = mesmo evento. Sem chave, cada publicação é um evento novo. */
  idempotencyKey?: string;
  correlationId?: string;
  causationId?: string;
  priority?: number;
  occurredAt?: Date;
}

export interface ContextoPublicacao {
  organizationId: string;
  source: string;
  ator: { tipo: TipoAtor; id?: string };
}

/** O consumidor lança isto quando tentar de novo não adianta: a entrega vai direto para dead_letter. */
export class ErroPermanente extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "ErroPermanente";
  }
}

export type CodigoErroBarramento =
  | "evento_invalido"
  | "entidade_invalida"
  | "conflito_idempotencia"
  | "conflito_entidade"
  | "entrega_nao_encontrada";

const STATUS_HTTP: Record<CodigoErroBarramento, number> = {
  evento_invalido: 400,
  entidade_invalida: 422,
  conflito_idempotencia: 409,
  conflito_entidade: 409,
  entrega_nao_encontrada: 404,
};

/** Recusa do barramento: nada foi gravado. */
export class ErroBarramento extends Error {
  readonly status: number;
  constructor(
    readonly codigo: CodigoErroBarramento,
    mensagem: string,
  ) {
    super(mensagem);
    this.name = "ErroBarramento";
    this.status = STATUS_HTTP[codigo];
  }
}

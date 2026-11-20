// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Barramento de eventos em Postgres (decisão D20, marco M7; G10), migration 0017.
//
// A semântica é a do barramento em memória (@obedient/event-bus, memoria.ts, o contrato) e a do
// despachante do Growth OS (casa-de-ia/src/event-bus/despachar.ts). O tenant é a PESSOA:
//   • publicar valida pelo vocabulário (dado pessoal recusado, tipo e fonte conhecidos), é tudo-ou-nada
//     e idempotente por (pessoa, fonte, chave): mesma chave e conteúdo = duplicado; conteúdo diferente
//     = conflito. Grava na transação de quem publica: o evento só existe se o fato gravou (outbox);
//   • cada evento gera uma entrega por assinatura ATIVA da mesma pessoa cujo padrão casa;
//   • despachar reivindica com FOR UPDATE SKIP LOCKED, conta a tentativa NA reivindicação, roda o
//     consumidor FORA da transação e grava o desfecho só se a trava ainda for deste despachante (cerca).
//     Falha volta a failed com espera base × 2^(n-1), até 6 h; esgotou ou ErroPermanente: dead_letter;
//   • evento derivado herda a correlação e tem causation_id = o evento que o causou.

import { randomUUID } from "node:crypto";
import { type Clock, payloadHash, systemClock } from "@obedient/core";
import {
  casa,
  type ContextoPublicacao,
  ErroBarramento,
  ErroPermanente,
  esperaAntesDaProxima,
  type EventoBus,
  type NovoEvento,
  REGEX_CONSUMIDOR,
  REGEX_PADRAO,
  type RegistroDeConsumidores,
  type StatusEntrega,
  validarEvento,
  type Vocabulario,
} from "@obedient/event-bus";
import type { Database, Executor } from "./db.ts";
import { comoOperador, comoUsuario } from "./sessao.ts";

/** Prazo da trava de uma entrega; vencido, outro despachante pode pegá-la. */
export const PRAZO_TRAVA_MS = 5 * 60_000;

export interface EntregaGravada {
  id: string;
  eventId: string;
  consumer: string;
  status: StatusEntrega;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
}

/** Hash do conteúdo, sem a chave e sem correlação (como no barramento em memória). */
function conteudoHash(e: NovoEvento): string {
  const { idempotencyKey: _k, correlationId: _c, causationId: _ca, ...resto } = e;
  return payloadHash(resto);
}

interface LinhaEvento {
  id: string;
  user_id: string;
  type: string;
  source: string;
  entity_type: string;
  entity_id: string;
  payload: unknown;
  metadata: unknown;
  correlation_id: string | null;
  causation_id: string | null;
  priority: number;
  occurred_at: unknown;
  created_at: unknown;
  idempotency_key: string | null;
  content_hash: string;
}

const paraEvento = (r: LinhaEvento): EventoBus => ({
  id: r.id,
  organizationId: r.user_id,
  type: r.type,
  source: r.source,
  entityType: r.entity_type,
  entityId: r.entity_id,
  payload: r.payload ?? {},
  metadata: r.metadata ?? {},
  correlationId: r.correlation_id,
  causationId: r.causation_id,
  priority: r.priority,
  occurredAt: new Date(r.occurred_at as string),
  createdAt: new Date(r.created_at as string),
  idempotencyKey: r.idempotency_key,
});

/** O barramento dentro de uma transação já presa à pessoa (comoUsuario). */
export class BarramentoPostgres {
  constructor(
    private readonly tx: Executor,
    private readonly vocab: Vocabulario,
    private readonly clock: Clock = systemClock,
    private readonly novoId: () => string = randomUUID,
  ) {}

  async assinar(a: { userId: string; consumer: string; padroes: string[]; maxAttempts?: number; backoffSeconds?: number }): Promise<string> {
    if (!REGEX_CONSUMIDOR.test(a.consumer)) throw new ErroBarramento("evento_invalido", `nome de consumidor inválido: ${a.consumer}`);
    const padroes = a.padroes.map((p) => this.vocab.normalizarPadrao(p));
    for (const p of padroes) {
      if (!REGEX_PADRAO.test(p)) throw new ErroBarramento("evento_invalido", `padrão "${p}" fora do formato`);
      const problema = this.vocab.problemaDoPadrao(p);
      if (problema) throw new ErroBarramento("evento_invalido", problema);
    }
    const id = this.novoId();
    await this.tx.query(
      "insert into obedient.event_subscriptions (id, user_id, consumer, padroes, max_attempts, backoff_seconds, ativa, created_at) values ($1, $2, $3, $4, $5, $6, true, $7)",
      [id, a.userId, a.consumer, padroes, a.maxAttempts ?? 5, a.backoffSeconds ?? 30, this.clock.now()],
    );
    return id;
  }

  async desativar(consumer: string): Promise<void> {
    await this.tx.query("update obedient.event_subscriptions set ativa = false where consumer = $1", [consumer]);
  }

  /** Tudo-ou-nada: valida o lote inteiro e confere os conflitos antes de gravar qualquer evento. */
  async publicar(ctx: ContextoPublicacao, novos: NovoEvento[]): Promise<{ id: string; duplicate: boolean; correlationId: string | null }[]> {
    if (!this.vocab.fontes.includes(ctx.source)) throw new ErroBarramento("evento_invalido", `fonte "${ctx.source}" não existe no vocabulário`);
    const normais = novos.map((e) => ({ ...e, type: this.vocab.normalizarTipo(e.type) }));
    normais.forEach((e, i) => validarEvento(e, this.vocab, i, ctx.source));
    const existentes = new Map<string, { id: string; hash: string; correlationId: string | null }>();
    for (const e of normais) {
      if (!e.idempotencyKey) continue;
      const { rows } = await this.tx.query<{ id: string; content_hash: string; correlation_id: string | null }>(
        "select id, content_hash, correlation_id from obedient.events where user_id = $1 and source = $2 and idempotency_key = $3",
        [ctx.organizationId, ctx.source, e.idempotencyKey],
      );
      const atual = rows[0];
      if (atual && atual.content_hash !== conteudoHash(e))
        throw new ErroBarramento("conflito_idempotencia", `idempotency_key ${e.idempotencyKey} já foi usada com outro conteúdo`);
      if (atual) existentes.set(e.idempotencyKey, { id: atual.id, hash: atual.content_hash, correlationId: atual.correlation_id });
    }
    const assinaturas = (
      await this.tx.query<{ consumer: string; padroes: string[]; max_attempts: number; backoff_seconds: number }>(
        "select consumer, padroes, max_attempts, backoff_seconds from obedient.event_subscriptions where user_id = $1 and ativa order by consumer",
        [ctx.organizationId],
      )
    ).rows;
    const saida: { id: string; duplicate: boolean; correlationId: string | null }[] = [];
    for (const e of normais) {
      const ja = e.idempotencyKey ? existentes.get(e.idempotencyKey) : undefined;
      if (ja) {
        saida.push({ id: ja.id, duplicate: true, correlationId: ja.correlationId });
        continue;
      }
      const agora = this.clock.now();
      const id = this.novoId();
      const correlacao = e.correlationId ?? id;
      await this.tx.query(
        `insert into obedient.events (id, user_id, type, source, entity_type, entity_id, payload, metadata, correlation_id, causation_id, priority, occurred_at, created_at, idempotency_key, content_hash)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13, $14, $15)`,
        [id, ctx.organizationId, e.type, ctx.source, e.entityType, e.entityId ?? `ext:${e.entityExternalId}`, JSON.stringify(e.payload ?? {}), JSON.stringify(e.metadata ?? {}),
          correlacao, e.causationId ?? null, e.priority ?? 5, e.occurredAt ?? agora, agora, e.idempotencyKey ?? null, conteudoHash(e)],
      );
      if (e.idempotencyKey) existentes.set(e.idempotencyKey, { id, hash: conteudoHash(e), correlationId: correlacao });
      for (const s of assinaturas) {
        if (!casa(s.padroes, e.type)) continue;
        await this.tx.query(
          `insert into obedient.event_deliveries (id, user_id, event_id, consumer, status, attempts, max_attempts, backoff_seconds, priority, next_attempt_at)
           values ($1, $2, $3, $4, 'pending', 0, $5, $6, $7, $8)`,
          [this.novoId(), ctx.organizationId, id, s.consumer, s.max_attempts, s.backoff_seconds, e.priority ?? 5, agora],
        );
      }
      saida.push({ id, duplicate: false, correlationId: correlacao });
    }
    return saida;
  }

  async evento(id: string): Promise<EventoBus | undefined> {
    const { rows } = await this.tx.query<LinhaEvento>("select * from obedient.events where id = $1", [id]);
    return rows[0] ? paraEvento(rows[0]) : undefined;
  }

  async entregas(): Promise<EntregaGravada[]> {
    const { rows } = await this.tx.query<{ id: string; event_id: string; consumer: string; status: StatusEntrega; attempts: number; max_attempts: number; next_attempt_at: unknown; last_error: string | null }>(
      "select id, event_id, consumer, status, attempts, max_attempts, next_attempt_at, last_error from obedient.event_deliveries order by next_attempt_at, id",
    );
    return rows.map((r) => ({ id: r.id, eventId: r.event_id, consumer: r.consumer, status: r.status, attempts: r.attempts, maxAttempts: r.max_attempts, nextAttemptAt: new Date(r.next_attempt_at as string), lastError: r.last_error }));
  }

  /** Reenvia uma entrega em dead_letter (decisão humana), zerando as tentativas. */
  async reprocessar(entregaId: string): Promise<void> {
    const { rows } = await this.tx.query<{ status: string }>("select status from obedient.event_deliveries where id = $1", [entregaId]);
    if (!rows[0]) throw new ErroBarramento("entrega_nao_encontrada", "entrega não encontrada");
    if (rows[0].status !== "dead_letter") throw new ErroBarramento("evento_invalido", `entrega em ${rows[0].status}, não em dead_letter`);
    await this.tx.query("update obedient.event_deliveries set status = 'pending', attempts = 0, next_attempt_at = $2, last_error = null where id = $1", [entregaId, this.clock.now()]);
  }
}

export interface ResultadoDespachoPg {
  reivindicadas: number;
  processadas: number;
  falhas: number;
  mortas: number;
  travasPerdidas: number;
}

/**
 * Despacha as entregas devidas de uma pessoa: reivindica num lote curto, roda cada consumidor fora da
 * transação e grava o desfecho só se a trava ainda for deste despachante.
 */
export async function despacharEventos(
  db: Database,
  userId: string,
  registro: RegistroDeConsumidores,
  o: { vocab: Vocabulario; clock?: Clock; worker?: string; lote?: number; prazoTravaMs?: number },
): Promise<ResultadoDespachoPg> {
  const clock = o.clock ?? systemClock;
  const worker = (o.worker ?? `despachante:${randomUUID().slice(0, 8)}`).slice(0, 200);
  const r: ResultadoDespachoPg = { reivindicadas: 0, processadas: 0, falhas: 0, mortas: 0, travasPerdidas: 0 };
  const agora = clock.now();
  const ate = new Date(agora.getTime() + (o.prazoTravaMs ?? PRAZO_TRAVA_MS));
  const reivindicadas = await comoUsuario(db, userId, async (tx) => {
    const { rows } = await tx.query<{ id: string; event_id: string; consumer: string; attempts: number; max_attempts: number; backoff_seconds: number }>(
      `update obedient.event_deliveries set status = 'processing', attempts = attempts + 1, locked_by = $2, locked_until = $3
        where id in (
          select id from obedient.event_deliveries
           where (status in ('pending', 'failed') and next_attempt_at <= $1) or (status = 'processing' and locked_until < $1)
           order by priority desc, next_attempt_at, id
           limit $4
           for update skip locked)
        returning id, event_id, consumer, attempts, max_attempts, backoff_seconds`,
      [agora, worker, ate, Math.min(Math.max(o.lote ?? 50, 1), 500)],
    );
    const eventos = new Map<string, EventoBus>();
    for (const d of rows) {
      if (eventos.has(d.event_id)) continue;
      const e = await tx.query<LinhaEvento>("select * from obedient.events where id = $1", [d.event_id]);
      if (e.rows[0]) eventos.set(d.event_id, paraEvento(e.rows[0]));
    }
    return rows.map((d) => ({ ...d, evento: eventos.get(d.event_id)! }));
  });
  r.reivindicadas = reivindicadas.length;
  for (const d of reivindicadas) {
    let erro: unknown = null;
    let resultado: unknown = null;
    // Trava vencida de um despachante que morreu e já gastou as tentativas: não roda de novo.
    if (d.attempts > d.max_attempts) erro = new ErroPermanente("tentativas esgotadas: o despachante anterior parou no meio");
    else {
      try {
        const fn = registro.obter(d.consumer);
        if (!fn) throw new Error(`consumidor ${d.consumer} não está registrado neste deploy`);
        resultado = await fn(structuredClone(d.evento), {
          entregaId: d.id,
          tentativa: d.attempts,
          publicar: (derivados) =>
            comoUsuario(db, userId, (tx) =>
              new BarramentoPostgres(tx, o.vocab, clock).publicar(
                { organizationId: userId, source: d.evento.source, ator: { tipo: "system", id: d.consumer } },
                derivados.map((x) => ({ ...x, correlationId: d.evento.correlationId ?? d.evento.id, causationId: d.evento.id })),
              ),
            ),
        });
      } catch (e) {
        erro = e;
      }
    }
    const fim = clock.now();
    let status: StatusEntrega;
    let proxima: Date | null = null;
    if (erro === null) status = "processed";
    else if (erro instanceof ErroPermanente || d.attempts >= d.max_attempts) status = "dead_letter";
    else {
      status = "failed";
      proxima = new Date(fim.getTime() + esperaAntesDaProxima(d.attempts, d.backoff_seconds) * 1000);
    }
    const mensagem = erro === null ? null : (erro instanceof Error ? erro.message : String(erro)).slice(0, 500);
    // Cerca: só grava se a trava ainda for deste despachante.
    const gravou = await comoUsuario(db, userId, async (tx) => {
      const { rows } = await tx.query(
        `update obedient.event_deliveries
            set status = $3, locked_by = null, locked_until = null, last_error = $4, result = $5::jsonb, next_attempt_at = coalesce($6, next_attempt_at)
          where id = $1 and locked_by = $2 and status = 'processing' returning id`,
        [d.id, worker, status, mensagem, resultado === null || resultado === undefined ? null : JSON.stringify(resultado), proxima],
      );
      return rows.length > 0;
    });
    if (!gravou) r.travasPerdidas++;
    else if (status === "processed") r.processadas++;
    else if (status === "failed") r.falhas++;
    else r.mortas++;
  }
  return r;
}

/** Quem tem entrega devida (para o agendador): só ids de pessoa. */
export function pessoasComEntregaDevida(db: Database, agora: Date, limite = 100): Promise<string[]> {
  return comoOperador(db, async (tx) => (await tx.query<{ pessoas_com_entrega_devida: string }>("select obedient.pessoas_com_entrega_devida($1, $2)", [agora, limite])).rows.map((x) => x.pessoas_com_entrega_devida));
}

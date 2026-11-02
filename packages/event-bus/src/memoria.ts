// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Barramento em memória: a mesma semântica do despachante do Growth OS (casa-de-ia/src/event-bus/
// despachar.ts e ingresso.ts, commit 45ba448), sem banco. Serve ao OBEDIENT em processo único e é o
// CONTRATO que a implementação Postgres tem de cumprir (os testes daqui valem para as duas).
//
//   • Publicar valida, normaliza o tipo legado e é idempotente por (tenant, fonte, chave): mesma
//     chave e mesmo conteúdo = duplicado, nada novo; mesma chave e conteúdo diferente = conflito.
//   • Cada evento gera uma entrega por assinatura do MESMO tenant cujo padrão casa. Tenant nunca cruza.
//   • Entrega é "pelo menos uma vez": a tentativa é contada antes de chamar o consumidor.
//   • Falha volta a `failed` com espera base × 2^(n-1), até 6 h. Esgotou as tentativas, ou
//     ErroPermanente: `dead_letter`. Consumidor desconhecido conta como falha (o próximo deploy
//     pode trazê-lo).
//   • Evento derivado herda o tenant, o correlation_id e tem causation_id = o evento que o causou.
//
// O que fica de fora de propósito: trava com prazo e cerca entre despachantes (só fazem sentido com
// vários processos e banco; a implementação Postgres do Growth OS as mantém).

import { randomUUID } from "node:crypto";
import { payloadHash } from "@obedient/core";
import type { RegistroDeConsumidores } from "./consumidores.ts";
import { casa, esperaAntesDaProxima, REGEX_CONSUMIDOR, REGEX_PADRAO, validarEvento } from "./regras.ts";
import { type ContextoPublicacao, ErroBarramento, ErroPermanente, type EventoBus, type NovoEvento, type StatusEntrega } from "./tipos.ts";
import type { Vocabulario } from "./vocabulario.ts";

export interface Assinatura {
  id: string;
  organizationId: string;
  consumer: string;
  padroes: string[];
  maxAttempts: number;
  backoffSeconds: number;
  ativa: boolean;
}

export interface Entrega {
  id: string;
  organizationId: string;
  eventId: string;
  consumer: string;
  status: StatusEntrega;
  attempts: number;
  maxAttempts: number;
  backoffSeconds: number;
  priority: number;
  nextAttemptAt: Date;
  lastError: string | null;
  result: unknown;
}

export interface ResultadoDespacho {
  processadas: number;
  falhas: number;
  mortas: number;
}

export interface Relogio {
  now(): Date;
}

/** Hash do conteúdo, sem a chave e sem correlação (que não mudam o que o evento diz). JSON canônico: ordem de chave não importa. */
function conteudoHash(e: NovoEvento): string {
  const { idempotencyKey: _k, correlationId: _c, causationId: _ca, ...resto } = e;
  return payloadHash(resto);
}

export class BarramentoEmMemoria {
  private readonly eventos = new Map<string, EventoBus>();
  private readonly porChave = new Map<string, { id: string; hash: string }>();
  private readonly assinaturas: Assinatura[] = [];
  private readonly entregas = new Map<string, Entrega>();

  constructor(
    private readonly vocab: Vocabulario,
    private readonly relogio: Relogio = { now: () => new Date() },
    private readonly novoId: () => string = randomUUID,
  ) {}

  assinar(a: { organizationId: string; consumer: string; padroes: string[]; maxAttempts?: number; backoffSeconds?: number }): Assinatura {
    if (!REGEX_CONSUMIDOR.test(a.consumer)) throw new ErroBarramento("evento_invalido", `nome de consumidor inválido: ${a.consumer}`);
    const padroes = a.padroes.map((p) => this.vocab.normalizarPadrao(p));
    for (const p of padroes) {
      if (!REGEX_PADRAO.test(p)) throw new ErroBarramento("evento_invalido", `padrão "${p}" fora do formato`);
      const problema = this.vocab.problemaDoPadrao(p);
      if (problema) throw new ErroBarramento("evento_invalido", problema);
    }
    const s: Assinatura = {
      id: this.novoId(),
      organizationId: a.organizationId,
      consumer: a.consumer,
      padroes,
      maxAttempts: a.maxAttempts ?? 5,
      backoffSeconds: a.backoffSeconds ?? 30,
      ativa: true,
    };
    this.assinaturas.push(s);
    return { ...s, padroes: [...s.padroes] };
  }

  /** Tudo-ou-nada: valida o lote inteiro antes de gravar qualquer evento. */
  publicar(ctx: ContextoPublicacao, novos: NovoEvento[]): { id: string; duplicate: boolean; correlationId: string | null }[] {
    if (!this.vocab.fontes.includes(ctx.source)) throw new ErroBarramento("evento_invalido", `fonte "${ctx.source}" não existe no vocabulário`);
    const normais = novos.map((e) => ({ ...e, type: this.vocab.normalizarTipo(e.type) }));
    normais.forEach((e, i) => validarEvento(e, this.vocab, i, ctx.source));
    // Conflito de idempotência também é conferido antes de gravar (tudo-ou-nada).
    for (const e of normais) {
      if (!e.idempotencyKey) continue;
      const atual = this.porChave.get(this.chave(ctx, e.idempotencyKey));
      if (atual && atual.hash !== conteudoHash(e))
        throw new ErroBarramento("conflito_idempotencia", `idempotency_key ${e.idempotencyKey} já foi usada com outro conteúdo`);
    }
    return normais.map((e) => {
      if (e.idempotencyKey) {
        const atual = this.porChave.get(this.chave(ctx, e.idempotencyKey));
        if (atual) return { id: atual.id, duplicate: true, correlationId: this.eventos.get(atual.id)!.correlationId };
      }
      const agora = this.relogio.now();
      const id = this.novoId();
      const ev: EventoBus = {
        id,
        organizationId: ctx.organizationId,
        type: e.type,
        source: ctx.source,
        entityType: e.entityType,
        entityId: e.entityId ?? `ext:${e.entityExternalId}`,
        payload: structuredClone(e.payload ?? {}),
        metadata: structuredClone(e.metadata ?? {}),
        correlationId: e.correlationId ?? id,
        causationId: e.causationId ?? null,
        priority: e.priority ?? 5,
        occurredAt: e.occurredAt ?? agora,
        createdAt: agora,
        idempotencyKey: e.idempotencyKey ?? null,
      };
      this.eventos.set(id, ev);
      if (e.idempotencyKey) this.porChave.set(this.chave(ctx, e.idempotencyKey), { id, hash: conteudoHash(e) });
      for (const s of this.assinaturas)
        if (s.ativa && s.organizationId === ctx.organizationId && casa(s.padroes, ev.type)) {
          const d: Entrega = {
            id: this.novoId(),
            organizationId: ctx.organizationId,
            eventId: id,
            consumer: s.consumer,
            status: "pending",
            attempts: 0,
            maxAttempts: s.maxAttempts,
            backoffSeconds: s.backoffSeconds,
            priority: ev.priority,
            nextAttemptAt: agora,
            lastError: null,
            result: null,
          };
          this.entregas.set(d.id, d);
        }
      return { id, duplicate: false, correlationId: ev.correlationId };
    });
  }

  /** Processa as entregas vencidas, da maior prioridade para a menor. */
  async despachar(registro: RegistroDeConsumidores, limite = 100): Promise<ResultadoDespacho> {
    const agora = this.relogio.now();
    const r: ResultadoDespacho = { processadas: 0, falhas: 0, mortas: 0 };
    const vencidas = [...this.entregas.values()]
      .filter((d) => (d.status === "pending" || d.status === "failed") && d.nextAttemptAt <= agora)
      .sort((a, b) => b.priority - a.priority || a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
      .slice(0, limite);
    for (const d of vencidas) {
      d.status = "processing";
      d.attempts += 1; // contada antes: um consumidor que derruba o processo também gasta tentativa
      const evento = this.eventos.get(d.eventId)!;
      let erro: unknown = null;
      let resultado: unknown = null;
      try {
        const fn = registro.obter(d.consumer);
        if (!fn) throw new Error(`consumidor ${d.consumer} não está registrado neste deploy`);
        resultado = await fn(structuredClone(evento), {
          entregaId: d.id,
          tentativa: d.attempts,
          publicar: async (derivados) =>
            this.publicar(
              { organizationId: evento.organizationId, source: evento.source, ator: { tipo: "system", id: d.consumer } },
              derivados.map((x) => ({ ...x, correlationId: evento.correlationId ?? evento.id, causationId: evento.id })),
            ),
        });
      } catch (e) {
        erro = e;
      }
      if (erro === null) {
        d.status = "processed";
        d.result = resultado ?? null;
        d.lastError = null;
        r.processadas++;
        continue;
      }
      d.lastError = erro instanceof Error ? erro.message : String(erro);
      if (erro instanceof ErroPermanente || d.attempts >= d.maxAttempts) {
        d.status = "dead_letter";
        r.mortas++;
      } else {
        d.status = "failed";
        d.nextAttemptAt = new Date(agora.getTime() + esperaAntesDaProxima(d.attempts, d.backoffSeconds) * 1000);
        r.falhas++;
      }
    }
    return r;
  }

  evento(id: string): EventoBus | undefined {
    const e = this.eventos.get(id);
    return e ? structuredClone(e) : undefined;
  }

  entregasDo(organizationId: string): Entrega[] {
    return [...this.entregas.values()].filter((d) => d.organizationId === organizationId).map((d) => ({ ...d }));
  }

  /** Reenvia uma entrega em dead_letter (decisão humana), zerando as tentativas. */
  reprocessar(organizationId: string, entregaId: string): void {
    const d = this.entregas.get(entregaId);
    if (!d || d.organizationId !== organizationId) throw new ErroBarramento("entrega_nao_encontrada", "entrega não encontrada");
    if (d.status !== "dead_letter") throw new ErroBarramento("evento_invalido", `entrega em ${d.status}, não em dead_letter`);
    d.status = "pending";
    d.attempts = 0;
    d.nextAttemptAt = this.relogio.now();
  }

  private chave(ctx: ContextoPublicacao, k: string): string {
    return `${ctx.organizationId}\u0000${ctx.source}\u0000${k}`;
  }
}

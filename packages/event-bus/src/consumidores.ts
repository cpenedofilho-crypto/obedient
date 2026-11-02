// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Proveniência: extraído de casa-de-ia/src/event-bus/consumidores.ts (commit 45ba448), decisão D7.
// Ficou de fora só a instância global do deploy do Growth OS (consumidoresDoDeploy).
//
// Registro dos consumidores: o NOME gravado em event_subscriptions.consumer aponta
// para uma função deste registro. A assinatura diz QUAIS eventos; o código diz O QUE
// fazer. Assinatura de um consumidor que este deploy não conhece falha e é tentada de
// novo (o próximo deploy pode trazê-lo); esgotadas as tentativas, vai para dead_letter.
//
// Entrega é "pelo menos uma vez": um consumidor pode receber o mesmo evento de novo
// (tempo esgotado, trava vencida). Todo consumidor precisa ser idempotente pelo
// evento.id.
import { REGEX_CONSUMIDOR } from "./regras.ts";
import type { EventoBus, NovoEvento } from "./tipos.ts";

/** Evento que um consumidor publica em reação: organização, correlação e causa são herdadas. */
export type EventoDerivado = Omit<NovoEvento, "correlationId" | "causationId">;

export interface ContextoConsumo {
  entregaId: string;
  tentativa: number;
  /** Publica eventos derivados na mesma organização, com correlation_id herdado e causation_id = este evento. */
  publicar(eventos: EventoDerivado[]): Promise<{ id: string; duplicate: boolean }[]>;
}

export type Consumidor = (evento: EventoBus, ctx: ContextoConsumo) => unknown | Promise<unknown>;

export class RegistroDeConsumidores {
  private readonly mapa = new Map<string, Consumidor>();

  registrar(nome: string, fn: Consumidor): this {
    if (!REGEX_CONSUMIDOR.test(nome)) throw new Error(`nome de consumidor inválido: ${nome}`);
    if (this.mapa.has(nome)) throw new Error(`consumidor ${nome} registrado duas vezes`);
    this.mapa.set(nome, fn);
    return this;
  }

  obter(nome: string): Consumidor | undefined {
    return this.mapa.get(nome);
  }

  nomes(): string[] {
    return [...this.mapa.keys()];
  }
}

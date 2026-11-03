// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Emergency Stop (CONSTITUTION.md Art. 9º). Conferido no servidor ANTES de cada ferramenta, por
// usuário e global. Acionar é permitido a quem estiver protegendo o usuário (o próprio usuário,
// o operador do serviço, um monitor); LIBERAR só o usuário (escopo do usuário) ou o operador
// (escopo global). Agente nunca libera. Ao acionar, os ouvintes revogam tokens e cancelam missões.

import { type Clock, ObedientError, systemClock } from "@obedient/core";

export type StopScope = { kind: "global" } | { kind: "user"; userId: string };

export interface StopState {
  engagedAt: Date;
  engagedBy: string;
  reason: string;
}

export type StopListener = (scope: StopScope, state: StopState) => void | Promise<void>;

/** Onde o estado da parada fica. Num banco, a parada vale para todos os processos ao mesmo tempo. */
export interface StopStore {
  get(scope: StopScope): Promise<StopState | null>;
  set(scope: StopScope, state: StopState): Promise<void>;
  clear(scope: StopScope): Promise<void>;
}

export class InMemoryStopStore implements StopStore {
  private global: StopState | null = null;
  private readonly users = new Map<string, StopState>();
  async get(scope: StopScope): Promise<StopState | null> {
    return scope.kind === "global" ? this.global : (this.users.get(scope.userId) ?? null);
  }
  async set(scope: StopScope, state: StopState): Promise<void> {
    if (scope.kind === "global") this.global = state;
    else this.users.set(scope.userId, state);
  }
  async clear(scope: StopScope): Promise<void> {
    if (scope.kind === "global") this.global = null;
    else this.users.delete(scope.userId);
  }
}

export class EmergencyStop {
  private readonly listeners: StopListener[] = [];

  constructor(
    private readonly clock: Clock = systemClock,
    /** Ids com poder de liberar o escopo global (operadores do serviço). */
    private readonly operators: ReadonlySet<string> = new Set(),
    private readonly store: StopStore = new InMemoryStopStore(),
  ) {}

  onEngage(l: StopListener): void {
    this.listeners.push(l);
  }

  async engage(scope: StopScope, by: string, reason: string): Promise<StopState> {
    const state: StopState = { engagedAt: this.clock.now(), engagedBy: by, reason };
    await this.store.set(scope, state);
    // Ouvinte com erro não impede os outros nem desfaz a parada.
    await Promise.allSettled(this.listeners.map(async (l) => l(scope, state)));
    return state;
  }

  async release(scope: StopScope, by: string, byKind: "user" | "agent" | "operator"): Promise<void> {
    if (byKind === "agent") throw new ObedientError("EMERGENCY_STOP", "agente não libera parada de emergência");
    if (scope.kind === "global") {
      if (byKind !== "operator" || !this.operators.has(by)) throw new ObedientError("EMERGENCY_STOP", "só operador libera a parada global");
    } else if (byKind !== "user" || by !== scope.userId) throw new ObedientError("EMERGENCY_STOP", "só o próprio usuário libera a parada dele");
    await this.store.clear(scope);
  }

  /** Estado que bloqueia este usuário agora (global vence). */
  async blocking(userId: string): Promise<StopState | null> {
    return (await this.store.get({ kind: "global" })) ?? (await this.store.get({ kind: "user", userId }));
  }
}

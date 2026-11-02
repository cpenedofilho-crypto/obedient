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

export class EmergencyStop {
  private global: StopState | null = null;
  private readonly users = new Map<string, StopState>();
  private readonly listeners: StopListener[] = [];

  constructor(
    private readonly clock: Clock = systemClock,
    /** Ids com poder de liberar o escopo global (operadores do serviço). */
    private readonly operators: ReadonlySet<string> = new Set(),
  ) {}

  onEngage(l: StopListener): void {
    this.listeners.push(l);
  }

  async engage(scope: StopScope, by: string, reason: string): Promise<StopState> {
    const state: StopState = { engagedAt: this.clock.now(), engagedBy: by, reason };
    if (scope.kind === "global") this.global = state;
    else this.users.set(scope.userId, state);
    // Ouvinte com erro não impede os outros nem desfaz a parada.
    await Promise.allSettled(this.listeners.map(async (l) => l(scope, state)));
    return state;
  }

  release(scope: StopScope, by: string, byKind: "user" | "agent" | "operator"): void {
    if (byKind === "agent") throw new ObedientError("EMERGENCY_STOP", "agente não libera parada de emergência");
    if (scope.kind === "global") {
      if (byKind !== "operator" || !this.operators.has(by)) throw new ObedientError("EMERGENCY_STOP", "só operador libera a parada global");
      this.global = null;
      return;
    }
    if (byKind !== "user" || by !== scope.userId) throw new ObedientError("EMERGENCY_STOP", "só o próprio usuário libera a parada dele");
    this.users.delete(scope.userId);
  }

  /** Estado que bloqueia este usuário agora (global vence). */
  blocking(userId: string): StopState | null {
    return this.global ?? this.users.get(userId) ?? null;
  }
}

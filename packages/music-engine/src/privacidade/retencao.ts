// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Trilha local de decisões, para a pessoa ver "por que trocou a música". Fica só no aparelho, sem
// frequência cardíaca nem bpm (só a zona-alvo e o motivo), apaga sozinha depois do prazo e pode ser
// exportada ou apagada inteira a qualquer momento (LGPD art. 18; CONSTITUTION.md Art. 13).

import type { Clock } from "@obedient/core";
import { systemClock } from "@obedient/core";
import type { Decisao, Motivo, Zona } from "@obedient/music-contracts";

export const RETENCAO_PADRAO_MS = 24 * 3600_000;

export interface RegistroDecisao {
  readonly em: string;
  readonly tipo: Decisao["tipo"];
  readonly motivo: Motivo;
  readonly zonaAlvo: Zona | null;
  readonly faixaId: string | null;
}

export class TrilhaLocal {
  private registros: { emMs: number; r: RegistroDecisao }[] = [];

  /** retencaoMs = 0 significa "não guardar nada". */
  constructor(
    private readonly retencaoMs: number = RETENCAO_PADRAO_MS,
    private readonly clock: Clock = systemClock,
  ) {
    if (!(retencaoMs >= 0)) throw new RangeError("retenção negativa");
  }

  registrar(d: Decisao): void {
    if (this.retencaoMs === 0) return;
    const agora = this.clock.now();
    this.registros.push({
      emMs: agora.getTime(),
      r: {
        em: agora.toISOString(),
        tipo: d.tipo,
        motivo: d.motivo,
        zonaAlvo: d.tipo === "trocar" || d.tipo === "sugerir" ? d.zonaAlvo : null,
        faixaId: d.tipo === "trocar" || d.tipo === "sugerir" ? d.faixaId : null,
      },
    });
    this.expurgar();
  }

  /** O que a pessoa vê e pode exportar. */
  exportar(): RegistroDecisao[] {
    this.expurgar();
    return this.registros.map((x) => ({ ...x.r }));
  }

  apagarTudo(): void {
    this.registros = [];
  }

  private expurgar(): void {
    const limite = this.clock.now().getTime() - this.retencaoMs;
    this.registros = this.registros.filter((x) => x.emMs > limite);
  }
}

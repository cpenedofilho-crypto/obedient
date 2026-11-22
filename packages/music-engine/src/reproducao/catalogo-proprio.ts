// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Playback Adapter do catálogo próprio. O som de verdade sai do player nativo do app, que implementa
// a porta PlayerNativo. Este adaptador é a última barreira antes do alto-falante: confere de novo a
// licença da faixa (pode ter vencido desde a ingestão), nunca faz crossfade que a licença não permite
// e nunca altera o áudio (sem mudar tempo nem tom; a porta nem oferece isso).

import type { Clock } from "@obedient/core";
import { systemClock } from "@obedient/core";
import type { Decisao, FaixaCatalogo, PlaybackAdapter, ResultadoReproducao } from "@obedient/music-contracts";
import { validarFaixa } from "../preferencias/engine.ts";

/** O que o app precisa oferecer. Repare que não há "taxa de reprodução" nem "tom". */
export interface PlayerNativo {
  readonly suportaCrossfade: boolean;
  tocar(faixaId: string, opcoes: { emMs: number; crossfade: boolean }): Promise<void>;
  /** Mostra a sugestão na tela; só toca se a pessoa tocar no botão. */
  sugerir(faixaId: string): Promise<void>;
  parar(): Promise<void>;
}

export class AdaptadorCatalogoProprio implements PlaybackAdapter {
  private readonly faixas: Map<string, FaixaCatalogo>;

  constructor(
    catalogo: readonly FaixaCatalogo[],
    private readonly player: PlayerNativo,
    private readonly clock: Clock = systemClock,
  ) {
    this.faixas = new Map(catalogo.map((f) => [f.id, f]));
  }

  get capacidades() {
    return { crossfade: this.player.suportaCrossfade };
  }

  async aplicar(d: Decisao): Promise<ResultadoReproducao> {
    if (d.tipo === "manter" || d.tipo === "nenhuma") return { ok: true };
    const faixa = this.faixas.get(d.faixaId);
    if (!faixa) return { ok: false, codigo: "faixa_desconhecida" };
    if (validarFaixa(faixa, this.clock.now().toISOString()).length) return { ok: false, codigo: "licenca_invalida" };
    try {
      if (d.tipo === "sugerir") await this.player.sugerir(d.faixaId);
      else await this.player.tocar(d.faixaId, { emMs: d.emMs, crossfade: d.transicao === "crossfade" && this.player.suportaCrossfade && faixa.licenca.permiteCrossfade });
      return { ok: true };
    } catch {
      return { ok: false, codigo: "erro_player" };
    }
  }

  parar(): Promise<void> {
    return this.player.parar();
  }
}

/** Player falso para testes e para o simulador: só registra o que pediram. */
export class PlayerFalso implements PlayerNativo {
  readonly pedidos: { acao: "tocar" | "sugerir" | "parar"; faixaId?: string; emMs?: number; crossfade?: boolean }[] = [];
  constructor(
    readonly suportaCrossfade = true,
    private readonly falhar = false,
  ) {}
  async tocar(faixaId: string, o: { emMs: number; crossfade: boolean }): Promise<void> {
    if (this.falhar) throw new Error("player indisponível");
    this.pedidos.push({ acao: "tocar", faixaId, emMs: o.emMs, crossfade: o.crossfade });
  }
  async sugerir(faixaId: string): Promise<void> {
    this.pedidos.push({ acao: "sugerir", faixaId });
  }
  async parar(): Promise<void> {
    this.pedidos.push({ acao: "parar" });
  }
}

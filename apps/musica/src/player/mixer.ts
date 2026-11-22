// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// PlayerNativo do motor sobre dois canais de áudio: a faixa nova entra no canal livre, na hora marcada
// pela decisão (fronteira de frase), e a troca é por corte ou por crossfade de volume. Só volume: o canal
// não oferece taxa de reprodução nem tom (D31: o áudio nunca é alterado). O canal real é o expo-audio
// (plataforma/canal-expo-audio.ts); nos testes, um canal falso.
import type { PlayerNativo } from "@obedient/music-engine";

export interface CanalAudio {
  carregar(uri: string): Promise<void>;
  tocar(): void;
  pausar(): void;
  volume(v: number): void;
  /** Chamado quando a faixa termina sozinha. */
  aoTerminar(f: () => void): void;
}

export interface Agenda {
  agora(): number;
  depois(ms: number, f: () => void): () => void;
}

export const CROSSFADE_MS = 3000;
const PASSOS = 15;

export class Mixer implements PlayerNativo {
  readonly suportaCrossfade = true;
  private ativo = 0;
  private pendentes: (() => void)[] = [];
  private tocandoId: string | null = null;
  private aoFimDaFaixa: ((id: string) => void) | null = null;

  constructor(
    private readonly canais: readonly [CanalAudio, CanalAudio],
    private readonly uriDe: (faixaId: string) => Promise<string | null>,
    private readonly agenda: Agenda,
    private readonly aoSugerir: (faixaId: string) => void,
  ) {
    canais.forEach((c, i) => c.aoTerminar(() => {
      if (i === this.ativo && this.tocandoId) this.aoFimDaFaixa?.(this.tocandoId);
    }));
  }

  /** Avisa quando a faixa atual acabar sozinha (o app informa a sessão). */
  quandoAcabar(f: (id: string) => void): void { this.aoFimDaFaixa = f; }

  async tocar(faixaId: string, o: { emMs: number; crossfade: boolean }): Promise<void> {
    const uri = await this.uriDe(faixaId);
    if (!uri) throw new Error(`faixa sem arquivo no aparelho: ${faixaId}`);
    const livre = 1 - this.ativo;
    const novo = this.canais[livre]!;
    await novo.carregar(uri);
    const atraso = Math.max(0, o.emMs - this.agenda.agora());
    this.pendentes.push(this.agenda.depois(atraso, () => this.trocar(livre, faixaId, o.crossfade)));
  }

  async sugerir(faixaId: string): Promise<void> {
    this.aoSugerir(faixaId);
  }

  async parar(): Promise<void> {
    for (const cancelar of this.pendentes.splice(0)) cancelar();
    for (const c of this.canais) c.pausar();
    this.tocandoId = null;
  }

  private trocar(novoIdx: number, faixaId: string, crossfade: boolean): void {
    const velho = this.canais[this.ativo]!;
    const novo = this.canais[novoIdx]!;
    const haviaFaixa = this.tocandoId !== null;
    this.ativo = novoIdx;
    this.tocandoId = faixaId;
    if (!crossfade || !haviaFaixa) {
      velho.pausar();
      novo.volume(1);
      novo.tocar();
      return;
    }
    novo.volume(0);
    novo.tocar();
    for (let p = 1; p <= PASSOS; p++) {
      const fracao = p / PASSOS;
      this.pendentes.push(this.agenda.depois((CROSSFADE_MS * p) / PASSOS, () => {
        novo.volume(fracao);
        velho.volume(1 - fracao);
        if (p === PASSOS) velho.pausar();
      }));
    }
  }
}

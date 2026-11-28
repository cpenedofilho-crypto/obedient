// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Context Engine: transforma amostras em um contexto estável (bpm suavizado, zona, fase).
// Tudo por regra explicável, sem modelo aprendido e sem entrada de humor (D31; ver o quadro de
// reivindicações em docs/governance/music-engine-f0.md):
//   - média exponencial só das amostras boas;
//   - histerese em bpm: a zona só muda se a média passar do limite com folga;
//   - permanência mínima: a zona nova precisa se sustentar por um tempo antes de valer;
//   - fase por regra: aquecimento até haver esforço, esforço a partir de z3, recuperação depois dele.
// Roda no aparelho. Nada daqui sai dele.

import type { AmostraFiltrada, AmostraSinal, ConfigContexto, Contexto, Fase, Zona } from "@obedient/music-contracts";
import { classificar } from "./filtro-artefatos.ts";
import { ordemZona, validarParametros, zonaDe } from "./zonas.ts";

export const PADROES_CONTEXTO = {
  histereseBpm: 3,
  permanenciaMinimaMs: 20_000,
  alfa: 0.2,
} as const;

/** Sem amostra boa por mais que isto, o sinal é considerado perdido. */
export const LIMIAR_SEM_SINAL_MS = 5_000;
const JANELA_CONFIANCA = 10;

export class ErroConfigContexto extends Error {
  constructor(readonly codigo: string) {
    super(`configuração de contexto inválida: ${codigo}`);
    this.name = "ErroConfigContexto";
  }
}

export class MotorDeContexto {
  private readonly cfg: Required<ConfigContexto>;
  private inicio: number | null = null;
  private ultimaBoa: AmostraFiltrada | null = null;
  private media: number | null = null;
  private zona: Zona | null = null;
  private candidata: { zona: Zona; desde: number } | null = null;
  private houveEsforco = false;
  private readonly qualidades: boolean[] = [];

  constructor(config: ConfigContexto) {
    const erro = validarParametros(config);
    if (erro) throw new ErroConfigContexto(erro);
    const cfg = { ...PADROES_CONTEXTO, ...config };
    if (!(cfg.alfa > 0 && cfg.alfa <= 1)) throw new ErroConfigContexto("alfa_fora_da_faixa");
    if (cfg.histereseBpm < 0 || cfg.permanenciaMinimaMs < 0) throw new ErroConfigContexto("valor_negativo");
    this.cfg = cfg;
  }

  /** Recebe uma amostra e devolve o contexto atualizado. */
  alimentar(amostra: AmostraSinal): Contexto {
    if (this.inicio === null) this.inicio = amostra.t;
    const filtrada = classificar(amostra, this.ultimaBoa);
    this.qualidades.push(filtrada.qualidade === "boa");
    if (this.qualidades.length > JANELA_CONFIANCA) this.qualidades.shift();

    if (filtrada.qualidade === "boa" && filtrada.bpm !== undefined) {
      this.ultimaBoa = filtrada;
      this.media = this.media === null ? filtrada.bpm : this.media + this.cfg.alfa * (filtrada.bpm - this.media);
      this.atualizarZona(this.media, filtrada.t);
    }
    return this.contextoEm(amostra.t);
  }

  /** Contexto num instante sem amostra nova (o sensor parou de mandar). */
  contextoEm(agora: number): Contexto {
    const inicio = this.inicio ?? agora;
    const perdido = this.ultimaBoa === null ? inicio : agora - this.ultimaBoa.t > LIMIAR_SEM_SINAL_MS ? this.ultimaBoa.t : null;
    const boas = this.qualidades.filter(Boolean).length;
    return {
      t: agora,
      bpmSuavizado: this.media === null ? null : Math.round(this.media * 10) / 10,
      zona: this.zona,
      fase: this.fase(),
      confianca: this.qualidades.length ? boas / this.qualidades.length : 0,
      sinalPerdidoDesde: perdido,
    };
  }

  private atualizarZona(media: number, t: number): void {
    const bruta = zonaDe(media, this.cfg);
    if (this.zona === null) {
      this.zona = bruta;
      this.marcarEsforco();
      return;
    }
    if (bruta === this.zona) {
      this.candidata = null;
      return;
    }
    // Histerese: confere que a zona nova se mantém mesmo empurrando a média de volta pela folga.
    const sobe = ordemZona(bruta) > ordemZona(this.zona);
    const comFolga = zonaDe(sobe ? media - this.cfg.histereseBpm : media + this.cfg.histereseBpm, this.cfg);
    const firme = sobe ? ordemZona(comFolga) > ordemZona(this.zona) : ordemZona(comFolga) < ordemZona(this.zona);
    if (!firme) {
      this.candidata = null;
      return;
    }
    const alvo = comFolga;
    if (!this.candidata || this.candidata.zona !== alvo) {
      this.candidata = { zona: alvo, desde: t };
      if (this.cfg.permanenciaMinimaMs > 0) return;
    }
    if (t - this.candidata.desde >= this.cfg.permanenciaMinimaMs) {
      this.zona = this.candidata.zona;
      this.candidata = null;
      this.marcarEsforco();
    }
  }

  private marcarEsforco(): void {
    if (this.zona && ordemZona(this.zona) >= ordemZona("z3")) this.houveEsforco = true;
  }

  /**
   * Esforço a partir de z3; recuperação depois de ter havido esforço. Sem esforço ainda, é
   * aquecimento: sessão leve inteira continua como aquecimento.
   */
  private fase(): Fase {
    const z = this.zona;
    if (z && ordemZona(z) >= ordemZona("z3")) return "esforco";
    if (this.houveEsforco) return "recuperacao";
    return "aquecimento";
  }
}

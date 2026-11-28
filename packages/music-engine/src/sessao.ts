// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Sessão de música adaptativa: liga sensor → contexto → decisão → player, no aparelho.
//
// Garantias que os testes cobram:
//   - sem consentimento específico vigente, nenhuma amostra entra no contexto (nem é guardada);
//   - revogar no meio da sessão para a leitura do sensor na hora; a música segue no manual;
//   - os controles manuais (pausar, travar faixa, travar zona, pular) sempre vencem a decisão;
//   - nenhuma troca automática antes do intervalo mínimo;
//   - o resumo final não carrega frequência cardíaca.

import type { Clock } from "@obedient/core";
import { systemClock } from "@obedient/core";
import type {
  AmostraSinal,
  ConfigContexto,
  Contexto,
  Decisao,
  FaixaCatalogo,
  PlaybackAdapter,
  Preferencias,
  ResumoSessao,
  SensorAdapter,
  Tocando,
  TravasManuais,
  Zona,
} from "@obedient/music-contracts";
import { TRAVAS_LIVRES } from "@obedient/music-contracts";
import { MotorDeContexto } from "./contexto/engine.ts";
import { decidir } from "./decisao/decidir.ts";
import type { MotorDePrivacidade } from "./privacidade/engine.ts";
import type { TrilhaLocal } from "./privacidade/retencao.ts";

export const VERSAO_MOTOR = "0.1.0";

/** O que a tela do aparelho mostra. Fica no aparelho: nada disto vai para o servidor nem para evento. */
export interface EstadoSessao {
  readonly consentimento: boolean;
  readonly contexto: Contexto | null;
  readonly tocando: Tocando | null;
  readonly travas: TravasManuais;
  readonly modo: Preferencias["modo"];
  readonly ultimaDecisao: Decisao | null;
}

export interface OpcoesSessao {
  readonly contexto: ConfigContexto;
  readonly preferencias: Preferencias;
  readonly catalogo: readonly FaixaCatalogo[];
  readonly player: PlaybackAdapter;
  readonly privacidade: MotorDePrivacidade;
  readonly trilha?: TrilhaLocal;
  /** Relógio de parede: só para validade de licença e trilha. O tempo do sinal vem das amostras. */
  readonly clock?: Clock;
}

export class SessaoMusical {
  private readonly contexto: MotorDeContexto;
  private readonly clock: Clock;
  private preferencias: Preferencias;
  private travas: TravasManuais = TRAVAS_LIVRES;
  private tocando: Tocando | null = null;
  private readonly historico: string[] = [];
  private ultimaTrocaEm: number | null = null;
  private consentimento = false;
  private leitura: AbortController | null = null;
  private cancelarAviso: (() => void) | null = null;
  private primeiroT: number | null = null;
  private ultimoT: number | null = null;
  private trocas = 0;
  private pulos = 0;
  private amostrasAdaptadas = 0;
  private amostrasRecebidas = 0;
  private ultimoContexto: Contexto | null = null;
  private ultimaDecisao: Decisao | null = null;

  constructor(private readonly o: OpcoesSessao) {
    this.contexto = new MotorDeContexto(o.contexto);
    this.clock = o.clock ?? systemClock;
    this.preferencias = o.preferencias;
  }

  /** Confere o consentimento e passa a ouvir a revogação. Sem consentimento, a sessão fica no manual. */
  async iniciar(): Promise<boolean> {
    this.consentimento = await this.o.privacidade.sinalPermitido();
    this.cancelarAviso = this.o.privacidade.aoRevogarSinal(() => {
      this.consentimento = false;
      this.leitura?.abort();
    });
    return this.consentimento;
  }

  /** Lê o sensor até acabar, até `parar()` ou até o consentimento ser revogado. */
  async ouvir(sensor: SensorAdapter): Promise<void> {
    if (!this.consentimento) return;
    this.leitura = new AbortController();
    const sinal = this.leitura.signal;
    for await (const amostra of sensor.amostras(sinal)) {
      if (sinal.aborted || !this.consentimento) break;
      await this.processar(amostra);
    }
  }

  /** Uma amostra. Devolve a decisão tomada (útil para a tela e para os testes). */
  async processar(amostra: AmostraSinal): Promise<Decisao> {
    this.amostrasRecebidas++;
    if (!this.consentimento) return { tipo: "nenhuma", motivo: "sem_consentimento" };
    this.primeiroT ??= amostra.t;
    this.ultimoT = amostra.t;
    const ctx = this.contexto.alimentar(amostra);
    return this.decidirEAplicar(ctx, amostra.t);
  }

  /** Quando o sensor some, o app chama isto de tempos em tempos para o motor perceber. */
  async tique(agora: number): Promise<Decisao> {
    if (!this.consentimento) return { tipo: "nenhuma", motivo: "sem_consentimento" };
    return this.decidirEAplicar(this.contexto.contextoEm(agora), agora);
  }

  // Controles manuais: sempre disponíveis, mesmo sem consentimento e sem sinal.
  pausar(): void {
    this.travas = { ...this.travas, pausado: true };
  }
  retomar(): void {
    this.travas = { ...this.travas, pausado: false };
  }
  travarFaixa(faixaId: string | null): void {
    this.travas = { ...this.travas, faixaTravada: faixaId };
  }
  travarZona(zona: Zona | null): void {
    this.travas = { ...this.travas, zonaTravada: zona };
  }
  mudarModo(modo: Preferencias["modo"]): void {
    this.preferencias = { ...this.preferencias, modo };
  }
  /** A pessoa pulou para outra faixa (ou parou de tocar, com null). Não conta como troca automática. */
  informarReproducao(faixaId: string | null, agora: number, manual: boolean): void {
    if (manual) this.pulos++;
    this.tocando = faixaId === null ? null : { faixaId, posicaoMs: 0, desde: agora };
    if (faixaId) this.historico.push(faixaId);
  }

  async parar(): Promise<ResumoSessao> {
    this.leitura?.abort();
    this.cancelarAviso?.();
    this.cancelarAviso = null;
    return this.resumo();
  }

  estado(): EstadoSessao {
    return {
      consentimento: this.consentimento,
      contexto: this.ultimoContexto,
      tocando: this.tocando,
      travas: this.travas,
      modo: this.preferencias.modo,
      ultimaDecisao: this.ultimaDecisao,
    };
  }

  resumo(): ResumoSessao {
    const duracaoS = this.primeiroT === null || this.ultimoT === null ? 0 : Math.round((this.ultimoT - this.primeiroT) / 1000);
    const percentual = this.amostrasRecebidas ? (100 * this.amostrasAdaptadas) / this.amostrasRecebidas : 0;
    return { duracaoS, trocasAutomaticas: this.trocas, pulosManuais: this.pulos, percentualAdaptado: Math.round(percentual * 10) / 10, versaoMotor: VERSAO_MOTOR };
  }

  private async decidirEAplicar(ctx: Contexto, agora: number): Promise<Decisao> {
    this.ultimoContexto = ctx;
    const tocando = this.tocando ? { ...this.tocando, posicaoMs: Math.max(0, agora - this.tocando.desde) } : null;
    const decisao = decidir({
      agora,
      dataIso: this.clock.now().toISOString(),
      consentimentoVigente: this.consentimento,
      contexto: ctx,
      preferencias: this.preferencias,
      travas: this.travas,
      tocando,
      historico: this.historico,
      ultimaTrocaEm: this.ultimaTrocaEm,
      catalogo: this.o.catalogo,
    });
    if (decisao.tipo !== "nenhuma") this.amostrasAdaptadas++;
    if (decisao.tipo === "trocar" || decisao.tipo === "sugerir") {
      const r = await this.o.player.aplicar(decisao);
      if (r.ok && decisao.tipo === "trocar") {
        this.trocas++;
        this.ultimaTrocaEm = agora;
        this.tocando = { faixaId: decisao.faixaId, posicaoMs: 0, desde: decisao.emMs };
        this.historico.push(decisao.faixaId);
      }
    }
    this.o.trilha?.registrar(decisao);
    this.ultimaDecisao = decisao;
    return decisao;
  }
}

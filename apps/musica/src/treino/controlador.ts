// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Controlador do treino: tudo o que as telas fazem passa por aqui, e daqui para o motor
// (@obedient/music-engine). Sem React e sem módulo nativo: as portas (armazenamento, sensor, player,
// relógios, API) são injetadas, o que deixa o fluxo inteiro testável no Node (controlador.test.ts).
//
// Regras que este arquivo garante, além das do motor:
// - sem FC de repouso e máxima informadas pela pessoa, não há treino adaptativo (o motor não estima);
// - o sensor real só é oferecido com SINAL_REAL liberado (D31: nenhum dado real antes do fim da F0);
// - o resumo da sessão só sai do aparelho com o consentimento de agregados, e espera numa fila se
//   não houver rede ou login;
// - "apagar meus dados" revoga, para tudo e apaga o que está no aparelho; com login, pede o mesmo ao servidor.
import type { Clock } from "@obedient/core";
import { ConsentManager } from "@obedient/ethics-engine";
import type { AmostraSinal, FaixaCatalogo, Preferencias, ResumoSessao, SensorAdapter, Zona } from "@obedient/music-contracts";
import {
  AdaptadorCatalogoProprio, type EstadoSessao, MotorDePrivacidade, PREFERENCIAS_PADRAO, type PlayerNativo,
  type RegistroDecisao, SessaoMusical, TrilhaLocal, validarFaixa, validarParametros, validarPreferencias,
} from "@obedient/music-engine";
import type { ClienteGrowthOs } from "../api/cliente.ts";
import { ConsentStoreLocal } from "../armazenamento/consentimentos.ts";
import { apagarTudo, gravarJson, type Kv, lerJson } from "../armazenamento/kv.ts";

/** Versão do texto de consentimento mostrado na tela (muda quando o jurídico aprovar o texto final). */
export const VERSAO_TEXTO = "musica-rascunho-1";
export const TIQUE_MS = 2000;

export interface AjustesLocais {
  /** Ficam SÓ no aparelho: são dado de saúde. */
  fcRepouso: number | null;
  fcMaxima: number | null;
  preferencias: Preferencias;
  retencaoTrilhaH: number;
}

export const AJUSTES_PADRAO: AjustesLocais = { fcRepouso: null, fcMaxima: null, preferencias: PREFERENCIAS_PADRAO, retencaoTrilhaH: 24 };

export interface Portas {
  kv: Kv;
  clock: Clock;
  /** Relógio monotônico em ms, o mesmo das amostras do sensor. */
  relogio: () => number;
  player: PlayerNativo & { quandoAcabar(f: (id: string) => void): void };
  catalogo: () => readonly FaixaCatalogo[];
  intervalo: (ms: number, f: () => void) => () => void;
  novoId: () => string;
  api?: ClienteGrowthOs;
  /** Apaga o que mais o app guardou fora do Kv (arquivos baixados do catálogo). */
  apagarArquivos?: () => Promise<unknown>;
}

export type ErroInicio = "sem_consentimento" | "sem_parametros" | "ja_em_treino" | "catalogo_vazio";

export interface Visao {
  ajustes: AjustesLocais;
  sinalPermitido: boolean;
  agregadosPermitidos: boolean;
  emTreino: boolean;
  sessao: EstadoSessao | null;
  sugestao: string | null;
  resumosPendentes: number;
}

const USUARIO = "pessoa-do-aparelho";

export class ControladorDoTreino {
  private ajustes: AjustesLocais = AJUSTES_PADRAO;
  private readonly privacidade: MotorDePrivacidade;
  private trilha: TrilhaLocal;
  private sessao: SessaoMusical | null = null;
  private pararTique: (() => void) | null = null;
  private leitura: Promise<void> | null = null;
  private sinal = false;
  private agregados = false;
  private sugestao: string | null = null;
  private pendentes = 0;
  private readonly ouvintes = new Set<() => void>();

  constructor(private readonly p: Portas) {
    this.privacidade = new MotorDePrivacidade(new ConsentManager(p.clock, new ConsentStoreLocal(p.kv), p.novoId), USUARIO);
    this.trilha = new TrilhaLocal(AJUSTES_PADRAO.retencaoTrilhaH * 3600_000, p.clock);
    p.player.quandoAcabar(() => {
      this.sessao?.informarReproducao(null, p.relogio(), false);
      this.avisar();
    });
  }

  async carregar(): Promise<void> {
    this.ajustes = { ...AJUSTES_PADRAO, ...(await lerJson<Partial<AjustesLocais>>(this.p.kv, "ajustes", {})) };
    this.trilha = new TrilhaLocal(this.ajustes.retencaoTrilhaH * 3600_000, this.p.clock);
    this.sinal = await this.privacidade.sinalPermitido();
    this.agregados = await this.privacidade.agregadosPermitidos();
    this.pendentes = (await lerJson<unknown[]>(this.p.kv, "resumos_pendentes", [])).length;
    this.avisar();
  }

  aoMudar(f: () => void): () => void {
    this.ouvintes.add(f);
    return () => this.ouvintes.delete(f);
  }

  visao(): Visao {
    return {
      ajustes: this.ajustes, sinalPermitido: this.sinal, agregadosPermitidos: this.agregados,
      emTreino: this.sessao !== null, sessao: this.sessao?.estado() ?? null, sugestao: this.sugestao, resumosPendentes: this.pendentes,
    };
  }

  // Consentimento (tela destacada). Com login, a prova também vai ao servidor; sem rede, fica para depois.
  async consentirSinal(concedido: boolean): Promise<void> {
    if (concedido) await this.privacidade.concederSinal();
    else await this.privacidade.revogarSinal();
    this.sinal = await this.privacidade.sinalPermitido();
    await this.p.api?.registrarConsentimento("adaptacao_musical", concedido, VERSAO_TEXTO);
    this.avisar();
  }

  async consentirAgregados(concedido: boolean): Promise<void> {
    if (concedido) await this.privacidade.concederAgregados();
    else await this.privacidade.revogarAgregados();
    this.agregados = await this.privacidade.agregadosPermitidos();
    if (!this.agregados) {
      await gravarJson(this.p.kv, "resumos_pendentes", []);
      this.pendentes = 0;
    }
    await this.p.api?.registrarConsentimento("musica_agregados", concedido, VERSAO_TEXTO);
    this.avisar();
  }

  async salvarAjustes(novos: AjustesLocais): Promise<string[]> {
    const erros: string[] = [];
    if (novos.fcRepouso !== null || novos.fcMaxima !== null) {
      const e = validarParametros({ fcRepouso: novos.fcRepouso ?? NaN, fcMaxima: novos.fcMaxima ?? NaN });
      if (e) erros.push(e);
    }
    erros.push(...validarPreferencias(novos.preferencias));
    if (!(novos.retencaoTrilhaH >= 0 && novos.retencaoTrilhaH <= 24 * 30)) erros.push("retencao_fora_da_faixa");
    if (erros.length) return erros;
    this.ajustes = novos;
    await gravarJson(this.p.kv, "ajustes", novos);
    this.trilha = new TrilhaLocal(novos.retencaoTrilhaH * 3600_000, this.p.clock);
    this.sessao?.mudarModo(novos.preferencias.modo);
    await this.p.api?.salvarPreferencias(novos.preferencias);
    this.avisar();
    return [];
  }

  async iniciarTreino(sensor: SensorAdapter): Promise<ErroInicio | null> {
    if (this.sessao) return "ja_em_treino";
    const { fcRepouso, fcMaxima, preferencias } = this.ajustes;
    if (fcRepouso === null || fcMaxima === null) return "sem_parametros";
    const catalogo = this.p.catalogo();
    if (!catalogo.length) return "catalogo_vazio";
    const sessao = new SessaoMusical({
      contexto: { fcRepouso, fcMaxima },
      preferencias,
      catalogo,
      player: new AdaptadorCatalogoProprio(catalogo, this.p.player, this.p.clock),
      privacidade: this.privacidade,
      trilha: this.trilha,
      clock: this.p.clock,
    });
    if (!(await sessao.iniciar())) {
      await sessao.parar();
      return "sem_consentimento";
    }
    this.sessao = sessao;
    this.sugestao = null;
    this.pararTique = this.p.intervalo(TIQUE_MS, () => {
      void sessao.tique(this.p.relogio()).then(() => this.avisar());
    });
    this.leitura = sessao.ouvir({
      id: sensor.id,
      fonte: sensor.fonte,
      amostras: (s) => this.comAviso(sensor.amostras(s)),
    });
    this.avisar();
    return null;
  }

  private async *comAviso(fonte: AsyncIterable<AmostraSinal>) {
    for await (const a of fonte) {
      yield a;
      this.avisar();
    }
  }

  /** Para o treino e devolve o resumo. Com consentimento de agregados, o resumo entra na fila de envio. */
  async pararTreino(): Promise<ResumoSessao | null> {
    const sessao = this.sessao;
    if (!sessao) return null;
    this.pararTique?.();
    this.pararTique = null;
    const resumo = await sessao.parar();
    await this.leitura?.catch(() => undefined);
    await this.p.player.parar();
    this.sessao = null;
    this.leitura = null;
    if (this.agregados && resumo.duracaoS > 0) {
      const fila = await lerJson<{ ref: string; resumo: ResumoSessao }[]>(this.p.kv, "resumos_pendentes", []);
      fila.push({ ref: this.p.novoId().replace(/-/g, ""), resumo });
      await gravarJson(this.p.kv, "resumos_pendentes", fila.slice(-200));
      this.pendentes = Math.min(fila.length, 200);
      await this.enviarPendentes();
    }
    this.avisar();
    return resumo;
  }

  /** Tenta mandar os resumos da fila. O que o servidor recusar por consentimento sai da fila; o resto espera. */
  async enviarPendentes(): Promise<number> {
    if (!this.p.api || !this.agregados) return 0;
    const fila = await lerJson<{ ref: string; resumo: ResumoSessao }[]>(this.p.kv, "resumos_pendentes", []);
    const ficam: typeof fila = [];
    let enviados = 0;
    for (const item of fila) {
      const r = await this.p.api.enviarResumo(item.ref, item.resumo);
      if (r.ok) enviados++;
      else if (r.status === 0 || r.status === 401 || r.status >= 500) ficam.push(item);
    }
    await gravarJson(this.p.kv, "resumos_pendentes", ficam);
    this.pendentes = ficam.length;
    this.avisar();
    return enviados;
  }

  // Controles manuais: sempre funcionam.
  pausar() { this.sessao?.pausar(); this.avisar(); }
  retomar() { this.sessao?.retomar(); this.avisar(); }
  travarFaixa(id: string | null) { this.sessao?.travarFaixa(id); this.avisar(); }
  travarZona(z: Zona | null) { this.sessao?.travarZona(z); this.avisar(); }
  /** A pessoa tocou na sugestão. A licença é conferida de novo antes de tocar, como no caminho automático. */
  async aceitarSugestao(id: string): Promise<boolean> {
    const faixa = this.p.catalogo().find((f) => f.id === id);
    if (!faixa || validarFaixa(faixa, this.p.clock.now().toISOString()).length) return false;
    await this.p.player.tocar(id, { emMs: this.p.relogio(), crossfade: faixa.licenca.permiteCrossfade });
    this.sessao?.informarReproducao(id, this.p.relogio(), true);
    this.sugestao = null;
    this.avisar();
    return true;
  }
  /** O mixer chama isto quando o motor sugere (modo "só sugestão"). */
  mostrarSugestao(id: string) { this.sugestao = id; this.avisar(); }

  trilhaLocal(): RegistroDecisao[] { return this.trilha.exportar(); }

  /** Tudo o que o aparelho guarda sobre a pessoa, para ela levar (LGPD art. 18). */
  async exportarDoAparelho() {
    return {
      ajustes: this.ajustes,
      consentimentos: await new ConsentManager(this.p.clock, new ConsentStoreLocal(this.p.kv)).export(USUARIO),
      trilha: this.trilha.exportar(),
      resumosPendentes: await lerJson<unknown[]>(this.p.kv, "resumos_pendentes", []),
    };
  }

  /** Revoga, para o treino, apaga o aparelho e, com login, pede o mesmo ao servidor. */
  async apagarMeusDados(): Promise<{ servidor: "apagado" | "sem_login" | "falhou" }> {
    await this.privacidade.revogarSinal();
    await this.privacidade.revogarAgregados();
    await this.pararTreino();
    let servidor: "apagado" | "sem_login" | "falhou" = "sem_login";
    if (this.p.api && (await this.p.api.logado())) servidor = (await this.p.api.apagarMeusDados(VERSAO_TEXTO)).ok ? "apagado" : "falhou";
    this.trilha.apagarTudo();
    await this.p.apagarArquivos?.();
    await apagarTudo(this.p.kv);
    this.ajustes = AJUSTES_PADRAO;
    this.sinal = false;
    this.agregados = false;
    this.pendentes = 0;
    this.avisar();
    return { servidor };
  }

  private avisar() { for (const f of this.ouvintes) f(); }
}

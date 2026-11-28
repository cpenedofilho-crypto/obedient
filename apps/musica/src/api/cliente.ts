// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Cliente das rotas /api/musica do Growth OS (F2, casa-de-ia#214). O app funciona sem ele (modo
// demonstração, offline); com login, sincroniza preferências declaradas, prova de consentimento,
// catálogo e o resumo de sessão autorizado. Frequência cardíaca nunca vai por aqui: os tipos não têm
// campo para isso, e o servidor recusa campo a mais.
import type { Preferencias, ResumoSessao } from "@obedient/music-contracts";

export type Finalidade = "adaptacao_musical" | "musica_agregados";

export interface Credenciais {
  /** Access token do Supabase Auth da pessoa, ou null sem login. */
  token(): Promise<string | null>;
  /** Slug da organização quando a pessoa tem mais de uma. */
  organizacao(): Promise<string | null>;
}

export type Resposta<T> = { ok: true; dados: T } | { ok: false; status: number; codigo: string };

export interface ArquivoRemoto { sha256: string; bytes: number; formato: string }

export interface FaixaRemota {
  trackRef: string; titulo: string; origem: string; genero: string; explicita: boolean; energia: number;
  duracaoMs: number; fronteirasMs: number[];
  licenca: { permiteCrossfade: boolean; permiteCacheOffline: boolean; validaAte: string | null };
  /** Ausente enquanto a faixa não tiver arquivo publicado (F4). */
  arquivo: ArquivoRemoto | null;
}

export class ClienteGrowthOs {
  constructor(
    private readonly base: string,
    private readonly cred: Credenciais,
    private readonly f: typeof fetch = fetch,
    private readonly prazoMs = 15_000,
  ) {
    if (!/^https:\/\/[^/]+$/.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) throw new Error("base do Growth OS precisa ser https (ou localhost em desenvolvimento)");
  }

  async logado(): Promise<boolean> { return (await this.cred.token()) !== null; }

  private async pedir<T>(metodo: string, caminho: string, corpo?: unknown): Promise<Resposta<T>> {
    const token = await this.cred.token();
    if (!token) return { ok: false, status: 401, codigo: "sem_login" };
    const org = await this.cred.organizacao();
    const ctrl = new AbortController();
    const prazo = setTimeout(() => ctrl.abort(), this.prazoMs);
    try {
      const r = await this.f(`${this.base}/api/musica/${caminho}`, {
        method: metodo,
        signal: ctrl.signal,
        headers: { authorization: `Bearer ${token}`, ...(org ? { "x-organizacao": org } : {}), ...(corpo === undefined ? {} : { "content-type": "application/json" }) },
        ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
      });
      const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (!r.ok) return { ok: false, status: r.status, codigo: typeof json.error === "string" ? json.error : "erro_http" };
      return { ok: true, dados: json as T };
    } catch (e) {
      return { ok: false, status: 0, codigo: e instanceof Error && e.name === "AbortError" ? "tempo_esgotado" : "sem_rede" };
    } finally {
      clearTimeout(prazo);
    }
  }

  lerPreferencias() { return this.pedir<{ preferencias: Preferencias }>("GET", "preferencias"); }
  salvarPreferencias(p: Preferencias) { return this.pedir<{ preferencias: Preferencias }>("PUT", "preferencias", p); }
  registrarConsentimento(finalidade: Finalidade, concedido: boolean, versaoTexto: string) {
    return this.pedir("POST", "consentimento", { finalidade, concedido, especifico: concedido, versaoTexto });
  }
  catalogo() { return this.pedir<{ faixas: FaixaRemota[] }>("GET", "catalogo"); }
  /** Endereço temporário (assinado pelo Growth OS) para baixar ou tocar o arquivo de uma faixa. */
  urlDoArquivo(trackRef: string) { return this.pedir<{ url: string; expiraEm: string }>("GET", `arquivo?trackRef=${encodeURIComponent(trackRef)}`); }
  enviarResumo(sessaoRef: string, r: ResumoSessao) {
    return this.pedir<{ registrado: boolean }>("POST", "sessoes", {
      sessaoRef, duracaoMin: Math.round(r.duracaoS / 60), trocasAutomaticas: r.trocasAutomaticas,
      pulosManuais: r.pulosManuais, percentualAdaptado: Math.round(r.percentualAdaptado), versaoMotor: r.versaoMotor,
    });
  }
  apagarMeusDados(versaoTexto: string) { return this.pedir<{ preferenciasApagadas: number }>("DELETE", "meus-dados", { versaoTexto }); }
}

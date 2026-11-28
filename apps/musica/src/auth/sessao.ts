// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Login do app no Supabase Auth do projeto growth-os: o mesmo do Repique (repique/docs/LOGIN.md), com as
// mesmas contas e memberships. Método: **link mágico por e-mail com PKCE**, sem senha em lugar nenhum.
//   1. pedirLink(email): gera o code_verifier, guarda no cofre e pede o link (POST /auth/v1/otp) com o
//      desafio S256. create_user: false — só entra quem já tem conta (o cadastro não é aberto pelo app).
//   2. O link do e-mail volta para o app (obedient-musica://auth/confirmar?code=...). concluir(url) troca o
//      código pela sessão (POST /auth/v1/token?grant_type=pkce) com o verifier guardado. Precisa ser aberto
//      no MESMO aparelho em que foi pedido (o verifier só existe nele).
//   3. token(): o access token, renovado pelo refresh token um minuto antes de vencer. Renovação recusada
//      encerra a sessão (a pessoa entra de novo).
//   4. sair(): avisa o Supabase (POST /auth/v1/logout) e apaga o cofre.
// A sessão fica no cofre seguro do aparelho (Keychain/Keystore, plataforma/cofre-seguro.ts), nunca no
// AsyncStorage. Sem SDK: só estas quatro chamadas, testadas com um Supabase falso (sessao.test.ts).
import { createHash } from "node:crypto";

export interface Cofre {
  ler(chave: string): Promise<string | null>;
  gravar(chave: string, valor: string): Promise<void>;
  apagar(chave: string): Promise<void>;
}

export interface Usuario { id: string; email: string | null }

interface Guardada { access: string; refresh: string; expiraEm: number; usuario: Usuario }

export type ErroLogin = "email_invalido" | "sem_pedido_pendente" | "link_invalido" | "link_expirado" | "sem_rede" | "recusado";

export class FalhaLogin extends Error {
  constructor(readonly codigo: ErroLogin, readonly detalhe?: string) { super(codigo); this.name = "FalhaLogin"; }
}

const CHAVE_SESSAO = "obedient.musica.sessao";
const CHAVE_VERIFIER = "obedient.musica.pkce";
export const REDIRECT_PADRAO = "obedient-musica://auth/confirmar";
const MARGEM_MS = 60_000;

const base64url = (b: Uint8Array) => {
  let s = "";
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i]! << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += a[(n >> 18) & 63]! + a[(n >> 12) & 63]!;
    if (i + 1 < b.length) s += a[(n >> 6) & 63]!;
    if (i + 2 < b.length) s += a[n & 63]!;
  }
  return s;
};

/** Desafio S256 do PKCE: base64url(SHA-256(verifier)). */
export function desafioPkce(verifier: string): string {
  return base64url(new Uint8Array(createHash("sha256").update(verifier, "utf8").digest()));
}

export interface OpcoesSessao {
  url: string;
  chavePublica: string;
  cofre: Cofre;
  f?: typeof fetch;
  agora?: () => number;
  aleatorio?: (n: number) => Uint8Array;
  redirect?: string;
}

export class SessaoSupabase {
  private readonly base: string;
  private readonly f: typeof fetch;
  private readonly agora: () => number;
  private readonly aleatorio: (n: number) => Uint8Array;
  private renovando: Promise<string | null> | null = null;

  constructor(private readonly o: OpcoesSessao) {
    if (!/^https:\/\/[^/]+$/.test(o.url.replace(/\/+$/, "")) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o.url)) throw new Error("URL do Supabase precisa ser https");
    this.base = `${o.url.replace(/\/+$/, "")}/auth/v1`;
    this.f = o.f ?? fetch;
    this.agora = o.agora ?? Date.now;
    this.aleatorio = o.aleatorio ?? ((n) => globalThis.crypto.getRandomValues(new Uint8Array(n)));
  }

  private cabecalhos(extra: Record<string, string> = {}) {
    return { apikey: this.o.chavePublica, "content-type": "application/json", ...extra };
  }

  async pedirLink(email: string): Promise<void> {
    const limpo = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(limpo) || limpo.length > 254) throw new FalhaLogin("email_invalido");
    const verifier = base64url(this.aleatorio(48));
    await this.o.cofre.gravar(CHAVE_VERIFIER, verifier);
    const redirect = encodeURIComponent(this.o.redirect ?? REDIRECT_PADRAO);
    const r = await this.chamar(`${this.base}/otp?redirect_to=${redirect}`, {
      email: limpo, create_user: false, code_challenge: desafioPkce(verifier), code_challenge_method: "s256",
    });
    // Conta inexistente também volta erro; a tela mostra a mesma mensagem genérica para não revelar quem tem conta.
    if (!r.ok) throw new FalhaLogin(r.status === 0 ? "sem_rede" : "recusado");
  }

  /** Conclui o login a partir do endereço que abriu o app. Devolve o usuário. */
  async concluir(urlDeVolta: string): Promise<Usuario> {
    let params: URLSearchParams;
    try {
      const u = new URL(urlDeVolta);
      params = new URLSearchParams(u.search);
      if (u.hash) for (const [k, v] of new URLSearchParams(u.hash.slice(1))) params.set(k, v);
    } catch { throw new FalhaLogin("link_invalido"); }
    if (params.get("error")) throw new FalhaLogin(/expired/i.test(params.get("error_description") ?? params.get("error_code") ?? "") ? "link_expirado" : "link_invalido");
    const code = params.get("code");
    if (!code) throw new FalhaLogin("link_invalido");
    const verifier = await this.o.cofre.ler(CHAVE_VERIFIER);
    if (!verifier) throw new FalhaLogin("sem_pedido_pendente");
    const r = await this.chamar(`${this.base}/token?grant_type=pkce`, { auth_code: code, code_verifier: verifier });
    await this.o.cofre.apagar(CHAVE_VERIFIER);
    if (!r.ok) throw new FalhaLogin(r.status === 0 ? "sem_rede" : "link_expirado");
    return (await this.guardar(r.json)).usuario;
  }

  async usuario(): Promise<Usuario | null> {
    return (await this.lerSessao())?.usuario ?? null;
  }

  /** Access token válido, renovando se faltar menos de um minuto; null sem sessão. */
  async token(): Promise<string | null> {
    const s = await this.lerSessao();
    if (!s) return null;
    if (s.expiraEm - this.agora() > MARGEM_MS) return s.access;
    this.renovando ??= this.renovar(s).finally(() => { this.renovando = null; });
    return this.renovando;
  }

  async sair(): Promise<void> {
    const s = await this.lerSessao();
    if (s) await this.f(`${this.base}/logout`, { method: "POST", headers: this.cabecalhos({ authorization: `Bearer ${s.access}` }) }).catch(() => undefined);
    await this.o.cofre.apagar(CHAVE_SESSAO);
    await this.o.cofre.apagar(CHAVE_VERIFIER);
  }

  private async renovar(s: Guardada): Promise<string | null> {
    const r = await this.chamar(`${this.base}/token?grant_type=refresh_token`, { refresh_token: s.refresh });
    if (r.ok) return (await this.guardar(r.json)).access;
    if (r.status === 0) return s.expiraEm > this.agora() ? s.access : null; // sem rede: usa o que ainda vale
    await this.o.cofre.apagar(CHAVE_SESSAO); // refresh recusado: sessão acabou
    return null;
  }

  private async guardar(j: Record<string, unknown>): Promise<Guardada> {
    const usuario = j.user as { id?: unknown; email?: unknown } | undefined;
    if (typeof j.access_token !== "string" || typeof j.refresh_token !== "string" || typeof usuario?.id !== "string") throw new FalhaLogin("recusado", "resposta fora do formato");
    const g: Guardada = {
      access: j.access_token, refresh: j.refresh_token,
      expiraEm: this.agora() + (typeof j.expires_in === "number" ? j.expires_in : 3600) * 1000,
      usuario: { id: usuario.id, email: typeof usuario.email === "string" ? usuario.email : null },
    };
    await this.o.cofre.gravar(CHAVE_SESSAO, JSON.stringify(g));
    return g;
  }

  private async lerSessao(): Promise<Guardada | null> {
    const t = await this.o.cofre.ler(CHAVE_SESSAO);
    if (!t) return null;
    try { return JSON.parse(t) as Guardada; } catch { return null; }
  }

  private async chamar(url: string, corpo: unknown): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
    // AbortController + setTimeout em vez de AbortSignal.timeout, que nem todo motor JS do celular tem.
    const ctrl = new AbortController();
    const prazo = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const r = await this.f(url, { method: "POST", headers: this.cabecalhos(), body: JSON.stringify(corpo), signal: ctrl.signal });
      return { ok: r.ok, status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
    } catch {
      return { ok: false, status: 0, json: {} };
    } finally {
      clearTimeout(prazo);
    }
  }
}

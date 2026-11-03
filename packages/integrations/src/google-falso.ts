// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Google falso, SÓ PARA TESTE e desenvolvimento: faz o papel da tela de autorização e do servidor de
// tokens (troca de código com PKCE, renovação, revogação). Entra no lugar do `fetch`.

import { createHash } from "node:crypto";
import { GOOGLE } from "./conexoes.ts";

/** Google falso: lembra os códigos emitidos e o PKCE de cada um. */
export class GoogleFalso {
  constructor(private readonly segredo: string) {}

  codigos = new Map<string, { desafio: string; escopo: string }>();
  revogados: string[] = [];
  refreshValido = new Set<string>();
  escopoDevolvido: ((pedido: string) => string) | null = null;
  chamadas: { url: string; corpo: URLSearchParams }[] = [];
  n = 0;

  /** O que a tela do Google faria: a pessoa aceita e o Google redireciona com um código. */
  autorizar(url: string): { state: string; code: string } {
    const u = new URL(url);
    if (u.origin + u.pathname !== GOOGLE.autorizacao || u.searchParams.get("code_challenge_method") !== "S256" || u.searchParams.get("access_type") !== "offline")
      throw new Error("pedido de autorização fora do esperado");
    const code = `codigo-${++this.n}`;
    this.codigos.set(code, { desafio: u.searchParams.get("code_challenge")!, escopo: u.searchParams.get("scope")! });
    return { state: u.searchParams.get("state")!, code };
  }

  /** Chamadas às APIs (Agenda, Gmail, Drive), com o token usado, para o teste conferir. */
  api: { metodo: string; url: string; auth: string | null; corpo: string }[] = [];
  /** Resposta das APIs; o padrão devolve um objeto vazio com id. */
  responderApi: (url: URL, metodo: string) => { status?: number; json?: unknown } = () => ({ json: { id: "x" } });

  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const alvo = new URL(String(url));
    if (/googleapis\.com$/.test(alvo.hostname) && alvo.hostname !== "oauth2.googleapis.com") {
      this.api.push({ metodo: init?.method ?? "GET", url: alvo.toString(), auth: new Headers(init?.headers).get("authorization"), corpo: String(init?.body ?? "") });
      const r = this.responderApi(alvo, init?.method ?? "GET");
      return r.status === 204 ? new Response(null, { status: 204 }) : new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
    }
    const corpo = new URLSearchParams(String(init?.body ?? ""));
    this.chamadas.push({ url: String(url), corpo });
    const json = (s: number, j: unknown) => new Response(JSON.stringify(j), { status: s, headers: { "content-type": "application/json" } });
    if (String(url) === GOOGLE.revogacao) {
      this.revogados.push(corpo.get("token")!);
      return new Response("", { status: 200 });
    }
    if (String(url) !== GOOGLE.token) return json(404, { error: "not_found" });
    if (corpo.get("client_secret") !== this.segredo) return json(401, { error: "invalid_client" });
    if (corpo.get("grant_type") === "authorization_code") {
      const c = this.codigos.get(corpo.get("code")!);
      if (!c) return json(400, { error: "invalid_grant" });
      this.codigos.delete(corpo.get("code")!);
      const desafio = createHash("sha256").update(corpo.get("code_verifier")!).digest("base64url");
      if (desafio !== c.desafio) return json(400, { error: "invalid_grant", error_description: "PKCE" });
      const refresh = `refresh-${++this.n}`;
      this.refreshValido.add(refresh);
      return json(200, { access_token: `acesso-${this.n}`, expires_in: 3600, refresh_token: refresh, scope: this.escopoDevolvido ? this.escopoDevolvido(c.escopo) : c.escopo, token_type: "Bearer" });
    }
    if (corpo.get("grant_type") === "refresh_token") {
      if (!this.refreshValido.has(corpo.get("refresh_token")!)) return json(400, { error: "invalid_grant" });
      return json(200, { access_token: `renovado-${++this.n}`, expires_in: 3600, token_type: "Bearer" });
    }
    return json(400, { error: "unsupported_grant_type" });
  };
}


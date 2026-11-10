// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Conexão OAuth da PESSOA com um servidor MCP (ex.: Recupera OS, que só aceita token de usuário do
// Authorization Server dele). O mesmo desenho da conexão com o Google (integrations/conexoes.ts):
//
//   iniciar   → state de uso único (10 min) preso à pessoa E ao navegador (nonce em cookie) + PKCE S256
//   concluir  → confere state e nonce, troca o código pelo token FORA de transação e grava a credencial
//               cifrada no cofre (a mesma tabela obedient.connections, integracao = id do servidor)
//   token     → token de acesso válido; renova com o refresh token antes de vencer
//   desconectar/parar/apagar → a credencial sai da conexão (fila de revogação, como a do Google)
//
// O que difere do Google, e por quê:
//   • cliente PÚBLICO (sem segredo): o Authorization Server tem de aceitar `none` + PKCE;
//   • o emissor vem da configuração do DONO, e os endpoints da descoberta (RFC 8414) só valem se o
//     `issuer` devolvido for exatamente o configurado e os endpoints forem https na mesma origem;
//   • sem endpoint de revogação conhecido: ao desconectar, a credencial é descartada aqui (a fila não
//     manda token de servidor MCP para lugar nenhum, muito menos para o Google).
// A credencial nunca sai do servidor: nem o app, nem o modelo, nem o log a veem.

import { createHash, randomBytes } from "node:crypto";
import { type Clock, ObedientError, systemClock } from "@obedient/core";
import { fetchSeguro } from "@obedient/integration-gateway";
import type { Cofre } from "@obedient/integrations";
import { tirarConexoes, voltaRepetida } from "@obedient/integrations";
import { type Database, type Executor, comoAutenticacao, comoUsuario } from "@obedient/store-postgres";
import type { ServidorMcp } from "./mcp-servidores.ts";

export const ROTA_RETORNO_MCP = "/api/conexoes/mcp/retorno";
const STATE_TTL_MS = 10 * 60 * 1000;
const MARGEM_RENOVACAO_MS = 60 * 1000;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const b64u = (b: Buffer) => b.toString("base64url");

interface Credencial { refreshToken: string; accessToken: string; expiraEm: number }
interface Metadados { autorizacao: string; token: string }

type ServidorOAuth = ServidorMcp & { oauth: NonNullable<ServidorMcp["oauth"]> };
export const comOAuth = (s: ServidorMcp): s is ServidorOAuth => !!s.oauth;

export class ConexoesMcp {
  private readonly metadados = new Map<string, Metadados>();

  constructor(
    private readonly db: Database,
    private readonly cofre: Cofre,
    private readonly servidores: readonly ServidorMcp[],
    /** Origem exata do app (OBEDIENT_ORIGIN); o retorno é <origem>/api/conexoes/mcp/retorno. */
    private readonly origem: string,
    private readonly http: typeof fetch = fetchSeguro,
    private readonly clock: Clock = systemClock,
  ) {}

  get redirectUri() { return `${this.origem}${ROTA_RETORNO_MCP}`; }

  /** Servidor OAuth que a pessoa pode conectar (está na lista do dono). */
  servidor(id: string, userId?: string): ServidorOAuth {
    const s = this.servidores.find((x) => x.id === id);
    if (!s || !comOAuth(s)) throw new ObedientError("INVALID_PAYLOAD", "servidor desconhecido");
    if (userId !== undefined && !s.usuarios.has(userId)) throw new ObedientError("GRANT_NOT_FOUND", `você não está na lista de quem pode usar ${s.nome}`);
    return s;
  }

  /** Descoberta (RFC 8414), conferida contra o emissor que o dono configurou. */
  private async descobrir(s: ServidorOAuth): Promise<Metadados> {
    const ja = this.metadados.get(s.id);
    if (ja) return ja;
    const emissor = new URL(s.oauth.issuer);
    const caminho = emissor.pathname.replace(/\/$/, "");
    const tentativas = [`${emissor.origin}/.well-known/oauth-authorization-server${caminho}`, `${emissor.origin}${caminho}/.well-known/oauth-authorization-server`];
    for (const url of tentativas) {
      let j: Record<string, unknown>;
      try {
        const r = await this.http(url, { headers: { accept: "application/json" }, redirect: "error" });
        if (!r.ok) continue;
        j = (await r.json()) as Record<string, unknown>;
      } catch { continue; }
      if (j.issuer !== s.oauth.issuer) throw new ObedientError("UNAUTHENTICATED", `${s.nome}: o emissor anunciado não é o configurado`);
      const mesmaOrigem = (v: unknown) => typeof v === "string" && /^https:\/\//.test(v) && new URL(v).origin === emissor.origin;
      if (!mesmaOrigem(j.authorization_endpoint) || !mesmaOrigem(j.token_endpoint)) throw new ObedientError("UNAUTHENTICATED", `${s.nome}: endpoints fora da origem do emissor`);
      const pkce = Array.isArray(j.code_challenge_methods_supported) && j.code_challenge_methods_supported.includes("S256");
      if (!pkce) throw new ObedientError("UNAUTHENTICATED", `${s.nome}: o emissor não aceita PKCE S256`);
      const m = { autorizacao: j.authorization_endpoint as string, token: j.token_endpoint as string };
      this.metadados.set(s.id, m);
      return m;
    }
    throw new ObedientError("UNAUTHENTICATED", `${s.nome}: não foi possível descobrir o emissor`);
  }

  async iniciar(userId: string, id: string): Promise<{ url: string; nonce: string }> {
    const s = this.servidor(id, userId);
    const m = await this.descobrir(s);
    const state = b64u(randomBytes(32));
    const nonce = b64u(randomBytes(32));
    const verifier = b64u(randomBytes(32));
    const desafio = b64u(createHash("sha256").update(verifier).digest());
    const c = this.cofre.cifrar(verifier, userId, `oauth:${s.id}`);
    const agora = this.clock.now();
    await comoUsuario(this.db, userId, (tx) =>
      tx.query(
        "insert into obedient.oauth_states (state_hash, user_id, integracao, nonce_hash, verifier_cifra, chave_id, criado_em, expira_em) values ($1,$2,$3,$4,$5,$6,$7,$8)",
        [sha(state), userId, s.id, sha(nonce), c.dados, c.chaveId, agora, new Date(agora.getTime() + STATE_TTL_MS)],
      ),
    );
    const url = new URL(m.autorizacao);
    url.search = new URLSearchParams({
      client_id: s.oauth.clientId,
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: s.oauth.escopos.join(" "),
      state,
      code_challenge: desafio,
      code_challenge_method: "S256",
    }).toString();
    return { url: url.toString(), nonce };
  }

  async concluir(state: string, code: string, nonce: string | null): Promise<{ userId: string; integracao: string; repetida?: true }> {
    if (!state || !code || !nonce || state.length > 200 || code.length > 2000 || nonce.length > 200) throw new ObedientError("UNAUTHENTICATED", "retorno incompleto");
    const agora = this.clock.now();
    const ids = this.servidores.filter(comOAuth).map((s) => s.id);
    const fluxo = await comoAutenticacao(this.db, async (tx) => {
      const { rows } = await tx.query<{ user_id: string; integracao: string; verifier_cifra: Buffer; chave_id: string }>(
        `update obedient.oauth_states set usado_em = $3
          where state_hash = $1 and nonce_hash = $2 and usado_em is null and expira_em > $3 and integracao = any($4)
          returning user_id, integracao, verifier_cifra, chave_id`,
        [sha(state), sha(nonce), agora, ids],
      );
      return rows[0] ?? null;
    });
    if (!fluxo) {
      // Segunda volta igual do MESMO navegador, já conectada: "conectado", sem trocar token nem conceder de novo.
      const ja = await voltaRepetida(this.db, state, nonce, agora);
      if (ja && ids.includes(ja.integracao)) return { ...ja, repetida: true };
      throw new ObedientError("UNAUTHENTICATED", "esse pedido de conexão não vale mais: comece de novo");
    }
    const s = this.servidor(fluxo.integracao, fluxo.user_id);
    const verifier = this.cofre.decifrar({ chaveId: fluxo.chave_id, dados: Buffer.from(fluxo.verifier_cifra) }, fluxo.user_id, `oauth:${s.id}`);
    const r = await this.pedirToken(s, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: this.redirectUri });
    if (!r.refresh_token) throw new ObedientError("UNAUTHENTICATED", `${s.nome} não devolveu acesso permanente: tente conectar de novo`);
    const cred: Credencial = { refreshToken: r.refresh_token, accessToken: r.access_token, expiraEm: agora.getTime() + r.expires_in * 1000 };
    await comoUsuario(this.db, fluxo.user_id, (tx) => this.gravar(tx, fluxo.user_id, s, cred, true));
    return { userId: fluxo.user_id, integracao: s.id };
  }

  /** Token de acesso válido da pessoa nesse servidor; renova antes de vencer (rede fora de transação). */
  async tokenDeAcesso(userId: string, id: string): Promise<string> {
    const s = this.servidor(id, userId);
    const cred = await comoUsuario(this.db, userId, (tx) => this.ler(tx, userId, s));
    if (!cred) throw new ObedientError("GRANT_NOT_FOUND", `${s.nome} não está conectado`);
    if (cred.expiraEm - MARGEM_RENOVACAO_MS > this.clock.now().getTime()) return cred.accessToken;
    let r;
    try {
      r = await this.pedirToken(s, { grant_type: "refresh_token", refresh_token: cred.refreshToken });
    } catch (e) {
      if (e instanceof ObedientError && /invalid_grant/.test(e.message)) {
        await comoUsuario(this.db, userId, (tx) => tirarConexoes(tx, userId, `${s.nome} recusou a renovação`, s.id));
        await this.descartarRevogacoes(userId);
        throw new ObedientError("GRANT_NOT_FOUND", `${s.nome} perdeu o acesso: conecte de novo`);
      }
      throw e;
    }
    const nova: Credencial = { refreshToken: r.refresh_token ?? cred.refreshToken, accessToken: r.access_token, expiraEm: this.clock.now().getTime() + r.expires_in * 1000 };
    await comoUsuario(this.db, userId, (tx) => this.gravar(tx, userId, s, nova, false));
    return nova.accessToken;
  }

  /**
   * Sem endpoint de revogação: a credencial que foi para a fila (desconectar, parar, apagar) é
   * descartada aqui, e nunca enviada a outro provedor. O acesso no servidor de lá some quando o
   * refresh token não for mais usado (ou a pessoa revoga no próprio servidor).
   */
  async descartarRevogacoes(userId: string): Promise<number> {
    const ids = this.servidores.filter(comOAuth).map((s) => s.id);
    return comoUsuario(this.db, userId, async (tx) => (await tx.query("delete from obedient.token_revocations where user_id = $1 and integracao = any($2) returning id", [userId, ids])).rows.length);
  }

  private async pedirToken(s: ServidorOAuth, campos: Record<string, string>): Promise<{ access_token: string; expires_in: number; refresh_token?: string }> {
    const m = await this.descobrir(s);
    let r: Response;
    try {
      r = await this.http(m.token, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ ...campos, client_id: s.oauth.clientId }).toString(),
        redirect: "error",
      });
    } catch {
      throw new ObedientError("UNAUTHENTICATED", `${s.nome} não respondeu: tente de novo`);
    }
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok || typeof j.access_token !== "string" || typeof j.expires_in !== "number")
      throw new ObedientError("UNAUTHENTICATED", `${s.nome} recusou: ${typeof j.error === "string" ? j.error.slice(0, 60) : r.status}`);
    return j as { access_token: string; expires_in: number; refresh_token?: string };
  }

  private async ler(tx: Executor, userId: string, s: ServidorOAuth): Promise<Credencial | null> {
    const { rows } = await tx.query<{ cifra: Buffer; chave_id: string }>("select cifra, chave_id from obedient.connections where user_id = $1 and integracao = $2", [userId, s.id]);
    if (!rows[0]) return null;
    return JSON.parse(this.cofre.decifrar({ chaveId: rows[0].chave_id, dados: Buffer.from(rows[0].cifra) }, userId, s.id)) as Credencial;
  }

  private async gravar(tx: Executor, userId: string, s: ServidorOAuth, cred: Credencial, nova: boolean) {
    const c = this.cofre.cifrar(JSON.stringify(cred), userId, s.id);
    const agora = this.clock.now();
    if (nova) {
      await tirarConexoes(tx, userId, "substituída por uma conexão nova", s.id);
      await tx.query("delete from obedient.token_revocations where user_id = $1 and integracao = $2", [userId, s.id]);
      await tx.query("insert into obedient.connections (user_id, integracao, escopos, cifra, chave_id, conectada_em, atualizada_em) values ($1,$2,$3,$4,$5,$6,$6)", [userId, s.id, [...s.oauth.escopos], c.dados, c.chaveId, agora]);
    } else await tx.query("update obedient.connections set cifra = $3, chave_id = $4, atualizada_em = $5 where user_id = $1 and integracao = $2", [userId, s.id, c.dados, c.chaveId, agora]);
  }
}

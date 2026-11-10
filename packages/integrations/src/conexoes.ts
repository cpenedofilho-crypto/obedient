// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Conectar uma integração do Google (OAuth 2.0 com PKCE), guardar a credencial cifrada, renovar o
// token de acesso e revogar no provedor.
//
//   iniciar   → state (uso único, 10 min) preso ao usuário E ao navegador (nonce em cookie) + PKCE
//   concluir  → confere state e nonce, troca o código pelo token FORA de qualquer transação, confere
//               que o Google deu exatamente os escopos pedidos e grava a credencial cifrada
//   token     → token de acesso válido; renova com o refresh token quando faltar menos de 1 minuto
//   desconectar / parar / apagar → a credencial sai da conexão e entra na fila de revogação, na
//               mesma transação; a chamada de revogação ao Google é feita depois, fora dela
//
// Nada aqui fala com o modelo. A credencial nunca sai do servidor: o app só vê o nome da
// integração, os escopos e a data.

import { createHash, randomBytes } from "node:crypto";
import { type Clock, ObedientError, systemClock, uuid } from "@obedient/core";
import { type Database, type Executor, comoAutenticacao, comoUsuario } from "@obedient/store-postgres";
import { type Integracao, integracao } from "./catalogo.ts";
import type { Cofre } from "./cofre.ts";

export const GOOGLE = {
  autorizacao: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  revogacao: "https://oauth2.googleapis.com/revoke",
} as const;

export const STATE_TTL_MS = 10 * 60 * 1000;
const MARGEM_RENOVACAO_MS = 60 * 1000;

export interface ClienteOAuth {
  clientId: string;
  clientSecret: string;
  /** URL exata cadastrada no Google, ex.: https://obedient.exemplo.org/api/conexoes/retorno */
  redirectUri: string;
}

export interface Credencial {
  refreshToken: string;
  accessToken: string;
  expiraEm: number;
}

export interface ConexaoVisivel {
  integracao: string;
  escopos: string[];
  conectadaEm: string;
}

type Fetch = typeof fetch;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const b64u = (b: Buffer) => b.toString("base64url");

export class Conexoes {
  constructor(
    private readonly db: Database,
    private readonly cofre: Cofre,
    private readonly cliente: ClienteOAuth,
    private readonly http: Fetch = fetch,
    private readonly clock: Clock = systemClock,
  ) {}

  /** A pessoa aperta "Conectar". Devolve a URL do Google e o nonce que vai no cookie do navegador. */
  async iniciar(userId: string, integracaoId: string): Promise<{ url: string; nonce: string }> {
    const i = integracao(integracaoId);
    const state = b64u(randomBytes(32));
    const nonce = b64u(randomBytes(32));
    const verifier = b64u(randomBytes(32));
    const desafio = b64u(createHash("sha256").update(verifier).digest());
    const c = this.cofre.cifrar(verifier, userId, `oauth:${i.id}`);
    const agora = this.clock.now();
    await comoUsuario(this.db, userId, (tx) =>
      tx.query(
        "insert into obedient.oauth_states (state_hash, user_id, integracao, nonce_hash, verifier_cifra, chave_id, criado_em, expira_em) values ($1,$2,$3,$4,$5,$6,$7,$8)",
        [sha(state), userId, i.id, sha(nonce), c.dados, c.chaveId, agora, new Date(agora.getTime() + STATE_TTL_MS)],
      ),
    );
    const url = new URL(GOOGLE.autorizacao);
    url.search = new URLSearchParams({
      client_id: this.cliente.clientId,
      redirect_uri: this.cliente.redirectUri,
      response_type: "code",
      scope: i.escopos.join(" "),
      state,
      code_challenge: desafio,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
      // Sem somar escopos de conexões anteriores: cada integração pede só o seu.
      include_granted_scopes: "false",
    }).toString();
    return { url: url.toString(), nonce };
  }

  /** O Google devolveu a pessoa com `code` e `state`; `nonce` vem do cookie do navegador. */
  async concluir(state: string, code: string, nonce: string | null): Promise<{ userId: string; integracao: string }> {
    if (!state || !code || !nonce || state.length > 200 || code.length > 2000 || nonce.length > 200) throw new ObedientError("UNAUTHENTICATED", "retorno do Google incompleto");
    const agora = this.clock.now();
    const fluxo = await comoAutenticacao(this.db, async (tx) => {
      const { rows } = await tx.query<{ user_id: string; integracao: string; verifier_cifra: Buffer; chave_id: string }>(
        `update obedient.oauth_states set usado_em = $3
          where state_hash = $1 and nonce_hash = $2 and usado_em is null and expira_em > $3
          returning user_id, integracao, verifier_cifra, chave_id`,
        [sha(state), sha(nonce), agora],
      );
      return rows[0] ?? null;
    });
    // State desconhecido, vencido, já usado, ou de OUTRO navegador (nonce diferente): nada é conectado.
    if (!fluxo) throw new ObedientError("UNAUTHENTICATED", "esse pedido de conexão não vale mais: comece de novo");
    const i = integracao(fluxo.integracao);
    const verifier = this.cofre.decifrar({ chaveId: fluxo.chave_id, dados: Buffer.from(fluxo.verifier_cifra) }, fluxo.user_id, `oauth:${i.id}`);

    const r = await this.pedirToken({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: this.cliente.redirectUri });
    if (!r.refresh_token) throw new ObedientError("UNAUTHENTICATED", "o Google não devolveu acesso permanente: tente conectar de novo");
    this.conferirEscopos(i, r.scope);
    const cred: Credencial = { refreshToken: r.refresh_token, accessToken: r.access_token, expiraEm: agora.getTime() + r.expires_in * 1000 };
    await comoUsuario(this.db, fluxo.user_id, (tx) => this.gravar(tx, fluxo.user_id, i, cred, true));
    return { userId: fluxo.user_id, integracao: i.id };
  }

  /** Token de acesso válido para a integração. A renovação (rede) acontece fora da transação. */
  async tokenDeAcesso(userId: string, integracaoId: string): Promise<string> {
    const i = integracao(integracaoId);
    const cred = await comoUsuario(this.db, userId, (tx) => this.ler(tx, userId, i));
    if (!cred) throw new ObedientError("GRANT_NOT_FOUND", `${i.nome} não está conectado`);
    if (cred.expiraEm - MARGEM_RENOVACAO_MS > this.clock.now().getTime()) return cred.accessToken;
    let r;
    try {
      r = await this.pedirToken({ grant_type: "refresh_token", refresh_token: cred.refreshToken });
    } catch (e) {
      // Acesso revogado pela pessoa no Google: a conexão deixa de existir aqui também.
      if (e instanceof ObedientError && /invalid_grant/.test(e.message)) {
        await comoUsuario(this.db, userId, (tx) => tx.query("delete from obedient.connections where user_id = $1 and integracao = $2", [userId, i.id]));
        throw new ObedientError("GRANT_NOT_FOUND", `${i.nome} perdeu o acesso no Google: conecte de novo`);
      }
      throw e;
    }
    const nova: Credencial = { refreshToken: r.refresh_token ?? cred.refreshToken, accessToken: r.access_token, expiraEm: this.clock.now().getTime() + r.expires_in * 1000 };
    await comoUsuario(this.db, userId, (tx) => this.gravar(tx, userId, i, nova, false));
    return nova.accessToken;
  }

  async listar(userId: string): Promise<ConexaoVisivel[]> {
    return comoUsuario(this.db, userId, async (tx) => {
      const { rows } = await tx.query<{ integracao: string; escopos: string[]; conectada_em: unknown }>(
        "select integracao, escopos, conectada_em from obedient.connections where user_id = $1 order by integracao",
        [userId],
      );
      return rows.map((r) => ({ integracao: r.integracao, escopos: r.escopos, conectadaEm: new Date(r.conectada_em as string | Date).toISOString() }));
    });
  }

  /** A pessoa desconecta: sai da conexão e entra na fila de revogação; depois revoga no Google. */
  async desconectar(userId: string, integracaoId: string): Promise<boolean> {
    const i = integracao(integracaoId);
    const tiradas = await comoUsuario(this.db, userId, (tx) => tirarConexoes(tx, userId, "desconectada pela pessoa", i.id));
    await this.revogarPendentes(userId);
    return tiradas.length > 0;
  }

  /** Chama a revogação no Google para o que está na fila. Falha de rede: fica para a próxima vez. */
  async revogarPendentes(userId: string): Promise<{ revogadas: number; pendentes: number }> {
    const fila = await comoUsuario(this.db, userId, async (tx) => {
      const { rows } = await tx.query<{ id: string; integracao: string; cifra: Buffer; chave_id: string }>(
        // Só o que é do Google vai ao endpoint do Google. Credencial de outro provedor (servidor MCP
        // com OAuth da pessoa) é tratada por quem a criou e nunca sai daqui para o Google.
        "select id, integracao, cifra, chave_id from obedient.token_revocations where user_id = $1 and integracao like 'google\\_%' order by criada_em",
        [userId],
      );
      return rows;
    });
    let revogadas = 0;
    for (const f of fila) {
      let ok = false;
      try {
        const cred = JSON.parse(this.cofre.decifrar({ chaveId: f.chave_id, dados: Buffer.from(f.cifra) }, userId, f.integracao)) as Credencial;
        const r = await this.http(GOOGLE.revogacao, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: cred.refreshToken }).toString() });
        // 400 invalid_token = já não vale no Google: o objetivo foi atingido.
        ok = r.ok || (r.status === 400 && /invalid_token/.test(await r.text().catch(() => "")));
      } catch (e) {
        // Cifra ilegível (chave retirada): não há o que revogar daqui.
        ok = e instanceof ObedientError;
      }
      await comoUsuario(this.db, userId, (tx) =>
        ok ? tx.query("delete from obedient.token_revocations where id = $1", [f.id]) : tx.query("update obedient.token_revocations set tentativas = tentativas + 1 where id = $1", [f.id]),
      );
      if (ok) revogadas++;
    }
    return { revogadas, pendentes: fila.length - revogadas };
  }

  private conferirEscopos(i: Integracao, dados: string | undefined) {
    const recebidos = new Set((dados ?? "").split(/\s+/).filter(Boolean));
    const faltam = i.escopos.filter((e) => !recebidos.has(e));
    // A pessoa pode desmarcar uma permissão na tela do Google: sem todas, a integração não funciona direito.
    if (faltam.length) throw new ObedientError("CONSENT_REQUIRED", `o Google não deu todas as permissões de ${i.nome}: conecte de novo e marque todas`);
    // Escopo a MAIS do que o pedido (conta com concessões antigas): recusado, para manter o mínimo.
    const sobram = [...recebidos].filter((e) => !i.escopos.includes(e) && !["openid", "email", "profile"].includes(e));
    if (sobram.length) throw new ObedientError("INVALID_PAYLOAD", `o Google deu permissões além das pedidas (${sobram.join(", ")}): remova o acesso antigo do OBEDIENT na sua conta Google e conecte de novo`);
  }

  private async pedirToken(campos: Record<string, string>): Promise<{ access_token: string; expires_in: number; refresh_token?: string; scope?: string }> {
    const body = new URLSearchParams({ ...campos, client_id: this.cliente.clientId, client_secret: this.cliente.clientSecret });
    let r: Response;
    try {
      r = await this.http(GOOGLE.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
    } catch {
      throw new ObedientError("UNAUTHENTICATED", "o Google não respondeu: tente de novo");
    }
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok || typeof j.access_token !== "string" || typeof j.expires_in !== "number")
      throw new ObedientError("UNAUTHENTICATED", `o Google recusou: ${typeof j.error === "string" ? j.error : r.status}`);
    return j as { access_token: string; expires_in: number; refresh_token?: string; scope?: string };
  }

  private async ler(tx: Executor, userId: string, i: Integracao): Promise<Credencial | null> {
    const { rows } = await tx.query<{ cifra: Buffer; chave_id: string }>("select cifra, chave_id from obedient.connections where user_id = $1 and integracao = $2", [userId, i.id]);
    if (!rows[0]) return null;
    return JSON.parse(this.cofre.decifrar({ chaveId: rows[0].chave_id, dados: Buffer.from(rows[0].cifra) }, userId, i.id)) as Credencial;
  }

  private async gravar(tx: Executor, userId: string, i: Integracao, cred: Credencial, nova: boolean) {
    const c = this.cofre.cifrar(JSON.stringify(cred), userId, i.id);
    const agora = this.clock.now();
    if (nova) {
      // Reconectar substitui a credencial antiga, que vai para a fila de revogação.
      await tirarConexoes(tx, userId, "substituída por uma conexão nova", i.id);
      await tx.query("insert into obedient.connections (user_id, integracao, escopos, cifra, chave_id, conectada_em, atualizada_em) values ($1,$2,$3,$4,$5,$6,$6)", [
        userId,
        i.id,
        [...i.escopos],
        c.dados,
        c.chaveId,
        agora,
      ]);
    } else await tx.query("update obedient.connections set cifra = $3, chave_id = $4, atualizada_em = $5 where user_id = $1 and integracao = $2", [userId, i.id, c.dados, c.chaveId, agora]);
  }
}

/**
 * Tira as conexões da pessoa (todas, ou uma) e põe as credenciais na fila de revogação, na
 * transação de quem chama. Usada ao desconectar, ao apertar parar (Art. 9º) e ao apagar tudo.
 */
export async function tirarConexoes(tx: Executor, userId: string, motivo: string, integracaoId?: string): Promise<string[]> {
  const { rows } = await tx.query<{ integracao: string; cifra: Buffer; chave_id: string }>(
    "delete from obedient.connections where user_id = $1 and ($2::text is null or integracao = $2) returning integracao, cifra, chave_id",
    [userId, integracaoId ?? null],
  );
  for (const r of rows)
    await tx.query("insert into obedient.token_revocations (id, user_id, integracao, cifra, chave_id, motivo, criada_em) values ($1,$2,$3,$4,$5,$6,now())", [
      uuid(),
      userId,
      r.integracao,
      r.cifra,
      r.chave_id,
      motivo,
    ]);
  return rows.map((r) => r.integracao);
}

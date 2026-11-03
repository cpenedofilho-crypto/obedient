// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// A API do app, como função pura de pedido → resposta (o servidor HTTP é só o transporte, e os
// testes chamam isto direto).
//
// Barreiras, nesta ordem:
//   • pedido que muda algo (POST) precisa vir da origem do app (cabeçalho Origin), ser JSON e trazer
//     o cabeçalho x-obedient: 1. Com o cookie SameSite=Strict, isso fecha CSRF;
//   • a sessão vem do cookie __Host-obedient (HttpOnly, Secure, SameSite=Strict), resolvida no
//     banco. O usuário de tudo o que segue é o da sessão, nunca um campo do corpo;
//   • tudo o que toca dado do usuário roda em comoUsuario(): a RLS é a segunda barreira.

import { type Clock, ObedientError, systemClock } from "@obedient/core";
import { type Database, type OpcoesMotor, Sessoes, comoUsuario, motorNaTransacao } from "@obedient/store-postgres";
import { aplicarAcao, lerAcao } from "./acoes.ts";
import { montarPainel } from "./painel.ts";
import { type ConfigPasskey, Passkeys } from "./passkeys.ts";

export const COOKIE = "__Host-obedient";
export const MAX_CORPO = 64 * 1024;

export interface Pedido {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface Resposta {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface ConfigApi extends ConfigPasskey {
  motor?: Omit<OpcoesMotor, "clock">;
}

const json = (status: number, dados: unknown, extra: Record<string, string> = {}): Resposta => ({
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  body: JSON.stringify(dados),
});

const erro = (status: number, codigo: string, mensagem: string) => json(status, { erro: codigo, mensagem });

export function lerCookie(header: string | undefined, nome: string): string | null {
  if (!header) return null;
  for (const parte of header.split(";")) {
    const [k, ...v] = parte.trim().split("=");
    if (k === nome) return v.join("=") || null;
  }
  return null;
}

const cookieDeSessao = (token: string, maxAgeS: number) => `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeS}`;
const cookieApagado = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

export function criarApi(db: Database, cfg: ConfigApi, clock: Clock = systemClock) {
  const sessoes = new Sessoes(db, clock);
  const passkeys = new Passkeys(db, cfg, clock);
  const opcoesMotor: OpcoesMotor = { ...cfg.motor, clock };

  const comCorpo = (p: Pedido): unknown => {
    if (p.body.length > MAX_CORPO) throw new ObedientError("INVALID_PAYLOAD", "corpo grande demais");
    try {
      return p.body ? JSON.parse(p.body) : {};
    } catch {
      throw new ObedientError("INVALID_PAYLOAD", "JSON inválido");
    }
  };

  /** CSRF: só a origem do app muda alguma coisa. */
  const origemOk = (p: Pedido) =>
    p.headers.origin === cfg.origin && p.headers["x-obedient"] === "1" && (p.headers["content-type"] ?? "").startsWith("application/json");

  async function sessaoDo(p: Pedido) {
    const token = lerCookie(p.headers.cookie, COOKIE);
    const s = token ? await sessoes.resolver(token) : null;
    return s && token ? { s, token } : null;
  }

  async function rota(p: Pedido): Promise<Resposta> {
    const [caminho] = p.path.split("?");
    if (p.method === "POST" && !origemOk(p)) return erro(403, "origem", "pedido fora do app");

    // -------------------------------------------------------------- entrada (sem sessão)
    if (p.method === "POST" && caminho === "/api/convite/opcoes") {
      const { codigo } = comCorpo(p) as { codigo?: string };
      return json(200, await passkeys.opcoesDoConvite(String(codigo ?? "")));
    }
    if (p.method === "POST" && caminho === "/api/convite/concluir") {
      const { codigo, resposta } = comCorpo(p) as { codigo?: string; resposta?: never };
      const r = await passkeys.concluirConvite(String(codigo ?? ""), resposta as never);
      return json(200, { usuario: r.userId }, { "set-cookie": cookieDeSessao(r.token, 12 * 3600) });
    }
    if (p.method === "POST" && caminho === "/api/entrar/opcoes") return json(200, await passkeys.opcoesDeEntrada());
    if (p.method === "POST" && caminho === "/api/entrar") {
      const { resposta } = comCorpo(p) as { resposta?: never };
      const r = await passkeys.entrar(resposta as never);
      return json(200, { usuario: r.userId }, { "set-cookie": cookieDeSessao(r.token, 12 * 3600) });
    }

    // -------------------------------------------------------------- daqui para baixo, com sessão
    const atual = await sessaoDo(p);
    if (!atual) return erro(401, "sessao", "entre de novo com a sua passkey");
    const { s, token } = atual;

    if (p.method === "GET" && caminho === "/api/painel")
      return json(200, await comoUsuario(db, s.userId, (tx) => montarPainel(motorNaTransacao(tx, opcoesMotor), s.userId, s.strongAuth, clock.now())));

    if (p.method === "POST" && caminho === "/api/acoes") {
      const acao = lerAcao(comCorpo(p));
      if (Array.isArray(acao)) return erro(400, "acao", acao.join("; "));
      try {
        const r = await comoUsuario(db, s.userId, (tx) => aplicarAcao(tx, motorNaTransacao(tx, opcoesMotor), s, acao, clock));
        return json(200, r);
      } catch (e) {
        // Mesmo opId chegando duas vezes ao mesmo tempo: a segunda perde na chave única e lê o
        // resultado que a primeira gravou.
        if ((e as { code?: string }).code === "23505") {
          const r = await comoUsuario(db, s.userId, (tx) => tx.query<{ result: unknown }>("select result from obedient.client_ops where user_id = $1 and op_id = $2", [s.userId, acao.opId]));
          if (r.rows[0]) return json(200, { resultado: r.rows[0].result, repetida: true });
        }
        throw e;
      }
    }

    if (p.method === "POST" && caminho === "/api/reautenticar/opcoes") return json(200, await passkeys.opcoesDeReautenticacao(s.userId));
    if (p.method === "POST" && caminho === "/api/reautenticar") {
      const { resposta } = comCorpo(p) as { resposta?: never };
      await passkeys.reautenticar(token, s.userId, resposta as never);
      return json(200, { reautenticado: true });
    }
    if (p.method === "POST" && caminho === "/api/sair") {
      await sessoes.encerrar(token);
      return json(200, { saiu: true }, { "set-cookie": cookieApagado });
    }
    return erro(404, "rota", "não existe");
  }

  return async function api(p: Pedido): Promise<Resposta> {
    try {
      return await rota(p);
    } catch (e) {
      if (e instanceof ObedientError) {
        const status = e.code === "UNAUTHENTICATED" ? 401 : 400;
        return erro(status, e.code, e.message);
      }
      // Erro interno não vaza detalhe para o aparelho; vai para o log do servidor.
      console.error(JSON.stringify({ evento: "api.erro", caminho: p.path, erro: e instanceof Error ? e.message : String(e) }));
      return erro(500, "interno", "erro no servidor, tente de novo");
    }
  };
}

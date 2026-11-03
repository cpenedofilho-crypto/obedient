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
import { type Database, type OpcoesMotor, Sessoes, comoUsuario, contestacoes, lerIdentificacao, motorNaTransacao } from "@obedient/store-postgres";
import { contexto } from "./contexto.ts";
import { type ClienteOAuth, type Cofre, Conexoes, INTEGRACOES, STATE_TTL_MS } from "@obedient/integrations";
import { CONSTITUTION_VERSION } from "@obedient/ethics-engine";
import { conexoesNoPainel } from "./painel.ts";
import { exportarDados } from "./exportar.ts";
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
  /** Integrações com o Google. Sem isto, o app mostra que o servidor não tem integrações ligadas. */
  google?: { cliente: ClienteOAuth; cofre: Cofre; fetch?: typeof fetch };
}

export const COOKIE_OAUTH = "__Host-obedient-oauth";

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
  const conexoes = cfg.google ? new Conexoes(db, cfg.google.cofre, cfg.google.cliente, cfg.google.fetch ?? fetch, clock) : null;
  /** Revogar no Google o que entrou na fila (rede, depois do commit). Falha fica para a próxima vez. */
  const revogarDepois = (userId: string) => {
    if (conexoes) void conexoes.revogarPendentes(userId).catch((e) => console.error(JSON.stringify({ evento: "conexoes.revogar_falhou", erro: e instanceof Error ? e.message : String(e) })));
  };
  // O servidor exige a identificação nas mensagens em nome da pessoa (Art. 5º).
  const opcoesMotor: OpcoesMotor = { ...cfg.motor, clock, exigirIdentificacao: true };

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

    // O Google devolve a pessoa aqui. Sem a sessão (o cookie dela é SameSite=Strict e não vem num
    // redirecionamento de outro site): quem prova o fluxo é o state no banco + o nonce no cookie Lax
    // deste navegador. Sempre termina redirecionando para o app, com o desfecho na URL.
    if (p.method === "GET" && caminho === "/api/conexoes/retorno") {
      const q = new URLSearchParams(p.path.split("?")[1] ?? "");
      const voltar = (status: "ok" | "erro", extra: Record<string, string>) => ({
        status: 303,
        headers: { location: `/?${new URLSearchParams({ conexao: status, ...extra }).toString()}`, "cache-control": "no-store", "set-cookie": `${COOKIE_OAUTH}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` },
        body: "",
      });
      if (!conexoes) return voltar("erro", { motivo: "integrações desligadas neste servidor" });
      if (q.get("error")) return voltar("erro", { motivo: q.get("error") === "access_denied" ? "você não autorizou no Google" : "o Google recusou" });
      try {
        const r = await conexoes.concluir(q.get("state") ?? "", q.get("code") ?? "", lerCookie(p.headers.cookie, COOKIE_OAUTH));
        await comoUsuario(db, r.userId, (tx) =>
          motorNaTransacao(tx, opcoesMotor).audit.record({ userId: r.userId, actor: `user:${r.userId}`, event: "connection.added", outcome: "info", systemId: r.integracao, constitutionVersion: CONSTITUTION_VERSION }),
        );
        return voltar("ok", { integracao: r.integracao });
      } catch (e) {
        return voltar("erro", { motivo: e instanceof ObedientError ? e.message : "não deu para conectar" });
      }
    }

    // -------------------------------------------------------------- daqui para baixo, com sessão
    const atual = await sessaoDo(p);
    if (!atual) return erro(401, "sessao", "entre de novo com a sua passkey");
    const { s, token } = atual;

    if (p.method === "GET" && caminho === "/api/painel")
      return json(
        200,
        await comoUsuario(db, s.userId, async (tx) => {
          const c = contexto(tx, opcoesMotor, clock);
          const conectadas = await tx.query<{ integracao: string; conectada_em: unknown }>("select integracao, conectada_em from obedient.connections where user_id = $1", [s.userId]);
          const painel = await montarPainel(c.motor, c.memoria, c.missoes, await contestacoes(tx, s.userId), await lerIdentificacao(tx, s.userId), s.userId, s.strongAuth, clock.now());
          return { ...painel, conexoes: conexoesNoPainel(conectadas.rows, !!conexoes) };
        }),
      );

    // Art. 13: tudo o que o OBEDIENT tem sobre a pessoa, num arquivo aberto (JSON).
    if (p.method === "GET" && caminho === "/api/meus-dados") {
      const dados = await comoUsuario(db, s.userId, (tx) => exportarDados(contexto(tx, opcoesMotor, clock), s.userId, clock.now()));
      const dia = clock.now().toISOString().slice(0, 10);
      return json(200, dados, { "content-disposition": `attachment; filename="obedient-${s.userId.replace(/[^A-Za-z0-9._-]/g, "_")}-${dia}.json"` });
    }

    if (p.method === "POST" && caminho === "/api/acoes") {
      const acao = lerAcao(comCorpo(p));
      if (Array.isArray(acao)) return erro(400, "acao", acao.join("; "));
      try {
        const r = await comoUsuario(db, s.userId, (tx) => aplicarAcao(contexto(tx, opcoesMotor, clock), s, acao));
        // Parar, apagar e desconectar põem credenciais na fila; a revogação no Google vem agora, fora da transação.
        if (["parar", "apagar_tudo", "desconectar"].includes(acao.tipo)) revogarDepois(s.userId);
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

    // A pessoa aperta "Conectar": o app vai para a URL do Google; o nonce fica num cookie Lax deste navegador.
    if (p.method === "POST" && caminho === "/api/conexoes/iniciar") {
      if (!conexoes) return erro(400, "conexoes", "este servidor não tem integrações ligadas");
      const { integracao: id } = comCorpo(p) as { integracao?: string };
      if (!INTEGRACOES.some((i) => i.id === id)) return erro(400, "conexoes", "integração desconhecida");
      const { url, nonce } = await conexoes.iniciar(s.userId, id!);
      return json(200, { url }, { "set-cookie": `${COOKIE_OAUTH}=${nonce}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${STATE_TTL_MS / 1000}` });
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

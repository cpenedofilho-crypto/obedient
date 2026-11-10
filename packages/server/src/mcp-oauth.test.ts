// SPDX-License-Identifier: AGPL-3.0-only
//
// Conexão OAuth da pessoa com um servidor MCP, contra um Authorization Server falso (o `fetch` é
// trocado; formato do Supabase OAuth Server, conferido em 10/11/2026: cliente público, PKCE S256,
// refresh token, sem endpoint de revogação):
//   • descoberta conferida: emissor diferente do configurado, endpoint fora da origem ou sem S256 = recusa;
//   • PKCE e state de uso único preso ao navegador; só quem está na lista do dono conecta;
//   • credencial cifrada, presa à pessoa; renovação antes de vencer; invalid_grant derruba a conexão;
//   • desconectar NUNCA manda o token do servidor MCP para o Google (a fila do Google só leva google_*).

import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ManualClock } from "@obedient/core";
import { Cofre, Conexoes, lerChaves, tirarConexoes } from "@obedient/integrations";
import { comoUsuario, motorNaTransacao } from "@obedient/store-postgres";
import { bancoDeTeste, type BancoDeTeste } from "../../store-postgres/src/banco-de-teste.ts";
import { ConexoesMcp, ROTA_RETORNO_MCP } from "./mcp-oauth.ts";
import { servidoresMcpDoAmbiente } from "./mcp-servidores.ts";

const T0 = new Date("2026-11-10T12:00:00Z");
const ORIGEM = "https://obedient.ficticio.test";
const ISSUER = "https://auth.recupera.ficticio.test/auth/v1";
const CLIENT_ID = "cliente-publico-obedient";
const configuracao = (extra: Record<string, unknown> = {}) => servidoresMcpDoAmbiente({
  OBEDIENT_MCP_SERVIDORES: JSON.stringify([{
    id: "recupera", nome: "Recupera OS", url: "https://mcp.recupera.ficticio.test/mcp", usuarios: ["ana-oauth", "bia-oauth"],
    ferramentas: ["recupera.minhas_capacidades"], oauth: { client_id: CLIENT_ID, issuer: ISSUER, escopos: ["openid"] }, ...extra,
  }]),
});

let banco: BancoDeTeste;
before(async () => { banco = await bancoDeTeste(); });
after(() => banco.fechar());
const cofre = new Cofre(lerChaves(`k1:${Cofre.novaChave()}`));

/** Authorization Server falso: descoberta, código com PKCE, refresh. Guarda o que recebeu. */
function asFalso(o: { issuer?: string; tokenUrl?: string; semS256?: boolean } = {}) {
  const codigos = new Map<string, { desafio: string; redirect: string }>();
  const recebidos: { url: string; corpo: URLSearchParams | null }[] = [];
  let refreshValido = true;
  let n = 0;
  const f = (async (entrada: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(entrada, init);
    const u = new URL(req.url);
    const corpo = req.method === "POST" ? new URLSearchParams(await req.text()) : null;
    recebidos.push({ url: `${u.origin}${u.pathname}`, corpo });
    if (u.pathname === "/.well-known/oauth-authorization-server/auth/v1") {
      return Response.json({
        issuer: o.issuer ?? ISSUER,
        authorization_endpoint: `${new URL(ISSUER).origin}/auth/v1/oauth/authorize`,
        token_endpoint: o.tokenUrl ?? `${new URL(ISSUER).origin}/auth/v1/oauth/token`,
        code_challenge_methods_supported: o.semS256 ? ["plain"] : ["S256", "plain"],
      });
    }
    if (u.pathname === "/auth/v1/oauth/token" && corpo) {
      if (corpo.get("client_id") !== CLIENT_ID || corpo.has("client_secret")) return Response.json({ error: "invalid_client" }, { status: 401 });
      if (corpo.get("grant_type") === "authorization_code") {
        const c = codigos.get(corpo.get("code") ?? "");
        const pkce = createHash("sha256").update(corpo.get("code_verifier") ?? "").digest("base64url");
        if (!c || c.desafio !== pkce || c.redirect !== corpo.get("redirect_uri")) return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json({ access_token: `at-${++n}`, refresh_token: `rt-${n}`, expires_in: 3600, token_type: "bearer" });
      }
      if (corpo.get("grant_type") === "refresh_token") {
        if (!refreshValido) return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json({ access_token: `at-renovado-${++n}`, refresh_token: `rt-${n}`, expires_in: 3600 });
      }
    }
    throw new TypeError(`rede bloqueada no teste (${u.host}${u.pathname})`);
  }) as typeof fetch;
  /** A pessoa autoriza na tela do servidor: devolve state e code como no redirecionamento. */
  const autorizar = (url: string) => {
    const q = new URL(url).searchParams;
    const code = `code-${codigos.size + 1}`;
    codigos.set(code, { desafio: q.get("code_challenge")!, redirect: q.get("redirect_uri")! });
    return { state: q.get("state")!, code };
  };
  return { f, autorizar, recebidos, revogarRefresh: () => { refreshValido = false; } };
}

function montar(o: Parameters<typeof asFalso>[0] = {}) {
  const as = asFalso(o);
  const clock = new ManualClock(T0);
  const conexoes = new ConexoesMcp(banco.db, cofre, configuracao(), ORIGEM, as.f, clock);
  const conectar = async (u: string) => {
    const { url, nonce } = await conexoes.iniciar(u, "recupera");
    const { state, code } = as.autorizar(url);
    return conexoes.concluir(state, code, nonce);
  };
  return { as, clock, conexoes, conectar };
}

describe("MCP com OAuth da pessoa: configuração", () => {
  it("token_env OU oauth; oauth com client_id, emissor https e escopos válidos", () => {
    assert.equal(configuracao()[0]!.oauth!.clientId, CLIENT_ID);
    assert.equal(configuracao()[0]!.tokenEnv, undefined);
    assert.throws(() => configuracao({ token_env: "OBEDIENT_MCP_X_TOKEN" }), /OU oauth/);
    assert.throws(() => configuracao({ oauth: { client_id: CLIENT_ID, issuer: "http://auth.ficticio.test" } }), /https/);
    assert.throws(() => configuracao({ oauth: { client_id: "tem espaço", issuer: ISSUER } }), /client_id/);
  });
});

describe("MCP com OAuth da pessoa: conectar", () => {
  it("pede com PKCE S256, cliente público e o retorno exato; conecta e guarda cifrado, preso à pessoa", async () => {
    const c = montar();
    const { url } = await c.conexoes.iniciar("ana-oauth", "recupera");
    const q = new URL(url).searchParams;
    assert.equal(new URL(url).origin + new URL(url).pathname, `${new URL(ISSUER).origin}/auth/v1/oauth/authorize`);
    assert.deepEqual([q.get("client_id"), q.get("redirect_uri"), q.get("code_challenge_method"), q.get("scope"), q.get("response_type")], [CLIENT_ID, `${ORIGEM}${ROTA_RETORNO_MCP}`, "S256", "openid", "code"]);
    assert.equal(q.has("client_secret"), false);

    assert.deepEqual(await c.conectar("ana-oauth"), { userId: "ana-oauth", integracao: "recupera" });
    const linha = await comoUsuario(banco.db, "ana-oauth", (tx) => tx.query<{ cifra: Buffer }>("select cifra from obedient.connections where user_id = $1 and integracao = 'recupera'", ["ana-oauth"]));
    assert.ok(linha.rows[0]);
    assert.doesNotMatch(Buffer.from(linha.rows[0]!.cifra).toString("latin1"), /at-\d|rt-\d/, "o token não fica em claro");
    assert.match(await c.conexoes.tokenDeAcesso("ana-oauth", "recupera"), /^at-\d+$/);
    await assert.rejects(c.conexoes.tokenDeAcesso("bia-oauth", "recupera"), /não está conectado/);
  });

  it("state de uso único e preso ao navegador; fora da lista do dono não conecta", async () => {
    const c = montar();
    const { url, nonce } = await c.conexoes.iniciar("bia-oauth", "recupera");
    const { state, code } = c.as.autorizar(url);
    await assert.rejects(c.conexoes.concluir(state, code, "nonce-de-outro-navegador"), /não vale mais/);
    await assert.rejects(c.conexoes.iniciar("caio-fora", "recupera"), /não está na lista/);
    const outro = await c.conexoes.iniciar("bia-oauth", "recupera");
    const r = c.as.autorizar(outro.url);
    await c.conexoes.concluir(r.state, r.code, outro.nonce);
    // Segunda volta igual do MESMO navegador: "conectado", sem novo pedido de token.
    const trocas = c.as.recebidos.filter((x) => x.url.endsWith("/oauth/token")).length;
    assert.deepEqual(await c.conexoes.concluir(r.state, r.code, outro.nonce), { userId: "bia-oauth", integracao: "recupera", repetida: true });
    assert.equal(c.as.recebidos.filter((x) => x.url.endsWith("/oauth/token")).length, trocas, "o código não foi trocado de novo");
    await assert.rejects(c.conexoes.concluir(r.state, r.code, "nonce-de-outro-navegador"), /não vale mais/, "de outro navegador continua recusado");
    c.clock.advance(11 * 60 * 1000);
    await assert.rejects(c.conexoes.concluir(r.state, r.code, outro.nonce), /não vale mais/, "passados 10 minutos, vale a regra normal");
    void nonce;
  });

  it("descoberta conferida: emissor diferente, token em outra origem ou sem S256 = não conecta", async () => {
    await assert.rejects(montar({ issuer: "https://outro-emissor.ficticio.test/auth/v1" }).conexoes.iniciar("ana-oauth", "recupera"), /emissor anunciado não é o configurado/);
    await assert.rejects(montar({ tokenUrl: "https://ladrao.ficticio.test/token" }).conexoes.iniciar("ana-oauth", "recupera"), /fora da origem/);
    await assert.rejects(montar({ semS256: true }).conexoes.iniciar("ana-oauth", "recupera"), /PKCE S256/);
  });
});

describe("MCP com OAuth da pessoa: renovar e desconectar", () => {
  it("renova antes de vencer; refresh recusado derruba a conexão", async () => {
    const c = montar();
    await c.conectar("ana-oauth");
    const primeiro = await c.conexoes.tokenDeAcesso("ana-oauth", "recupera");
    c.clock.advance(3600_000);
    const renovado = await c.conexoes.tokenDeAcesso("ana-oauth", "recupera");
    assert.notEqual(renovado, primeiro);
    assert.match(renovado, /^at-renovado-/);
    c.as.revogarRefresh();
    c.clock.advance(3600_000);
    await assert.rejects(c.conexoes.tokenDeAcesso("ana-oauth", "recupera"), /perdeu o acesso/);
    await assert.rejects(c.conexoes.tokenDeAcesso("ana-oauth", "recupera"), /não está conectado/);
  });

  it("desconectar: a fila do Google não leva o token do servidor MCP ao Google; a do MCP descarta", async () => {
    const c = montar();
    await c.conectar("bia-oauth");
    await comoUsuario(banco.db, "bia-oauth", (tx) => tirarConexoes(tx, "bia-oauth", "desconectada pela pessoa", "recupera"));
    const paraOGoogle: string[] = [];
    const google = new Conexoes(banco.db, cofre, { clientId: "g", clientSecret: "s", redirectUri: `${ORIGEM}/api/conexoes/retorno` }, (async (u: RequestInfo | URL) => {
      paraOGoogle.push(String(u));
      return new Response("", { status: 200 });
    }) as typeof fetch, c.clock);
    assert.deepEqual(await google.revogarPendentes("bia-oauth"), { revogadas: 0, pendentes: 0 });
    assert.deepEqual(paraOGoogle, [], "nada foi enviado ao Google");
    assert.equal(await c.conexoes.descartarRevogacoes("bia-oauth"), 1);
    const fila = await comoUsuario(banco.db, "bia-oauth", (tx) => tx.query("select 1 from obedient.token_revocations where user_id = $1", ["bia-oauth"]));
    assert.equal(fila.rows.length, 0);
  });
});

describe("MCP com OAuth da pessoa: parada (Art. 9º)", () => {
  it("parado, ou parado depois de iniciar, o retorno não conecta e nem troca o código", async () => {
    const c = montar();
    const u = "bia-oauth";
    const motor = <T>(fn: (m: ReturnType<typeof motorNaTransacao>) => Promise<T>) => comoUsuario(banco.db, u, (tx) => fn(motorNaTransacao(tx, { clock: c.clock })));
    const trocas = () => c.as.recebidos.filter((r) => r.corpo?.get("grant_type") === "authorization_code").length;
    await comoUsuario(banco.db, u, (tx) => tirarConexoes(tx, u, "começo do teste", "recupera"));
    const antes = trocas();

    // Começou, parou, voltou: recusado antes de pedir token.
    let ini = await c.conexoes.iniciar(u, "recupera");
    let volta = c.as.autorizar(ini.url);
    c.clock.advance(1000);
    await motor((m) => m.stop.engage({ kind: "user", userId: u }, u, "parar no meio"));
    await assert.rejects(c.conexoes.concluir(volta.state, volta.code, ini.nonce), /parada de emergência/);
    assert.equal(trocas(), antes);

    // Liberou; o pedido antigo continua sem valer.
    c.clock.advance(1000);
    await motor((m) => m.stop.release({ kind: "user", userId: u }, u, "user"));
    await assert.rejects(c.conexoes.concluir(volta.state, volta.code, ini.nonce), /não vale mais/, "o state já foi gasto na tentativa recusada");
    c.clock.advance(1000);
    ini = await c.conexoes.iniciar(u, "recupera");
    volta = c.as.autorizar(ini.url);
    c.clock.advance(1000);
    await motor((m) => m.stop.engage({ kind: "user", userId: u }, u, "de novo"));
    c.clock.advance(1000);
    await motor((m) => m.stop.release({ kind: "user", userId: u }, u, "user"));
    c.clock.advance(1000);
    await assert.rejects(c.conexoes.concluir(volta.state, volta.code, ini.nonce), /depois que este pedido de conexão começou/);
    assert.equal(trocas(), antes);
    await assert.rejects(c.conexoes.tokenDeAcesso(u, "recupera"), /não está conectado/);

    // Pedido novo, depois de liberar: conecta.
    c.clock.advance(1000);
    assert.deepEqual(await c.conectar(u), { userId: u, integracao: "recupera" });
  });
});

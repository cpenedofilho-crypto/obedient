// SPDX-License-Identifier: AGPL-3.0-only
// Login por link mágico com PKCE contra um Supabase Auth falso: pedido, troca do código, renovação,
// recusa, falta de rede e saída.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { type Cofre, desafioPkce, FalhaLogin, SessaoSupabase } from "./sessao.ts";

class CofreMemoria implements Cofre {
  dados = new Map<string, string>();
  async ler(c: string) { return this.dados.get(c) ?? null; }
  async gravar(c: string, v: string) { this.dados.set(c, v); }
  async apagar(c: string) { this.dados.delete(c); }
}

function supabaseFalso(opts: { online?: () => boolean; recusarRefresh?: boolean } = {}) {
  const pedidos: { url: string; corpo: Record<string, unknown>; headers: Record<string, string> }[] = [];
  let desafio = "";
  let n = 0;
  const f = (async (url: string, init: RequestInit) => {
    if (opts.online && !opts.online()) throw new TypeError("sem rede");
    const corpo = init.body ? JSON.parse(init.body as string) : {};
    const headers = init.headers as Record<string, string>;
    pedidos.push({ url, corpo, headers });
    if (headers.apikey !== "sb_publishable_teste") return Response.json({ msg: "no apikey" }, { status: 401 });
    const u = new URL(url);
    if (u.pathname === "/auth/v1/otp") { desafio = corpo.code_challenge; return Response.json({}); }
    if (u.pathname === "/auth/v1/token" && u.searchParams.get("grant_type") === "pkce") {
      const confere = createHash("sha256").update(corpo.code_verifier).digest("base64url") === desafio;
      if (corpo.auth_code !== "codigo-bom" || !confere) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: `at-${++n}`, refresh_token: `rt-${n}`, expires_in: 3600, user: { id: "u-1", email: "pessoa@exemplo.test" } });
    }
    if (u.pathname === "/auth/v1/token" && u.searchParams.get("grant_type") === "refresh_token") {
      if (opts.recusarRefresh) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: `at-${++n}`, refresh_token: `rt-${n}`, expires_in: 3600, user: { id: "u-1", email: "pessoa@exemplo.test" } });
    }
    if (u.pathname === "/auth/v1/logout") return new Response(null, { status: 204 });
    return new Response("?", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, pedidos };
}

function montar(opts: Parameters<typeof supabaseFalso>[0] = {}) {
  const s = supabaseFalso(opts);
  const cofre = new CofreMemoria();
  let agora = 1_000_000;
  const sessao = new SessaoSupabase({ url: "https://projeto.supabase.co", chavePublica: "sb_publishable_teste", cofre, f: s.f, agora: () => agora, aleatorio: (k) => new Uint8Array(k).fill(7) });
  return { sessao, cofre, ...s, avancar: (ms: number) => { agora += ms; } };
}

const VOLTA = "obedient-musica://auth/confirmar?code=codigo-bom";

describe("SessaoSupabase", () => {
  it("PKCE challenge is base64url(sha256(verifier))", () => {
    assert.equal(desafioPkce("abc"), createHash("sha256").update("abc").digest("base64url"));
  });

  it("asks for a magic link only for existing accounts, with the S256 challenge and the app redirect", async () => {
    const { sessao, pedidos } = montar();
    await sessao.pedirLink("  Pessoa@Exemplo.test ");
    const p = pedidos[0]!;
    assert.equal(p.url, "https://projeto.supabase.co/auth/v1/otp?redirect_to=obedient-musica%3A%2F%2Fauth%2Fconfirmar");
    assert.equal(p.corpo.email, "pessoa@exemplo.test");
    assert.equal(p.corpo.create_user, false);
    assert.equal(p.corpo.code_challenge_method, "s256");
    await assert.rejects(sessao.pedirLink("sem-arroba"), (e: unknown) => e instanceof FalhaLogin && e.codigo === "email_invalido");
  });

  it("exchanges the code with the stored verifier, keeps the session and forgets the verifier", async () => {
    const { sessao, cofre } = montar();
    await sessao.pedirLink("pessoa@exemplo.test");
    assert.deepEqual(await sessao.concluir(VOLTA), { id: "u-1", email: "pessoa@exemplo.test" });
    assert.equal(await sessao.token(), "at-1");
    assert.ok(!cofre.dados.has("obedient.musica.pkce"));
  });

  it("refuses a link without a pending request, with an error, without a code, or with a wrong code", async () => {
    const { sessao } = montar();
    await assert.rejects(sessao.concluir(VOLTA), (e: unknown) => e instanceof FalhaLogin && e.codigo === "sem_pedido_pendente");
    await sessao.pedirLink("pessoa@exemplo.test");
    await assert.rejects(sessao.concluir("obedient-musica://auth/confirmar#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired"), (e: unknown) => e instanceof FalhaLogin && e.codigo === "link_expirado");
    await assert.rejects(sessao.concluir("obedient-musica://auth/confirmar"), (e: unknown) => e instanceof FalhaLogin && e.codigo === "link_invalido");
    await assert.rejects(sessao.concluir("obedient-musica://auth/confirmar?code=forjado"), (e: unknown) => e instanceof FalhaLogin && e.codigo === "link_expirado");
    assert.equal(await sessao.token(), null);
  });

  it("refreshes one minute before expiry, once even with concurrent callers", async () => {
    const { sessao, pedidos, avancar } = montar();
    await sessao.pedirLink("pessoa@exemplo.test");
    await sessao.concluir(VOLTA);
    avancar(3600_000 - 30_000);
    const [a, b] = await Promise.all([sessao.token(), sessao.token()]);
    assert.equal(a, "at-2");
    assert.equal(b, "at-2");
    assert.equal(pedidos.filter((p) => p.url.includes("grant_type=refresh_token")).length, 1);
  });

  it("a refused refresh ends the session; no network keeps a still-valid token", async () => {
    const recusado = montar({ recusarRefresh: true });
    await recusado.sessao.pedirLink("pessoa@exemplo.test");
    await recusado.sessao.concluir(VOLTA);
    recusado.avancar(3600_000);
    assert.equal(await recusado.sessao.token(), null);
    assert.equal(await recusado.sessao.usuario(), null);

    let online = true;
    const off = montar({ online: () => online });
    await off.sessao.pedirLink("pessoa@exemplo.test");
    await off.sessao.concluir(VOLTA);
    off.avancar(3600_000 - 30_000);
    online = false;
    assert.equal(await off.sessao.token(), "at-1");
  });

  it("logout tells Supabase and wipes the vault", async () => {
    const { sessao, cofre, pedidos } = montar();
    await sessao.pedirLink("pessoa@exemplo.test");
    await sessao.concluir(VOLTA);
    await sessao.sair();
    assert.equal(cofre.dados.size, 0);
    const logout = pedidos.find((p) => p.url.endsWith("/logout"))!;
    assert.equal(logout.headers.authorization, "Bearer at-1");
  });

  it("refuses a non-https Supabase URL", () => {
    assert.throws(() => new SessaoSupabase({ url: "http://projeto.supabase.co", chavePublica: "x", cofre: new CofreMemoria() }));
  });
});

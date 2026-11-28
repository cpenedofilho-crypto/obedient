// SPDX-License-Identifier: AGPL-3.0-only
// Conta: organização vinda do Growth OS (/api/eu), só as que têm musica:usar; escolha guardada; 401 encerra.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ClienteGrowthOs, type OrganizacaoDaPessoa } from "../api/cliente.ts";
import { KvMemoria } from "../armazenamento/kv.ts";
import { Conta } from "./conta.ts";
import { type Cofre, SessaoSupabase } from "./sessao.ts";

class CofreMemoria implements Cofre {
  dados = new Map<string, string>();
  async ler(c: string) { return this.dados.get(c) ?? null; }
  async gravar(c: string, v: string) { this.dados.set(c, v); }
  async apagar(c: string) { this.dados.delete(c); }
}

const org = (slug: string, permissoes = ["musica:usar"]): OrganizacaoDaPessoa => ({ slug, nome: slug.toUpperCase(), papel: "viewer", permissoes });

async function montar(organizacoes: OrganizacaoDaPessoa[] | "401" | "sem_rede", logado = true) {
  const cofre = new CofreMemoria();
  if (logado) await cofre.gravar("obedient.musica.sessao", JSON.stringify({ access: "at", refresh: "rt", expiraEm: Date.now() + 3600_000, usuario: { id: "u-1", email: "p@exemplo.test" } }));
  const sessao = new SessaoSupabase({ url: "https://projeto.supabase.co", chavePublica: "k", cofre, f: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch });
  const kv = new KvMemoria();
  const conta = new Conta(sessao, kv);
  const cabecalhos: Record<string, string>[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    cabecalhos.push(init.headers as Record<string, string>);
    if (organizacoes === "sem_rede") throw new TypeError("rede");
    if (organizacoes === "401") return Response.json({ error: "unauthorized" }, { status: 401 });
    return Response.json({ usuario: { id: "u-1", email: "p@exemplo.test" }, organizacoes });
  }) as unknown as typeof fetch;
  const api = new ClienteGrowthOs("https://growth.exemplo.test", conta, f);
  return { conta, api, cofre, cabecalhos };
}

describe("Conta", () => {
  it("logged out without calling the Growth OS", async () => {
    const { conta, api, cabecalhos } = await montar([org("a")], false);
    assert.deepEqual(await conta.estado(api), { tipo: "fora" });
    assert.equal(cabecalhos.length, 0);
  });

  it("one organization with music: chosen automatically and sent as x-organizacao afterwards", async () => {
    const { conta, api, cabecalhos } = await montar([org("a"), org("b", ["operacao:ler"])]);
    const e = await conta.estado(api);
    assert.equal(e.tipo, "dentro");
    assert.equal(e.tipo === "dentro" && e.organizacao.slug, "a");
    await api.catalogo();
    assert.equal(cabecalhos.at(-1)!["x-organizacao"], "a");
    assert.equal(cabecalhos.at(-1)!.authorization, "Bearer at");
  });

  it("several organizations: the person chooses, and the choice is kept", async () => {
    const { conta, api } = await montar([org("a"), org("b")]);
    const e = await conta.estado(api);
    assert.equal(e.tipo, "escolher");
    await conta.escolher("b");
    const d = await conta.estado(api);
    assert.ok(d.tipo === "dentro" && d.organizacao.slug === "b");
  });

  it("no organization with music, token refused, and no network", async () => {
    const sem = await montar([org("a", ["operacao:ler"])]);
    assert.equal((await sem.conta.estado(sem.api)).tipo, "sem_organizacao");
    const r = await montar("401");
    assert.deepEqual(await r.conta.estado(r.api), { tipo: "fora" });
    assert.equal(r.cofre.dados.size, 0);
    const s = await montar("sem_rede");
    assert.equal((await s.conta.estado(s.api)).tipo, "sem_rede");
  });
});

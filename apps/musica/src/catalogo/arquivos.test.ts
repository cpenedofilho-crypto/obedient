// SPDX-License-Identifier: AGPL-3.0-only
// Catálogo real no aparelho: conversão do que vem do Growth OS e arquivos conferidos por tamanho e SHA-256.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ClienteGrowthOs, type FaixaRemota } from "../api/cliente.ts";
import { ArquivosDoCatalogo, type PastaDeArquivos } from "./arquivos.ts";
import { doGrowthOs } from "./remoto.ts";

const bytesDe = (id: string) => new TextEncoder().encode(`audio-${id}`);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function remota(id: string, extra: Partial<FaixaRemota> = {}): FaixaRemota {
  const b = bytesDe(id);
  return {
    trackRef: id, titulo: id, origem: "proprio", genero: "pop", explicita: false, energia: 0.5, duracaoMs: 180_000, fronteirasMs: [30_000],
    licenca: { permiteCrossfade: true, permiteCacheOffline: true, validaAte: null },
    arquivo: { sha256: sha(b), bytes: b.length, formato: "audio/mp4" },
    ...extra,
  };
}

class PastaFalsa implements PastaDeArquivos {
  arquivos = new Map<string, Uint8Array>();
  async listar() { return [...this.arquivos.keys()]; }
  async ler(n: string) { return this.arquivos.get(n) ?? null; }
  async gravar(n: string, b: Uint8Array) { this.arquivos.set(n, b); }
  async apagar(n: string) { this.arquivos.delete(n); }
  uri(n: string) { return `file:///cache/${n}`; }
}

function montar(opts: { online?: boolean; corromper?: string } = {}) {
  const online = opts.online ?? true;
  const f = (async (url: string) => {
    if (!online) throw new TypeError("sem rede");
    const id = new URL(url).searchParams.get("trackRef")!;
    return Response.json({ url: `https://arquivos.exemplo.test/${id}?assinado=1`, expiraEm: "2026-11-22T13:00:00.000Z" });
  }) as unknown as typeof fetch;
  const api = new ClienteGrowthOs("https://growth.exemplo.test", { token: async () => "tok", organizacao: async () => null }, f);
  const baixados: string[] = [];
  const baixar = async (url: string) => {
    if (!online) throw new TypeError("sem rede");
    const id = new URL(url).pathname.slice(1);
    baixados.push(id);
    return id === opts.corromper ? new TextEncoder().encode("outra-coisa") : bytesDe(id);
  };
  const pasta = new PastaFalsa();
  return { a: new ArquivosDoCatalogo(pasta, api, baixar), pasta, baixados };
}

const AGORA = "2026-11-22T12:00:00.000Z";

describe("doGrowthOs", () => {
  it("keeps only tracks with a published file and a valid licence", () => {
    const r = doGrowthOs([
      remota("ok"),
      remota("sem-arquivo", { arquivo: null }),
      remota("vencida", { licenca: { permiteCrossfade: true, permiteCacheOffline: true, validaAte: "2026-01-01T00:00:00.000Z" } }),
      remota("hash-ruim", { arquivo: { sha256: "x", bytes: 3, formato: "audio/mp4" } }),
      remota("grande", { arquivo: { sha256: "a".repeat(64), bytes: 100 * 1024 * 1024, formato: "audio/mp4" } }),
      remota("streaming", { origem: "spotify" }),
    ], AGORA);
    assert.deepEqual(r.map((x) => x.faixa.id), ["ok"]);
  });
});

describe("ArquivosDoCatalogo", () => {
  it("downloads, verifies and keeps; a second sync downloads nothing", async () => {
    const { a, pasta, baixados } = montar();
    const faixas = doGrowthOs([remota("f1"), remota("f2")], AGORA);
    assert.deepEqual(await a.atualizar(faixas), { mantidos: 0, baixados: 2, recusados: [], apagados: 0, semRede: 0 });
    assert.equal(pasta.arquivos.size, 2);
    assert.deepEqual(await a.atualizar(faixas), { mantidos: 2, baixados: 0, recusados: [], apagados: 0, semRede: 0 });
    assert.equal(baixados.length, 2);
    assert.match((await a.uriDe("f1"))!, /^file:\/\/\/cache\/f1\./);
  });

  it("refuses a file whose hash does not match the catalogue", async () => {
    const { a, pasta } = montar({ corromper: "f2" });
    const r = await a.atualizar(doGrowthOs([remota("f1"), remota("f2")], AGORA));
    assert.deepEqual(r.recusados, ["f2"]);
    assert.equal(pasta.arquivos.size, 1);
  });

  it("a track without permission to cache is never stored and plays from a temporary address", async () => {
    const { a, pasta } = montar();
    await a.atualizar(doGrowthOs([remota("so-online", { licenca: { permiteCrossfade: true, permiteCacheOffline: false, validaAte: null } })], AGORA));
    assert.equal(pasta.arquivos.size, 0);
    assert.equal(await a.uriDe("so-online"), "https://arquivos.exemplo.test/so-online?assinado=1");
  });

  it("deletes files of tracks that left the catalogue", async () => {
    const { a, pasta } = montar();
    await a.atualizar(doGrowthOs([remota("f1"), remota("f2")], AGORA));
    const r = await a.atualizar(doGrowthOs([remota("f1")], AGORA));
    assert.equal(r.apagados, 1);
    assert.equal(pasta.arquivos.size, 1);
    assert.equal(await a.uriDe("f2"), null);
  });

  it("offline: cached tracks still play, the rest waits; wipe removes everything", async () => {
    const online = montar();
    await online.a.atualizar(doGrowthOs([remota("f1")], AGORA));
    const offline = montar({ online: false });
    offline.pasta.arquivos = online.pasta.arquivos;
    const r = await offline.a.atualizar(doGrowthOs([remota("f1"), remota("f2")], AGORA));
    assert.equal(r.mantidos, 1);
    assert.equal(r.semRede, 1);
    assert.ok(await offline.a.uriDe("f1"));
    assert.equal(await offline.a.uriDe("f2"), null);
    assert.equal(await offline.a.apagarTudo(), 1);
  });
});

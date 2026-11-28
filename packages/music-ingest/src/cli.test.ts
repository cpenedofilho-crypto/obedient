// SPDX-License-Identifier: AGPL-3.0-only
// Linha de comando da ingestão: rascunho sem rede; envio só com confirmação, token e rascunho limpo.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executar } from "./cli.ts";

function wavSimples(segundos: number): Uint8Array {
  const taxa = 8000, n = taxa * segundos;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const s = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  s(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); s(8, "WAVE"); s(12, "fmt "); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, taxa, true); v.setUint32(28, taxa * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); s(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(8000 * Math.sin((2 * Math.PI * 330 * i) / taxa)), true);
  return new Uint8Array(buf);
}

function preparar(licencaOk = true) {
  const dir = mkdtempSync(join(tmpdir(), "ingest-"));
  writeFileSync(join(dir, "m.wav"), wavSimples(12));
  writeFileSync(join(dir, "d.m4a"), Uint8Array.from([9, 9, 9]));
  writeFileSync(join(dir, "manifesto.json"), JSON.stringify([{
    trackRef: "faixa-01", titulo: "Faixa", origem: "proprio", genero: "pop", explicita: false, mestre: "m.wav",
    distribuicao: { arquivo: "d.m4a", formato: "audio/mp4" },
    licenca: { instrumento: "contrato-1", permiteComercial: licencaOk, permiteCrossfade: true, permiteCacheOffline: true, evidencia: "c/1.pdf", validaAte: null },
  }]));
  return dir;
}

const saida = () => { const linhas: string[] = []; return { linhas, s: { log: (m: string) => linhas.push(m), erro: (m: string) => linhas.push(`ERRO ${m}`) } }; };

describe("cli de ingestão", () => {
  it("rascunho writes the draft without any network", async () => {
    const dir = preparar();
    const o = saida();
    let rede = 0;
    const codigo = await executar(["rascunho", join(dir, "manifesto.json"), join(dir, "r.json")], {}, o.s, (async () => { rede++; return new Response(); }) as unknown as typeof fetch);
    assert.equal(codigo, 0, o.linhas.join("\n"));
    assert.equal(rede, 0);
    const r = JSON.parse(readFileSync(join(dir, "r.json"), "utf8"));
    assert.equal(r[0].faixa.id, "faixa-01");
    assert.equal(r[0].arquivo.bytes, 3);
  });

  it("enviar refuses without confirmation, without token, with http, or with a problem in the draft", async () => {
    const dir = preparar(false);
    const o = saida();
    assert.equal(await executar(["rascunho", join(dir, "manifesto.json"), join(dir, "r.json")], {}, o.s), 1);
    let rede = 0;
    const f = (async () => { rede++; return new Response(null, { status: 201 }); }) as unknown as typeof fetch;
    const r = join(dir, "r.json");
    assert.equal(await executar(["enviar", r, "--growth-os", "https://g.exemplo.test"], { GROWTH_OS_TOKEN: "t" }, o.s, f), 2);
    assert.equal(await executar(["enviar", r, "--growth-os", "http://g.exemplo.test", "--confirmo-publicar"], { GROWTH_OS_TOKEN: "t" }, o.s, f), 2);
    assert.equal(await executar(["enviar", r, "--growth-os", "https://g.exemplo.test", "--confirmo-publicar"], {}, o.s, f), 2);
    assert.equal(await executar(["enviar", r, "--growth-os", "https://g.exemplo.test", "--confirmo-publicar"], { GROWTH_OS_TOKEN: "t" }, o.s, f), 1);
    assert.equal(rede, 0);
  });

  it("enviar posts each track with the bearer token and the organization, then uploads the file to the signed address", async () => {
    const dir = preparar();
    const o = saida();
    await executar(["rascunho", join(dir, "manifesto.json"), join(dir, "r.json")], {}, o.s);
    const pedidos: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      pedidos.push({ url, init });
      return url.includes("/api/musica/catalogo") ? Response.json({ trackRef: "faixa-01", criada: true, envio: { url: "https://storage.exemplo.test/upload?token=x" } }, { status: 201 }) : new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const codigo = await executar(["enviar", join(dir, "r.json"), "--growth-os", "https://g.exemplo.test", "--confirmo-publicar"], { GROWTH_OS_TOKEN: "tok", GROWTH_OS_ORGANIZACAO: "org-a" }, o.s, f);
    assert.equal(codigo, 0, o.linhas.join("\n"));
    assert.equal(pedidos.length, 2);
    assert.equal(pedidos[1]!.url, "https://storage.exemplo.test/upload?token=x");
    assert.equal(pedidos[1]!.init.method, "PUT");
    assert.deepEqual([...(pedidos[1]!.init.body as Uint8Array)], [9, 9, 9]);
    assert.equal((pedidos[1]!.init.headers as Record<string, string>).authorization, undefined);
    assert.equal(pedidos[0]!.url, "https://g.exemplo.test/api/musica/catalogo");
    const h = pedidos[0]!.init.headers as Record<string, string>;
    assert.equal(h.authorization, "Bearer tok");
    assert.equal(h["x-organizacao"], "org-a");
    assert.equal(JSON.parse(pedidos[0]!.init.body as string).arquivo.sha256.length, 64);
    assert.ok(!("caminhoDistribuicao" in JSON.parse(pedidos[0]!.init.body as string)));
  });

  it("a file changed after the draft is not uploaded", async () => {
    const dir = preparar();
    const o = saida();
    await executar(["rascunho", join(dir, "manifesto.json"), join(dir, "r.json")], {}, o.s);
    writeFileSync(join(dir, "d.m4a"), Uint8Array.from([1, 1, 1]));
    const urls: string[] = [];
    const f = (async (url: string) => { urls.push(url); return Response.json({ envio: { url: "https://storage.exemplo.test/u" } }, { status: 201 }); }) as unknown as typeof fetch;
    assert.equal(await executar(["enviar", join(dir, "r.json"), "--growth-os", "https://g.exemplo.test", "--confirmo-publicar"], { GROWTH_OS_TOKEN: "t" }, o.s, f), 1);
    assert.deepEqual(urls, ["https://g.exemplo.test/api/musica/catalogo"]);
  });
});

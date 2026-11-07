// SPDX-License-Identifier: AGPL-3.0-only
// fetch de saída contra DNS rebinding (auditoria A2A de 06/11/2026, R9). Sem rede: DNS falso e um
// servidor local. O "IP permitido" do teste é 127.0.0.1, liberado só pela opção de teste.

import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { criarFetchSeguro, ErroDestinoProibido, ipReservado, lookupSeguro } from "./index.ts";

let srv: Server;
let porta = 0;
const recebidos: { host?: string; metodo?: string; corpo: string }[] = [];

before(async () => {
  srv = createServer((req, res) => {
    let corpo = "";
    req.on("data", (c) => (corpo += c));
    req.on("end", () => {
      recebidos.push({ host: req.headers.host, metodo: req.method, corpo });
      if (req.url === "/redirect") { res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" }); return res.end(); }
      if (req.url === "/sse") {
        res.writeHead(200, { "content-type": "text/event-stream", "set-cookie": ["a=1", "b=2"] });
        res.write("data: um\n\n");
        setTimeout(() => { res.write("data: dois\n\n"); res.end(); }, 20);
        return;
      }
      res.writeHead(201, { "content-type": "application/json", "x-eco": req.headers["x-eco"] ?? "" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", () => ok()));
  porta = (srv.address() as { port: number }).port;
});
after(() => srv.close());

const dns = (mapa: Record<string, string[]>) => async (host: string) => {
  const ips = mapa[host];
  if (!ips) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  return ips.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};
/** No teste, só 127.0.0.1 (o servidor local) faz o papel de "IP público". */
const soLocalPermitido = (ip: string) => ip !== "127.0.0.1" && ipReservado(ip);

describe("ipReservado", () => {
  it("recusa loopback, privado, metadados de nuvem, CGNAT, IPv6 local e IPv4 embutido em IPv6", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
      "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:169.254.169.254", "::ffff:10.0.0.1", "64:ff9b::a9fe:a9fe", "2002:a9fe:a9fe::1", "ff02::1"]) {
      assert.equal(ipReservado(ip), true, ip);
    }
  });
  it("aceita IP público e recusa o que não é IP", () => {
    for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"]) assert.equal(ipReservado(ip), false, ip);
    assert.equal(ipReservado("não-é-ip"), true);
  });
});

describe("fetch seguro", () => {
  it("rebinding: domínio que resolve para metadados de nuvem, rede interna ou loopback é recusado sem conectar", async () => {
    const antes = recebidos.length;
    for (const ips of [["169.254.169.254"], ["10.0.0.5"], ["127.0.0.1"], ["::ffff:169.254.169.254"]]) {
      const f = criarFetchSeguro({ resolver: dns({ "api.fora.test": ips }) });
      await assert.rejects(f(`http://api.fora.test:${porta}/x`), ErroDestinoProibido, String(ips));
    }
    assert.equal(recebidos.length, antes);
  });

  it("um endereço reservado no meio de públicos já recusa a conexão inteira", async () => {
    const f = criarFetchSeguro({ resolver: dns({ "misto.test": ["127.0.0.1", "10.0.0.5"] }), ipProibido: soLocalPermitido });
    await assert.rejects(f(`http://misto.test:${porta}/x`), ErroDestinoProibido);
  });

  it("conecta no IP que o próprio lookup conferiu (o Host continua o nome), com método, corpo e cabeçalhos", async () => {
    let chamadas = 0;
    const resolver = async (h: string) => { chamadas++; return dns({ "api.ok.test": ["127.0.0.1"] })(h); };
    const f = criarFetchSeguro({ resolver, ipProibido: soLocalPermitido });
    const r = await f(`http://api.ok.test:${porta}/eco`, { method: "POST", body: "{\"a\":1}", headers: { "x-eco": "oi" } });
    assert.equal(r.status, 201);
    assert.equal(r.headers.get("x-eco"), "oi");
    assert.deepEqual(await r.json(), { ok: true });
    assert.equal(chamadas, 1);
    assert.deepEqual(recebidos.at(-1), { host: `api.ok.test:${porta}`, metodo: "POST", corpo: "{\"a\":1}" });
  });

  it("corpo em stream (SSE do MCP) chega pedaço por pedaço; cabeçalho repetido é preservado", async () => {
    const f = criarFetchSeguro({ resolver: dns({ "sse.test": ["127.0.0.1"] }), ipProibido: soLocalPermitido });
    const r = await f(`http://sse.test:${porta}/sse`);
    assert.equal(r.headers.get("content-type"), "text/event-stream");
    assert.match(r.headers.get("set-cookie") ?? "", /a=1.*b=2/);
    assert.equal(await r.text(), "data: um\n\ndata: dois\n\n");
  });

  it("nunca segue redirect (o destino do 3xx não passou pela checagem)", async () => {
    const f = criarFetchSeguro({ resolver: dns({ "redir.test": ["127.0.0.1"] }), ipProibido: soLocalPermitido });
    await assert.rejects(f(`http://redir.test:${porta}/redirect`), /redirect recusado/);
  });

  it("IP literal reservado é recusado mesmo sem passar pelo DNS; protocolo e credencial na URL também", async () => {
    const f = criarFetchSeguro({ resolver: async () => { throw new Error("não devia resolver") } });
    await assert.rejects(f(`http://127.0.0.1:${porta}/x`), ErroDestinoProibido);
    await assert.rejects(f("http://[::1]/x"), ErroDestinoProibido);
    await assert.rejects(f("http://169.254.169.254/latest"), ErroDestinoProibido);
    await assert.rejects(f("file:///etc/passwd"), /só http e https/);
    await assert.rejects(f("https://u:s@api.test/"), /credencial/);
  });

  it("aborto pelo sinal é respeitado", async () => {
    const f = criarFetchSeguro({ resolver: dns({ "lento.test": ["127.0.0.1"] }), ipProibido: soLocalPermitido });
    const c = new AbortController();
    c.abort();
    await assert.rejects(f(`http://lento.test:${porta}/x`, { signal: c.signal }));
  });

  it("lookupSeguro filtra por família e responde no formato all:true", async () => {
    const l = lookupSeguro({ resolver: dns({ "duplo.test": ["93.184.216.34", "2606:4700:4700::1111"] }) });
    const r = await new Promise<unknown>((ok, erro) => l("duplo.test", { all: true, family: 6 } as never, (e, a) => (e ? erro(e) : ok(a))));
    assert.deepEqual(r, [{ address: "2606:4700:4700::1111", family: 6 }]);
  });
});

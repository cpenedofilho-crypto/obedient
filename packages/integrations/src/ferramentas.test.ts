// SPDX-License-Identifier: AGPL-3.0-only
//
// Contrato de cada ferramenta com a API do Google: o pedido que sai (método, URL, token, corpo) e a
// leitura da resposta. Argumento fora do esquema é recusado ANTES da rede.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { API, FERRAMENTAS, LIMITES, executar, validarArgs } from "./ferramentas.ts";

interface Pedido {
  metodo: string;
  url: URL;
  auth: string | null;
  corpo: string;
}

/** API do Google falsa: anota cada pedido e responde com o que o teste mandar. */
function apiFalsa(responder: (p: Pedido) => { status?: number; json?: unknown }) {
  const pedidos: Pedido[] = [];
  const http = (async (url: string | URL | Request, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    const p: Pedido = { metodo: init?.method ?? "GET", url: new URL(String(url)), auth: h.get("authorization"), corpo: String(init?.body ?? "") };
    pedidos.push(p);
    const r = responder(p);
    return r.status === 204 ? new Response(null, { status: 204 }) : new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { http, pedidos };
}
const token = async (integracao: string) => `token-de-${integracao}`;

describe("ferramentas do Google: contrato", () => {
  it("agenda.listar_eventos: período em UTC, só eventos únicos em ordem, resposta resumida", async () => {
    const { http, pedidos } = apiFalsa(() => ({
      json: { items: [{ id: "ev1", summary: "Dentista", start: { dateTime: "2026-11-04T10:00:00-03:00" }, end: { dateTime: "2026-11-04T11:00:00-03:00" }, attendees: [{ email: "a@b.c" }], htmlLink: "x", description: "segredo" }] },
    }));
    const r = await executar("google_agenda.listar_eventos", { de: "2026-11-04T00:00:00-03:00", ate: "2026-11-05T00:00:00-03:00" }, token, http);
    const p = pedidos[0]!;
    assert.equal(p.metodo, "GET");
    assert.equal(p.url.origin + p.url.pathname, API.agenda);
    assert.equal(p.auth, "Bearer token-de-google_agenda");
    assert.deepEqual(Object.fromEntries(p.url.searchParams), { timeMin: "2026-11-04T03:00:00.000Z", timeMax: "2026-11-05T03:00:00.000Z", singleEvents: "true", orderBy: "startTime", maxResults: String(LIMITES.eventos) });
    assert.deepEqual(r, { eventos: [{ id: "ev1", titulo: "Dentista", inicio: "2026-11-04T10:00:00-03:00", fim: "2026-11-04T11:00:00-03:00", local: null, participantes: 1 }] });
  });

  it("agenda.criar_evento: sem convidados e sem aviso a ninguém", async () => {
    const { http, pedidos } = apiFalsa(() => ({ json: { id: "novo", htmlLink: "https://calendar.google.com/x" } }));
    const r = await executar("google_agenda.criar_evento", { titulo: "Reunião com fornecedor", inicio: "2026-11-05T14:00:00-03:00", fim: "2026-11-05T15:00:00-03:00" }, token, http);
    const p = pedidos[0]!;
    assert.equal(p.metodo, "POST");
    assert.equal(p.url.searchParams.get("sendUpdates"), "none");
    assert.deepEqual(JSON.parse(p.corpo), { summary: "Reunião com fornecedor", start: { dateTime: "2026-11-05T17:00:00.000Z" }, end: { dateTime: "2026-11-05T18:00:00.000Z" } });
    assert.deepEqual(r, { criado: true, id: "novo", link: "https://calendar.google.com/x" });
    // Convidados não estão no esquema: o modelo não consegue mandar convite por aqui.
    await assert.rejects(executar("google_agenda.criar_evento", { titulo: "x", inicio: "2026-11-05T14:00:00Z", fim: "2026-11-05T15:00:00Z", convidados: "todos@empresa.com" }, token, http), /não previsto: convidados/);
  });

  it("agenda.apagar_evento: id validado antes da URL; título e início conferidos antes de apagar", async () => {
    const evento = { id: "abc123", summary: "Dentista", start: { dateTime: "2026-11-05T14:00:00-03:00" } };
    const { http, pedidos } = apiFalsa((p) => (p.metodo === "GET" ? { json: evento } : { status: 204 }));
    const certo = { id: "abc123", titulo: "Dentista", inicio: "2026-11-05T14:00:00-03:00" };
    assert.deepEqual(await executar("google_agenda.apagar_evento", certo, token, http), { apagado: true });
    assert.deepEqual(pedidos.map((p) => p.metodo), ["GET", "DELETE"]);
    assert.equal(pedidos[1]!.url.pathname, "/calendar/v3/calendars/primary/events/abc123");
    // O mesmo instante escrito em UTC também vale.
    assert.deepEqual(await executar("google_agenda.apagar_evento", { ...certo, inicio: "2026-11-05T17:00:00Z" }, token, http), { apagado: true });
    pedidos.length = 0;
    // Título ou início diferentes do compromisso: nada é apagado.
    await assert.rejects(executar("google_agenda.apagar_evento", { ...certo, titulo: "Reunião de rotina" }, token, http), /não é o que foi aprovado/);
    await assert.rejects(executar("google_agenda.apagar_evento", { ...certo, inicio: "2026-11-06T14:00:00-03:00" }, token, http), /não é o que foi aprovado/);
    assert.deepEqual(pedidos.map((p) => p.metodo), ["GET", "GET"], "nenhum DELETE");
    await assert.rejects(executar("google_agenda.apagar_evento", { ...certo, id: "../../outra-agenda" }, token, http), /id de compromisso inválido/);
    assert.equal(pedidos.length, 2);
    await assert.rejects(executar("google_agenda.apagar_evento", { id: "abc123" }, token, http), /titulo/, "sem título e início, o pedido nem é aceito");
  });

  it("gmail.buscar_mensagens: busca, lê cada uma e corta o corpo", async () => {
    const longo = "x".repeat(LIMITES.corpoMensagem + 500);
    const { http, pedidos } = apiFalsa((p) =>
      p.url.pathname.endsWith("/messages")
        ? { json: { messages: [{ id: "m1" }, { id: "m2" }] } }
        : {
            json: {
              snippet: "resumo",
              payload: {
                headers: [{ name: "From", value: "Fornecedor <f@exemplo.org>" }, { name: "Subject", value: "Pedido" }, { name: "To", value: "ana@exemplo.org" }, { name: "Date", value: "Tue, 3 Nov 2026" }],
                parts: [{ mimeType: "text/html", body: { data: Buffer.from("<b>x</b>").toString("base64url") } }, { mimeType: "text/plain", body: { data: Buffer.from(p.url.pathname.endsWith("m1") ? "Confirmo 12 caixas." : longo).toString("base64url") } }],
              },
            },
          },
    );
    const r = (await executar("google_gmail.buscar_mensagens", { busca: "from:f@exemplo.org", quantas: 2 }, token, http)) as { mensagens: { texto: string; de: string; assunto: string }[] };
    assert.equal(pedidos[0]!.url.searchParams.get("q"), "from:f@exemplo.org");
    assert.equal(pedidos[0]!.auth, "Bearer token-de-google_gmail");
    assert.equal(pedidos[1]!.url.searchParams.get("format"), "full");
    assert.equal(r.mensagens[0]!.texto, "Confirmo 12 caixas.");
    assert.equal(r.mensagens[1]!.texto.length, LIMITES.corpoMensagem);
    assert.equal(r.mensagens[0]!.assunto, "Pedido");
    const pedido10 = apiFalsa(() => ({ json: { messages: [] } }));
    await executar("google_gmail.buscar_mensagens", { busca: "x", quantas: 500 }, token, pedido10.http);
    assert.equal(pedido10.pedidos[0]!.url.searchParams.get("maxResults"), String(LIMITES.mensagens));
  });

  it("gmail.enviar_mensagem: um destinatário, assinatura no fim, sem injeção de cabeçalho", async () => {
    const { http, pedidos } = apiFalsa(() => ({ json: { id: "enviada" } }));
    await executar("google_gmail.enviar_mensagem", { para: "fornecedor@exemplo.org", assunto: "Pedido de quinta", texto: "Confirmo 12 caixas.", identificacao: "Enviada pelo assistente da Ana" }, token, http);
    const p = pedidos[0]!;
    assert.equal(p.url.toString(), `${API.gmail}/send`);
    const mime = Buffer.from(JSON.parse(p.corpo).raw, "base64url").toString("utf8");
    const [cab, corpo] = mime.split("\r\n\r\n");
    assert.match(cab!, /^To: fornecedor@exemplo\.org\r\nSubject: Pedido de quinta\r\n/);
    assert.equal(Buffer.from(corpo!, "base64").toString("utf8"), "Confirmo 12 caixas.\n\n-- \nEnviada pelo assistente da Ana\n");
    for (const ruim of [
      { para: "a@b.c\r\nBcc: todos@empresa.com" },
      { para: "a@b.c, outro@b.c" },
      { assunto: "Oi\r\nBcc: todos@empresa.com" },
      { identificacao: undefined },
    ]) {
      const args = { para: "a@b.c", assunto: "x", texto: "y", identificacao: "Ana", ...ruim };
      if (ruim.identificacao === undefined && "identificacao" in ruim) delete (args as Record<string, unknown>).identificacao;
      await assert.rejects(executar("google_gmail.enviar_mensagem", args, token, http), JSON.stringify(ruim));
    }
    assert.equal(pedidos.length, 1, "nenhuma tentativa ruim chegou à rede");
    // Assunto com acento vai codificado (RFC 2047).
    await executar("google_gmail.enviar_mensagem", { para: "a@b.c", assunto: "Reunião", texto: "y", identificacao: "Ana" }, token, http);
    assert.match(Buffer.from(JSON.parse(pedidos[1]!.corpo).raw, "base64url").toString("utf8"), /Subject: =\?UTF-8\?B\?/);
  });

  it("drive: lista só o que o app vê e cria documento convertido em Google Docs", async () => {
    const { http, pedidos } = apiFalsa((p) => (p.metodo === "GET" ? { json: { files: [{ id: "f1", name: "Resumo", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-11-03", webViewLink: "l" }] } } : { json: { id: "f2", webViewLink: "l2" } }));
    const lista = await executar("google_drive.listar_arquivos", {}, token, http);
    assert.deepEqual(lista, { arquivos: [{ id: "f1", nome: "Resumo", tipo: "application/vnd.google-apps.document", alterado: "2026-11-03", link: "l" }] });
    assert.equal(pedidos[0]!.url.searchParams.get("q"), "trashed = false");
    const r = await executar("google_drive.criar_documento", { nome: "Resumo da semana", texto: "Tudo certo." }, token, http);
    const p = pedidos[1]!;
    assert.equal(p.url.origin + p.url.pathname, API.driveUpload);
    assert.equal(p.url.searchParams.get("uploadType"), "multipart");
    assert.match(p.corpo, /"mimeType":"application\/vnd\.google-apps\.document"/);
    assert.match(p.corpo, /\r\nTudo certo\.\r\n--obedient-/);
    assert.deepEqual(r, { criado: true, id: "f2", link: "l2" });
  });

  it("erro do Google vira falha legível, sem vazar o token", async () => {
    const { http } = apiFalsa(() => ({ status: 403, json: { error: { message: "Insufficient Permission" } } }));
    await assert.rejects(executar("google_drive.listar_arquivos", {}, token, http), (e: Error) => /recusou \(403\): Insufficient Permission/.test(e.message) && !/token-de/.test(e.message));
  });

  it("esquema: nada além do declarado, obrigatórios, tamanhos, datas e e-mail", () => {
    const e = FERRAMENTAS.find((f) => f.nome === "google_agenda.criar_evento")!.esquema;
    assert.throws(() => validarArgs(e, null));
    assert.throws(() => validarArgs(e, { titulo: "x", inicio: "ontem", fim: "2026-11-05T15:00:00Z" }), /data e hora/);
    assert.throws(() => validarArgs(e, { titulo: "x".repeat(201), inicio: "2026-11-05T14:00:00Z", fim: "2026-11-05T15:00:00Z" }), /longo demais/);
    assert.throws(() => validarArgs(e, { inicio: "2026-11-05T14:00:00Z", fim: "2026-11-05T15:00:00Z" }), /falta titulo/);
    for (const f of FERRAMENTAS) assert.equal(f.esquema.additionalProperties, false, f.nome);
  });
});

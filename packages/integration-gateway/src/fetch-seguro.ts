// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// fetch de saída resistente a DNS rebinding (auditoria A2A de 06/11/2026, achado R9).
//
// validarEndpoint() olha a STRING do host. Um domínio de fora pode responder um IP público na
// validação e 169.254.169.254 (metadados de nuvem), 10.x ou 127.0.0.1 na conexão: é o rebinding.
// Aqui a checagem do IP acontece DENTRO do lookup que a própria conexão usa. O IP conferido é o IP
// conectado, sem segunda resolução no meio. Qualquer endereço reservado na resposta do DNS (mesmo
// misturado com públicos) recusa a conexão inteira.
//
// O pool de conexões (keep-alive) é de cada fetch criado, nunca o globalAgent do Node: um socket
// aberto por outro código, com outra regra ou sem regra nenhuma, não é reaproveitado sem lookup.
//
// Também: nunca segue redirect (o destino de um 3xx não passou pela checagem); só http e https.
// Devolve um Response do fetch padrão, com o corpo em stream (o SSE do MCP Streamable HTTP funciona).

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { Agent as AgenteHttp, request as httpRequest, type IncomingMessage } from "node:http";
import { Agent as AgenteHttps, request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { hostLocalOuPrivado } from "./seguranca.ts";

/** IP (como o DNS devolve, sem colchetes) que nunca é destino de saída. */
export function ipReservado(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return hostLocalOuPrivado(ip);
  if (v === 6) {
    // A forma normalizada do WHATWG (comprimida, IPv4 embutido em hexa) é a que hostLocalOuPrivado trata.
    let normal: string;
    try { normal = new URL(`http://[${ip}]/`).hostname; } catch { return true; }
    return hostLocalOuPrivado(normal);
  }
  return true; // não é IP: falha fechada
}

export class ErroDestinoProibido extends Error {
  readonly code = "EDESTINOPROIBIDO";
  constructor(host: string) {
    super(`destino proibido: ${host} resolve para endereço local, privado ou reservado`);
  }
}

type Resolver = (host: string) => Promise<LookupAddress[]>;

const resolverPadrao: Resolver = (host) => new Promise((ok, erro) => {
  dnsLookup(host, { all: true, verbatim: true }, (e, enderecos) => (e ? erro(e) : ok(enderecos)));
});

export interface OpcoesFetchSeguro {
  /** Só para teste: troca o DNS. */
  resolver?: Resolver;
  /** Só para teste: troca o critério de IP proibido (padrão: ipReservado). */
  ipProibido?: (ip: string) => boolean;
}

/** lookup para http.request/https.request: resolve, confere TODOS os endereços e entrega só se nenhum for reservado. */
export function lookupSeguro(o: OpcoesFetchSeguro = {}): LookupFunction {
  const resolver = o.resolver ?? resolverPadrao;
  const proibido = o.ipProibido ?? ipReservado;
  return ((host: string, opcoes: { all?: boolean; family?: number | string }, cb: (e: NodeJS.ErrnoException | null, a: string | LookupAddress[], f?: number) => void) => {
    resolver(host).then((todos) => {
      const familia = opcoes?.family === 4 || opcoes?.family === "IPv4" ? 4 : opcoes?.family === 6 || opcoes?.family === "IPv6" ? 6 : 0;
      const enderecos = familia ? todos.filter((a) => a.family === familia) : todos;
      if (!enderecos.length) return cb(Object.assign(new Error(`sem endereço para ${host}`), { code: "ENOTFOUND" }), "");
      if (todos.some((a) => proibido(a.address))) return cb(new ErroDestinoProibido(host), "");
      if (opcoes?.all) return cb(null, enderecos);
      const [primeiro] = enderecos as [LookupAddress, ...LookupAddress[]];
      cb(null, primeiro.address, primeiro.family);
    }, (e: NodeJS.ErrnoException) => cb(e, ""));
  }) as LookupFunction;
}

function corpoDe(body: unknown): Buffer | undefined {
  if (body == null) return undefined;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), "utf8");
  throw new TypeError("fetch seguro: corpo não suportado (use string ou bytes)");
}

/**
 * Cria um fetch com a mesma assinatura do global, que só conecta a IP público e não segue redirect.
 * Use no lugar do fetch global em qualquer saída para URL que veio de configuração ou de fora.
 */
export function criarFetchSeguro(o: OpcoesFetchSeguro = {}): typeof fetch {
  const lookup = lookupSeguro(o);
  const agentes = { http: new AgenteHttp({ keepAlive: true, lookup }), https: new AgenteHttps({ keepAlive: true, lookup }) };
  return (async (entrada: RequestInfo | URL, init: RequestInit = {}) => {
    const pedido = entrada instanceof Request ? entrada : null;
    const url = new URL(pedido ? pedido.url : String(entrada));
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new TypeError("fetch seguro: só http e https");
    if (url.username || url.password) throw new TypeError("fetch seguro: URL com credencial");
    // Host que já é IP não passa pelo lookup (o Node conecta direto): confere aqui.
    const literal = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(literal) && (o.ipProibido ?? ipReservado)(literal)) throw new ErroDestinoProibido(url.hostname);
    const metodo = (init.method ?? pedido?.method ?? "GET").toUpperCase();
    const cabecalhos = new Headers(pedido?.headers);
    new Headers(init.headers).forEach((v, k) => cabecalhos.set(k, v));
    const corpo = corpoDe(init.body ?? (pedido && metodo !== "GET" && metodo !== "HEAD" ? new Uint8Array(await pedido.arrayBuffer()) : undefined));
    if (corpo) cabecalhos.set("content-length", String(corpo.length));
    const sinal = init.signal ?? pedido?.signal ?? undefined;
    const fazer = url.protocol === "https:" ? httpsRequest : httpRequest;
    const agent = url.protocol === "https:" ? agentes.https : agentes.http;

    return new Promise<Response>((ok, erro) => {
      if (sinal?.aborted) return erro(sinal.reason ?? new DOMException("abortado", "AbortError"));
      const req = fazer(url, { method: metodo, headers: Object.fromEntries(cabecalhos), lookup, agent, signal: sinal }, (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          // redirect: "manual" do fetch devolveria a resposta opaca; aqui é sempre recusa.
          return erro(new TypeError(`fetch seguro: redirect recusado (${status})`));
        }
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) for (const x of v) h.append(k, x);
          else if (v !== undefined) h.set(k, v);
        }
        const semCorpo = metodo === "HEAD" || status === 204 || status === 304;
        if (semCorpo) res.resume();
        ok(new Response(semCorpo ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, statusText: res.statusMessage, headers: h }));
      });
      req.on("error", (e) => erro(e instanceof ErroDestinoProibido ? e : Object.assign(new TypeError(`fetch failed: ${e.message}`), { cause: e })));
      if (corpo) req.end(corpo); else req.end();
    });
  }) as typeof fetch;
}

/** O fetch seguro com o DNS do sistema. */
export const fetchSeguro: typeof fetch = criarFetchSeguro();

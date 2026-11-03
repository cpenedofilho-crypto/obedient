// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Transporte: node:http, sem framework. Serve a API (api.ts) e os arquivos do app (public/). Todo
// arquivo sai com política de conteúdo estrita: só script e estilo do próprio app, nenhum inline,
// nenhum iframe. O service worker e a página inicial nunca ficam em cache do navegador, para que
// a versão nova do app chegue na próxima abertura.

import { createServer, type IncomingMessage, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_CORPO, type Pedido, type Resposta } from "./api.ts";

export const PUBLICO = fileURLToPath(new URL("../public/", import.meta.url));

export const CABECALHOS_DE_SEGURANCA: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

const TIPOS: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json; charset=utf-8",
};

const SEM_CACHE = new Set(["/", "/index.html", "/sw.js", "/manifest.webmanifest"]);

/** Arquivo do app. Caminho fora de public/ (../) não existe. */
export async function arquivoEstatico(caminho: string, raiz = PUBLICO): Promise<Resposta | null> {
  const limpo = caminho.split("?")[0] ?? "/";
  const rel = limpo === "/" ? "index.html" : decodeURIComponent(limpo).replace(/^\/+/, "");
  const alvo = normalize(join(raiz, rel));
  if (!alvo.startsWith(raiz.endsWith(sep) ? raiz : raiz + sep)) return null;
  const tipo = TIPOS[extname(alvo)];
  if (!tipo) return null;
  try {
    const body = await readFile(alvo);
    return {
      status: 200,
      headers: { "content-type": tipo, "cache-control": SEM_CACHE.has(limpo) ? "no-cache" : "public, max-age=3600" },
      body: body.toString(tipo.startsWith("image/png") ? "latin1" : "utf8"),
    };
  } catch {
    return null;
  }
}

async function lerCorpo(req: IncomingMessage): Promise<string | null> {
  let total = 0;
  const partes: Buffer[] = [];
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > MAX_CORPO) return null;
    partes.push(c as Buffer);
  }
  return Buffer.concat(partes).toString("utf8");
}

export function servidorHttp(api: (p: Pedido) => Promise<Resposta>, raiz = PUBLICO): Server {
  return createServer(async (req, res) => {
    const enviar = (r: Resposta) => {
      res.writeHead(r.status, { ...CABECALHOS_DE_SEGURANCA, ...r.headers });
      res.end(r.headers["content-type"]?.startsWith("image/png") ? Buffer.from(r.body, "latin1") : r.body);
    };
    try {
      const path = req.url ?? "/";
      if (path.startsWith("/api/")) {
        const body = await lerCorpo(req);
        if (body === null) return enviar({ status: 413, headers: { "content-type": "application/json" }, body: '{"erro":"tamanho"}' });
        const headers: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(", ") : v;
        return enviar(await api({ method: req.method ?? "GET", path, headers, body }));
      }
      if (req.method !== "GET" && req.method !== "HEAD") return enviar({ status: 405, headers: { "content-type": "text/plain" }, body: "método não aceito" });
      const r = await arquivoEstatico(path, raiz);
      // Rota desconhecida do app cai na página inicial (o app é uma página só).
      return enviar(r ?? (await arquivoEstatico("/", raiz)) ?? { status: 404, headers: { "content-type": "text/plain" }, body: "não existe" });
    } catch (e) {
      console.error(JSON.stringify({ evento: "http.erro", erro: e instanceof Error ? e.message : String(e) }));
      enviar({ status: 500, headers: { "content-type": "text/plain" }, body: "erro no servidor" });
    }
  });
}

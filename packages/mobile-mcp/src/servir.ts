// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// O servidor MCP do Mobile Control Engine em HTTP (streamable, sem estado por requisição), para o MCP
// Gateway do Growth OS registrar em mcp_servers.
//
//   • uma organização por instância (MOBILE_MCP_TENANT); o token é o que o Gateway manda (secret_ref
//     no Growth OS), conferido em tempo constante; sem token, nada;
//   • só POST /mcp; corpo limitado; Host conferido (proteção contra DNS rebinding);
//   • o motor (sessões, propostas) vive no processo; o aparelho é o serviço do casa-de-ia
//     (executores/mobile-control), na rede interna, com o token dele.
//
//   node --import tsx packages/mobile-mcp/src/servir.ts

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AdaptadorHttp, type AdaptadorMovel, MotorMovel, RegistroDeDispositivos } from "@obedient/mobile-control";
import { criarServidorMcp, type OpcoesServidor } from "./servidor.ts";

export const MAX_CORPO = 1_000_000;

export interface ConfigServir {
  tenantId: string;
  token: string;
  hostsPermitidos: string[];
  motor: MotorMovel;
  host?: string;
  porta?: number;
  /** Chave pública do Gateway e a regra da faixa comum (ver servidor.ts). */
  aprovacao?: OpcoesServidor;
}

function iguais(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const responder = (res: ServerResponse, status: number, erro: string) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ erro }));
};

async function lerCorpo(req: IncomingMessage): Promise<unknown> {
  let total = 0;
  const partes: Buffer[] = [];
  for await (const p of req) {
    total += (p as Buffer).length;
    if (total > MAX_CORPO) throw new Error("grande");
    partes.push(p as Buffer);
  }
  return JSON.parse(Buffer.concat(partes).toString("utf8") || "null");
}

export function servirMcp(c: ConfigServir): Promise<Server> {
  if (c.token.length < 32) throw new Error("o token do servidor MCP precisa de pelo menos 32 caracteres");
  if (!c.hostsPermitidos.length) throw new Error("diga os hosts permitidos (proteção contra DNS rebinding)");
  c = { ...c, hostsPermitidos: c.hostsPermitidos.map((h) => h.toLowerCase()) };
  const srv = createServer(async (req, res) => {
    if (req.url !== "/mcp") return responder(res, 404, "rota inexistente");
    if (req.method !== "POST") return responder(res, 405, "só POST");
    // DNS rebinding: o Host tem de ser um dos nomes desta instância (a porta não conta).
    const host = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
    if (!c.hostsPermitidos.includes(host)) return responder(res, 403, "host não permitido");
    if (!iguais(req.headers.authorization ?? "", `Bearer ${c.token}`)) {
      res.setHeader("www-authenticate", 'Bearer realm="obedient-mobile"');
      return responder(res, 401, "não autorizado");
    }
    let corpo: unknown;
    try {
      corpo = await lerCorpo(req);
    } catch {
      return responder(res, 400, "corpo inválido ou grande demais");
    }
    const mcp = criarServidorMcp(c.motor, c.tenantId, c.aprovacao);
    const transporte = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transporte.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transporte);
      await transporte.handleRequest(req, res, corpo);
    } catch {
      if (!res.headersSent) responder(res, 500, "falha interna");
    }
  });
  return new Promise((ok) => srv.listen(c.porta ?? 8780, c.host ?? "127.0.0.1", () => ok(srv)));
}

/** O motor com o aparelho único da instância (fase 1: emulador isolado, sem apps de mensagem). */
export function motorDaInstancia(env: Record<string, string | undefined>, adaptador?: AdaptadorMovel): { motor: MotorMovel; tenantId: string } {
  const precisa = (k: string) => {
    const v = env[k]?.trim();
    if (!v) throw new Error(`defina ${k}`);
    return v;
  };
  const tenantId = precisa("MOBILE_MCP_TENANT");
  const dispositivos = new RegistroDeDispositivos();
  dispositivos.registrar({
    id: env.MOBILE_MCP_DISPOSITIVO?.trim() || "emulador-1",
    tenantId,
    rotulo: env.MOBILE_MCP_ROTULO?.trim() || "Emulador de teste",
    plataforma: "android",
    provedor: "android_local",
    ambiente: "isolado",
    appsPermitidos: (env.MOBILE_MCP_APPS_PERMITIDOS ?? "").split(",").map((a) => a.trim()).filter(Boolean),
    appsNegados: [],
    permiteMensagens: false,
    credencialRef: env.MOBILE_CONTROL_TOKEN_REF?.trim() || "MOBILE_CONTROL_TOKEN",
    ativo: true,
  });
  const ref = env.MOBILE_CONTROL_TOKEN_REF?.trim() || "MOBILE_CONTROL_TOKEN";
  const aparelho = adaptador ?? new AdaptadorHttp({ url: precisa("MOBILE_CONTROL_URL"), token: precisa(ref) });
  return { motor: new MotorMovel({ dispositivos, adaptador: aparelho }), tenantId };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = process.env;
  try {
    const { motor, tenantId } = motorDaInstancia(env);
    const ref = env.MOBILE_MCP_TOKEN_REF?.trim() || "MOBILE_MCP_TOKEN";
    const srv = await servirMcp({
      tenantId,
      token: env[ref]?.trim() ?? "",
      hostsPermitidos: (env.MOBILE_MCP_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean),
      motor,
      host: env.MOBILE_MCP_HOST?.trim() || "127.0.0.1",
      porta: Number(env.MOBILE_MCP_PORTA ?? 8780),
      aprovacao: {
        chaveAprovacao: env.MOBILE_MCP_CHAVE_APROVACAO?.trim() || undefined,
        comumSemAprovacao: env.MOBILE_MCP_COMUM_SEM_APROVACAO?.trim() === "1",
      },
    });
    if (!env.MOBILE_MCP_CHAVE_APROVACAO?.trim()) console.warn("obedient-mobile: sem MOBILE_MCP_CHAVE_APROVACAO, nenhuma ação será executada");
    const a = srv.address();
    console.log(`obedient-mobile MCP em ${typeof a === "object" && a ? `${a.address}:${a.port}` : a} (organização ${tenantId})`);
  } catch (e) {
    console.error(`obedient-mobile não sobe: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}

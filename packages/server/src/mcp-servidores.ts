// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Cliente MCP genérico: servidores MCP de fora (Motor IGA, Recupera OS…) como ferramentas das missões.
//
// Quem decide o que entra é o DONO do servidor, numa configuração fechada (OBEDIENT_MCP_SERVIDORES):
//   • cada servidor vira um "sistema" do Ethics Engine (id), com URL https e o NOME da variável que
//     guarda o token (o valor nunca entra na configuração, no log nem na conversa);
//   • só as ferramentas listadas existem para o agente. A lista é do dono, não do servidor: ferramenta
//     nova no servidor não aparece sozinha. Do servidor vem só o esquema de entrada (tools/list) e uma
//     descrição curta, cortada; o que ele devolve volta como conteúdo externo, nunca instrução;
//   • nesta fase toda ferramenta é tratada como LEITURA de risco BAIXO, e o grant (concedido pela
//     linha de comando, por pessoa listada) só autoriza isso. Escrita fica para depois, com aprovação;
//   • a saída é pelo fetchSeguro (IP conferido na conexão, sem redirect para fora da origem).
// Servidor fora do ar não derruba a missão: as ferramentas dele só não são oferecidas naquela vez.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Executor, ItemGovernado } from "@obedient/agent-orchestrator";
import type { EthicsEngine } from "@obedient/ethics-engine";
import { fetchSeguro } from "@obedient/integration-gateway";
import { AGENTE, PRAZO_DO_GRANT_MS } from "@obedient/integrations";

export interface ServidorMcp {
  id: string;
  nome: string;
  url: string;
  /** Token de máquina: nome da variável de ambiente com o token (Bearer), lido a cada chamada. */
  tokenEnv?: string;
  /**
   * Ou token da PESSOA (mcp-oauth.ts): cliente público no Authorization Server do servidor, com PKCE.
   * Exatamente um dos dois: tokenEnv ou oauth.
   */
  oauth?: { clientId: string; issuer: string; escopos: readonly string[] };
  usuarios: ReadonlySet<string>;
  ferramentas: readonly string[];
}

const RESERVADOS = new Set(["obedient", "growth_os", "google_agenda", "google_gmail", "google_drive"]);
const ID = /^[a-z][a-z0-9_]{1,30}$/;
const FERRAMENTA = /^[A-Za-z0-9_.-]{1,64}$/;
const TOKEN_ENV = /^OBEDIENT_MCP_[A-Z0-9_]{1,60}$/;
const MAX_FERRAMENTAS = 40;
const MAX_DESCRICAO = 400;
const MAX_RESULTADO = 20_000;

/** Lê e valida a configuração. Sem a variável: nenhum servidor. Configuração inválida: o servidor não sobe. */
export function servidoresMcpDoAmbiente(env: Record<string, string | undefined> = process.env): ServidorMcp[] {
  const bruto = env.OBEDIENT_MCP_SERVIDORES?.trim();
  if (!bruto) return [];
  let lista: unknown;
  try { lista = JSON.parse(bruto); } catch { throw new Error("OBEDIENT_MCP_SERVIDORES não é JSON válido"); }
  if (!Array.isArray(lista)) throw new Error("OBEDIENT_MCP_SERVIDORES precisa ser uma lista");
  const vistos = new Set<string>();
  return lista.map((s, i) => {
    const o = (s ?? {}) as Record<string, unknown>;
    const onde = `OBEDIENT_MCP_SERVIDORES[${i}]`;
    const id = String(o.id ?? "");
    if (!ID.test(id) || RESERVADOS.has(id) || id.startsWith("google_")) throw new Error(`${onde}: id inválido ou reservado`);
    if (vistos.has(id)) throw new Error(`${onde}: id repetido`);
    vistos.add(id);
    const url = String(o.url ?? "");
    let u: URL;
    try { u = new URL(url); } catch { throw new Error(`${onde}: url inválida`); }
    if (u.protocol !== "https:" || u.username || u.password) throw new Error(`${onde}: url precisa ser https e sem credencial`);
    let tokenEnv: string | undefined;
    let oauth: ServidorMcp["oauth"];
    if (o.oauth !== undefined) {
      if (o.token_env !== undefined) throw new Error(`${onde}: use token_env OU oauth, não os dois`);
      const a = (o.oauth ?? {}) as Record<string, unknown>;
      const clientId = String(a.client_id ?? "");
      const issuer = String(a.issuer ?? "");
      const escopos = Array.isArray(a.escopos) ? a.escopos.map(String) : ["openid"];
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(clientId)) throw new Error(`${onde}: oauth.client_id inválido`);
      let i: URL;
      try { i = new URL(issuer); } catch { throw new Error(`${onde}: oauth.issuer inválido`); }
      if (i.protocol !== "https:" || i.username || i.password || i.search || i.hash) throw new Error(`${onde}: oauth.issuer precisa ser https, sem credencial`);
      if (!escopos.length || escopos.length > 10 || !escopos.every((e) => /^[A-Za-z0-9._:/-]{1,100}$/.test(e))) throw new Error(`${onde}: oauth.escopos inválidos`);
      oauth = { clientId, issuer, escopos };
    } else {
      tokenEnv = String(o.token_env ?? "");
      if (!TOKEN_ENV.test(tokenEnv)) throw new Error(`${onde}: token_env precisa ser o NOME de uma variável OBEDIENT_MCP_*`);
    }
    const usuarios = Array.isArray(o.usuarios) ? o.usuarios.map(String).map((x) => x.trim()).filter(Boolean) : [];
    if (!usuarios.length) throw new Error(`${onde}: liste quem pode usar (usuarios)`);
    const ferramentas = Array.isArray(o.ferramentas) ? o.ferramentas.map(String) : [];
    if (!ferramentas.length || ferramentas.length > MAX_FERRAMENTAS || !ferramentas.every((f) => FERRAMENTA.test(f))) {
      throw new Error(`${onde}: ferramentas precisa ser uma lista de 1 a ${MAX_FERRAMENTAS} nomes`);
    }
    const nome = String(o.nome ?? id).slice(0, 60);
    return { id, nome, url: u.toString(), ...(tokenEnv ? { tokenEnv } : {}), ...(oauth ? { oauth } : {}), usuarios: new Set(usuarios), ferramentas: [...new Set(ferramentas)] };
  });
}

/** Nome que o modelo vê: <servidor>__<ferramenta> (a API de modelos aceita só letras, números, _ e -). */
export const nomeMcpParaModelo = (servidor: string, ferramenta: string) => `${servidor}__${ferramenta.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 128);

/** Token do servidor ausente no ambiente: falha de configuração, não de rede. */
export class ErroMcpSemToken extends Error {
  constructor(servidor: string) { super(`servidor ${servidor} sem token configurado`); this.name = "ErroMcpSemToken"; }
}

/**
 * Motivo curto e seguro para o log quando um servidor MCP fica de fora (mcp.indisponivel). Só uma
 * classe fechada, nunca a mensagem: a do servidor é texto de fora e poderia trazer o que não deve ir
 * para o log. O token nunca está no erro.
 */
export type MotivoMcp = "sem_token" | "recusado_401" | "recusado_403" | "nao_encontrado_404" | "erro_servidor_5xx" | `http_${number}` | "destino_proibido" | "tempo_esgotado" | "rede" | "resposta_invalida" | "erro";
export function motivoMcp(e: unknown): MotivoMcp {
  if (e instanceof ErroMcpSemToken) return "sem_token";
  const o = (e ?? {}) as { name?: unknown; code?: unknown; cause?: unknown };
  if (o.code === "EDESTINOPROIBIDO" || (o.cause as { code?: unknown } | undefined)?.code === "EDESTINOPROIBIDO") return "destino_proibido";
  if (o.name === "UnauthorizedError") return "recusado_401";
  if (typeof o.code === "number") {
    if (o.code === 401) return "recusado_401";
    if (o.code === 403) return "recusado_403";
    if (o.code === 404) return "nao_encontrado_404";
    if (o.code >= 500 && o.code <= 599) return "erro_servidor_5xx";
    if (o.code >= 400 && o.code <= 499) return `http_${o.code}`;
  }
  if (o.name === "TimeoutError" || o.name === "AbortError") return "tempo_esgotado";
  if (o.name === "TypeError") return "rede";
  if (o.name === "SyntaxError" || o.name === "ZodError") return "resposta_invalida";
  return "erro";
}

const limpar = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "");

export interface ConexaoMcp {
  listar(): Promise<{ name: string; description?: string; inputSchema?: Record<string, unknown> }[]>;
  chamar(nome: string, argumentos: Record<string, unknown>): Promise<unknown>;
}

/** De onde vem o token de máquina (variável de ambiente); null sem a variável. */
export const tokenDoAmbiente = (s: ServidorMcp, env: Record<string, string | undefined> = process.env) => async () => (s.tokenEnv ? env[s.tokenEnv]?.trim() || null : null);

/**
 * Conexão pelo SDK oficial, Streamable HTTP, uma sessão por operação. `token` dá o Bearer: o de
 * máquina (tokenDoAmbiente) ou o da pessoa (ConexoesMcp.tokenDeAcesso). `http` injetável para teste.
 */
export function conexaoMcp(s: ServidorMcp, token: () => Promise<string | null>, http: typeof fetch = fetchSeguro): ConexaoMcp {
  const abrir = async <T>(fn: (c: Client) => Promise<T>): Promise<T> => {
    const bearer = await token();
    if (!bearer) throw new ErroMcpSemToken(s.id);
    const transporte = new StreamableHTTPClientTransport(new URL(s.url), {
      requestInit: { headers: { authorization: `Bearer ${bearer}` } },
      fetch: http,
    });
    const c = new Client({ name: "obedient", version: "0.0.0" });
    await c.connect(transporte);
    try { return await fn(c); } finally { await c.close().catch(() => {}); }
  };
  return {
    listar: () => abrir(async (c) => (await c.listTools()).tools as { name: string; description?: string; inputSchema?: Record<string, unknown> }[]),
    chamar: (nome, argumentos) => abrir((c) => c.callTool({ name: nome, arguments: argumentos })),
  };
}

/** As ferramentas do servidor que o dono listou E o servidor anuncia, como o laço do agente as quer. */
export async function itensMcp(s: ServidorMcp, conexao: ConexaoMcp): Promise<ItemGovernado[]> {
  const anunciadas = new Map((await conexao.listar()).map((t) => [t.name, t]));
  return s.ferramentas.flatMap((f) => {
    const t = anunciadas.get(f);
    if (!t) return [];
    const esquema = t.inputSchema && t.inputSchema.type === "object" ? t.inputSchema : { type: "object", properties: {} };
    return [{
      definicao: {
        name: nomeMcpParaModelo(s.id, f),
        description: `[${s.nome}, só leitura] ${limpar(t.description, MAX_DESCRICAO) || f}`,
        input_schema: esquema as Record<string, unknown>,
      },
      chave: `${s.id}/${f}`,
      sistema: s.id,
      ferramenta: `${s.id}.${f}`,
      risco: "LOW" as const,
      categoria: "READ" as const,
      finalidade: `integracao:${s.id}`,
    }];
  });
}

/** O que volta ao modelo: o texto e o conteúdo estruturado do resultado, cortados. */
function paraModelo(r: unknown) {
  const o = (r ?? {}) as { content?: { type?: string; text?: string }[]; structuredContent?: unknown; isError?: boolean };
  const texto = (o.content ?? []).filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n").slice(0, MAX_RESULTADO);
  const estruturado = o.structuredContent === undefined ? undefined : JSON.stringify(o.structuredContent).length <= MAX_RESULTADO ? o.structuredContent : "(grande demais)";
  return { erro: o.isError === true, texto, ...(estruturado !== undefined ? { dados: estruturado } : {}) };
}

/** O executor que o Ethics Engine chama depois de autorizar: só ferramenta listada do servidor certo. */
export function executorMcp(servidores: readonly ServidorMcp[], conexoes: ReadonlyMap<string, ConexaoMcp>): Executor {
  return async (sistema, ferramenta, argumentos) => {
    const s = servidores.find((x) => x.id === sistema);
    const nome = ferramenta.startsWith(`${sistema}.`) ? ferramenta.slice(sistema.length + 1) : "";
    const c = conexoes.get(sistema);
    if (!s || !c || !s.ferramentas.includes(nome)) throw new Error("ferramenta MCP fora da lista do dono");
    return paraModelo(await c.chamar(nome, argumentos));
  };
}

export async function concederMcp(motor: EthicsEngine, s: ServidorMcp, userId: string, agora: Date): Promise<void> {
  if (!s.usuarios.has(userId)) throw new Error(`essa pessoa não está em usuarios do servidor ${s.id}`);
  await retirarMcp(motor, s.id, userId);
  await motor.grants.grant(
    {
      userId,
      agentId: AGENTE,
      systemId: s.id,
      capability: `${s.id}.*`,
      purpose: `Ler, no ${s.nome}, o que as ferramentas listadas pelo dono do servidor mostram. Só leitura.`,
      limits: { maxRisk: "LOW", autonomousUpTo: "LOW", maxAmount: null, amountField: null },
      expiresAt: new Date(agora.getTime() + PRAZO_DO_GRANT_MS),
    },
    userId,
  );
}

export async function retirarMcp(motor: EthicsEngine, id: string, userId: string): Promise<void> {
  for (const g of await motor.grants.list(userId)) if (g.agentId === AGENTE && g.systemId === id && !g.revokedAt) await motor.grants.revoke(g.id, userId);
}

/** Servidores em que a pessoa tem grant vigente (e está na lista do dono). */
export async function servidoresDaPessoa(motor: EthicsEngine, servidores: readonly ServidorMcp[], userId: string, agora: Date): Promise<ServidorMcp[]> {
  const vigentes = new Set((await motor.grants.list(userId)).filter((g) => g.agentId === AGENTE && !g.revokedAt && g.expiresAt > agora).map((g) => g.systemId));
  return servidores.filter((s) => s.usuarios.has(userId) && vigentes.has(s.id));
}

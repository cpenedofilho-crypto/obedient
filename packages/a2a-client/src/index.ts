// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Cliente A2A 1.0 do OBEDIENT (auditoria A2A de 06/11/2026, fase 1: piloto só de leitura com o
// Growth OS). Fala o binding JSON-RPC (a2aproject/A2A v1.0.1) e entra no laço como um Executor do
// agent-orchestrator, então passa pelo Ethics Engine como qualquer ferramenta:
//
//   · o Ethics Engine decide (grant, risco, autonomia) ANTES de chegar aqui; o cliente não decide nada;
//   · saída sempre por fetchSeguro (integration-gateway, R9): IP conferido no lookup, sem redirect;
//   · o card só vale se o endpoint declarado for da MESMA origem do card e https: um card adulterado
//     não desvia o tráfego (e o token) para outro host;
//   · o token de máquina sai de uma fonte injetada (client_credentials, segredo no cofre); nunca da
//     conversa nem de argumento do modelo;
//   · resposta é validada por formato e tamanho; o que volta é dado (conteudo_externo, no governado),
//     e o texto do servidor nunca vira instrução;
//   · só o que o piloto usa: SendMessage, GetTask, ListTasks, CancelTask.

import { randomUUID } from "node:crypto";
import { fetchSeguro } from "@obedient/integration-gateway";

export const VERSAO_A2A = "1.0";
const MAX_RESPOSTA = 256 * 1024;
const ESTADOS = new Set(["TASK_STATE_SUBMITTED", "TASK_STATE_WORKING", "TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED", "TASK_STATE_REJECTED", "TASK_STATE_INPUT_REQUIRED", "TASK_STATE_AUTH_REQUIRED"]);
export const TERMINAIS = new Set(["TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED", "TASK_STATE_REJECTED"]);

export class ErroClienteA2A extends Error {
  /** Código JSON-RPC do servidor (ex.: -32001), ou o nosso em texto (ex.: "card_invalido"). */
  constructor(readonly codigo: number | string, mensagem: string) {
    super(mensagem);
  }
}

export interface CardValidado {
  nome: string;
  versao: string;
  endpoint: string;
  skills: readonly string[];
}

export interface Parte { text?: string; data?: unknown; mediaType?: string }
export interface Tarefa {
  id: string;
  contextId: string;
  estado: string;
  artefatos: { nome: string | null; partes: Parte[] }[];
  skillId: string | null;
  /** Código de erro do servidor quando a tarefa falha (metadata.erro). Só letras minúsculas e "_". */
  erro: string | null;
}

/** Fonte do token de máquina. Use `fonteClientCredentials` com o segredo vindo do cofre. */
export type FonteDeToken = () => Promise<string>;

export interface ConfigCliente {
  /** URL do card, ex.: https://growth-os.exemplo.com/.well-known/agent-card.json */
  cardUrl: string;
  token: FonteDeToken;
  /** Padrão: fetchSeguro. Injetável para teste. */
  fetch?: typeof fetch;
  /** Só teste: aceita http em 127.0.0.1/localhost. */
  permitirHttpLocal?: boolean;
}

const objeto = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const texto = (v: unknown, max = 200): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

async function lerJson(r: Response): Promise<unknown> {
  const t = await r.text();
  if (t.length > MAX_RESPOSTA) throw new ErroClienteA2A("resposta_grande_demais", "resposta acima do limite");
  try { return JSON.parse(t); } catch { throw new ErroClienteA2A("resposta_nao_json", "resposta não é JSON"); }
}

function origemPermitida(u: URL, permitirHttpLocal: boolean): boolean {
  if (u.protocol === "https:") return true;
  return permitirHttpLocal && u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname.endsWith(".test"));
}

/** Valida o card do A2A 1.0 (§4.4.1, §8) e escolhe a interface JSON-RPC 1.0 da mesma origem do card. */
export function validarCard(bruto: unknown, cardUrl: string, permitirHttpLocal = false): CardValidado {
  const base = new URL(cardUrl);
  if (!origemPermitida(base, permitirHttpLocal)) throw new ErroClienteA2A("card_invalido", "card fora de https");
  if (!objeto(bruto) || !texto(bruto.name) || !texto(bruto.version, 40) || !Array.isArray(bruto.supportedInterfaces) || !Array.isArray(bruto.skills)) {
    throw new ErroClienteA2A("card_invalido", "card sem campos obrigatórios");
  }
  const iface = bruto.supportedInterfaces.find((i) => {
    if (!objeto(i) || i.protocolBinding !== "JSONRPC" || i.protocolVersion !== VERSAO_A2A || !texto(i.url, 2048)) return false;
    try {
      const u = new URL(i.url);
      return u.origin === base.origin && origemPermitida(u, permitirHttpLocal) && !u.username && !u.password;
    } catch { return false; }
  }) as { url: string } | undefined;
  if (!iface) throw new ErroClienteA2A("card_sem_interface", "nenhuma interface JSON-RPC 1.0 na mesma origem do card");
  const skills = bruto.skills.filter((s): s is { id: string } => objeto(s) && texto(s.id, 64) && /^[a-z0-9_]+$/.test(s.id)).map((s) => s.id);
  return { nome: bruto.name, versao: bruto.version, endpoint: iface.url, skills };
}

/** Valida e reduz uma Task (§4.1.1) ao que o OBEDIENT usa. Campo desconhecido é descartado. */
export function validarTarefa(v: unknown): Tarefa {
  if (!objeto(v) || !texto(v.id) || !objeto(v.status) || typeof v.status.state !== "string" || !ESTADOS.has(v.status.state)) {
    throw new ErroClienteA2A("tarefa_invalida", "resposta não é uma Task do A2A 1.0");
  }
  const artefatos = (Array.isArray(v.artifacts) ? v.artifacts : []).slice(0, 20).filter(objeto).map((a) => ({
    nome: texto(a.name, 100) ? a.name : null,
    partes: (Array.isArray(a.parts) ? a.parts : []).slice(0, 20).filter(objeto).map((p): Parte => ({
      ...(typeof p.text === "string" ? { text: p.text.slice(0, 8000) } : {}),
      ...("data" in p ? { data: p.data } : {}),
      ...(texto(p.mediaType, 100) ? { mediaType: p.mediaType } : {}),
    })),
  }));
  const skillId = objeto(v.metadata) && texto(v.metadata.skillId, 64) ? v.metadata.skillId : null;
  const erro = objeto(v.metadata) && typeof v.metadata.erro === "string" && /^[a-z_]{1,60}$/.test(v.metadata.erro) ? v.metadata.erro : null;
  return { id: v.id, contextId: texto(v.contextId) ? v.contextId : "", estado: v.status.state, artefatos, skillId, erro };
}

export class ClienteA2A {
  private cache: { card: CardValidado; etag: string | null } | null = null;
  private readonly f: typeof fetch;
  constructor(private readonly c: ConfigCliente) {
    this.f = c.fetch ?? fetchSeguro;
  }

  /** Card, com cache por ETag (§8.6.2). */
  async card(): Promise<CardValidado> {
    const r = await this.f(this.c.cardUrl, { headers: this.cache?.etag ? { "if-none-match": this.cache.etag } : {} });
    if (r.status === 304 && this.cache) return this.cache.card;
    if (!r.ok) throw new ErroClienteA2A("card_indisponivel", `card respondeu ${r.status}`);
    const card = validarCard(await lerJson(r), this.c.cardUrl, this.c.permitirHttpLocal);
    this.cache = { card, etag: r.headers.get("etag") };
    return card;
  }

  private async rpc(metodo: string, params: unknown): Promise<unknown> {
    const { endpoint } = await this.card();
    const token = await this.c.token();
    const id = randomUUID();
    const r = await this.f(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "a2a-version": VERSAO_A2A, authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: metodo, params }),
    });
    if (r.status === 401) throw new ErroClienteA2A(401, "não autorizado pelo servidor A2A");
    const corpo = await lerJson(r);
    if (!objeto(corpo) || corpo.jsonrpc !== "2.0" || corpo.id !== id) throw new ErroClienteA2A("resposta_invalida", "resposta JSON-RPC inválida");
    if (objeto(corpo.error)) {
      const codigo = typeof corpo.error.code === "number" ? corpo.error.code : "erro";
      throw new ErroClienteA2A(codigo, texto(corpo.error.message, 200) ? corpo.error.message : "erro do servidor A2A");
    }
    if (!("result" in corpo)) throw new ErroClienteA2A("resposta_invalida", "resposta sem result");
    return corpo.result;
  }

  /**
   * Pede uma skill. `messageId` estável torna o reenvio idempotente no servidor. `dados` são os
   * campos estruturados da skill (quem chama decide quais; nunca repasse argumento de modelo sem
   * validar). O campo `skill` é sempre o do primeiro parâmetro.
   */
  async enviar(skill: string, o: { messageId?: string; retornarImediato?: boolean; dados?: Record<string, unknown> } = {}): Promise<Tarefa> {
    const { skills } = await this.card();
    if (!skills.includes(skill)) throw new ErroClienteA2A("skill_ausente_no_card", `o servidor não anuncia a skill ${skill}`);
    const r = await this.rpc("SendMessage", {
      message: { messageId: o.messageId ?? randomUUID(), role: "ROLE_USER", parts: [{ data: { ...(o.dados ?? {}), skill }, mediaType: "application/json" }] },
      configuration: { acceptedOutputModes: ["application/json"], ...(o.retornarImediato ? { returnImmediately: true } : {}) },
    });
    if (!objeto(r) || !("task" in r)) throw new ErroClienteA2A("resposta_invalida", "SendMessage sem task");
    return validarTarefa(r.task);
  }

  async obter(id: string): Promise<Tarefa> {
    return validarTarefa(await this.rpc("GetTask", { id }));
  }

  async cancelar(id: string): Promise<Tarefa> {
    return validarTarefa(await this.rpc("CancelTask", { id }));
  }

  async listar(p: { contextId?: string; status?: string; pageSize?: number; pageToken?: string } = {}): Promise<{ tarefas: Tarefa[]; proxima: string; total: number }> {
    const r = await this.rpc("ListTasks", p);
    if (!objeto(r) || !Array.isArray(r.tasks)) throw new ErroClienteA2A("resposta_invalida", "ListTasks sem tasks");
    return { tarefas: r.tasks.map(validarTarefa), proxima: typeof r.nextPageToken === "string" ? r.nextPageToken : "", total: typeof r.totalSize === "number" ? r.totalSize : r.tasks.length };
  }
}

/**
 * Executor do agent-orchestrator: `ferramenta` é a skill; argumentos aceitos: `message_id` (idempotência)
 * e `retornar_imediato`. Nada mais do argumento chega ao servidor. Registre a ferramenta com risco LOW e
 * categoria de leitura; o governado (chamarComEthics) marca o retorno como conteúdo externo.
 */
export function executorA2A(cliente: ClienteA2A, sistema: string) {
  return async (sis: string, ferramenta: string, argumentos: Record<string, unknown>): Promise<Tarefa> => {
    if (sis !== sistema) throw new ErroClienteA2A("sistema_desconhecido", `executor A2A atende só ${sistema}`);
    const messageId = typeof argumentos.message_id === "string" && /^[A-Za-z0-9_-]{8,100}$/.test(argumentos.message_id) ? argumentos.message_id : undefined;
    return cliente.enviar(ferramenta, { messageId, retornarImediato: argumentos.retornar_imediato === true });
  };
}

/**
 * Token client_credentials (RFC 6749 §4.4), com cache até perto do vencimento. O segredo vem de quem
 * chama (decifrado do cofre na hora); este módulo não guarda segredo em disco nem em log.
 */
export function fonteClientCredentials(o: { tokenUrl: string; clientId: string; segredo: () => Promise<string>; escopo?: string; fetch?: typeof fetch; agora?: () => number }): FonteDeToken {
  const f = o.fetch ?? fetchSeguro;
  const agora = o.agora ?? Date.now;
  let atual: { token: string; vence: number } | null = null;
  return async () => {
    if (atual && atual.vence - 60_000 > agora()) return atual.token;
    const corpo = new URLSearchParams({ grant_type: "client_credentials", client_id: o.clientId, client_secret: await o.segredo(), ...(o.escopo ? { scope: o.escopo } : {}) });
    const r = await f(o.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: corpo.toString() });
    if (!r.ok) throw new ErroClienteA2A("token_recusado", `token endpoint respondeu ${r.status}`);
    const j = await lerJson(r);
    if (!objeto(j) || !texto(j.access_token, 8192) || (j.token_type !== undefined && String(j.token_type).toLowerCase() !== "bearer")) throw new ErroClienteA2A("token_invalido", "resposta do token endpoint inválida");
    const expira = typeof j.expires_in === "number" && j.expires_in > 0 ? Math.min(j.expires_in, 86_400) : 300;
    atual = { token: j.access_token, vence: agora() + expira * 1000 };
    return atual.token;
  };
}

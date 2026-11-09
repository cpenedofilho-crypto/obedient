// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// As ferramentas do Google. Cada uma:
//   • valida os argumentos ANTES de qualquer rede (o que não está no esquema não passa);
//   • fala com a API do Google com o token da conexão da pessoa (Conexoes.tokenDeAcesso);
//   • devolve um resultado curto e limitado, que o laço do agente entrega ao modelo marcado como
//     conteúdo externo (dado, nunca instrução).
//
// Quem decide se a ferramenta roda é o Ethics Engine (grant, consentimento, política, aprovação),
// ANTES de chegar aqui: este módulo é só o "como". O executor que o servidor passa ao
// chamarComEthics/executeApproved é `executar()`.
//
// Mandar e-mail exige `identificacao` (Art. 5º): o motor confere que é a assinatura da pessoa, e
// aqui ela vai no fim do corpo, sempre.

import { ObedientError } from "@obedient/core";
import { INTEGRACOES } from "./catalogo.ts";

export const API = {
  agenda: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
  gmail: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
  drive: "https://www.googleapis.com/drive/v3/files",
  driveUpload: "https://www.googleapis.com/upload/drive/v3/files",
} as const;

export const LIMITES = { eventos: 50, mensagens: 10, corpoMensagem: 4000, arquivos: 20, texto: 50_000, titulo: 200 } as const;

type Fetch = typeof fetch;
export type ObterToken = (integracao: string) => Promise<string>;

interface Esquema {
  type: "object";
  properties: Record<string, { type: string; description: string; maxLength?: number; format?: string }>;
  required: string[];
  additionalProperties: false;
}

export interface DefinicaoDeFerramenta {
  nome: string;
  integracao: string;
  /** Para o modelo: o que a ferramenta faz e os argumentos (JSON Schema). */
  esquema: Esquema;
  executar(args: Record<string, unknown>, token: string, http: Fetch): Promise<unknown>;
}

const erro = (m: string): never => {
  throw new ObedientError("INVALID_PAYLOAD", m);
};

/** Confere os argumentos contra o esquema: tipos, obrigatórios, tamanhos e nada além do declarado. */
export function validarArgs(e: Esquema, args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) erro("argumentos precisam ser um objeto");
  const a = args as Record<string, unknown>;
  for (const k of Object.keys(a)) if (!(k in e.properties)) erro(`argumento não previsto: ${k}`);
  for (const k of e.required) if (a[k] === undefined || a[k] === null || a[k] === "") erro(`falta ${k}`);
  for (const [k, p] of Object.entries(e.properties)) {
    const v = a[k];
    if (v === undefined) continue;
    if (p.type === "string") {
      if (typeof v !== "string") erro(`${k} precisa ser texto`);
      if (p.maxLength && (v as string).length > p.maxLength) erro(`${k} longo demais`);
      if (p.format === "date-time" && Number.isNaN(Date.parse(v as string))) erro(`${k} precisa ser data e hora (ISO 8601)`);
      if (p.format === "email" && !/^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(v as string)) erro(`${k} precisa ser um e-mail`);
    }
    if (p.type === "integer" && (!Number.isInteger(v) || (v as number) < 1)) erro(`${k} precisa ser inteiro positivo`);
  }
  return a;
}

async function chamar(http: Fetch, url: string, token: string, init: RequestInit = {}): Promise<unknown> {
  let r: Response;
  try {
    r = await http(url, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  } catch {
    throw new Error("o Google não respondeu");
  }
  if (r.status === 204) return null;
  const j = (await r.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!r.ok) throw new Error(`o Google recusou (${r.status})${j?.error?.message ? `: ${String(j.error.message).slice(0, 200)}` : ""}`);
  return j;
}

const curto = (s: unknown, n: number) => (typeof s === "string" ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : "");
/** Sem quebra de linha (cabeçalho de e-mail com \r\n viraria cabeçalho injetado). */
const umaLinha = (s: string) => {
  if (/[\r\n]/.test(s)) erro("texto de uma linha não pode ter quebra de linha");
  return s;
};
const b64u = (s: string) => Buffer.from(s, "utf8").toString("base64url");
/** Assunto com acento em cabeçalho de e-mail (RFC 2047). */
const assuntoMime = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);

export const FERRAMENTAS: readonly DefinicaoDeFerramenta[] = [
  {
    nome: "google_agenda.listar_eventos",
    integracao: "google_agenda",
    esquema: {
      type: "object",
      properties: {
        de: { type: "string", format: "date-time", description: "Início do período, ISO 8601 com fuso (ex.: 2026-11-04T00:00:00-03:00)" },
        ate: { type: "string", format: "date-time", description: "Fim do período, ISO 8601 com fuso" },
      },
      required: ["de", "ate"],
      additionalProperties: false,
    },
    async executar(a, token, http) {
      if (Date.parse(a.ate as string) <= Date.parse(a.de as string)) erro("o fim precisa ser depois do início");
      const q = new URLSearchParams({ timeMin: new Date(a.de as string).toISOString(), timeMax: new Date(a.ate as string).toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: String(LIMITES.eventos) });
      const r = (await chamar(http, `${API.agenda}?${q}`, token)) as { items?: Record<string, any>[] };
      return {
        eventos: (r.items ?? []).map((e) => ({
          id: e.id,
          titulo: curto(e.summary, LIMITES.titulo),
          inicio: e.start?.dateTime ?? e.start?.date ?? null,
          fim: e.end?.dateTime ?? e.end?.date ?? null,
          local: curto(e.location, 200) || null,
          participantes: Array.isArray(e.attendees) ? e.attendees.length : 0,
        })),
      };
    },
  },
  {
    nome: "google_agenda.criar_evento",
    integracao: "google_agenda",
    esquema: {
      type: "object",
      properties: {
        titulo: { type: "string", maxLength: LIMITES.titulo, description: "Título do compromisso" },
        inicio: { type: "string", format: "date-time", description: "Início, ISO 8601 com fuso" },
        fim: { type: "string", format: "date-time", description: "Fim, ISO 8601 com fuso" },
        descricao: { type: "string", maxLength: 2000, description: "Detalhes (opcional)" },
        local: { type: "string", maxLength: 200, description: "Lugar (opcional)" },
      },
      required: ["titulo", "inicio", "fim"],
      additionalProperties: false,
    },
    async executar(a, token, http) {
      if (Date.parse(a.fim as string) <= Date.parse(a.inicio as string)) erro("o fim precisa ser depois do início");
      // Sem convidados e sem aviso: criar compromisso não manda nada a ninguém (isso seria COMMUNICATION).
      const corpo = { summary: a.titulo, start: { dateTime: new Date(a.inicio as string).toISOString() }, end: { dateTime: new Date(a.fim as string).toISOString() }, ...(a.descricao ? { description: a.descricao } : {}), ...(a.local ? { location: a.local } : {}) };
      const r = (await chamar(http, `${API.agenda}?sendUpdates=none`, token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo) })) as Record<string, unknown>;
      return { criado: true, id: r.id, link: r.htmlLink ?? null };
    },
  },
  {
    nome: "google_agenda.apagar_evento",
    integracao: "google_agenda",
    // Título e início vão no pedido para a pessoa saber O QUE aprova (um id não diz nada) e são
    // conferidos com o Google antes de apagar: se não baterem, nada é apagado.
    esquema: {
      type: "object",
      properties: {
        id: { type: "string", maxLength: 1024, description: "Id do compromisso (de listar_eventos)" },
        titulo: { type: "string", maxLength: LIMITES.titulo, description: "Título do compromisso, exatamente como listar_eventos devolveu" },
        inicio: { type: "string", maxLength: 64, description: "Início do compromisso, exatamente como listar_eventos devolveu" },
      },
      required: ["id", "titulo", "inicio"],
      additionalProperties: false,
    },
    async executar(a, token, http) {
      if (!/^[A-Za-z0-9_-]+$/.test(a.id as string)) erro("id de compromisso inválido");
      const url = `${API.agenda}/${encodeURIComponent(a.id as string)}`;
      const e = (await chamar(http, url, token)) as Record<string, any>;
      const inicio = e?.start?.dateTime ?? e?.start?.date ?? null;
      const mesmoInicio = typeof inicio === "string" && (inicio === a.inicio || (e.start?.dateTime && Date.parse(inicio) === Date.parse(a.inicio as string)));
      if (e?.status === "cancelled" || curto(e?.summary, LIMITES.titulo) !== a.titulo || !mesmoInicio) erro("o compromisso não é o que foi aprovado: nada foi apagado");
      await chamar(http, `${url}?sendUpdates=none`, token, { method: "DELETE" });
      return { apagado: true };
    },
  },
  {
    nome: "google_gmail.buscar_mensagens",
    integracao: "google_gmail",
    esquema: {
      type: "object",
      properties: {
        busca: { type: "string", maxLength: 300, description: "Busca do Gmail (ex.: from:fornecedor@exemplo.org newer_than:7d)" },
        quantas: { type: "integer", description: `Quantas mensagens (até ${LIMITES.mensagens})` },
      },
      required: ["busca"],
      additionalProperties: false,
    },
    async executar(a, token, http) {
      const n = Math.min((a.quantas as number | undefined) ?? 5, LIMITES.mensagens);
      const lista = (await chamar(http, `${API.gmail}?${new URLSearchParams({ q: a.busca as string, maxResults: String(n) })}`, token)) as { messages?: { id: string }[] };
      const mensagens = [];
      for (const { id } of (lista.messages ?? []).slice(0, n)) {
        if (!/^[A-Za-z0-9]+$/.test(id)) continue;
        const m = (await chamar(http, `${API.gmail}/${id}?format=full`, token)) as { payload?: any; snippet?: string };
        const cab = (k: string) => (m.payload?.headers ?? []).find((h: { name: string }) => h.name.toLowerCase() === k)?.value ?? "";
        mensagens.push({ id, de: curto(cab("from"), 200), para: curto(cab("to"), 300), assunto: curto(cab("subject"), 200), data: cab("date"), texto: curto(textoDoCorpo(m.payload) || m.snippet || "", LIMITES.corpoMensagem) });
      }
      return { mensagens };
    },
  },
  {
    nome: "google_gmail.enviar_mensagem",
    integracao: "google_gmail",
    esquema: {
      type: "object",
      properties: {
        para: { type: "string", format: "email", maxLength: 254, description: "Um destinatário" },
        assunto: { type: "string", maxLength: LIMITES.titulo, description: "Assunto" },
        texto: { type: "string", maxLength: 10_000, description: "Corpo da mensagem, em texto" },
        identificacao: { type: "string", maxLength: 200, description: "A assinatura que a pessoa configurou (obrigatória; vai no fim do texto)" },
      },
      required: ["para", "assunto", "texto", "identificacao"],
      additionalProperties: false,
    },
    async executar(a, token, http) {
      const mime = [
        `To: ${umaLinha(a.para as string)}`,
        `Subject: ${assuntoMime(umaLinha(a.assunto as string))}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from(`${a.texto as string}\n\n-- \n${umaLinha(a.identificacao as string)}\n`, "utf8").toString("base64"),
      ].join("\r\n");
      const r = (await chamar(http, `${API.gmail}/send`, token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ raw: b64u(mime) }) })) as Record<string, unknown>;
      return { enviado: true, id: r.id };
    },
  },
  {
    nome: "google_drive.listar_arquivos",
    integracao: "google_drive",
    esquema: { type: "object", properties: {}, required: [], additionalProperties: false },
    async executar(_a, token, http) {
      // Com drive.file, o Google só mostra o que este app criou ou abriu: nada do resto do Drive.
      const q = new URLSearchParams({ q: "trashed = false", pageSize: String(LIMITES.arquivos), fields: "files(id,name,mimeType,modifiedTime,webViewLink)", orderBy: "modifiedTime desc" });
      const r = (await chamar(http, `${API.drive}?${q}`, token)) as { files?: Record<string, string>[] };
      return { arquivos: (r.files ?? []).map((f) => ({ id: f.id, nome: curto(f.name, 200), tipo: f.mimeType, alterado: f.modifiedTime, link: f.webViewLink ?? null })) };
    },
  },
  {
    nome: "google_drive.criar_documento",
    integracao: "google_drive",
    esquema: {
      type: "object",
      properties: {
        nome: { type: "string", maxLength: LIMITES.titulo, description: "Nome do documento" },
        texto: { type: "string", maxLength: LIMITES.texto, description: "Conteúdo, em texto" },
      },
      required: ["nome", "texto"],
      additionalProperties: false,
    },
    async executar(a, token, http) {
      const fronteira = `obedient-${Date.now().toString(36)}`;
      const corpo = [
        `--${fronteira}`,
        "Content-Type: application/json; charset=UTF-8",
        "",
        JSON.stringify({ name: umaLinha(a.nome as string), mimeType: "application/vnd.google-apps.document" }),
        `--${fronteira}`,
        "Content-Type: text/plain; charset=UTF-8",
        "",
        a.texto as string,
        `--${fronteira}--`,
      ].join("\r\n");
      const r = (await chamar(http, `${API.driveUpload}?uploadType=multipart&fields=id,webViewLink`, token, { method: "POST", headers: { "content-type": `multipart/related; boundary=${fronteira}` }, body: corpo })) as Record<string, unknown>;
      return { criado: true, id: r.id, link: r.webViewLink ?? null };
    },
  },
];

/** O texto de uma mensagem do Gmail: a primeira parte text/plain (base64url). */
function textoDoCorpo(p: any, profundidade = 0): string {
  if (!p || profundidade > 5) return "";
  if (p.mimeType === "text/plain" && typeof p.body?.data === "string") return Buffer.from(p.body.data, "base64url").toString("utf8");
  for (const parte of p.parts ?? []) {
    const t = textoDoCorpo(parte, profundidade + 1);
    if (t) return t;
  }
  return "";
}

// Toda ferramenta declarada no catálogo tem implementação, e nenhuma implementação fica sem declaração.
{
  const declaradas = INTEGRACOES.flatMap((i) => i.ferramentas.map((f) => f.name)).sort();
  const implementadas = FERRAMENTAS.map((f) => f.nome).sort();
  if (JSON.stringify(declaradas) !== JSON.stringify(implementadas)) throw new Error(`catálogo e ferramentas divergem: ${declaradas} × ${implementadas}`);
}

export function ferramenta(nome: string): DefinicaoDeFerramenta {
  const f = FERRAMENTAS.find((x) => x.nome === nome);
  if (!f) throw new ObedientError("INVALID_PAYLOAD", `ferramenta desconhecida: ${nome}`);
  return f;
}

/**
 * Roda uma ferramenta para a pessoa. É o executor que o servidor entrega ao Ethics Engine: só é
 * chamado DEPOIS de a ação ser autorizada (ou aprovada). Argumento fora do esquema é recusado
 * antes da rede.
 */
export async function executar(nome: string, args: Record<string, unknown>, obterToken: ObterToken, http: Fetch = fetch): Promise<unknown> {
  const f = ferramenta(nome);
  const a = validarArgs(f.esquema, args);
  return f.executar(a, await obterToken(f.integracao), http);
}

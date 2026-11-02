// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Proveniência: extraído de casa-de-ia/src/mcp-gateway/seguranca.ts (commit 45ba448), do mesmo autor,
// pela decisão D7 (opção A). Nomes mantidos em português de propósito: o Growth OS passa a
// consumir este pacote trocando só o caminho do import. Ver docs/architecture/extracao-growth-os.md.
//
// Ficou de fora: validarAuthConfig e o dono do segredo por organização (MCP_SEGREDOS), que são do
// deploy multiempresa do Growth OS. O OBEDIENT guarda credencial de integração de outro jeito (Fase 7).

import { createHash } from "node:crypto";
import { ErroGateway } from "./tipos.ts";

// Faixas IPv4 que nunca são um servidor MCP de fora: privadas, loopback, link-local (metadados de
// nuvem), CGNAT, benchmark, documentação, multicast e reservadas (RFC 6890).
const FAIXAS_V4_RESERVADAS: readonly [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

function ipv4(s: string): number | null {
  const p = s.split(".");
  if (p.length !== 4 || !p.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255)) return null;
  return p.reduce((n, x) => n * 256 + Number(x), 0);
}

function v4Reservado(n: number): boolean {
  return FAIXAS_V4_RESERVADAS.some(([base, bits]) => {
    const b = ipv4(base)!;
    const tam = 2 ** (32 - bits);
    return n >= b && n < b + tam;
  });
}

/**
 * Host local, privado ou reservado. O URL do WHATWG já normaliza o IPv4 (decimal, hexa, octal viram
 * pontilhado) e comprime o IPv6 (::ffff:169.254.169.254 vira [::ffff:a9fe:a9fe]); aqui se trata a forma
 * normalizada, inclusive o IPv4 embutido em IPv6.
 */
export function hostLocalOuPrivado(hostBruto: string): boolean {
  const host = hostBruto.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const n4 = ipv4(host);
  if (n4 !== null) return v4Reservado(n4);
  if (!host.startsWith("[")) return false;
  const h6 = host.slice(1, -1);
  // ::, ::1, IPv4 mapeado (::ffff:x) ou compatível (::x): tudo que começa com "::" fica fora.
  if (h6.startsWith("::")) return true;
  // ULA fc00::/7, link-local fe80::/10, multicast ff00::/8, documentação 2001:db8::/32,
  // 6to4 2002::/16 e NAT64 64:ff9b::/96 (os dois últimos embutem um IPv4 qualquer).
  return /^(f[cd][0-9a-f]{0,2}|fe[89ab][0-9a-f]?|ff[0-9a-f]{0,2}):/.test(h6) || /^2001:0?db8:/.test(h6) || /^2002:/.test(h6) || /^64:ff9b:/.test(h6);
}

/**
 * Endpoint aceito: https para fora. http e host local/privado só com permitirLocal
 * (desenvolvimento e testes). Não cobre DNS que resolve para IP privado (rebinding).
 */
export function validarEndpoint(bruto: string, opts: { permitirLocal: boolean }): string {
  let u: URL;
  try { u = new URL(bruto); } catch { throw new ErroGateway("endpoint_invalido", "endpoint não é URL"); }
  if (u.username || u.password) throw new ErroGateway("endpoint_invalido", "endpoint não pode levar credencial na URL");
  const host = u.hostname.toLowerCase();
  const local = hostLocalOuPrivado(host);
  if (local && !opts.permitirLocal) throw new ErroGateway("endpoint_invalido", `host ${host} é local ou privado`);
  if (u.protocol === "http:" && !(local && opts.permitirLocal)) throw new ErroGateway("endpoint_invalido", "endpoint externo precisa de https");
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new ErroGateway("endpoint_invalido", "protocolo não suportado");
  return u.toString();
}


/**
 * JSON com chaves ordenadas: o mesmo argumento dá o mesmo hash, em qualquer ordem. `undefined` vira `null`.
 * Há outra cópia em `criativos/tipos.ts` com regra diferente para `undefined`, cujos hashes estão gravados no
 * banco: não unificar sem migração (veja o comentário de lá e `src/criativos/jsonEstavel.test.ts`).
 */
export function jsonEstavel(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(jsonEstavel).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${jsonEstavel(o[k])}`).join(",")}}`;
}

export function hashArgumentos(args: unknown): string {
  return createHash("sha256").update(jsonEstavel(args ?? {})).digest("hex");
}

const CHAVE_SENSIVEL = /(token|secret|segredo|senha|password|authorization|api_?key|cpf|telefone|phone|celular|whatsapp|e_?mail)/i;
const MAX_GRAVADO = 8000;

/** Cópia para log e aprovação, sem segredo nem dado pessoal sob chave conhecida. */
export function redigir(v: unknown, profundidade = 0): unknown {
  if (profundidade > 8) return "[profundo demais]";
  if (Array.isArray(v)) return v.slice(0, 100).map((x) => redigir(x, profundidade + 1));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, CHAVE_SENSIVEL.test(k) ? "[redigido]" : redigir(x, profundidade + 1)]));
  }
  return v;
}

const CHAVE_SEGREDO = /(token|secret|segredo|senha|password|authorization|api_?key|cpf)/i;
const CHAVE_CONTATO = /(telefone|phone|celular|whatsapp|e_?mail)/i;

/** "+55 (21) 98765-1234" -> "55219****1234": DDI/DDD e os 4 últimos, o bastante para conferir o destino. */
function mascararTelefone(s: string): string {
  const d = s.replace(/\D/g, "");
  return d.length >= 8 ? `${d.slice(0, d.length - 8)}****${d.slice(-4)}` : "[redigido]";
}

/** "joana.silva@empresa.com.br" -> "j***@empresa.com.br". */
function mascararEmail(s: string): string {
  const m = /^([^@\s])[^@\s]*@([^@\s]+\.[^@\s]+)$/.exec(s.trim());
  return m ? `${m[1]}***@${m[2]}` : "[redigido]";
}

function mascararContato(chave: string, x: unknown, profundidade: number): unknown {
  if (Array.isArray(x)) return x.slice(0, 100).map((y) => mascararContato(chave, y, profundidade + 1));
  if (typeof x === "number") x = String(x);
  if (typeof x !== "string") return "[redigido]";
  return /e_?mail/i.test(chave) ? mascararEmail(x) : mascararTelefone(x);
}

/**
 * Cópia para quem APROVA: segredo e CPF redigidos como no log, mas telefone e e-mail mascarados só em
 * parte. Com tudo "[redigido]", a pessoa aprovava sem ver o destinatário de uma mensagem, e uma troca de
 * destino por injeção passava pelo carimbo. O log de chamadas segue com redigir().
 */
export function paraAprovacao(v: unknown, profundidade = 0): unknown {
  if (profundidade > 8) return "[profundo demais]";
  if (Array.isArray(v)) return v.slice(0, 100).map((x) => paraAprovacao(x, profundidade + 1));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k,
      CHAVE_SEGREDO.test(k) ? "[redigido]" : CHAVE_CONTATO.test(k) ? mascararContato(k, x, profundidade + 1) : paraAprovacao(x, profundidade + 1)]));
  }
  return v;
}

/** Limita o que vai para o banco (resultado, argumentos). */
export function paraGravar(v: unknown): unknown {
  if (v === undefined) return null;
  let texto: string;
  try { texto = JSON.stringify(v); } catch { return { nao_serializavel: true }; }
  if (texto === undefined) return null;
  return texto.length > MAX_GRAVADO ? { truncado: true, tamanho: texto.length, inicio: texto.slice(0, 2000) } : v;
}

/** Remove o segredo de qualquer texto de erro antes de gravar ou devolver. */
export function semSegredo(texto: string, segredo: string | null): string {
  return segredo ? texto.split(segredo).join("[redigido]") : texto;
}

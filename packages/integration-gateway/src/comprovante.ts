// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Comprovante de aprovação: o que o Gateway leva ao servidor MCP de destino junto com uma chamada que
// uma pessoa aprovou (auditoria A2A de 06/11/2026, achado R6).
//
// Antes, a aprovação morava só no Gateway. Quem tivesse o Bearer do servidor MCP chamava a ferramenta
// crítica direto, sem pessoa nenhuma no meio. Com o comprovante, o destino também confere:
//
//   · Ed25519: o Gateway assina com a chave PRIVADA; o destino só tem a PÚBLICA. Nem quem tem o Bearer
//     nem o próprio servidor de destino consegue fabricar um comprovante.
//   · A assinatura cobre a ferramenta, o hash dos argumentos (o mesmo hashArgumentos com que o Gateway
//     amarra a aprovação), o id da aprovação e o vencimento. Mudar qualquer um invalida.
//   · Vale por pouco tempo (padrão 5 min). O replay dentro do prazo esbarra no uso único do destino:
//     no Mobile Control Engine, a proposta executa uma vez só.
//
// Viaja em `_meta` da chamada tools/call, no campo CAMPO_COMPROVANTE.

import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { hashArgumentos } from "./seguranca.ts";

export const CAMPO_COMPROVANTE = "obedient/aprovacao";
export const VERSAO_COMPROVANTE = 1;
export const VALIDADE_PADRAO_MS = 5 * 60_000;
const VALIDADE_MAXIMA_MS = 15 * 60_000;
const UUIDISH = /^[A-Za-z0-9-]{8,64}$/;

export interface ComprovanteAprovacao {
  v: 1;
  approval_id: string;
  ferramenta: string;
  args_hash: string;
  /** Vencimento em milissegundos desde a época. */
  exp: number;
  /** Assinatura Ed25519 em base64url. */
  assinatura: string;
}

function mensagem(c: Omit<ComprovanteAprovacao, "assinatura">): Buffer {
  return Buffer.from(`obedient-aprovacao-v${c.v}\n${c.ferramenta}\n${c.args_hash}\n${c.approval_id}\n${c.exp}`, "utf8");
}

/** Aceita a chave em PEM ou em DER base64 (o formato mais prático numa variável de ambiente). */
function chave(texto: string, tipo: "privada" | "publica"): KeyObject {
  const t = texto.trim();
  const k = t.startsWith("-----BEGIN")
    ? (tipo === "privada" ? createPrivateKey(t) : createPublicKey(t))
    : tipo === "privada"
      ? createPrivateKey({ key: Buffer.from(t, "base64"), format: "der", type: "pkcs8" })
      : createPublicKey({ key: Buffer.from(t, "base64"), format: "der", type: "spki" });
  if (k.asymmetricKeyType !== "ed25519") throw new Error("A chave de aprovação tem de ser Ed25519.");
  return k;
}

export interface Assinar {
  chavePrivada: string;
  ferramenta: string;
  argumentos: unknown;
  approvalId: string;
  agora?: number;
  validadeMs?: number;
}

export function assinarComprovante(p: Assinar): ComprovanteAprovacao {
  if (!UUIDISH.test(p.approvalId)) throw new Error("approval_id inválido para o comprovante.");
  const validade = Math.min(Math.max(p.validadeMs ?? VALIDADE_PADRAO_MS, 1_000), VALIDADE_MAXIMA_MS);
  const base = { v: 1 as const, approval_id: p.approvalId, ferramenta: p.ferramenta, args_hash: hashArgumentos(p.argumentos), exp: (p.agora ?? Date.now()) + validade };
  const assinatura = sign(null, mensagem(base), chave(p.chavePrivada, "privada")).toString("base64url");
  return { ...base, assinatura };
}

export type MotivoRecusa = "ausente" | "formato" | "ferramenta" | "argumentos" | "vencido" | "assinatura" | "chave";

export interface Verificar {
  chavePublica: string;
  ferramenta: string;
  argumentos: unknown;
  /** O que veio em `_meta[CAMPO_COMPROVANTE]`, sem confiar no formato. */
  comprovante: unknown;
  agora?: number;
}

/** Confere o comprovante. Falha fechada: qualquer dúvida é recusa, com o motivo. */
export function verificarComprovante(p: Verificar): { ok: true; approvalId: string } | { ok: false; motivo: MotivoRecusa } {
  const c = p.comprovante as Partial<ComprovanteAprovacao> | null | undefined;
  if (c == null) return { ok: false, motivo: "ausente" };
  if (typeof c !== "object" || c.v !== VERSAO_COMPROVANTE || typeof c.approval_id !== "string" || !UUIDISH.test(c.approval_id)
    || typeof c.ferramenta !== "string" || typeof c.args_hash !== "string" || !/^[0-9a-f]{64}$/.test(c.args_hash)
    || typeof c.exp !== "number" || !Number.isFinite(c.exp) || typeof c.assinatura !== "string" || c.assinatura.length > 200) {
    return { ok: false, motivo: "formato" };
  }
  if (c.ferramenta !== p.ferramenta) return { ok: false, motivo: "ferramenta" };
  if (c.args_hash !== hashArgumentos(p.argumentos)) return { ok: false, motivo: "argumentos" };
  const agora = p.agora ?? Date.now();
  if (c.exp <= agora || c.exp > agora + VALIDADE_MAXIMA_MS) return { ok: false, motivo: "vencido" };
  let pub: KeyObject;
  try {
    pub = chave(p.chavePublica, "publica");
  } catch {
    return { ok: false, motivo: "chave" };
  }
  const base = { v: 1 as const, approval_id: c.approval_id, ferramenta: c.ferramenta, args_hash: c.args_hash, exp: c.exp };
  let valido = false;
  try {
    valido = verify(null, mensagem(base), pub, Buffer.from(c.assinatura, "base64url"));
  } catch {
    valido = false;
  }
  return valido ? { ok: true, approvalId: c.approval_id } : { ok: false, motivo: "assinatura" };
}

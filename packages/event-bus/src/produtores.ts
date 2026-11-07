// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Proveniência: extraído de casa-de-ia/src/event-bus/produtores.ts (commit 45ba448), decisão D7.
// Mudou: as fontes válidas e a variável de ambiente entram por parâmetro (lá eram fixas do deploy).
//
// Quem pode publicar pela API, e em nome de qual organização e fonte.
//
// EVENT_BUS_PRODUCERS="v2:<sha256('event-bus\n'+token)>:<org>:<fonte>:<AAAA-MM-DD>,..."
// (R7: prazo e audience, tokens-maquina.ts). O formato antigo "<sha256 do token>:<org>:<fonte>"
// segue aceito até EXIGIR_PRAZO_TOKENS=1. Guarda só o HASH: o token fica com o produtor. A
// organização e a fonte saem daqui, nunca do corpo da requisição.
import { hashLegado, identificarToken, lerEntradas, type EntradaToken, type OpcoesToken } from "./tokens-maquina.ts";

export const AUDIENCIA_EVENT_BUS = "event-bus";

export interface Produtor { orgSlug: string; source: string }

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function lerProdutores(bruto: string | undefined, fontes: readonly string[], o: OpcoesToken = {}): (Produtor & { hash: Buffer; expiraEm: Date | null })[] {
  return lerEntradas<Produtor>(bruto, 2, ([orgSlug, source]) => (orgSlug && SLUG.test(orgSlug) && source && fontes.includes(source) ? { orgSlug, source } : null), o)
    .map((e: EntradaToken<Produtor>) => ({ ...e.campos, hash: e.hash, expiraEm: e.expiraEm }));
}

/** Hash do formato antigo (sem audience). Para gerar entrada nova, use o script do Growth OS. */
export function hashDoToken(token: string): string {
  return hashLegado(token);
}

/** Produtor dono do token do cabeçalho `Authorization: Bearer <token>`, ou null. */
export function identificarProdutor(authorization: string | null, bruto: string | undefined, fontes: readonly string[], o: OpcoesToken = {}): Produtor | null {
  const entradas = lerEntradas<Produtor>(bruto, 2, ([orgSlug, source]) => (orgSlug && SLUG.test(orgSlug) && source && fontes.includes(source) ? { orgSlug, source } : null), o);
  const p = identificarToken(authorization, entradas, AUDIENCIA_EVENT_BUS);
  return p ? { orgSlug: p.orgSlug, source: p.source } : null;
}

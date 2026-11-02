// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Proveniência: extraído de casa-de-ia/src/event-bus/produtores.ts (commit 45ba448), decisão D7.
// Mudou: as fontes válidas e a variável de ambiente entram por parâmetro (lá eram fixas do deploy).
//
// Quem pode publicar pela API, e em nome de qual organização e fonte.
//
// EVENT_BUS_PRODUCERS="<sha256 do token>:<slug da organização>:<fonte>,..."
// Guarda só o HASH: o token em si fica com o produtor. A organização e a fonte saem
// daqui, nunca do corpo da requisição. Mesmo padrão do MCP_AGENT_TOKENS do Motor.
import { createHash, timingSafeEqual } from "node:crypto";

export interface Produtor { orgSlug: string; source: string }

interface Entrada extends Produtor { hash: Buffer }

export function lerProdutores(bruto: string | undefined, fontes: readonly string[]): Entrada[] {
  if (!bruto) return [];
  const saida: Entrada[] = [];
  for (const item of bruto.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [hash, orgSlug, source] = item.split(":");
    // Entrada malformada é ignorada: falha fechada (ninguém entra por ela).
    if (!/^[0-9a-f]{64}$/i.test(hash ?? "") || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(orgSlug ?? "")) continue;
    if (!hash || !orgSlug || !source || !fontes.includes(source)) continue;
    saida.push({ hash: Buffer.from(hash.toLowerCase(), "hex"), orgSlug, source });
  }
  return saida;
}

export function hashDoToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Produtor dono do token do cabeçalho `Authorization: Bearer <token>`, ou null. */
export function identificarProdutor(authorization: string | null, bruto: string | undefined, fontes: readonly string[]): Produtor | null {
  const token = /^Bearer\s+(\S+)$/.exec(authorization ?? "")?.[1];
  if (!token) return null;
  const alvo = Buffer.from(hashDoToken(token), "hex");
  let achado: Produtor | null = null;
  // Compara com todas as entradas, sem sair cedo: o tempo não denuncia qual casou.
  for (const e of lerProdutores(bruto, fontes)) {
    if (timingSafeEqual(e.hash, alvo) && !achado) achado = { orgSlug: e.orgSlug, source: e.source };
  }
  return achado;
}

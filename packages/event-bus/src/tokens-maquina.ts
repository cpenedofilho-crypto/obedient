// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Token de máquina com prazo e audience (auditoria A2A de 06/11/2026, achado R7).
//
// Antes: "<sha256 do token>:<org>[:<fonte>]" numa variável de ambiente, para sempre, e o mesmo token
// servia em qualquer lista que tivesse o hash dele. Agora há o formato v2:
//
//   v2:<sha256(audience + "\n" + token)>:<campos...>:<AAAA-MM-DD>
//
//   · audience: o nome do serviço ("event-bus", "mission-control") entra no hash. O token de um não
//     abre o outro, mesmo que alguém copie o hash para a lista errada;
//   · prazo: a entrada vale até o fim do dia (UTC) da data. Vencida, ou com prazo acima de
//     PRAZO_MAXIMO_DIAS, é ignorada (falha fechada): ninguém cadastra token "para sempre" de novo.
//
// A entrada antiga (sem "v2:") continua aceita para não derrubar quem está em produção, até a
// variável EXIGIR_PRAZO_TOKENS=1 ser ligada depois da troca. Gerar: scripts do Growth OS
// (scripts/gerar-token-maquina.mjs), que mostra o token uma vez e a entrada para a variável.
import { createHash, timingSafeEqual } from "node:crypto";

export const PRAZO_MAXIMO_DIAS = 366;
const DIA = 86_400_000;

export interface OpcoesToken {
  agora?: Date;
  /** Recusa entrada sem prazo (formato antigo). Padrão: EXIGIR_PRAZO_TOKENS=1 no ambiente. */
  exigirPrazo?: boolean;
}

export interface EntradaToken<C> { hash: Buffer; campos: C; expiraEm: Date | null; /** true = hash com audience (formato v2). */ v2: boolean }

export const hashLegado = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");
export const hashComAudiencia = (audiencia: string, token: string) => createHash("sha256").update(`${audiencia}\n${token}`, "utf8").digest("hex");

/** Fim do dia UTC da data AAAA-MM-DD, se for data real e dentro do prazo máximo; senão null. */
export function lerPrazo(s: string | undefined, agora: Date): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? "");
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999));
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
  if (d.getTime() < agora.getTime() || d.getTime() > agora.getTime() + PRAZO_MAXIMO_DIAS * DIA) return null;
  return d;
}

export const exigirPrazoDoAmbiente = () => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.EXIGIR_PRAZO_TOKENS?.trim() === "1";

/**
 * Lê "item,item,...". `campos` recebe as partes entre o hash e o prazo (ou o fim, no formato antigo)
 * e devolve os campos validados, ou null para ignorar a entrada.
 */
export function lerEntradas<C>(bruto: string | undefined, nCampos: number, campos: (partes: string[]) => C | null, o: OpcoesToken = {}): EntradaToken<C>[] {
  if (!bruto) return [];
  const agora = o.agora ?? new Date();
  const exigir = o.exigirPrazo ?? exigirPrazoDoAmbiente();
  const saida: EntradaToken<C>[] = [];
  for (const item of bruto.split(",").map((s) => s.trim()).filter(Boolean)) {
    const partes = item.split(":");
    const v2 = partes[0] === "v2";
    if (v2 ? partes.length !== nCampos + 3 : partes.length !== nCampos + 1) continue;
    const [hash, ...resto] = v2 ? partes.slice(1) : partes;
    if (!/^[0-9a-f]{64}$/i.test(hash ?? "")) continue;
    const c = campos(resto.slice(0, nCampos));
    if (!c) continue;
    let expiraEm: Date | null = null;
    if (v2) {
      expiraEm = lerPrazo(resto[nCampos], agora);
      if (!expiraEm) continue; // vencida, data inválida ou "para sempre"
    } else if (exigir) continue;
    saida.push({ hash: Buffer.from(hash!.toLowerCase(), "hex"), campos: c, expiraEm, v2 });
  }
  return saida;
}

/** Dono do token do `Authorization: Bearer`, comparando com TODAS as entradas (o tempo não denuncia qual casou). */
export function identificarToken<C>(authorization: string | null, entradas: readonly EntradaToken<C>[], audiencia: string): (C & { expiraEm: Date | null }) | null {
  const token = /^Bearer\s+(\S+)$/.exec(authorization ?? "")?.[1];
  if (!token) return null;
  const legado = Buffer.from(hashLegado(token), "hex");
  const comAud = Buffer.from(hashComAudiencia(audiencia, token), "hex");
  let achado: (C & { expiraEm: Date | null }) | null = null;
  for (const e of entradas) {
    const alvo = e.v2 ? comAud : legado;
    if (timingSafeEqual(e.hash, alvo) && !achado) achado = { ...e.campos, expiraEm: e.expiraEm };
  }
  return achado;
}

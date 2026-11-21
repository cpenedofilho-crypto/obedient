// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Mandato da missão e teto mensal (decisão D20, marco M4; tetos da D21; autonomia da D22).
//
// O mandato só ESTREITA o que os grants já permitem, nunca amplia:
//   • ferramentas: a missão só enxerga as ferramentas listadas (nome exato ou prefixo com "*"); as
//     outras nem são oferecidas ao agente. null = as que a pessoa conectou, como antes;
//   • prazoFinalEm: depois dele, a missão não tenta mais e termina como "não conseguiu";
//   • ambientes (M5): só ferramentas dos ambientes listados (produção, homologação, teste). Quem
//     declara o ambiente é a configuração do servidor; o que não declara é produção;
//   • autonomia: nenhuma além da dos grants (D22: só leitura é autônoma). Escrita continua pedindo
//     aprovação (D18). Por isso o mandato não tem campo de autonomia: não há o que ampliar aqui.
// O objetivo nunca é autorização: nada que o modelo diga cria ou amplia o mandato.
//
// Teto mensal (D21): R$ 300 por pessoa por mês, somando o gasto de todas as tentativas do mês (mês do
// Brasil, UTC−3, sem horário de verão desde 2019). Ao passar de 80%, o painel avisa.

export const TETO_MENSAL_CENTAVOS = 30_000;
export const AVISO_MENSAL = 0.8;
export const MAX_FERRAMENTAS_NO_MANDATO = 30;
/** Prazo final no máximo 30 dias à frente. */
export const PRAZO_FINAL_MAXIMO_MS = 30 * 24 * 3_600_000;
const BRASIL_MS = -3 * 3_600_000;

export const AMBIENTES = ["producao", "homologacao", "teste"] as const;
export type Ambiente = (typeof AMBIENTES)[number];

export interface Mandato {
  ferramentas: string[] | null;
  prazoFinalEm: Date | null;
  /** null = todos os ambientes que os grants deixarem. */
  ambientes: Ambiente[] | null;
}

export const MANDATO_LIVRE: Mandato = Object.freeze({ ferramentas: null, prazoFinalEm: null, ambientes: null }) as Mandato;

/** Problemas do mandato pedido (vazio = válido). `agora` para conferir o prazo. */
export function problemasDoMandato(m: unknown, agora: Date): string[] {
  if (m === undefined || m === null) return [];
  if (typeof m !== "object" || Array.isArray(m)) return ["o mandato precisa ser um objeto"];
  const o = m as Record<string, unknown>;
  const saida: string[] = [];
  if (Object.keys(o).some((k) => k !== "ferramentas" && k !== "prazoFinalEm" && k !== "ambientes")) saida.push("mandato: campo não previsto");
  if (o.ambientes !== undefined && o.ambientes !== null) {
    if (!Array.isArray(o.ambientes) || !o.ambientes.length || o.ambientes.some((a) => !AMBIENTES.includes(a as Ambiente)) || new Set(o.ambientes).size !== o.ambientes.length)
      saida.push(`mandato: ambientes é uma lista sem repetição de ${AMBIENTES.join(", ")}`);
  }
  if (o.ferramentas !== undefined && o.ferramentas !== null) {
    if (!Array.isArray(o.ferramentas) || !o.ferramentas.length) saida.push("mandato: ferramentas precisa ser uma lista não vazia (ou ausente)");
    else {
      if (o.ferramentas.length > MAX_FERRAMENTAS_NO_MANDATO) saida.push(`mandato: no máximo ${MAX_FERRAMENTAS_NO_MANDATO} ferramentas`);
      for (const f of o.ferramentas) {
        // Como nos grants (Art. 3º): sem curinga. "*" ou um prefixo curto equivalem a "tudo".
        if (typeof f !== "string" || f.trim().replace(/\*+$/, "").length < 3 || f.length > 200) saida.push("mandato: cada ferramenta é um nome ou prefixo com * de 3 a 200 caracteres");
      }
    }
  }
  if (o.prazoFinalEm !== undefined && o.prazoFinalEm !== null) {
    const d = o.prazoFinalEm instanceof Date ? o.prazoFinalEm : typeof o.prazoFinalEm === "string" ? new Date(o.prazoFinalEm) : null;
    if (!d || Number.isNaN(d.getTime())) saida.push("mandato: prazo final inválido");
    else if (d.getTime() <= agora.getTime()) saida.push("mandato: o prazo final precisa estar no futuro");
    else if (d.getTime() - agora.getTime() > PRAZO_FINAL_MAXIMO_MS) saida.push("mandato: prazo final de no máximo 30 dias");
  }
  return saida;
}

/** Mandato já validado, normalizado. */
export function lerMandato(m: unknown): Mandato {
  if (!m || typeof m !== "object") return { ...MANDATO_LIVRE };
  const o = m as Record<string, unknown>;
  const ferramentas = Array.isArray(o.ferramentas) && o.ferramentas.length ? o.ferramentas.map((f) => String(f).trim()) : null;
  const p = o.prazoFinalEm instanceof Date ? o.prazoFinalEm : typeof o.prazoFinalEm === "string" ? new Date(o.prazoFinalEm) : null;
  const ambientes = Array.isArray(o.ambientes) && o.ambientes.length ? (o.ambientes.filter((a) => AMBIENTES.includes(a as Ambiente)) as Ambiente[]) : null;
  return { ferramentas, prazoFinalEm: p && !Number.isNaN(p.getTime()) ? p : null, ambientes: ambientes?.length ? ambientes : null };
}

/**
 * A ferramenta (pela chave do registro, no ambiente dela) cabe no mandato? Sem lista, cabe tudo que os
 * grants deixarem. Ambiente não declarado é produção.
 */
export function cabeNoMandato(m: Mandato, chave: string, ambiente: Ambiente = "producao"): boolean {
  if (m.ambientes && !m.ambientes.includes(ambiente)) return false;
  if (!m.ferramentas) return true;
  return m.ferramentas.some((f) => (f.endsWith("*") ? chave.startsWith(f.replace(/\*+$/, "")) : chave === f));
}

/** Começo do mês corrente no Brasil (UTC−3), em UTC. */
export function inicioDoMes(agora: Date): Date {
  const local = new Date(agora.getTime() + BRASIL_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - BRASIL_MS);
}

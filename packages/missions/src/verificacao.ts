// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Critérios de conclusão e o verificador (decisão D20, marco M3). Uma missão só termina "feito" quando
// cada critério tem evidência conferida por CÓDIGO, nunca porque o agente disse que terminou.
//
// Critérios, numa lista fechada (o que não está aqui é recusado na criação):
//   • ferramenta_ok: uma ferramenta (nome exato ou prefixo com "*") rodou com sucesso nesta missão,
//     pelo menos `minimo` vezes. Conferido no registro de passos (M1), não no texto do agente;
//   • resultado_conforme: o `resultado` que o agente entrega ao concluir segue um esquema (o subconjunto
//     de JSON Schema do mission-engine). Guarda-se o hash do resultado, nunca o resultado.
//
// Sem critério, a missão ainda passa por verifying, e a evidência diz isso: "nenhum critério definido;
// conferido só o registro de passos". Nada é apresentado como verificado sem ter sido.
//
// Este verificador é só determinístico. Uma revisão por outro modelo (que dobraria o custo de cada
// missão) não faz parte do M3 e depende de decisão.

import { payloadHash } from "@obedient/core";
import { conferirValor, problemasDoEsquema } from "@obedient/mission-engine";

export const MAX_CRITERIOS = 10;
/** Voltas de correção depois de uma verificação que não confere; a seguinte para a missão. */
export const MAX_VOLTAS_VERIFICACAO = 2;
const MAX_TAMANHO_CRITERIOS = 20_000;

export type Criterio =
  | { tipo: "ferramenta_ok"; ferramenta: string; minimo?: number }
  | { tipo: "resultado_conforme"; esquema: Record<string, unknown> };

// plano_completo (M5): todas as tarefas do plano aprovado foram feitas, conferido pelo que está gravado.
export const TIPOS_EVIDENCIA = ["ferramenta_ok", "resultado_conforme", "sem_criterio", "nao_sei", "plano_completo"] as const;
export type TipoEvidencia = (typeof TIPOS_EVIDENCIA)[number];

export interface Evidencia {
  /** Índice do critério (null para sem_criterio, nao_sei e plano_completo). */
  criterio: number | null;
  tipo: TipoEvidencia;
  ok: boolean;
  /** Onde está a prova: passos ("1:3, 2:4") ou o hash do resultado. Nunca conteúdo. */
  referencia: string | null;
  /** Frase curta para a pessoa, sem dado de terceiros. */
  detalhe: string;
}

/** O que o verificador precisa de um passo (do registro de passos do M1). */
export interface PassoVerificavel {
  tentativa: number;
  seq: number;
  tipo: string;
  status: string;
  ferramenta: string | null;
}

const ehObjeto = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Problemas da lista de critérios (vazio = válida). */
export function problemasDosCriterios(c: unknown): string[] {
  if (c === undefined) return [];
  if (!Array.isArray(c)) return ["critérios precisam ser uma lista"];
  const saida: string[] = [];
  if (c.length > MAX_CRITERIOS) saida.push(`no máximo ${MAX_CRITERIOS} critérios`);
  if (JSON.stringify(c).length > MAX_TAMANHO_CRITERIOS) saida.push("critérios grandes demais");
  c.forEach((x, i) => {
    if (!ehObjeto(x)) return void saida.push(`critério ${i + 1}: precisa ser objeto`);
    if (x.tipo === "ferramenta_ok") {
      const f = typeof x.ferramenta === "string" ? x.ferramenta.trim() : "";
      if (f.replace(/\*+$/, "").length < 3 || f.length > 200) saida.push(`critério ${i + 1}: nome de ferramenta (ou prefixo com *) de 3 a 200 caracteres`);
      if (x.minimo !== undefined && (!Number.isInteger(x.minimo) || (x.minimo as number) < 1 || (x.minimo as number) > 50)) saida.push(`critério ${i + 1}: minimo de 1 a 50`);
      if (Object.keys(x).some((k) => !["tipo", "ferramenta", "minimo"].includes(k))) saida.push(`critério ${i + 1}: campo não previsto`);
    } else if (x.tipo === "resultado_conforme") {
      for (const p of problemasDoEsquema(x.esquema)) saida.push(`critério ${i + 1}: ${p}`);
      if (Object.keys(x).some((k) => !["tipo", "esquema"].includes(k))) saida.push(`critério ${i + 1}: campo não previsto`);
    } else saida.push(`critério ${i + 1}: tipo precisa ser ferramenta_ok ou resultado_conforme`);
  });
  return saida;
}

const casa = (padrao: string, ferramenta: string) => (padrao.endsWith("*") ? ferramenta.startsWith(padrao.replace(/\*+$/, "")) : ferramenta === padrao);

/** Passos que provam uma chamada concluída com sucesso (o fim da chamada, não o início). */
const sucessos = (passos: readonly PassoVerificavel[]) => passos.filter((p) => (p.tipo === "ferramenta" || p.tipo === "retomada") && p.status === "succeeded" && p.ferramenta);

/**
 * Confere os critérios contra o registro de passos e o resultado entregue. `ok` só quando TODOS conferem.
 * Sem critério: ok, com uma evidência sem_criterio que diz o que foi (e o que não foi) conferido.
 */
export function verificar(criterios: readonly Criterio[], passos: readonly PassoVerificavel[], resultado: unknown): { ok: boolean; evidencias: Evidencia[] } {
  const ok = sucessos(passos);
  if (!criterios.length) {
    return {
      ok: true,
      evidencias: [{
        criterio: null,
        tipo: "sem_criterio",
        ok: true,
        referencia: ok.length ? ok.slice(0, 20).map((p) => `${p.tentativa}:${p.seq}`).join(", ") : null,
        detalhe: `Nenhum critério definido: conferido só o registro de passos (${ok.length} chamada(s) com sucesso).`,
      }],
    };
  }
  const evidencias = criterios.map((c, i): Evidencia => {
    if (c.tipo === "ferramenta_ok") {
      const minimo = c.minimo ?? 1;
      const achados = ok.filter((p) => casa(c.ferramenta, p.ferramenta!));
      return {
        criterio: i,
        tipo: "ferramenta_ok",
        ok: achados.length >= minimo,
        referencia: achados.length ? achados.slice(0, 20).map((p) => `${p.tentativa}:${p.seq}`).join(", ") : null,
        detalhe: achados.length >= minimo
          ? `${c.ferramenta} rodou com sucesso ${achados.length} vez(es).`
          : `${c.ferramenta} rodou com sucesso ${achados.length} vez(es); o critério pede pelo menos ${minimo}.`,
      };
    }
    const problemas = resultado === undefined ? ["$: o agente não entregou resultado"] : conferirValor(c.esquema, resultado);
    return {
      criterio: i,
      tipo: "resultado_conforme",
      ok: problemas.length === 0,
      referencia: resultado === undefined ? null : `sha256:${payloadHash(resultado)}`,
      detalhe: problemas.length ? `O resultado não segue o esquema: ${problemas.slice(0, 3).join("; ")}.` : "O resultado segue o esquema.",
    };
  });
  return { ok: evidencias.every((e) => e.ok), evidencias };
}

/** Texto do impedimento quando a verificação não confere depois das voltas de correção. */
export function textoNaoVerificada(evidencias: readonly Evidencia[]): string {
  const falhas = evidencias.filter((e) => !e.ok).map((e) => e.detalhe);
  return `O agente disse que terminou, mas a verificação não confere: ${falhas.join(" ")} Confira o que foi feito antes de mandar tentar de novo ou cancelar.`.slice(0, 500);
}

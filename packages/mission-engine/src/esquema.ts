// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Proveniência: extraído de casa-de-ia/src/equipes/esquema.ts (commit 45ba448), decisão D7, etapa 4.
// Nomes mantidos em português para o Growth OS trocar só o import.
//
// Esquema de entrada e saída do contrato de agente: um SUBCONJUNTO pequeno de JSON Schema,
// conferido aqui mesmo, sem dependência nova. Palavra-chave fora do subconjunto é recusada ao
// definir o contrato: um esquema que o conferidor ignorasse em silêncio daria falsa garantia.
//
// Suportado: type (object, array, string, number, integer, boolean), properties, required,
// additionalProperties: false, items, enum, maxLength, maxItems, description.

const TIPOS = ["object", "array", "string", "number", "integer", "boolean"] as const;
const CHAVES = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "maxLength", "maxItems", "description"]);
const MAX_PROFUNDIDADE = 8;

type Esquema = Record<string, unknown>;
const ehObjeto = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Problemas do próprio esquema (vazio = válido). A raiz precisa ser type: "object". */
export function problemasDoEsquema(e: unknown): string[] {
  if (!ehObjeto(e) || e.type !== "object") return ["a raiz do esquema precisa ser { type: \"object\" }"];
  const saida: string[] = [];
  andar(e, "$", 0, saida);
  return saida;
}

function andar(e: unknown, caminho: string, prof: number, saida: string[]): void {
  if (prof > MAX_PROFUNDIDADE) { saida.push(`${caminho}: profundo demais`); return; }
  if (!ehObjeto(e)) { saida.push(`${caminho}: esquema precisa ser objeto`); return; }
  for (const k of Object.keys(e)) if (!CHAVES.has(k)) saida.push(`${caminho}: palavra-chave "${k}" fora do subconjunto suportado`);
  if (!(TIPOS as readonly unknown[]).includes(e.type)) saida.push(`${caminho}: type deve ser ${TIPOS.join(", ")}`);
  if (e.properties !== undefined) {
    if (!ehObjeto(e.properties)) saida.push(`${caminho}.properties: precisa ser objeto`);
    else for (const [k, v] of Object.entries(e.properties)) andar(v, `${caminho}.${k}`, prof + 1, saida);
  }
  if (e.required !== undefined && (!Array.isArray(e.required) || e.required.some((r) => typeof r !== "string"))) saida.push(`${caminho}.required: lista de nomes`);
  if (e.additionalProperties !== undefined && e.additionalProperties !== false) saida.push(`${caminho}.additionalProperties: só false é suportado`);
  if (e.items !== undefined) andar(e.items, `${caminho}[]`, prof + 1, saida);
  if (e.enum !== undefined && (!Array.isArray(e.enum) || !e.enum.length)) saida.push(`${caminho}.enum: lista não vazia`);
  for (const k of ["maxLength", "maxItems"] as const) {
    if (e[k] !== undefined && (!Number.isInteger(e[k]) || (e[k] as number) < 0)) saida.push(`${caminho}.${k}: inteiro >= 0`);
  }
}

/** Onde o valor diverge do esquema (vazio = confere). O esquema já passou por problemasDoEsquema. */
export function conferirValor(esquema: Esquema, valor: unknown, caminho = "$"): string[] {
  const saida: string[] = [];
  const tipo = esquema.type;
  const ok =
    tipo === "object" ? ehObjeto(valor)
    : tipo === "array" ? Array.isArray(valor)
    : tipo === "integer" ? Number.isInteger(valor)
    : tipo === "number" ? typeof valor === "number" && Number.isFinite(valor)
    : typeof valor === tipo;
  if (!ok) return [`${caminho}: esperado ${String(tipo)}`];
  if (Array.isArray(esquema.enum) && !esquema.enum.some((x) => JSON.stringify(x) === JSON.stringify(valor))) saida.push(`${caminho}: fora dos valores permitidos`);
  if (typeof valor === "string" && typeof esquema.maxLength === "number" && valor.length > esquema.maxLength) saida.push(`${caminho}: mais de ${esquema.maxLength} caracteres`);
  if (Array.isArray(valor)) {
    if (typeof esquema.maxItems === "number" && valor.length > esquema.maxItems) saida.push(`${caminho}: mais de ${esquema.maxItems} itens`);
    if (ehObjeto(esquema.items)) valor.forEach((v, i) => saida.push(...conferirValor(esquema.items as Esquema, v, `${caminho}[${i}]`)));
  }
  if (ehObjeto(valor)) {
    const props = ehObjeto(esquema.properties) ? esquema.properties : {};
    for (const r of (esquema.required as string[] | undefined) ?? []) if (!(r in valor)) saida.push(`${caminho}.${r}: obrigatório`);
    for (const [k, v] of Object.entries(valor)) {
      if (ehObjeto(props[k])) saida.push(...conferirValor(props[k] as Esquema, v, `${caminho}.${k}`));
      else if (esquema.additionalProperties === false) saida.push(`${caminho}.${k}: campo não previsto`);
    }
  }
  return saida;
}

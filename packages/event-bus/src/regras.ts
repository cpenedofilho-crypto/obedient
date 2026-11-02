// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Proveniência: extraído de casa-de-ia/src/event-bus/regras.ts (commit 45ba448), decisão D7, etapa 3.
// Mudou só o que prendia ao Growth OS: validarEvento recebe o vocabulário como parâmetro, e as
// entidades que só aceitam id interno vêm dele (lá eram "organization" e "business_unit" fixas).
//
// Regras puras do barramento: formato de tipo e de filtro, casamento, espera entre
// tentativas e validação de evento. O casamento espelha public.event_bus_casa (SQL);
// o teste do harness confere que os dois concordam.
import { ErroBarramento, type NovoEvento } from "./tipos.ts";
import type { Vocabulario } from "./vocabulario.ts";

/** lead.no_response, payment_received, company.diagnostic.completed. */
export const REGEX_TIPO = /^[a-z]+(_[a-z]+)*(\.[a-z]+(_[a-z]+)*)*$/;
/** '*', tipo exato ou prefixo terminado em '.*'. */
export const REGEX_PADRAO = /^(\*|[a-z]+(_[a-z]+)*(\.[a-z]+(_[a-z]+)*)*(\.\*)?)$/;
export const REGEX_CONSUMIDOR = /^[a-z0-9]+([-_.][a-z0-9]+)*$/;
const REGEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function casa(padroes: readonly string[], tipo: string): boolean {
  return padroes.some((p) => p === "*" || p === tipo || (p.endsWith(".*") && tipo.startsWith(p.slice(0, -1))));
}

/** Espera antes da próxima tentativa: base × 2^(tentativa-1), no máximo 6 horas. */
export const ESPERA_MAXIMA_S = 6 * 3600;
export function esperaAntesDaProxima(tentativa: number, baseSegundos: number): number {
  return Math.min(baseSegundos * 2 ** Math.max(0, tentativa - 1), ESPERA_MAXIMA_S);
}

export const TAMANHO_MAXIMO_PAYLOAD = 32 * 1024;

/**
 * Chaves que denunciam dado pessoal. O barramento não guarda telefone, e-mail, CPF nem
 * nome (o dado pessoal fica no sistema dono dele); ele recusa em vez de
 * confiar que a origem limpou. É uma rede, não uma prova: valor pessoal sob chave
 * neutra passa.
 */
const CHAVES_PESSOAIS = new Set(["telefone", "phone", "celular", "whatsapp", "email", "e_mail", "cpf", "rg", "nome", "name", "endereco", "address"]);

export function chavePessoal(valor: unknown, caminho = ""): string | null {
  if (Array.isArray(valor)) {
    for (let i = 0; i < valor.length; i++) {
      const achou = chavePessoal(valor[i], `${caminho}[${i}]`);
      if (achou) return achou;
    }
    return null;
  }
  if (valor && typeof valor === "object") {
    for (const [k, v] of Object.entries(valor)) {
      const normal = k.toLowerCase().replace(/[^a-z]/g, "_");
      if (CHAVES_PESSOAIS.has(normal)) return caminho ? `${caminho}.${k}` : k;
      const achou = chavePessoal(v, caminho ? `${caminho}.${k}` : k);
      if (achou) return achou;
    }
  }
  return null;
}

/**
 * Valor que tem cara de dado pessoal, sob qualquer chave: e-mail, CPF formatado e
 * telefone (com máscara, ou 10 a 13 dígitos seguidos). Fecha o buraco de `chavePessoal`,
 * que só olha o NOME do campo: `valor_depois: "21999998888"` passava. Dígitos já
 * mascarados pela origem (`***88`) passam. Só olha texto; número não é inspecionado.
 */
const VALOR_PESSOAL: readonly [string, RegExp][] = [
  ["e-mail", /[^\s@]+@[^\s@]+\.[a-z]{2,}/i],
  ["cpf", /(?<!\d)\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)/],
  ["telefone", /(?<![\d-])(?:\+?55[\s-]?)?\(?\d{2}\)?[\s-]?9?\d{4}-\d{4}(?![\d-])/],
  ["telefone", /(?<![\d.-])\+?\d{10,13}(?![\d.-])/],
];

/**
 * Identificador não é contato: UUID e hex longo (hash) saem antes da busca. Sem isto, ~0,8% dos UUIDs
 * aleatórios ("…-e6251096243c") têm 10+ dígitos seguidos e eram lidos como telefone, e o evento que
 * levava o id (agent_run.*, mission.*) era recusado ao acaso.
 */
const IDENTIFICADORES = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[0-9a-f]{32,}\b/gi;

/**
 * Id numérico de plataforma de anúncio sob a própria chave não é telefone. Os ids do Google Ads têm
 * 10 a 12 dígitos (campanha, grupo, anúncio) e caíam na regra de "10 a 13 dígitos seguidos"; os da
 * Meta (15 a 18) já passavam. Só estas chaves, só valor que é inteiro um número: um telefone com
 * máscara, ou um número dentro de texto, continua recusado, e a chave errada (obs, valor_depois) também.
 */
const CHAVES_ID_ANUNCIO = new Set(["anuncio_id", "campanha_id", "conjunto_id"]);
const ID_NUMERICO = /^\d{1,30}$/;

export function valorPessoal(valor: unknown, caminho = ""): string | null {
  if (typeof valor === "string") {
    const texto = valor.replace(IDENTIFICADORES, " ");
    const tipo = VALOR_PESSOAL.find(([, re]) => re.test(texto))?.[0];
    return tipo ? `${caminho || "(raiz)"}: parece ${tipo}` : null;
  }
  if (Array.isArray(valor)) {
    for (let i = 0; i < valor.length; i++) {
      const achou = valorPessoal(valor[i], `${caminho}[${i}]`);
      if (achou) return achou;
    }
    return null;
  }
  if (valor && typeof valor === "object") {
    for (const [k, v] of Object.entries(valor)) {
      if (CHAVES_ID_ANUNCIO.has(k) && typeof v === "string" && ID_NUMERICO.test(v)) continue;
      const achou = valorPessoal(v, caminho ? `${caminho}.${k}` : k);
      if (achou) return achou;
    }
  }
  return null;
}

function recusar(i: number, motivo: string): never {
  throw new ErroBarramento("evento_invalido", `evento ${i}: ${motivo}`);
}

/**
 * Confere o evento antes de abrir transação. Lança ErroBarramento("evento_invalido").
 * Com `fonte`, confere também se essa fonte pode publicar o tipo (vocabulário).
 * O tipo é conferido já normalizado: `lead_created` vale como `lead.created`.
 */
export function validarEvento(e: NovoEvento, vocab: Vocabulario, i = 0, fonte?: string): void {
  if (!REGEX_TIPO.test(e.type)) recusar(i, `tipo "${e.type}" fora do formato (minúsculas, sublinhado, ponto entre partes)`);
  if (!vocab.entidades.includes(e.entityType)) recusar(i, `entity_type "${e.entityType}" não existe no vocabulário`);
  const temInterno = e.entityId != null;
  const temExterno = e.entityExternalId != null;
  if (temInterno === temExterno) recusar(i, "informe exatamente um entre entity_id e entity_external_id");
  if (temInterno) {
    if (!vocab.entidadesInternas.includes(e.entityType)) {
      recusar(i, `entity_type "${e.entityType}" não tem tabela aqui; use entity_external_id`);
    }
    if (!REGEX_UUID.test(e.entityId!)) recusar(i, "entity_id não é um UUID");
  }
  if (temExterno) {
    if (vocab.somenteInternas.includes(e.entityType)) recusar(i, `${e.entityType} só aceita entity_id interno`);
    if (!e.entityExternalId!.trim() || e.entityExternalId!.length > 200) recusar(i, "entity_external_id vazio ou maior que 200");
  }
  if (e.priority != null && (!Number.isInteger(e.priority) || e.priority < 0 || e.priority > 9)) recusar(i, "priority vai de 0 a 9");
  if (e.idempotencyKey != null && (!e.idempotencyKey.trim() || e.idempotencyKey.length > 200)) recusar(i, "idempotency_key vazia ou maior que 200");
  if (e.correlationId != null && (!e.correlationId.trim() || e.correlationId.length > 200)) recusar(i, "correlation_id vazio ou maior que 200");
  if (e.causationId != null && (!e.causationId.trim() || e.causationId.length > 200)) recusar(i, "causation_id vazio ou maior que 200");
  if (e.occurredAt != null && Number.isNaN(e.occurredAt.getTime())) recusar(i, "occurred_at inválido");
  for (const [campo, valor] of [["payload", e.payload], ["metadata", e.metadata]] as const) {
    if (valor == null) continue;
    if (Buffer.byteLength(JSON.stringify(valor), "utf8") > TAMANHO_MAXIMO_PAYLOAD) recusar(i, `${campo} maior que ${TAMANHO_MAXIMO_PAYLOAD} bytes`);
    const pessoal = chavePessoal(valor);
    if (pessoal) recusar(i, `${campo} traz dado pessoal (${pessoal}); o barramento não guarda dado pessoal`);
    // A mensagem cita o caminho e o tipo, nunca o valor: o log de recusa não pode vazar o dado.
    const pareceDado = valorPessoal(valor);
    if (pareceDado) recusar(i, `${campo} traz dado pessoal (${pareceDado}); o barramento não guarda dado pessoal`);
  }
  // Por último, o vocabulário: as recusas de formato acima dizem mais sobre o erro.
  const tipo = vocab.normalizarTipo(e.type);
  const def = vocab.definicaoDoTipo(tipo);
  if (!def) recusar(i, `tipo "${e.type}" não existe no vocabulário de eventos`);
  if (!def.entidades.includes(e.entityType)) {
    recusar(i, `tipo "${tipo}" não se aplica a entity_type "${e.entityType}" (aceita: ${def.entidades.join(", ")})`);
  }
  if (fonte && def.fontes && !def.fontes.includes(fonte)) recusar(i, `a fonte "${fonte}" não pode publicar "${tipo}"`);
}

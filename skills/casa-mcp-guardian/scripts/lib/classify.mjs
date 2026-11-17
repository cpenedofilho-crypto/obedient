// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
// @ts-check
//
// Risk and category of an MCP tool, from its NAME and its boolean annotations. Never from the
// description: that is free text written by the server and is treated as untrusted data.
//
// Provenance: ported from packages/integration-gateway/src/risco.ts and from
// classificarFerramentaMcp() in packages/server/src/mcp-servidores.ts (same author, same license).
// Removed on purpose: the exact tool-name list of one ad platform and verbs that belonged to internal
// products. Generic spend words (budget, spend, boost, bid) still count as FINANCIAL; the user can add
// their own critical patterns with --critical-pattern.
//
// Rules, in short:
//   · annotations are hints from the server; only booleans count, and a hint never LOWERS what the
//     name reveals (delete_x with readOnlyHint stays destructive);
//   · readOnlyHint:false is the server saying it writes: that one counts (raises);
//   · destructive, financial and legal are CRITICAL; external communication is HIGH;
//   · anything that is not a read is never below HIGH;
//   · when in doubt, the risk goes up.

export const RISKS = /** @type {const} */ (["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export const CATEGORIES = /** @type {const} */ (["READ", "WRITE", "COMMUNICATION", "FINANCIAL", "LEGAL", "DESTRUCTIVE"]);
/** @typedef {typeof RISKS[number]} Risk */
/** @typedef {typeof CATEGORIES[number]} Category */

/** @param {Risk} r */
export const riskRank = (r) => RISKS.indexOf(r);

// Spending money on ads or plans: activating, boosting, changing budget or bid.
const SPEND = "budget|orcament|spend|activat|(?:^|_)ativar(?:_|$)|boost|impulsion|(?:^|_)bid(?:_|$)|(?:^|_)lance(?:_|$)";
const CRITICAL_DOMAIN = new RegExp(
  `(delet|remov|apag|exclu|destru|drop|purg|estorn|refund|cancel|revog|revok|pagament|payment|pagar|charge|cobran|boleto|(?:^|_)pix(?:_|$)|transfer|financ|juridic|legal|judicia|protest|contrat|acordo|agreement|${SPEND})`,
);
const EXTERNAL_COMMS = /(enviar|envio|send|notif|mensag|message|email|whatsapp|sms|publicar|publish|post_)/;
// Read verb at the start, with at most one namespace prefix (e.g. crm_list_contacts).
const READ_VERB = /^([a-z0-9]+_)?(get|list|listar|consultar|buscar|obter|ler|read|search|pesquisar|detalhar|resumo|ping|contar|calcular|identificar|sugerir)(_|$)/;
// Write verb at the start: what follows never turns it into a read (update_status, create_list).
const WRITE_VERB = /^(atualizar|update|criar|create|registrar|register|gravar|salvar|save|set|definir|marcar|mark|editar|edit|alterar|change|mudar|adicionar|add|inserir|insert|incluir|enviar|send|post|publicar|publish|agendar|schedule|aplicar|apply|executar|execute|exec|run|iniciar|start|parar|stop|ativar|activate|desativar|deactivate|habilitar|enable|desabilitar|disable|mover|move|copiar|copy|upload|reset|resetar|apagar|delete|remover|remove)_/;
const DESTRUCTIVE = /(delet|remov|apag|exclu|destru|drop|purg|revog|revok|cancel)/;
// Destructive verb as a word anywhere in the name beats the leading read verb (get_and_delete_x).
const DESTRUCTIVE_VERB = /(?:^|_)(delete|deletar|remove|remover|apagar|excluir|destroy|destruir|drop|purge|purgar|revoke|revogar|cancel|cancelar)(?:_|$)/;
const FINANCIAL = new RegExp(`(pagament|payment|pagar|charge|cobran|boleto|(?:^|_)pix(?:_|$)|transfer|financ|estorn|refund|${SPEND})`);
const LEGAL = /(juridic|legal|judicia|protest|contrat|acordo|agreement)/;

/** @param {string} name */
export function normalName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_");
}
/** @param {string} n */
const isRead = (n) => READ_VERB.test(n) && !WRITE_VERB.test(n);
/** @param {string} n */
const isComms = (n) => EXTERNAL_COMMS.test(n) && !isRead(n);

/**
 * Only boolean hints count; anything else from the server is ignored.
 * @param {unknown} a
 * @returns {{ readOnlyHint?: boolean, destructiveHint?: boolean, idempotentHint?: boolean, openWorldHint?: boolean }}
 */
export function hints(a) {
  if (typeof a !== "object" || a === null || Array.isArray(a)) return {};
  const o = /** @type {Record<string, unknown>} */ (a);
  /** @type {Record<string, boolean>} */
  const out = {};
  for (const k of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) if (typeof o[k] === "boolean") out[k] = /** @type {boolean} */ (o[k]);
  return out;
}

/**
 * @param {{ name: string, annotations?: ReturnType<typeof hints> }} f
 * @param {RegExp[]} [extraCritical]
 * @returns {{ risk: Risk, reason: string }}
 */
export function classifyRisk(f, extraCritical = []) {
  const n = normalName(f.name);
  const a = f.annotations ?? {};
  const critical = CRITICAL_DOMAIN.test(n);
  if (a.destructiveHint === true) return { risk: "CRITICAL", reason: "destructiveHint annotation" };
  if (extraCritical.some((r) => r.test(n))) return { risk: "CRITICAL", reason: "matches a critical pattern you configured" };
  if (critical && a.readOnlyHint !== true) return { risk: "CRITICAL", reason: "name suggests a destructive, financial or legal action" };
  if (isComms(n)) return { risk: "HIGH", reason: a.readOnlyHint === true ? "external communication (readOnlyHint does not lower it)" : "external communication" };
  if (a.readOnlyHint === true) return critical ? { risk: "MEDIUM", reason: "readOnlyHint in a financial or legal domain" } : { risk: "LOW", reason: "readOnlyHint annotation" };
  if (isRead(n)) return { risk: "MEDIUM", reason: "name suggests a read, no annotation confirms it" };
  return { risk: "HIGH", reason: "write without annotation: conservative" };
}

/**
 * @param {{ name: string, annotations?: ReturnType<typeof hints> }} f
 * @param {RegExp[]} [extraCritical]
 * @returns {{ category: Category, reason: string }}
 */
export function classifyCategory(f, extraCritical = []) {
  const n = normalName(f.name);
  const a = f.annotations ?? {};
  const read = (a.readOnlyHint === true && !isComms(n)) || isRead(n);
  if (a.destructiveHint === true) return { category: "DESTRUCTIVE", reason: "destructiveHint annotation" };
  if (DESTRUCTIVE_VERB.test(n) || (DESTRUCTIVE.test(n) && !isRead(n))) return { category: "DESTRUCTIVE", reason: "name suggests a destructive action" };
  if (extraCritical.some((r) => r.test(n))) return { category: "FINANCIAL", reason: "matches a critical pattern you configured" };
  if (read) return { category: "READ", reason: a.readOnlyHint === true ? "readOnlyHint annotation" : "name suggests a read" };
  if (FINANCIAL.test(n)) return { category: "FINANCIAL", reason: "name suggests a financial action" };
  if (LEGAL.test(n)) return { category: "LEGAL", reason: "name suggests a legal action" };
  if (EXTERNAL_COMMS.test(n)) return { category: "COMMUNICATION", reason: "name suggests external communication" };
  return { category: "WRITE", reason: "write" };
}

/**
 * The verdict for one advertised tool. `usable: false` when the tool has no object input schema (an
 * agent that follows the MCP spec would not get a well-formed call; OBEDIENT does not offer it).
 * @param {{ name?: unknown, annotations?: unknown, inputSchema?: unknown }} t
 * @param {{ extraCritical?: RegExp[] }} [o]
 * @returns {{ risk: Risk, category: Category, reason: string, usable: boolean, hintContradicts: boolean }}
 */
export function classifyTool(t, o = {}) {
  const extra = o.extraCritical ?? [];
  const name = typeof t.name === "string" ? t.name : "";
  const s = t.inputSchema;
  const usable = !!s && typeof s === "object" && !Array.isArray(s) && /** @type {Record<string, unknown>} */ (s).type === "object";
  const annotations = hints(t.annotations);
  const withHints = classifyRisk({ name, annotations }, extra);
  const byName = classifyRisk({ name }, extra);
  let risk = withHints.risk;
  let reason = withHints.reason;
  let hintContradicts = false;
  // The name reveals a write, a communication or a critical domain: a read hint does not undo it.
  if (riskRank(byName.risk) > riskRank(risk) && riskRank(byName.risk) >= riskRank("HIGH")) {
    risk = byName.risk;
    reason = `${byName.reason} (the server annotation does not lower it)`;
    hintContradicts = annotations.readOnlyHint === true;
  }
  let category = classifyCategory({ name, annotations }, extra).category;
  const categoryByName = classifyCategory({ name }, extra).category;
  if (category === "READ" && categoryByName !== "READ") {
    category = categoryByName;
    hintContradicts = hintContradicts || annotations.readOnlyHint === true;
  }
  if (annotations.readOnlyHint === false) {
    if (category === "READ") category = "WRITE";
    if (riskRank(risk) < riskRank("HIGH")) { risk = "HIGH"; reason = "the server annotates readOnlyHint:false (it writes)"; }
  }
  if (category !== "READ" && riskRank(risk) < riskRank("HIGH")) risk = "HIGH";
  if (!name) return { risk: "HIGH", category: "WRITE", reason: "tool without a valid name", usable: false, hintContradicts };
  return { risk, category, reason, usable, hintContradicts };
}

/**
 * User-supplied critical patterns (e.g. the exact names of tools that move money in your stack). Each
 * is a plain substring or a /regex/ over the normalized name. Invalid ones are refused, not ignored.
 * @param {string[]} raw
 * @returns {RegExp[]}
 */
export function parseCriticalPatterns(raw) {
  return raw.map((p) => {
    if (p.length > 200) throw new Error("critical pattern too long (max 200)");
    const m = /^\/(.+)\/$/.exec(p);
    if (m) return new RegExp(/** @type {string} */ (m[1]));
    return new RegExp(normalName(p).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  });
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
// @ts-check
//
// Text that came from an MCP server or a config file (tool names, descriptions, server names, keys)
// is DATA, never instructions. Two jobs here:
//   1. `safeText`: what may be printed. Control characters, ANSI escapes, bidirectional overrides,
//      zero-width and Unicode tag characters are removed (they hide text from people and can steer a
//      terminal or a model); Markdown-breaking characters are neutralized; length is capped.
//   2. `injectionSignals`: names of the signals found in a description, never the description itself.
//
// Provenance: the description cap and control-character strip come from the description cleanup in
// packages/server/src/mcp-servidores.ts; the signal list is new.

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(\u0007|\u001b\\)/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const INVISIBLE = /[\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]|\udb40[\udc00-\udc7f]/g;

/**
 * @param {unknown} v
 * @param {number} [max]
 * @param {boolean} [dropControls] remove control characters instead of turning them into spaces (used
 *   before masking, so a control character inside a token cannot split it in two)
 */
export function safeText(v, max = 80, dropControls = false) {
  let t = typeof v === "string" ? v : String(v ?? "");
  t = t.replace(ANSI, "").replace(INVISIBLE, "").replace(CONTROL, dropControls ? "" : " ").replace(/\s+/g, " ").trim();
  t = t.replace(/[|`<>]/g, (c) => ({ "|": "¦", "`": "'", "<": "‹", ">": "›" })[c] ?? c);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** @param {string} s */
export function hasHiddenCharacters(s) {
  return new RegExp(INVISIBLE.source).test(s) || new RegExp(ANSI.source).test(s);
}

/** Signal code → pattern. Patterns in English and Portuguese; matched case-insensitively. */
const SIGNALS = /** @type {const} */ ([
  ["override_instructions", /\b(ignore|disregard|forget|override)\b.{0,40}\b(previous|prior|above|all|earlier|system)\b.{0,20}\b(instruction|prompt|rule|message)s?\b|\bignor[ea]\b.{0,30}\b(instru[cç][oõ]es|regras)\b/i],
  ["impersonates_system", /<\/?\s*(system|instructions?|important|admin|assistant)\s*>|\[(system|inst)\]|\bsystem prompt\b|\bprompt do sistema\b/i],
  ["hide_from_user", /\b(do not|don't|never)\b.{0,30}\b(tell|mention|show|reveal|inform)\b.{0,20}\b(the )?user\b|\bn[aã]o\b.{0,20}\b(conte|mencione|mostre|informe)\b.{0,20}\b(ao )?usu[aá]rio\b/i],
  ["tool_ordering", /\b(before|instead of)\b.{0,30}\b(any|other|every)\b.{0,15}\btools?\b|\balways (call|use|run) this tool\b|\bantes de (usar|chamar) qualquer\b/i],
  ["sensitive_files", /(\.ssh|id_rsa|id_ed25519|\.aws\/credentials|\.env\b|\.npmrc|\.netrc|\.git-credentials|mcp\.json|claude\.json|wallet|keychain|private key|chave privada)/i],
  ["exfiltration", /\b(send|post|upload|forward|transmit|envi[ae]|mand[ae])\b.{0,60}\b(https?:\/\/|webhook|endpoint|url|servidor externo)/i],
  ["credential_request", /\b(api[_ ]?key|password|senha|token|secret|segredo|credential|credencial)s?\b.{0,40}\b(parameter|argument|field|campo|par[aâ]metro|include|inclua|pass|passe)\b/i],
  ["encoded_payload", /[A-Za-z0-9+/]{120,}={0,2}/],
  ["html_comment", /<!--[\s\S]*?-->/],
]);

/**
 * Signals in an untrusted text. Returns codes only.
 * @param {unknown} text
 * @returns {string[]}
 */
export function injectionSignals(text) {
  if (typeof text !== "string" || !text) return [];
  /** @type {string[]} */
  const out = [];
  if (hasHiddenCharacters(text)) out.push("hidden_characters");
  // Look at the visible text too (hidden characters can split a keyword).
  const visible = text.replace(ANSI, "").replace(INVISIBLE, "");
  for (const [code, re] of SIGNALS) if (re.test(visible)) out.push(code);
  if (text.length > 4000) out.push("very_long");
  return out;
}

/**
 * Every description inside a tool: the tool's own and those of its input-schema properties (a
 * poisoned instruction often hides in a parameter description).
 * @param {{ description?: unknown, inputSchema?: unknown }} t
 * @returns {string[]}
 */
export function allDescriptions(t) {
  /** @type {string[]} */
  const out = [];
  if (typeof t.description === "string") out.push(t.description);
  /** @param {unknown} node @param {number} depth */
  const walk = (node, depth) => {
    if (depth > 6 || !node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach((x) => walk(x, depth + 1)); return; }
    for (const [k, v] of Object.entries(node)) {
      if ((k === "description" || k === "title") && typeof v === "string") out.push(v);
      else walk(v, depth + 1);
    }
  };
  walk(t.inputSchema, 0);
  return out;
}

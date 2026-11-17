// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
// @ts-check
//
// Literal credentials in an MCP config. The rule that matters: a VALUE is never returned, logged or
// echoed, not even its length or its first characters. A finding says WHERE (the key path) and WHY
// (key name or value shape), nothing else.
//
// Provenance: the sensitive-key idea comes from redigir()/CHAVE_SENSIVEL in
// packages/integration-gateway/src/seguranca.ts; the value shapes are new.

const SENSITIVE_KEY = /(token|secret|segredo|senha|password|passwd|pwd|authorization|auth|api_?key|apikey|access_?key|private_?key|client_?secret|cookie|session|credential|bearer)/i;

// A reference to a value kept elsewhere: environment variable, editor input, template. Fine.
const REFERENCE = /^(\$\{[A-Za-z0-9_:.-]+\}|\$[A-Z_][A-Z0-9_]*|\{\{\s*[A-Za-z0-9_.-]+\s*\}\}|%[A-Z_][A-Z0-9_]*%)$/;
// "Bearer ${TOKEN}" is still a reference.
const BEARER_REFERENCE = /^(Bearer|Basic|Token)\s+(\$\{[A-Za-z0-9_:.-]+\}|\$[A-Z_][A-Z0-9_]*|\{\{\s*[A-Za-z0-9_.-]+\s*\}\})$/i;

/** Known credential shapes. Matching any of these is a finding even under an innocent key name. */
const SHAPES = [
  /\bsk-(?:ant-|proj-|live-)?[A-Za-z0-9_-]{20,}/, // Anthropic / OpenAI style
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/, // Stripe style
  /\bgh[pousr]_[A-Za-z0-9]{30,}/, /\bgithub_pat_[A-Za-z0-9_]{40,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/, /\bAIza[0-9A-Za-z_-]{35}\b/, /\bhf_[A-Za-z0-9]{30,}/, /\bnpm_[A-Za-z0-9]{36}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** @param {string} v */
export function looksLikeCredential(v) {
  return SHAPES.some((r) => r.test(v));
}

/** @param {string} v */
function isReference(v) {
  const t = v.trim();
  return t === "" || REFERENCE.test(t) || BEARER_REFERENCE.test(t);
}

/**
 * Long token-like string with letters and digits: probably a credential if it sits under a sensitive
 * key. Not used on its own (too many false positives on ids and hashes).
 * @param {string} v
 */
function tokenLike(v) {
  const t = v.trim();
  return t.length >= 12 && !/\s/.test(t) && /[A-Za-z]/.test(t) && /\d/.test(t);
}

/**
 * @typedef {{ path: string, why: "credential_shape" | "sensitive_key" | "sensitive_flag" }} SecretHit
 * Walks a server entry (env, headers, args, url is handled elsewhere). Returns key paths only.
 * @param {unknown} node
 * @param {string} path
 * @param {SecretHit[]} [out]
 * @param {number} [depth]
 * @returns {SecretHit[]}
 */
export function findLiteralSecrets(node, path, out = [], depth = 0) {
  if (depth > 8 || out.length > 200) return out;
  if (typeof node === "string") {
    const leaf = (path.split(".").pop() ?? "").replace(/-/g, "_");
    if (looksLikeCredential(node)) out.push({ path, why: "credential_shape" });
    else if (SENSITIVE_KEY.test(leaf) && !isReference(node) && (tokenLike(node) || node.trim().length >= 8)) out.push({ path, why: "sensitive_key" });
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((x, i) => {
      // ["--api-key", "abc..."]: the value after a sensitive flag.
      const prev = i > 0 ? node[i - 1] : null;
      if (typeof x === "string" && typeof prev === "string" && /^--?[A-Za-z0-9_-]+$/.test(prev) && SENSITIVE_KEY.test(prev.replace(/-/g, "_")) && !isReference(x) && !looksLikeCredential(x) && x.trim().length >= 8) {
        out.push({ path: `${path}[${i}]`, why: "sensitive_flag" });
        return;
      }
      // "--token=abc..."
      if (typeof x === "string") {
        const m = /^--?([A-Za-z0-9_-]+)=(.+)$/.exec(x);
        if (m && SENSITIVE_KEY.test(/** @type {string} */ (m[1]).replace(/-/g, "_")) && !isReference(/** @type {string} */ (m[2])) && !looksLikeCredential(x) && /** @type {string} */ (m[2]).trim().length >= 8) {
          out.push({ path: `${path}[${i}]`, why: "sensitive_flag" });
          return;
        }
      }
      findLiteralSecrets(x, `${path}[${i}]`, out, depth + 1);
    });
    return out;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) findLiteralSecrets(v, `${path}.${k}`, out, depth + 1);
  }
  return out;
}

/**
 * Last line of defence for anything printed: every credential-shaped run is replaced. Applied to the
 * whole report before it leaves the process.
 * @param {string} text
 */
export function scrubCredentials(text) {
  let t = text;
  for (const r of SHAPES) t = t.replace(new RegExp(r.source, r.flags.includes("g") ? r.flags : `${r.flags}g`), "[credential omitted]");
  return t;
}

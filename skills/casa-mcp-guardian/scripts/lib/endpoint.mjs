// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
// @ts-check
//
// Assessment of an MCP server URL, as written in a config file. Pure string analysis: no DNS lookup,
// no connection. A public name that RESOLVES to a private address (DNS rebinding) is out of reach of a
// static check; that needs the connection-time guard (packages/integration-gateway/src/fetch-seguro.ts).
//
// Provenance: hostLocalOuPrivado() and validarEndpoint() from packages/integration-gateway/src/seguranca.ts
// (same author, same license), turned from "throw" into findings.
//
// The URL path is never shown: webhooks carry their token in the path, in formats nobody can list.
// URL_SECRET_PATH is decided on the ORIGINAL path, before it is hidden.

import { hasToken } from "./secrets.mjs";

/** @type {readonly [string, number][]} */
const RESERVED_V4 = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

/** @param {string} s */
function ipv4(s) {
  const p = s.split(".");
  if (p.length !== 4 || !p.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255)) return null;
  return p.reduce((n, x) => n * 256 + Number(x), 0);
}
/** @param {number} n @param {string} base @param {number} bits */
function inRange(n, base, bits) {
  const b = /** @type {number} */ (ipv4(base));
  return n >= b && n < b + 2 ** (32 - bits);
}

/**
 * "loopback" | "metadata" | "private" | null. The WHATWG URL parser already normalizes IPv4 written in
 * decimal, hex or octal and compresses IPv6; this works on the normalized form.
 * @param {string} hostRaw
 * @returns {"loopback" | "metadata" | "private" | null}
 */
export function hostKind(hostRaw) {
  const host = hostRaw.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
  const n4 = ipv4(host);
  if (n4 !== null) {
    if (inRange(n4, "127.0.0.0", 8)) return "loopback";
    if (inRange(n4, "169.254.0.0", 16)) return "metadata";
    return RESERVED_V4.some(([b, bits]) => inRange(n4, b, bits)) ? "private" : null;
  }
  if (!host.startsWith("[")) return null;
  const h6 = host.slice(1, -1);
  if (h6 === "::1") return "loopback";
  // IPv4-mapped (::ffff:a9fe:a9fe), NAT64 and 6to4 can carry the metadata address.
  if (/a9fe:/.test(h6) && (h6.startsWith("::") || /^64:ff9b:/.test(h6) || /^2002:/.test(h6))) return "metadata";
  if (h6.startsWith("::")) return "private";
  if (/^fe[89ab][0-9a-f]?:/.test(h6)) return "metadata"; // link-local, where cloud metadata also lives
  return /^(f[cd][0-9a-f]{0,2}|ff[0-9a-f]{0,2}):/.test(h6) || /^2001:0?db8:/.test(h6) || /^2002:/.test(h6) || /^64:ff9b:/.test(h6) ? "private" : null;
}

const SECRET_PARAM = /(token|secret|key|pass|pwd|auth|sig|signature|session|cred|apikey|api_key|access)/i;

/**
 * @typedef {{ code: string, severity: "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL", detail: string }} UrlFinding `detail` holds data (names), never prose: the title comes from the message catalog.
 * @param {string} raw
 * @returns {{ display: string, findings: UrlFinding[], parts: { protocol: string, host: string, hasPath: boolean, hasQuery: boolean } | null, params: string[] }}
 *   `display` never contains user info, path, query or fragment; `parts` and `params` are raw and only
 *   reach the report through scripts/lib/present.mjs.
 */
export function assessUrl(raw) {
  /** @type {UrlFinding[]} */
  const findings = [];
  let u;
  try { u = new URL(raw); } catch {
    return { display: "[unparseable URL]", findings: [{ code: "URL_INVALID", severity: "HIGH", detail: "" }], parts: null, params: [] };
  }
  if (u.username || u.password) findings.push({ code: "URL_CREDENTIALS", severity: "CRITICAL", detail: "" });
  const secretParams = [...u.searchParams.keys()].filter((k) => SECRET_PARAM.test(k));
  if (secretParams.length) findings.push({ code: "URL_SECRET_PARAM", severity: "HIGH", detail: String(secretParams.length) });
  // On the original path, before it is hidden: the normalized path, the RAW path as written (a "/../"
  // would otherwise drop a token) and the fragment. Only a count goes out, never a segment.
  const rest = raw.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "");
  const rawPath = rest.split(/[?#]/)[0] ?? "";
  const fragment = rest.includes("#") ? rest.slice(rest.indexOf("#") + 1) : "";
  const pieces = new Set([...u.pathname.split("/"), ...rawPath.split("/"), ...fragment.split(/[/?&=#]/)]);
  let tokenSegments = 0;
  for (const seg of pieces) {
    if (!seg || seg === "." || seg === "..") continue;
    let s = seg;
    try { s = decodeURIComponent(seg); } catch { /* keep it encoded */ }
    if (hasToken(s)) tokenSegments++;
  }
  if (tokenSegments) findings.push({ code: "URL_SECRET_PATH", severity: "HIGH", detail: String(tokenSegments) });
  if (u.protocol !== "https:" && u.protocol !== "http:" && u.protocol !== "ws:" && u.protocol !== "wss:") {
    findings.push({ code: "URL_PROTOCOL", severity: "HIGH", detail: "" });
  }
  const kind = hostKind(u.hostname);
  if (kind === "metadata") findings.push({ code: "URL_METADATA_HOST", severity: "CRITICAL", detail: "" });
  else if (kind === "private") findings.push({ code: "URL_PRIVATE_HOST", severity: "MEDIUM", detail: "" });
  else if (kind === "loopback") findings.push({ code: "URL_LOOPBACK", severity: "INFO", detail: "" });
  if ((u.protocol === "http:" || u.protocol === "ws:") && kind !== "loopback") {
    findings.push({ code: "URL_PLAINTEXT", severity: "HIGH", detail: "" });
  }
  // Shown without user info, path, query and fragment.
  const hasPath = u.pathname !== "" && u.pathname !== "/";
  const display = `${u.protocol}//${u.host}/${hasPath ? "[path omitted]" : ""}${u.search ? "?[query omitted]" : ""}`;
  return { display, findings, parts: { protocol: u.protocol, host: u.host, hasPath, hasQuery: !!u.search }, params: secretParams };
}

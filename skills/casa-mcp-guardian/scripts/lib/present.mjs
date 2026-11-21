// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
// @ts-check
//
// How free text from the audited files reaches the report. Every identifier that comes from input
// (server and tool names, file names, hosts, commands, config key paths, URL parameter names, package
// names, auto-approved tool lists, the "type" field, pin labels) goes through one of these functions;
// nothing else from the input is printed.
//
//   · default:  names stay readable; pieces that look like tokens are masked (a heuristic, with a
//               measured residual risk: see docs/skills/casa-mcp-guardian.md);
//   · redacted (--redact-names): every free identifier is replaced by a neutral label ("server-1",
//               "tool-3", "file-2", "[host omitted]"...). Only fixed vocabulary is printed: finding
//               codes, severities, risk and category, signal codes, the fixed list of default config
//               file names, the known transport types, the known auto-approval keys.

import { createHash } from "node:crypto";
import { maskTokens } from "./secrets.mjs";
import { safeText } from "./untrusted.mjs";

/** Domain of the opaque identifiers, so a pin id can never collide with another use of SHA-256. */
export const ID_DOMAIN = "casa-mcp-guardian/id/v1";

/**
 * 128-bit opaque identifier: SHA-256 over the domain and the JSON form of [kind, ...parts], truncated to
 * 32 hex characters. JSON keeps lone UTF-16 surrogates distinct ("\ud800" is not "\udc00" nor U+FFFD),
 * which the UTF-8 encoder would merge, and makes the parts unambiguous. Stable and deterministic, independent of how names are displayed. It identifies;
 * it does NOT anonymize: a predictable name can be found by trying candidates.
 * @param {"server" | "tool"} kind
 * @param {string[]} parts
 */
export function opaqueId(kind, ...parts) {
  const h = createHash("sha256");
  h.update(`${ID_DOMAIN}\0`);
  h.update(JSON.stringify([kind, ...parts]));
  return h.digest("hex").slice(0, 32);
}

const TRANSPORTS = new Set(["http", "https", "sse", "stdio", "streamable-http", "streamablehttp", "ws", "wss", "websocket"]);

/**
 * @typedef {{
 *   redacted: boolean,
 *   server: (raw: string) => string,
 *   tool: (raw: string) => string,
 *   file: (label: string) => string,
 *   host: (raw: string) => string,
 *   command: (raw: string) => string,
 *   keyPath: (raw: string) => string,
 *   params: (names: string[]) => string,
 *   pkg: (name: string) => string,
 *   toolList: (names: string[]) => string,
 *   protocol: (raw: string) => string,
 *   transport: (raw: string) => string,
 *   pinLabel: (server: string, tool: string) => string | undefined,
 *   removed: (label: unknown) => string,
 * }} Presenter
 */

/**
 * In this order: (1) clean (invisible characters, ANSI escapes and controls removed, so none of them can
 * split a token and hide it from the mask); (2) mask; (3) cut to the length limit (cutting first could
 * leave half a token that no longer looks like one).
 * @param {string} v @param {number} n */
const shown = (v, n) => {
  const masked = maskTokens(safeText(v, Number.MAX_SAFE_INTEGER, true));
  return masked.length > n ? `${masked.slice(0, n - 1)}…` : masked;
};

/**
 * @param {boolean} redacted
 * @param {readonly string[]} fixedFiles file labels that are fixed vocabulary (the default config paths)
 * @returns {Presenter}
 */
export function presenter(redacted, fixedFiles = []) {
  /** @param {string} prefix */
  const ordinal = (prefix) => {
    /** @type {Map<string, string>} */
    const seen = new Map();
    return (/** @type {string} */ raw) => {
      let v = seen.get(raw);
      if (!v) { v = `${prefix}-${seen.size + 1}`; seen.set(raw, v); }
      return v;
    };
  };
  const transport = (/** @type {string} */ raw) => (TRANSPORTS.has(raw.toLowerCase()) ? raw.toLowerCase() : raw ? "other" : "");
  if (!redacted) {
    return {
      redacted,
      server: (raw) => shown(raw, 60),
      tool: (raw) => shown(raw, 80) || "(no name)",
      file: (label) => shown(label, 120),
      host: (raw) => shown(raw, 100),
      command: (raw) => shown(raw, 40),
      keyPath: (raw) => shown(raw, 120),
      params: (names) => names.slice(0, 5).map((n) => shown(n, 40)).join(", "),
      pkg: (name) => shown(name, 80),
      toolList: (names) => names.slice(0, 8).map((n) => shown(n, 40)).join(", "),
      protocol: (raw) => shown(raw, 20),
      transport,
      pinLabel: (server, tool) => `${shown(server, 60)}/${shown(tool, 80)}`,
      removed: (label) => (typeof label === "string" && label ? shown(label, 120) : "(pin without label)"),
    };
  }
  const server = ordinal("server");
  const tool = ordinal("tool");
  const file = ordinal("file");
  const removed = ordinal("pinned-tool");
  let removedCount = 0;
  return {
    redacted,
    server,
    tool,
    file: (label) => (fixedFiles.includes(label) ? label : file(label)),
    host: () => "[host omitted]",
    command: () => "[command]",
    keyPath: () => "[key omitted]",
    params: (names) => `${names.length} parameter${names.length === 1 ? "" : "s"}`,
    pkg: () => "[package]",
    toolList: (names) => `${names.length} tool${names.length === 1 ? "" : "s"}`,
    protocol: () => "[protocol]",
    transport,
    pinLabel: () => undefined,
    removed: () => removed(String(++removedCount)),
  };
}

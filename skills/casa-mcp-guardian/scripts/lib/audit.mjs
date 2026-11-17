// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
// @ts-check
//
// The audit itself: config files and tool listings in, findings and a tool table out. Pure functions
// over parsed JSON; the only I/O is `readJsonFile`, which READS a file the caller named. Nothing here
// writes, spawns or connects.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { classifyTool, riskRank } from "./classify.mjs";
import { assessUrl } from "./endpoint.mjs";
import { opaqueId, presenter } from "./present.mjs";
import { findLiteralSecrets } from "./secrets.mjs";
import { allDescriptions, hasHiddenCharacters, injectionSignals, safeText } from "./untrusted.mjs";

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const SEVERITIES = /** @type {const} */ (["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]);
/** @typedef {typeof SEVERITIES[number]} Severity */
/** @typedef {{ code: string, severity: Severity, file: string, target: string, data: string }} Finding */
/** @param {Severity} s */
export const severityRank = (s) => SEVERITIES.indexOf(s);

/**
 * Removes // and /* *\/ comments and trailing commas outside strings (VS Code's mcp.json is JSONC).
 * @param {string} src
 */
export function stripJsonc(src) {
  // One pass, string-aware for both comments and trailing commas: text inside a string is never touched
  // (a value such as "https://x/a,}" or "a // b" stays exactly as written).
  let out = "";
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === "\\") { out += src[i + 1] ?? ""; i++; } else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    // A line comment ends at LF or CR; a block comment becomes a space, so it never joins two tokens.
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n" && src[i] !== "\r") i++; out += "\n"; continue; }
    if (c === "/" && src[i + 1] === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i++; out += " "; continue; }
    if (c === ",") {
      // Trailing comma: the next thing outside comments and whitespace closes an object or an array.
      let j = i + 1;
      for (;;) {
        while (j < src.length && /\s/.test(/** @type {string} */ (src[j]))) j++;
        if (src[j] === "/" && src[j + 1] === "/") { while (j < src.length && src[j] !== "\n" && src[j] !== "\r") j++; continue; }
        if (src[j] === "/" && src[j + 1] === "*") { j += 2; while (j < src.length && !(src[j] === "*" && src[j + 1] === "/")) j++; j += 2; continue; }
        break;
      }
      if (src[j] === "}" || src[j] === "]") continue;
    }
    out += c;
  }
  return out;
}

/**
 * Reads and parses a JSON(C) file the user named. Never follows into directories; refuses large files.
 * @param {string} path
 * @returns {{ ok: true, value: unknown } | { ok: false, code: "FILE_UNREADABLE" | "FILE_TOO_LARGE" | "FILE_NOT_JSON" }}
 */
export function readJsonFile(path) {
  let st;
  try { st = statSync(path); } catch { return { ok: false, code: "FILE_UNREADABLE" }; }
  if (!st.isFile()) return { ok: false, code: "FILE_UNREADABLE" };
  if (st.size > MAX_FILE_BYTES) return { ok: false, code: "FILE_TOO_LARGE" };
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return { ok: false, code: "FILE_UNREADABLE" }; }
  try { return { ok: true, value: JSON.parse(stripJsonc(text.replace(/^\uFEFF/, ""))) }; } catch { return { ok: false, code: "FILE_NOT_JSON" }; }
}

const RUNNERS = new Set(["npx", "bunx", "pnpx"]);
const DLX = new Set(["pnpm", "yarn", "npm"]);
const PY_RUNNERS = new Set(["uvx", "pipx"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh"]);
const CONTAINERS = new Set(["docker", "podman"]);
/** Flags of npx / npm exec / pnpm|yarn dlx / uvx / pipx run that take no value. */
const BOOLEAN_FLAGS = new Set([
  "-y", "--yes", "--no", "--no-install", "--ignore-existing", "-q", "--quiet", "-s", "--silent", "-v", "--verbose",
  "--prefer-offline", "--prefer-online", "--offline", "--no-color", "--no-progress", "-h", "--help",
  "--ignore-scripts", "--no-save", "--legacy-peer-deps", "--no-update-notifier", "--bun", "--no-audit", "--no-fund",
  "--version", "--no-cache", "--refresh", "--isolated", "--no-python-downloads", "--system-site-packages",
  "--include-deps", "--preview", "--no-config", "--native-tls", "--no-build", "--no-sources",
]);
/** Flags whose value is the package itself. */
const NPM_PACKAGE_FLAGS = new Set(["-p", "--package"]);
const PY_PACKAGE_FLAGS = new Set(["--from", "--spec"]);

/** @param {unknown} x */
const str = (x) => (typeof x === "string" ? x : "");
/** @param {string} c */
const cmdName = (c) => basename(c.replace(/\\/g, "/")).toLowerCase();

/** npm package spec has a version: "pkg@1.2.3", "@scope/pkg@1.2.3" (not "latest", not a range like ^). */
/** @param {string} spec */
function npmPinned(spec) {
  const at = spec.startsWith("@") ? spec.indexOf("@", 1) : spec.indexOf("@");
  if (at <= 0) return false;
  const v = spec.slice(at + 1);
  return /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(v);
}

/** The package NAME of a spec, without version, tag, range, extra or anything after it: a spec may
 * carry free text ("pkg@<anything>"), and only the name is needed to say it is unpinned.
 * @param {string} spec0 @param {boolean} python */
export function packageName(spec0, python) {
  // Cleaned first: an invisible character inside the spec would otherwise end the name early and hand
  // half a token to the report, too short to look like one.
  const spec = safeText(spec0, Number.MAX_SAFE_INTEGER);
  if (python) return (/^[A-Za-z0-9._-]+/.exec(spec) ?? [""])[0];
  return (/^(?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+/.exec(spec) ?? [""])[0];
}

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {{ code: string, severity: Severity, data: string }[]}
 */
export function assessCommand(command, args) {
  /** @type {{ code: string, severity: Severity, data: string }[]} */
  const out = [];
  const name = cmdName(command);
  const joined = [command, ...args].join(" ");
  if (/\b(curl|wget|iwr|invoke-webrequest)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|python3?|node|iex|pwsh|powershell)\b/i.test(joined)) {
    out.push({ code: "PIPE_TO_SHELL", severity: "CRITICAL", data: "" });
  }
  if (SHELLS.has(name) && args.some((a) => /^(-c|\/c|\/k|-command|-encodedcommand)$/i.test(a))) out.push({ code: "SHELL_WRAPPER", severity: "HIGH", data: name });

  /**
   * The package argument: the first argument that is neither a flag nor a flag's VALUE. A flag written
   * without "=" takes the next argument as its value unless it is a known boolean flag, so the value of
   * "--token VALUE" or "--registry URL" is never taken for the package (and never printed). At worst an
   * unknown boolean flag hides the package, and the package is not judged.
   * @param {string[]} list @param {ReadonlySet<string>} packageFlags flags whose value IS the package
   */
  const packageArg = (list, packageFlags) => {
    for (let i = 0; i < list.length; i++) {
      const a = /** @type {string} */ (list[i]);
      if (a === "--") return list[i + 1] ?? null; // end of options: the next argument is the package
      if (packageFlags.has(a)) return list[i + 1] ?? null;
      const eq = a.indexOf("=");
      if (eq > 0 && packageFlags.has(a.slice(0, eq))) return a.slice(eq + 1) || null; // --package=pkg
      if (a.startsWith("-")) {
        if (!a.includes("=") && !BOOLEAN_FLAGS.has(a)) i++;
        continue;
      }
      return a;
    }
    return null;
  };
  let spec = null;
  if (RUNNERS.has(name)) spec = packageArg(args, NPM_PACKAGE_FLAGS);
  else if (DLX.has(name) && (args[0] === "dlx" || args[0] === "exec")) spec = packageArg(args.slice(1), NPM_PACKAGE_FLAGS);
  if (spec && !spec.startsWith(".") && !spec.startsWith("/") && !npmPinned(spec)) out.push({ code: "UNPINNED_PACKAGE", severity: "MEDIUM", data: packageName(spec, false) });

  if (PY_RUNNERS.has(name)) {
    const list = name === "pipx" && args[0] === "run" ? args.slice(1) : args;
    const pySpec = packageArg(list, PY_PACKAGE_FLAGS) ?? "";
    if (pySpec && !/(==|@)\d/.test(pySpec)) out.push({ code: "UNPINNED_PACKAGE", severity: "MEDIUM", data: packageName(pySpec, true) });
  }
  if (CONTAINERS.has(name) && args.includes("run") && !args.some((a) => /@sha256:[0-9a-f]{64}$/.test(a))) out.push({ code: "UNPINNED_IMAGE", severity: "MEDIUM", data: "" });
  return out;
}

/**
 * @param {unknown} cfg parsed config
 * @param {string} file label for the report, already presented
 * @param {import("./present.mjs").Presenter} [nm] how free text is shown (default: names with tokens masked)
 * @returns {{ findings: Finding[], servers: { name: string, transport: string, endpoint: string }[] }}
 */
export function auditConfig(cfg, file, nm = presenter(false)) {
  /** @type {Finding[]} */
  const findings = [];
  /** @type {{ name: string, transport: string, endpoint: string }[]} */
  const servers = [];
  const root = cfg && typeof cfg === "object" && !Array.isArray(cfg) ? /** @type {Record<string, unknown>} */ (cfg) : {};
  // Claude Code project settings: everything in .mcp.json switched on without review.
  if (root.enableAllProjectMcpServers === true) findings.push({ code: "ENABLE_ALL_PROJECT_SERVERS", severity: "MEDIUM", file, target: "enableAllProjectMcpServers", data: "" });
  const box = root.mcpServers ?? root.servers ?? (root.mcp && typeof root.mcp === "object" ? /** @type {Record<string, unknown>} */ (root.mcp).servers : undefined);
  if (!box || typeof box !== "object" || Array.isArray(box)) {
    if (!("enableAllProjectMcpServers" in root)) findings.push({ code: "NO_SERVERS", severity: "INFO", file, target: "", data: "" });
    return { findings, servers };
  }
  for (const [rawName, entryRaw] of Object.entries(/** @type {Record<string, unknown>} */ (box))) {
    const name = nm.server(rawName);
    const target = `server ${name}`;
    if (!entryRaw || typeof entryRaw !== "object" || Array.isArray(entryRaw)) { findings.push({ code: "SERVER_UNRECOGNIZED", severity: "LOW", file, target, data: "" }); continue; }
    const e = /** @type {Record<string, unknown>} */ (entryRaw);
    const url = str(e.url) || str(e.serverUrl) || str(e.httpUrl);
    const command = str(e.command);
    const args = Array.isArray(e.args) ? e.args.filter((a) => typeof a === "string").map(String) : [];
    if (url) {
      const a = assessUrl(url);
      const pt = a.parts;
      const endpoint = pt ? `${nm.protocol(pt.protocol.replace(/:$/, ""))}://${nm.host(pt.host)}/${pt.hasPath ? "[path omitted]" : ""}${pt.hasQuery ? "?[query omitted]" : ""}` : a.display;
      servers.push({ name, transport: nm.transport(str(e.type)) || "http", endpoint });
      for (const f of a.findings) {
        const data = f.code === "URL_SECRET_PARAM" ? nm.params(a.params) : f.code === "URL_SECRET_PATH" ? f.detail : "";
        findings.push({ code: f.code, severity: f.severity, file, target, data });
      }
    } else if (command) {
      servers.push({ name, transport: "stdio", endpoint: `${nm.command(cmdName(command))}${args.length ? " …" : ""}` });
      // SHELL_WRAPPER names a shell from a fixed list; UNPINNED_PACKAGE names a package (free text).
      for (const f of assessCommand(command, args)) findings.push({ ...f, file, target, data: f.code === "UNPINNED_PACKAGE" ? nm.pkg(f.data) : f.data });
    } else {
      findings.push({ code: "SERVER_UNRECOGNIZED", severity: "LOW", file, target, data: "" });
    }
    // Literal secrets anywhere in the entry except the URL (handled above). Key paths only.
    const { url: _u, serverUrl: _s, httpUrl: _h, ...rest } = e;
    for (const hit of findLiteralSecrets(rest, `servers.${rawName}`)) {
      findings.push({ code: "LITERAL_SECRET", severity: "HIGH", file, target, data: `${nm.keyPath(hit.path.replace(`servers.${rawName}`, ""))} (${hit.why})` });
    }
    for (const key of ["alwaysAllow", "autoApprove", "autoapprove", "allowedTools"]) {
      const v = e[key];
      if (Array.isArray(v) && v.length) {
        const all = v.some((x) => x === "*" || x === "all");
        findings.push({ code: all ? "AUTO_APPROVE_ALL" : "AUTO_APPROVE", severity: all ? "CRITICAL" : "HIGH", file, target, data: all ? key : `${key}: ${nm.toolList(v.filter((x) => typeof x === "string").map(String))}` });
      }
    }
    if (e.trust === true) findings.push({ code: "AUTO_APPROVE_ALL", severity: "CRITICAL", file, target, data: "trust: true" });
  }
  if (!servers.length && !findings.some((f) => f.code === "SERVER_UNRECOGNIZED")) findings.push({ code: "NO_SERVERS", severity: "INFO", file, target: "", data: "" });
  return { findings, servers };
}

/** JSON with sorted keys: the same tool gives the same hash whatever the key order. */
/** @param {unknown} v @returns {string} */
export function stableJson(v) {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const o = /** @type {Record<string, unknown>} */ (v);
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
}

/** Deepest nesting a tool may have to be pinned and inspected (real schemas stay far below). */
export const MAX_DEPTH = 64;

/** True when `v` nests deeper than `limit`. Iterative: a hostile 200,000-level listing cannot overflow
 * the stack here. @param {unknown} v @param {number} limit */
export function tooDeep(v, limit = MAX_DEPTH) {
  /** @type {[unknown, number][]} */
  const stack = [[v, 0]];
  while (stack.length) {
    const [node, d] = /** @type {[unknown, number]} */ (stack.pop());
    if (!node || typeof node !== "object") continue;
    if (d > limit) return true;
    for (const x of Array.isArray(node) ? node : Object.values(node)) stack.push([x, d + 1]);
  }
  return false;
}

/** Pin of a tool: what the model sees (name, description, schema, annotations). */
/** @param {Record<string, unknown>} t */
export function pinOf(t) {
  return createHash("sha256").update(stableJson({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })).digest("hex");
}

/** @param {unknown} v @returns {Record<string, unknown>[]} */
export function toolsFromListing(v) {
  const o = /** @type {any} */ (v);
  const list = Array.isArray(o) ? o : Array.isArray(o?.tools) ? o.tools : Array.isArray(o?.result?.tools) ? o.result.tools : [];
  return list.filter((/** @type {unknown} */ t) => !!t && typeof t === "object" && !Array.isArray(t));
}

/**
 * A pin (version 2). The key is opaqueId("tool", server, tool): 128 bits, stable whatever the display
 * mode. `server` is opaqueId("server", server), to tell a removed tool from a server not listed this
 * time. `label` is the default-mode display name, only for people; it is never used to compare.
 * @typedef {{ server: string, sha256: string, label?: string }} PinEntry
 */
/** @param {unknown} p @returns {Record<string, PinEntry> | null} */
function validPins(p) {
  const o = /** @type {any} */ (p);
  if (!o || o.version !== 2 || !o.tools || typeof o.tools !== "object" || Array.isArray(o.tools)) return null;
  for (const [k, v] of Object.entries(o.tools)) {
    const e = /** @type {any} */ (v);
    // typeof first: String() on a hostile object ({ toString: 1 }) would throw.
    if (!/^[0-9a-f]{32}$/.test(k) || !e || typeof e !== "object" || Array.isArray(e)) return null;
    if (typeof e.server !== "string" || !/^[0-9a-f]{32}$/.test(e.server) || typeof e.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(e.sha256)) return null;
    if (e.label !== undefined && typeof e.label !== "string") return null;
  }
  return o.tools;
}

/**
 * @typedef {{ server: string, tool: string, risk: string, category: string, usable: boolean, signals: string[] }} ToolRow
 * @param {{ server: string, file: string, tools: Record<string, unknown>[] }[]} listings
 * @param {{ extraCritical?: RegExp[], pins?: unknown, nm?: import("./present.mjs").Presenter }} [o]
 * @returns {{ findings: Finding[], rows: ToolRow[], pins: Record<string, PinEntry> }}
 */
export function auditTools(listings, o = {}) {
  /** @type {Finding[]} */
  const findings = [];
  /** @type {ToolRow[]} */
  const rows = [];
  const nm = o.nm ?? presenter(false);
  /** @type {Record<string, PinEntry>} */
  const pins = {};
  /** @type {Map<string, Set<string>>} */
  const byName = new Map();
  // The same server and tool twice, in one listing or across listings of the same server: a pin cannot
  // tell the copies apart, so it is always a finding (and --emit-pins refuses).
  /** @type {Map<string, { server: string, name: string, file: string, n: number }>} */
  const seen = new Map();
  for (const l of listings) {
    for (const t of l.tools) {
      const id = opaqueId("tool", l.server, str(t.name));
      const e = seen.get(id) ?? { server: l.server, name: str(t.name), file: l.file, n: 0 };
      e.n++;
      seen.set(id, e);
    }
  }
  for (const e of seen.values()) if (e.n > 1) findings.push({ code: "TOOL_DUPLICATE_NAME", severity: "HIGH", file: e.file, target: `${nm.server(e.server)}/${nm.tool(e.name)}`, data: String(e.n) });
  for (const l of listings) {
    const server = nm.server(l.server);
    if (!l.tools.length) findings.push({ code: "TOOLS_FILE_EMPTY", severity: "INFO", file: l.file, target: `server ${server}`, data: "" });
    for (const t0 of l.tools) {
      const rawName = str(t0.name);
      const tool = nm.tool(rawName);
      // Too deep to inspect or pin safely: a finding, and only the name is classified.
      const deep = tooDeep(t0);
      if (deep) findings.push({ code: "TOOL_SCHEMA_TOO_DEEP", severity: "HIGH", file: l.file, target: `${server}/${tool}`, data: "" });
      const t = deep ? { name: t0.name } : t0;
      const target = `${server}/${tool}`;
      const c = classifyTool(t, { extraCritical: o.extraCritical });
      const signals = [...new Set(allDescriptions(t).flatMap((d) => injectionSignals(d)))];
      const hostile = signals.filter((s) => !["encoded_payload", "html_comment", "very_long"].includes(s));
      if (hostile.length) findings.push({ code: "TOOL_INJECTION_SIGNAL", severity: "HIGH", file: l.file, target, data: hostile.join(", ") });
      const odd = signals.filter((s) => ["encoded_payload", "html_comment", "very_long"].includes(s));
      if (odd.length) findings.push({ code: "TOOL_SUSPICIOUS_TEXT", severity: "MEDIUM", file: l.file, target, data: odd.join(", ") });
      if (rawName && (hasHiddenCharacters(rawName) || /[\u0000-\u001f\u007f]/.test(rawName))) findings.push({ code: "TOOL_NAME_HIDDEN", severity: "HIGH", file: l.file, target, data: "" });
      if (c.hintContradicts) findings.push({ code: "TOOL_HINT_CONTRADICTS", severity: "MEDIUM", file: l.file, target, data: `${c.risk}/${c.category}` });
      if (!c.usable) findings.push({ code: "TOOL_NO_OBJECT_SCHEMA", severity: "MEDIUM", file: l.file, target, data: "" });
      rows.push({ server, tool, risk: c.risk, category: c.category, usable: c.usable, signals });
      const label = nm.pinLabel(l.server, rawName);
      if (!deep) pins[opaqueId("tool", l.server, rawName)] = { server: opaqueId("server", l.server), sha256: pinOf(t), ...(label ? { label } : {}) };
      const seen = byName.get(rawName) ?? new Set();
      seen.add(l.server);
      byName.set(rawName, seen);
    }
  }
  for (const [name, servers] of byName) {
    if (name && servers.size > 1) findings.push({ code: "TOOL_NAME_COLLISION", severity: "MEDIUM", file: "", target: nm.tool(name), data: [...servers].map((x) => nm.server(x)).join(", ") });
  }
  if (o.pins !== undefined) {
    const stored = validPins(o.pins);
    if (!stored) findings.push({ code: "PINS_INVALID", severity: "HIGH", file: "", target: "", data: "" });
    else {
      // Compared by opaque id only: the display mode never changes the result.
      for (const l of listings) {
        for (const t of l.tools) {
          if (tooDeep(t)) continue; // already TOOL_SCHEMA_TOO_DEEP
          const rawName = str(t.name);
          const id = opaqueId("tool", l.server, rawName);
          const target = `${nm.server(l.server)}/${nm.tool(rawName)}`;
          if (!(id in stored)) findings.push({ code: "TOOL_NEW", severity: "MEDIUM", file: "", target, data: "" });
          // Each tool against its OWN hash: with duplicate names, every copy is checked.
          else if (stored[id]?.sha256 !== pinOf(t)) findings.push({ code: "TOOL_CHANGED", severity: "HIGH", file: "", target, data: "" });
        }
      }
      const listed = new Set(listings.map((l) => opaqueId("server", l.server)));
      for (const [id, e] of Object.entries(stored)) {
        if (listed.has(e.server) && !(id in pins)) findings.push({ code: "TOOL_REMOVED", severity: "LOW", file: "", target: nm.removed(e.label), data: "" });
      }
    }
  }
  rows.sort((a, b) => riskRank(/** @type {any} */ (b.risk)) - riskRank(/** @type {any} */ (a.risk)) || a.server.localeCompare(b.server) || a.tool.localeCompare(b.tool));
  return { findings, rows, pins };
}

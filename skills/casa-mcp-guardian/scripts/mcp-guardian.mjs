#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
// @ts-check
//
// casa-mcp-guardian: audits MCP server configs and tool listings. Read-only, offline.
//
//   node mcp-guardian.mjs                         # looks for the project's MCP config files in the current folder
//   node mcp-guardian.mjs --config .mcp.json --tools github=tools-github.json --lang pt
//   node mcp-guardian.mjs --tools github=tools-github.json --pins mcp-pins.json
//   node mcp-guardian.mjs --tools github=tools-github.json --emit-pins > mcp-pins.json   (you save it)
//
// What it never does: open a network connection, write a file, start a process, call an MCP tool,
// read files you did not name (besides the fixed list of project config paths), or print the value of
// a credential. Exit code: 0 = nothing at or above --fail-on; 1 = something at or above it; 2 = usage.
//
// Personal and global configs are never read implicitly: without --config, a root that is the home
// folder (however it is spelled: trailing slash, "..", a symlink) is refused, and a default path that
// leads out of the project (a symlinked .claude or .cursor folder) is skipped and reported.
//
// Requires Node.js 22 or newer (tested on 22 and 24). No dependencies.

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { auditConfig, auditTools, readJsonFile, severityRank, SEVERITIES, toolsFromListing } from "./lib/audit.mjs";
import { parseCriticalPatterns } from "./lib/classify.mjs";
import { renderJson, renderMarkdown } from "./lib/report.mjs";
import { scrubCredentials } from "./lib/secrets.mjs";
import { safeText } from "./lib/untrusted.mjs";

/** Canonical form of a path: resolved (which also drops "." , ".." and a trailing separator), symlinks
 * followed when the process may see them, case folded where the file system usually ignores case.
 * @param {string} p */
export function canonical(p) {
  let r = resolve(p);
  try { r = realpathSync(r); } catch { /* not visible or does not exist: keep the resolved path */ }
  return process.platform === "win32" || process.platform === "darwin" ? r.toLowerCase() : r;
}

/** Every spelling of the current user's home folder that this process can know of. */
export function homeFolders() {
  /** @type {string[]} */
  const raw = [];
  try { raw.push(homedir()); } catch { /* no home folder */ }
  for (const v of [process.env.HOME, process.env.USERPROFILE]) if (v) raw.push(v);
  return [...new Set(raw.filter(Boolean).map(canonical))];
}

/** True when `dir` is the home folder, however it is written.
 * @param {string} dir */
export function isHomeFolder(dir) {
  const c = canonical(dir);
  return homeFolders().includes(c);
}

/** True when `file` (after symlinks) is inside `root` (after symlinks).
 * @param {string} file @param {string} root */
function inside(file, root) {
  const f = canonical(file);
  const r = canonical(root);
  return f === r || f.startsWith(r.endsWith(sep) ? r : r + sep);
}

const HOME_REFUSED = {
  en: "refusing to look for MCP configs in the home folder: that is where personal and global configs live, and they are never read implicitly. Run from the project folder, or name a file with --config once the user has agreed to it.",
  pt: "recusado procurar configurações MCP na pasta pessoal: ali ficam as configurações pessoais e globais, que nunca são lidas implicitamente. Rode da pasta do projeto, ou indique um arquivo com --config depois que a pessoa concordar.",
};

/** Exists and may be read; a path the process is not allowed to see counts as absent. */
/** @param {string} f */
function present(f) {
  try { return existsSync(f); } catch { return false; }
}

/** Project-level config files looked up when no --config is given. Never the home folder. */
export const DEFAULT_CONFIGS = [".mcp.json", ".cursor/mcp.json", ".vscode/mcp.json", ".claude/settings.json", ".claude/settings.local.json"];

const USAGE = `usage: mcp-guardian.mjs [--config FILE]... [--tools [SERVER=]FILE]... [--pins FILE] [--emit-pins]
                       [--critical-pattern TEXT|/REGEX/]... [--format md|json] [--lang en|pt]
                       [--fail-on INFO|LOW|MEDIUM|HIGH|CRITICAL|never] [--root DIR]`;

/**
 * @param {string[]} argv
 * @returns {{ ok: true, o: { configs: string[], tools: { server: string, file: string }[], pins: string | null, emitPins: boolean, critical: string[], format: "md" | "json", lang: "en" | "pt", failOn: string, root: string } } | { ok: false, error: string }}
 */
export function parseArgs(argv) {
  const o = { configs: /** @type {string[]} */ ([]), tools: /** @type {{ server: string, file: string }[]} */ ([]), pins: /** @type {string | null} */ (null), emitPins: false, critical: /** @type {string[]} */ ([]), format: /** @type {"md" | "json"} */ ("md"), lang: /** @type {"en" | "pt"} */ ("en"), failOn: "HIGH", root: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = /** @type {string} */ (argv[i]);
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    try {
      if (a === "--config") o.configs.push(next());
      else if (a === "--tools") {
        const v = next();
        const eq = v.indexOf("=");
        o.tools.push(eq > 0 && !/^[A-Za-z]:[\\/]/.test(v) ? { server: v.slice(0, eq), file: v.slice(eq + 1) } : { server: "", file: v });
      } else if (a === "--pins") o.pins = next();
      else if (a === "--emit-pins") o.emitPins = true;
      else if (a === "--critical-pattern") o.critical.push(next());
      else if (a === "--format") { const v = next(); if (v !== "md" && v !== "json") throw new Error("--format is md or json"); o.format = v; }
      else if (a === "--lang") { const v = next(); if (v !== "en" && v !== "pt") throw new Error("--lang is en or pt"); o.lang = v; }
      else if (a === "--fail-on") { const v = next().toUpperCase(); if (v !== "NEVER" && !SEVERITIES.includes(/** @type {any} */ (v))) throw new Error("--fail-on is INFO, LOW, MEDIUM, HIGH, CRITICAL or never"); o.failOn = v; }
      else if (a === "--root") o.root = next();
      else if (a === "-h" || a === "--help") return { ok: false, error: USAGE };
      // Echo the option only when it is a plain option name: a pasted credential must not come back.
      else return { ok: false, error: `unknown option${/^--?[a-z][a-z-]{0,30}$/.test(a) ? ` ${a}` : ""}\n${USAGE}` };
    } catch (e) {
      return { ok: false, error: `${e instanceof Error ? e.message : String(e)}\n${USAGE}` };
    }
  }
  return { ok: true, o };
}

/**
 * Runs the audit and returns what to print and the exit code. No side effects besides reading files.
 * @param {string[]} argv
 * @returns {{ out: string, err: string, code: number }}
 */
export function run(argv) {
  const p = parseArgs(argv);
  if (!p.ok) return { out: "", err: p.error, code: 2 };
  const o = p.o;
  let critical;
  try { critical = parseCriticalPatterns(o.critical); } catch (e) { return { out: "", err: `invalid --critical-pattern: ${e instanceof Error ? safeText(e.message, 120) : ""}`, code: 2 }; }
  const root = resolve(o.root);
  /** @param {string} f */
  const label = (f) => safeText(relative(root, resolve(root, f)) || f, 120);

  /** @type {import("./lib/audit.mjs").Finding[]} */
  const findings = [];
  const implicit = !o.configs.length && !o.tools.length;
  if (implicit && isHomeFolder(root)) return { out: "", err: HOME_REFUSED[o.lang], code: 2 };
  /** @type {string[]} */
  let configs = o.configs;
  if (implicit) {
    configs = [];
    for (const f of DEFAULT_CONFIGS) {
      const path = join(root, f);
      if (!present(path)) continue;
      // A default path that leads out of the project (symlinked folder) may be a personal config.
      if (!inside(path, root)) { findings.push({ code: "IMPLICIT_PATH_OUTSIDE_PROJECT", severity: "MEDIUM", file: label(path), target: "", data: "" }); continue; }
      configs.push(path);
    }
  }
  /** @type {{ name: string, transport: string, endpoint: string }[]} */
  const servers = [];
  /** @type {string[]} */
  const files = [];
  for (const c of configs) {
    const path = resolve(root, c);
    files.push(label(path));
    const r = readJsonFile(path);
    if (!r.ok) { findings.push({ code: r.code, severity: "HIGH", file: label(path), target: "", data: "" }); continue; }
    const a = auditConfig(r.value, label(path));
    findings.push(...a.findings);
    servers.push(...a.servers);
  }
  /** @type {{ server: string, file: string, tools: Record<string, unknown>[] }[]} */
  const listings = [];
  for (const t of o.tools) {
    const path = resolve(root, t.file);
    files.push(label(path));
    const r = readJsonFile(path);
    if (!r.ok) { findings.push({ code: r.code, severity: "HIGH", file: label(path), target: "", data: "" }); continue; }
    listings.push({ server: t.server || safeText(t.file.replace(/^.*[\\/]/, "").replace(/\.json$/i, ""), 60), file: label(path), tools: toolsFromListing(r.value) });
  }
  let pins;
  if (o.pins) {
    const path = resolve(root, o.pins);
    files.push(label(path));
    const r = readJsonFile(path);
    if (!r.ok) findings.push({ code: r.code, severity: "HIGH", file: label(path), target: "", data: "" });
    else pins = r.value;
  }
  const t = auditTools(listings, { extraCritical: critical, pins });
  findings.push(...t.findings);

  if (o.emitPins) {
    // Pins go to stdout; the person decides where to save them. This program writes no file.
    return { out: scrubCredentials(JSON.stringify({ version: 1, tools: Object.fromEntries(Object.entries(t.pins).sort()) }, null, 2)), err: "", code: 0 };
  }
  const report = { files, servers, findings, rows: t.rows };
  const out = o.format === "json" ? renderJson(report) : renderMarkdown(report, o.lang);
  const worst = findings.reduce((m, f) => Math.max(m, severityRank(f.severity)), -1);
  const code = o.failOn === "NEVER" ? 0 : worst >= severityRank(/** @type {any} */ (o.failOn)) ? 1 : 0;
  return { out, err: "", code };
}

// Only when executed directly (the tests import run()).
const direct = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  const r = run(process.argv.slice(2));
  if (r.out) process.stdout.write(`${r.out}\n`);
  if (r.err) process.stderr.write(`${r.err}\n`);
  process.exitCode = r.code;
}

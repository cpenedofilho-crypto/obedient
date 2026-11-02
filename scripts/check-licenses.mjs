#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Reprova o CI quando entra dependência com licença fora da allowlist (docs/licensing/excecoes.md).
// Lê o package-lock.json; não precisa de rede.
import { readFileSync } from "node:fs";

const ALLOWED = new Set(["MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "Unlicense", "CC0-1.0", "BlueOak-1.0.0", "Zlib", "MIT-0", "Python-2.0", "CC-BY-4.0", "OFL-1.1"]);
const REVIEW = [/^LGPL-/, /^MPL-2\.0$/];

// Exceções aprovadas: "nome@licença" → motivo. Manter em sincronia com docs/licensing/excecoes.md.
const EXCEPTIONS = new Map([]);

function idOk(id) {
  return ALLOWED.has(id.replace(/^\(|\)$/g, "").trim());
}

/** Avalia expressão SPDX simples: OR basta um lado; AND precisa de todos. */
function evaluate(expr) {
  const e = expr.trim().replace(/^\((.*)\)$/, "$1");
  if (/ OR /.test(e)) return e.split(/ OR /).some((p) => evaluate(p));
  if (/ AND /.test(e)) return e.split(/ AND /).every((p) => evaluate(p));
  return idOk(e);
}

const lockPath = process.argv[2] ?? new URL("../package-lock.json", import.meta.url);
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const problems = [];
const review = [];
for (const [path, meta] of Object.entries(lock.packages ?? {})) {
  if (!path || meta.link || !path.includes("node_modules/")) continue;
  const name = path.split("node_modules/").pop();
  let lic = meta.license;
  if (lic && typeof lic === "object") lic = lic.type;
  const key = `${name}@${lic ?? "UNKNOWN"}`;
  if (EXCEPTIONS.has(key)) continue;
  if (!lic) problems.push(`${name}@${meta.version}: sem licença declarada`);
  else if (REVIEW.some((r) => r.test(lic))) review.push(`${name}@${meta.version}: ${lic}`);
  else if (!evaluate(lic)) problems.push(`${name}@${meta.version}: ${lic}`);
}

if (review.length) console.log(`Precisam de linha em docs/licensing/excecoes.md:\n  ${review.join("\n  ")}`);
if (problems.length || review.length) {
  if (problems.length) console.error(`Licenças bloqueadas ou desconhecidas:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`licenças ok (${Object.keys(lock.packages ?? {}).length - 1} entradas no lockfile)`);

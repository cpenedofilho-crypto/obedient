// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
// @ts-check
//
// Rendering. Every string from audited files was already passed through safeText; the whole output
// still goes through scrubCredentials before it is printed (defence in depth: no value that has the
// shape of a credential leaves the process).

import { fix, title } from "./messages.mjs";
import { scrubCredentials } from "./secrets.mjs";
import { severityRank } from "./audit.mjs";

/** @typedef {import("./audit.mjs").Finding} Finding */
/** @typedef {import("./audit.mjs").ToolRow} ToolRow */

const L = {
  en: {
    heading: "MCP Guardian report", mode: "Read-only run: no network connection was made, no file was written, no tool was called.",
    files: "Files read", servers: "Servers", findings: "Findings", tools: "Tools", none: "No findings at or above INFO.",
    sev: "Severity", what: "What", where: "Where", data: "Data", fixh: "What to do", server: "Server", transport: "Transport", endpoint: "Endpoint",
    tool: "Tool", risk: "Risk", category: "Category", usable: "Schema ok", signals: "Signals in description",
    untrusted: "Tool names and descriptions come from the servers and are untrusted data. Descriptions are not reproduced here.",
    summary: "Summary", yes: "yes", no: "no",
    riskNote: "Risk and category come from the tool NAME and boolean annotations only; an annotation never lowers what the name reveals.",
  },
  pt: {
    heading: "Relatório do MCP Guardian", mode: "Execução somente leitura: nenhuma conexão de rede, nenhum arquivo escrito, nenhuma ferramenta chamada.",
    files: "Arquivos lidos", servers: "Servidores", findings: "Achados", tools: "Ferramentas", none: "Nenhum achado.",
    sev: "Gravidade", what: "O quê", where: "Onde", data: "Dados", fixh: "O que fazer", server: "Servidor", transport: "Transporte", endpoint: "Endereço",
    tool: "Ferramenta", risk: "Risco", category: "Categoria", usable: "Esquema ok", signals: "Sinais na descrição",
    untrusted: "Nomes e descrições de ferramenta vêm dos servidores e são dados não confiáveis. As descrições não são reproduzidas aqui.",
    summary: "Resumo", yes: "sim", no: "não",
    riskNote: "Risco e categoria saem só do NOME da ferramenta e das anotações booleanas; anotação nunca rebaixa o que o nome revela.",
  },
};

/**
 * @param {{ files: string[], servers: { name: string, transport: string, endpoint: string }[], findings: Finding[], rows: ToolRow[] }} r
 * @param {"en" | "pt"} lang
 */
export function renderMarkdown(r, lang) {
  const t = L[lang];
  const findings = [...r.findings].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  const count = (/** @type {string} */ s) => findings.filter((f) => f.severity === s).length;
  /** @type {string[]} */
  const out = [`# ${t.heading}`, "", `> ${t.mode}`, ""];
  out.push(`**${t.summary}:** CRITICAL ${count("CRITICAL")} · HIGH ${count("HIGH")} · MEDIUM ${count("MEDIUM")} · LOW ${count("LOW")} · INFO ${count("INFO")}`, "");
  out.push(`## ${t.files}`, "", ...(r.files.length ? r.files.map((f) => `- ${f}`) : ["- —"]), "");
  if (r.servers.length) {
    out.push(`## ${t.servers}`, "", `| ${t.server} | ${t.transport} | ${t.endpoint} |`, "| --- | --- | --- |");
    for (const s of r.servers) out.push(`| ${s.name} | ${s.transport} | ${s.endpoint} |`);
    out.push("");
  }
  out.push(`## ${t.findings}`, "");
  if (!findings.length) out.push(t.none, "");
  else {
    out.push(`| ${t.sev} | ${t.what} | ${t.where} | ${t.data} | ${t.fixh} |`, "| --- | --- | --- | --- | --- |");
    for (const f of findings) out.push(`| ${f.severity} | ${title(f.code, lang)} (\`${f.code}\`) | ${[f.file, f.target].filter(Boolean).join(" · ")} | ${f.data || "—"} | ${fix(f.code, lang)} |`);
    out.push("");
  }
  if (r.rows.length) {
    out.push(`## ${t.tools}`, "", `_${t.untrusted}_`, "", `_${t.riskNote}_`, "");
    out.push(`| ${t.server} | ${t.tool} | ${t.risk} | ${t.category} | ${t.usable} | ${t.signals} |`, "| --- | --- | --- | --- | --- | --- |");
    for (const row of r.rows) out.push(`| ${row.server} | ${row.tool} | ${row.risk} | ${row.category} | ${row.usable ? t.yes : t.no} | ${row.signals.join(", ") || "—"} |`);
    out.push("");
  }
  return scrubCredentials(out.join("\n"));
}

/**
 * @param {{ files: string[], servers: { name: string, transport: string, endpoint: string }[], findings: Finding[], rows: ToolRow[] }} r
 */
export function renderJson(r) {
  const findings = [...r.findings].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  return scrubCredentials(JSON.stringify({
    tool: "casa-mcp-guardian", version: 1, mode: { network: false, writes: false, toolCalls: false },
    files: r.files, servers: r.servers,
    findings: findings.map((f) => ({ ...f, title: title(f.code, "en") })),
    tools: r.rows,
  }, null, 2));
}

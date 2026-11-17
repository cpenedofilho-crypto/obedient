// SPDX-License-Identifier: AGPL-3.0-only
// Non-leakage: no credential, or any 8-character piece of one, appears in any output, in any format or
// language, including the pin output and the error paths.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { run } from "../scripts/mcp-guardian.mjs";
import { findLiteralSecrets, scrubCredentials } from "../scripts/lib/secrets.mjs";
import { fakeSecrets, fragments, tempProject } from "./helpers.mjs";

function project() {
  const s = fakeSecrets();
  const dir = tempProject({
    ".mcp.json": {
      mcpServers: {
        stdio: { command: "node", args: ["server.js", "--api-key", s.plain, `--token=${s.github}`], env: { ANTHROPIC_API_KEY: s.anthropic, AWS_ACCESS_KEY_ID: s.aws, SAFE: "${SAFE_TOKEN}", DB_PASSWORD: s.plain } },
        remote: { type: "http", url: `https://admin:${s.urlPass}@mcp.example.com/mcp?access_token=${s.jwt}`, headers: { Authorization: `Bearer ${s.github}`, "X-Api-Key": s.plain, Ok: "Bearer ${MCP_TOKEN}" } },
      },
    },
    "tools.json": { tools: [
      { name: "list_items", inputSchema: { type: "object" }, description: `Uses key ${s.anthropic} internally.` },
      { name: "get_token", inputSchema: { type: "object", properties: { k: { type: "string", description: `default ${s.github}` } } } },
    ] },
  });
  return { s, dir };
}

function assertNoLeak(text, s, where) {
  for (const [name, secret] of Object.entries(s)) {
    assert.ok(!text.includes(secret), `${where}: full ${name} leaked`);
    for (const f of fragments(secret)) assert.ok(!text.includes(f), `${where}: a piece of ${name} leaked`);
  }
}

describe("no credential leaves the process", () => {
  it("markdown and JSON, English and Portuguese, report and pins", () => {
    const { s, dir } = project();
    for (const extra of [[], ["--lang", "pt"], ["--format", "json"], ["--emit-pins"]]) {
      const r = run(["--root", dir, "--config", ".mcp.json", "--tools", "srv=tools.json", ...extra]);
      assertNoLeak(r.out + r.err, s, extra.join(" ") || "default");
    }
  });

  it("every literal is found, and references are not", () => {
    const { s, dir } = project();
    const r = run(["--root", dir, "--config", ".mcp.json", "--format", "json", "--fail-on", "never"]);
    const lit = JSON.parse(r.out).findings.filter((f) => f.code === "LITERAL_SECRET").map((f) => f.data);
    for (const k of [".args[2] (sensitive_flag)", ".args[3] (credential_shape)", ".env.ANTHROPIC_API_KEY (credential_shape)", ".env.AWS_ACCESS_KEY_ID (credential_shape)", ".env.DB_PASSWORD (sensitive_key)", ".headers.Authorization (credential_shape)", ".headers.X-Api-Key (sensitive_key)"])
      assert.ok(lit.includes(k), `${k} in ${JSON.stringify(lit)}`);
    assert.ok(!lit.some((x) => x.includes("SAFE") || x.includes(".headers.Ok")), "references are not findings");
    const codes = JSON.parse(r.out).findings.map((f) => f.code);
    assert.ok(codes.includes("URL_CREDENTIALS") && codes.includes("URL_SECRET_PARAM"));
    assertNoLeak(r.out, s, "json");
  });

  it("errors never echo the input", () => {
    const s = fakeSecrets();
    const r = run([`--${s.anthropic}`]);
    assert.equal(r.code, 2);
    assertNoLeak(r.out + r.err, s, "unknown option");
    const dir = tempProject({ "bad.json": `{ "mcpServers": { "x": { "env": { "K": "${s.anthropic}" } } ` });
    const b = run(["--root", dir, "--config", "bad.json"]);
    assert.match(b.out, /FILE_NOT_JSON/);
    assertNoLeak(b.out + b.err, s, "broken JSON");
  });

  it("scrubCredentials is the last line of defence", () => {
    const s = fakeSecrets();
    const text = `a ${s.anthropic} b ${s.github} c ${s.aws} d ${s.jwt}`;
    assertNoLeak(scrubCredentials(text), { anthropic: s.anthropic, github: s.github, aws: s.aws, jwt: s.jwt }, "scrub");
  });

  it("findLiteralSecrets returns paths, never values", () => {
    const s = fakeSecrets();
    const hits = findLiteralSecrets({ env: { TOKEN: s.plain }, args: ["--password", s.plain] }, "x");
    assert.ok(hits.length === 2);
    assertNoLeak(JSON.stringify(hits), { plain: s.plain }, "hits");
  });
});

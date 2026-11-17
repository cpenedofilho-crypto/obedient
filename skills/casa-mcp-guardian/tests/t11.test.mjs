// SPDX-License-Identifier: AGPL-3.0-only
// Regressions for the findings of the independent review of T10 (fixed in T11).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../scripts/mcp-guardian.mjs";
import { pinOf } from "../scripts/lib/audit.mjs";
import { opaqueId } from "../scripts/lib/present.mjs";
import { CLI, tempProject } from "./helpers.mjs";

/** @param {string[]} args @param {{ cwd?: string }} [o] */
const cli = (args, o = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: o.cwd, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const json = (/** @type {string[]} */ args) => JSON.parse(run([...args, "--format", "json", "--fail-on", "never"]).out);
const codes = (/** @type {string[]} */ args) => json(args).findings.map((/** @type {any} */ f) => f.code);

describe("N1: the same tool of the same server in two listings is never accepted silently", () => {
  const a = { name: "get_doc", description: "Reads.", inputSchema: { type: "object" } };
  const a2 = { name: "get_doc", description: "Reads and deletes.", inputSchema: { type: "object" } };
  const pins = { version: 2, tools: { [opaqueId("tool", "s", "get_doc")]: { server: opaqueId("server", "s"), sha256: pinOf(a) } } };

  it("two --tools with the same server name: TOOL_DUPLICATE_NAME, and a changed copy is TOOL_CHANGED", () => {
    const dir = tempProject({ "a.json": { tools: [a] }, "a2.json": { tools: [a2] }, "p.json": pins });
    const c = codes(["--root", dir, "--tools", "s=a2.json", "--tools", "s=a.json", "--pins", "p.json"]);
    assert.ok(c.includes("TOOL_DUPLICATE_NAME"), c.join());
    assert.ok(c.includes("TOOL_CHANGED"), c.join());
    const same = codes(["--root", dir, "--tools", "s=a.json", "--tools", "s=a.json", "--pins", "p.json"]);
    assert.ok(same.includes("TOOL_DUPLICATE_NAME"), same.join());
  });

  it("server names derived from two files with the same name count as the same server", () => {
    const dir = tempProject({});
    mkdirSync(join(dir, "d1")); mkdirSync(join(dir, "d2"));
    writeFileSync(join(dir, "d1", "s.json"), JSON.stringify({ tools: [a] }));
    writeFileSync(join(dir, "d2", "s.json"), JSON.stringify({ tools: [a2] }));
    assert.ok(codes(["--root", dir, "--tools", "d1/s.json", "--tools", "d2/s.json"]).includes("TOOL_DUPLICATE_NAME"));
  });

  it("--emit-pins refuses it (exit 2, nothing on stdout); different servers are fine", () => {
    const dir = tempProject({ "a.json": { tools: [a] }, "a2.json": { tools: [a2] } });
    const r = cli(["--root", dir, "--tools", "s=a.json", "--tools", "s=a2.json", "--emit-pins"]);
    assert.equal(r.code, 2);
    assert.equal(r.out, "");
    const ok = cli(["--root", dir, "--tools", "s=a.json", "--tools", "t=a2.json", "--emit-pins"]);
    assert.equal(ok.code, 0, ok.err);
    assert.equal(Object.keys(JSON.parse(ok.out).tools).length, 2);
  });
});

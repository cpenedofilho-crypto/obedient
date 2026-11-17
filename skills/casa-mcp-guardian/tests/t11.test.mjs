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
import { assessUrl } from "../scripts/lib/endpoint.mjs";
import { syntheticTokens } from "./helpers.mjs";
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

describe("N6: an invisible character inside a token does not defeat default-mode masking", () => {
  const TOKENS = ["aB3-xY9_kL2-mN7_pQ4-rS8_tU1-vW6", "Zq8xW2kL9mN4pR7tV3yB6cF1hJ5sD0gA", "q7154ccf8f143ed5872390226bfe5cb3"];
  const HIDDEN = ["​", "\u001b[0m", "⁠", "‮", "﻿"];
  it("server, tool, file, key, auto-approved tool and package names, in Markdown, JSON and pins", () => {
    for (const tok of TOKENS) {
      for (const h of HIDDEN) {
        const z = `${tok.slice(0, 15)}${h}${tok.slice(15)}`;
        const dir = tempProject({
          [`cfg-${z}.json`]: { mcpServers: {
            [`srv_${z}`]: { type: "http", url: "https://h.example.com/" },
            b: { command: "npx", args: ["-y", `pkg_${z}`], env: { [`TOKEN_${z}`]: "x" }, alwaysAllow: [`tool_${z}`] },
          } },
          "t.json": { tools: [{ name: `get_${z}`, inputSchema: { type: "object" } }] },
        });
        for (const extra of [[], ["--format", "json"], ["--lang", "pt"], ["--emit-pins"]]) {
          const r = run(["--root", dir, "--config", `cfg-${z}.json`, "--tools", `s_${z}=t.json`, "--fail-on", "never", ...extra]);
          const text = `${r.out}\n${r.err}`;
          for (let i = 0; i + 8 <= tok.length; i++) assert.ok(!text.includes(tok.slice(i, i + 8)), `${JSON.stringify(h)} ${extra.join(" ")}`);
        }
      }
    }
  });
});

describe("N2 + N3: the package is found after '--', in '=' forms and after common boolean flags", () => {
  const pkg = (/** @type {string} */ cmd, /** @type {string[]} */ args) => {
    const dir = tempProject({ ".mcp.json": { mcpServers: { a: { command: cmd, args } } } });
    const r = json(["--root", dir]);
    return { names: r.findings.filter((/** @type {any} */ f) => f.code === "UNPINNED_PACKAGE").map((/** @type {any} */ f) => f.data), all: JSON.stringify(r) };
  };
  it("'--' marks the package (npx, npm exec)", () => {
    assert.deepEqual(pkg("npx", ["--", "@scope/server"]).names, ["@scope/server"]);
    assert.deepEqual(pkg("npm", ["exec", "--", "@scope/server"]).names, ["@scope/server"]);
    assert.deepEqual(pkg("npm", ["exec", "--registry", "https://r.example.com", "--", "@scope/server"]).names, ["@scope/server"]);
    assert.deepEqual(pkg("npx", ["--", "@scope/server@1.2.3"]).names, []);
  });
  it("common boolean flags do not hide the package", () => {
    assert.deepEqual(pkg("npx", ["--ignore-scripts", "pkg"]).names, ["pkg"]);
    assert.deepEqual(pkg("bunx", ["--bun", "pkg"]).names, ["pkg"]);
    assert.deepEqual(pkg("npx", ["--yes", "--ignore-scripts", "--no-install", "pkg"]).names, ["pkg"]);
  });
  it("package flags written with '=' are read, and their value is the package", () => {
    assert.deepEqual(pkg("npx", ["--package=@s/p", "cmd"]).names, ["@s/p"]);
    assert.deepEqual(pkg("npx", ["-p=@s/p", "cmd"]).names, ["@s/p"]);
    assert.deepEqual(pkg("npx", ["--package=@s/p@1.2.3", "cmd"]).names, []);
    assert.deepEqual(pkg("uvx", ["--from=x", "cmd"]).names, ["x"]);
    assert.deepEqual(pkg("pipx", ["run", "--spec=y", "cmd"]).names, ["y"]);
  });
  it("--color takes a value, and the value is never shown as a package", () => {
    const r = pkg("npx", ["--color", "always", "pkg"]);
    assert.deepEqual(r.names, ["pkg"]);
    assert.ok(!r.all.includes("always"));
  });
});

describe("N4: --emit-pins with no listing refuses instead of printing an empty pin file", () => {
  it("no --tools at all, or only configs: exit 2, nothing on stdout", () => {
    const dir = tempProject({ "empty.json": { mcpServers: {} }, ".mcp.json": { mcpServers: { a: { url: "https://a.example.com/" } } } });
    for (const args of [["--emit-pins"], ["--config", "empty.json", "--emit-pins"], ["--config", ".mcp.json", "--emit-pins", "--redact-names"]]) {
      const r = cli(["--root", dir, ...args]);
      assert.equal(r.code, 2, args.join(" "));
      assert.equal(r.out, "");
      assert.match(r.err, /cannot emit pins/);
    }
  });
});

describe("N5: a token after a backslash right after the host is still found", () => {
  it("https://host\\TOKEN\\.. and similar", () => {
    const t = syntheticTokens(5, 32).mixed;
    for (const u of [`https://h.example\\${t}\\..`, `https://h.example\\a\\${t}`, `https://h.example/a\\${t}\\..`]) {
      const a = assessUrl(u);
      assert.ok(a.findings.some((f) => f.code === "URL_SECRET_PATH"), u);
      assert.ok(!a.display.includes(t.slice(0, 8)));
    }
  });
});


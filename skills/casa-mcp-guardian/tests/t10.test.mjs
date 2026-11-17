// SPDX-License-Identifier: AGPL-3.0-only
// Regressions for the findings of the independent review T9 (fixed in T10). Some cases run the real
// executable in a child process, so crashes, standard error and exit codes are what a user would see.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { assessUrl } from "../scripts/lib/endpoint.mjs";
import { syntheticTokens } from "./helpers.mjs";
import { main, run } from "../scripts/mcp-guardian.mjs";
import { pinOf } from "../scripts/lib/audit.mjs";
import { opaqueId } from "../scripts/lib/present.mjs";
import { CLI, tempProject } from "./helpers.mjs";

/** Runs the real executable. @param {string[]} args @param {{ cwd?: string, env?: Record<string, string> }} [o] */
export function cli(args, o = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: o.cwd, env: { ...process.env, ...(o.env ?? {}) }, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const json = (/** @type {string[]} */ args) => JSON.parse(run([...args, "--format", "json", "--fail-on", "never"]).out);
const codes = (/** @type {string[]} */ args) => json(args).findings.map((/** @type {any} */ f) => f.code);

describe("F1: a listing with duplicate tool names is never accepted silently", () => {
  const doc = { name: "get_doc", description: "Reads a doc.", inputSchema: { type: "object" } };
  const changed = { name: "get_doc", description: "Reads a doc and also deletes it.", inputSchema: { type: "object", properties: { x: { type: "string" } } }, annotations: { readOnlyHint: true } };
  const pinsFor = (/** @type {Record<string, unknown>} */ t) => ({ version: 3, tools: { [opaqueId("tool", "s", "get_doc")]: { server: opaqueId("server", "s"), sha256: pinOf(t) } } });

  it("one of two same-named tools changed: TOOL_CHANGED and TOOL_DUPLICATE_NAME", () => {
    const dir = tempProject({ "v3.json": { tools: [changed, doc] }, "pins.json": pinsFor(doc) });
    const c = codes(["--root", dir, "--tools", "s=v3.json", "--pins", "pins.json"]);
    assert.ok(c.includes("TOOL_CHANGED"), c.join());
    assert.ok(c.includes("TOOL_DUPLICATE_NAME"), c.join());
    // Order does not matter.
    const dir2 = tempProject({ "v3.json": { tools: [doc, changed] }, "pins.json": pinsFor(doc) });
    assert.ok(codes(["--root", dir2, "--tools", "s=v3.json", "--pins", "pins.json"]).includes("TOOL_CHANGED"));
  });

  it("identical duplicates are still reported, as HIGH, so the default --fail-on fails", () => {
    const dir = tempProject({ "v.json": { tools: [doc, doc] }, "pins.json": pinsFor(doc) });
    const r = run(["--root", dir, "--tools", "s=v.json", "--pins", "pins.json", "--format", "json"]);
    const f = JSON.parse(r.out).findings.find((/** @type {any} */ x) => x.code === "TOOL_DUPLICATE_NAME");
    assert.equal(f?.severity, "HIGH");
    assert.equal(r.code, 1);
  });

  it("--emit-pins refuses a listing with duplicate names (exit 2, nothing on stdout)", () => {
    const dir = tempProject({ "v.json": { tools: [doc, doc] } });
    for (const extra of [[], ["--redact-names"]]) {
      const r = cli(["--root", dir, "--tools", "s=v.json", "--emit-pins", ...extra]);
      assert.equal(r.code, 2, r.err);
      assert.equal(r.out, "");
      assert.match(r.err, /duplicate/);
    }
  });
});

describe("F2: names that differ only in lone surrogates get different ids", () => {
  it("lone surrogates and U+FFFD are not merged by the UTF-8 encoder", () => {
    const ids = ["a\ud800", "a\udfff", "a\udc00", "a�", "a"].map((n) => opaqueId("tool", "s", n));
    assert.equal(new Set(ids).size, ids.length);
  });
  it("two such tools in one listing give two pins", () => {
    const dir = tempProject({ "t.json": JSON.stringify({ tools: [{ name: "get_a\ud800", inputSchema: { type: "object" } }, { name: "get_a\udc00", inputSchema: { type: "object" } }] }) });
    const pins = JSON.parse(run(["--root", dir, "--tools", "s=t.json", "--emit-pins"]).out);
    assert.equal(Object.keys(pins.tools).length, 2);
  });
});

describe("F3: the value of a flag is never taken for the package", () => {
  const c = (/** @type {string} */ cmd, /** @type {string[]} */ args) => {
    const dir = tempProject({ ".mcp.json": { mcpServers: { a: { command: cmd, args } } } });
    return json(["--root", dir]);
  };
  const SECRET = "kingfisherpaperlantern";
  it("npx --token VALUE @scope/server: the package is @scope/server and VALUE never appears", () => {
    for (const extra of [[], ["--lang", "pt"]]) {
      const dir = tempProject({ ".mcp.json": { mcpServers: { a: { command: "npx", args: ["--token", SECRET, "@scope/server"] } } } });
      const out = run(["--root", dir, "--fail-on", "never", ...extra]).out;
      assert.ok(!out.includes(SECRET), "markdown");
    }
    const r = c("npx", ["--token", SECRET, "@scope/server"]);
    assert.ok(!JSON.stringify(r).includes(SECRET), "json");
    assert.deepEqual(r.findings.filter((/** @type {any} */ f) => f.code === "UNPINNED_PACKAGE").map((/** @type {any} */ f) => f.data), ["@scope/server"]);
  });
  it("value-taking flags are skipped, so the real package is judged", () => {
    const pkg = (/** @type {any} */ r) => r.findings.filter((/** @type {any} */ f) => f.code === "UNPINNED_PACKAGE").map((/** @type {any} */ f) => f.data);
    assert.deepEqual(pkg(c("npx", ["--registry", "https://r.example.com", "real-pkg@1.2.3"])), []);
    assert.deepEqual(pkg(c("npx", ["--registry", "https://r.example.com", "real-pkg"])), ["real-pkg"]);
    assert.deepEqual(pkg(c("npx", ["-y", "--api-key", SECRET, "real-pkg"])), ["real-pkg"]);
    assert.deepEqual(pkg(c("uvx", ["--index-url", "https://i.example.com", "pkg==1.0.0"])), []);
    assert.deepEqual(pkg(c("uvx", ["--index-url", "https://i.example.com", "pkg"])), ["pkg"]);
    assert.deepEqual(pkg(c("pipx", ["run", "--index-url", "https://i.example.com", "pkg"])), ["pkg"]);
    assert.deepEqual(pkg(c("pnpm", ["dlx", "--reporter", "silent", "srv"])), ["srv"]);
    // Boolean flags still do not swallow the package.
    assert.deepEqual(pkg(c("npx", ["-y", "@scope/server"])), ["@scope/server"]);
    assert.deepEqual(pkg(c("npx", ["--yes", "--quiet", "server@latest"])), ["server"]);
    assert.deepEqual(pkg(c("uvx", ["--offline", "mcp-server-x"])), ["mcp-server-x"]);
  });
  it("an unknown flag never makes its value the package: at worst the package is not judged", () => {
    const r = c("npx", ["--some-new-flag", SECRET]);
    assert.ok(!JSON.stringify(r).includes(SECRET));
  });
});

describe("F4: hostile or malformed input is rejected, never crashes", () => {
  const listing = { tools: [{ name: "x", inputSchema: { type: "object" } }] };
  it("pins with non-string fields are PINS_INVALID (real executable, nothing on stderr)", () => {
    const id = opaqueId("tool", "s", "x");
    for (const entry of [{ server: { toString: 1, valueOf: 1 }, sha256: "x" }, { server: opaqueId("server", "s"), sha256: 7 }, { server: opaqueId("server", "s"), sha256: "0".repeat(64), label: { a: 1 } }, null, []]) {
      const dir = tempProject({ "t.json": listing, "p.json": { version: 3, tools: { [id]: entry } } });
      const r = cli(["--root", dir, "--tools", "s=t.json", "--pins", "p.json", "--format", "json", "--fail-on", "never"]);
      assert.equal(r.code, 0, r.err);
      assert.equal(r.err, "");
      assert.ok(JSON.parse(r.out).findings.some((/** @type {any} */ f) => f.code === "PINS_INVALID"), JSON.stringify(entry));
    }
  });
  it("a tool nested 200,000 levels deep is a finding, not a stack overflow", () => {
    const deep = `${"[".repeat(200000)}${"]".repeat(200000)}`;
    const dir = tempProject({ "t.json": `{"tools":[{"name":"deep_tool","inputSchema":{"type":"object","properties":{"x":${deep}}}},{"name":"ok_tool","inputSchema":{"type":"object"}}]}` });
    const r = cli(["--root", dir, "--tools", "s=t.json", "--format", "json", "--fail-on", "never"]);
    assert.equal(r.code, 0, r.err.slice(0, 200));
    assert.equal(r.err, "");
    const out = JSON.parse(r.out);
    assert.ok(out.findings.some((/** @type {any} */ f) => f.code === "TOOL_SCHEMA_TOO_DEEP"));
    assert.equal(out.tools.length, 2);
    const e = cli(["--root", dir, "--tools", "s=t.json", "--emit-pins"]);
    assert.equal(e.code, 2);
    assert.equal(e.out, "");
    assert.doesNotMatch(e.err, /\n\s+at |RangeError|\.mjs/);
  });
  it("any unexpected error becomes a fixed message and exit code 2, never a stack trace or the input", () => {
    const r = main(["--x"], () => { throw new Error("leaked-input-text-qwerty /home/someone/secret"); });
    assert.equal(r.code, 2);
    assert.equal(r.out, "");
    assert.doesNotMatch(r.err, /qwerty|someone|Error:|\n\s+at /);
    assert.match(r.err, /internal error/);
  });
});

describe("F5: --emit-pins refuses when an input could not be read", () => {
  it("missing, invalid or empty listings do not produce an empty pin file", () => {
    const dir = tempProject({ "bad.json": "{not json", "ok.json": { tools: [{ name: "x", inputSchema: { type: "object" } }] } });
    for (const files of [["s=missing.json"], ["s=bad.json"], ["s=ok.json", "t=missing.json"]]) {
      for (const extra of [[], ["--redact-names"]]) {
        const r = cli(["--root", dir, ...files.flatMap((f) => ["--tools", f]), "--emit-pins", ...extra]);
        assert.equal(r.code, 2, files.join());
        assert.equal(r.out, "");
        assert.match(r.err, /cannot emit pins/);
      }
    }
    const ok = cli(["--root", dir, "--tools", "s=ok.json", "--emit-pins"]);
    assert.equal(ok.code, 0);
    assert.equal(Object.keys(JSON.parse(ok.out).tools).length, 1);
  });
});

describe("F6: the home folder is recognized even when HOME points elsewhere", () => {
  it("run from the account's real home folder with HOME changed: refused", () => {
    const real = userInfo().homedir;
    const other = tempProject({});
    const r = cli([], { cwd: real, env: { HOME: other, USERPROFILE: other } });
    assert.equal(r.code, 2, r.out.slice(0, 200));
    assert.match(r.err, /home folder/);
  });
});

describe("F7: URL_SECRET_PATH also sees the raw path and the fragment", () => {
  const t = syntheticTokens(7, 40).mixed;
  it("a token removed by '..' normalization is still found", () => {
    const a = assessUrl(`https://h.example.com/hooks/${t}/../x`);
    assert.ok(a.findings.some((f) => f.code === "URL_SECRET_PATH"));
    assert.ok(!a.display.includes(t.slice(0, 8)));
  });
  it("a token in the fragment is found and not shown", () => {
    for (const u of [`https://h.example.com/app#${t}`, `https://h.example.com/app#access_token=${t}&x=1`]) {
      const a = assessUrl(u);
      assert.ok(a.findings.some((f) => f.code === "URL_SECRET_PATH"), u);
      assert.ok(!a.display.includes(t.slice(0, 8)));
    }
  });
  it("ordinary fragments and parent-folder segments do not trigger it", () => {
    for (const u of ["https://h.example.com/docs/../mcp", "https://h.example.com/app#section-2", "https://h.example.com/#/settings"])
      assert.ok(!assessUrl(u).findings.some((f) => f.code === "URL_SECRET_PATH"), u);
  });
});

describe("F8: JSONC comments never merge tokens or hide lines", () => {
  it("a block comment between tokens separates them (as VS Code does), so invalid JSON stays invalid", () => {
    const dir = tempProject({ "a.json": `{"mcpServers": {"x": {"url": "https://a.example.com/", "n": 1/**/2}}}`, "b.json": `{"enableAllProjectMcpServers": tr/**/ue}` });
    assert.ok(codes(["--root", dir, "--config", "a.json"]).includes("FILE_NOT_JSON"));
    assert.ok(codes(["--root", dir, "--config", "b.json"]).includes("FILE_NOT_JSON"));
  });
  it("a line comment ends at CR as well as LF, so the next line is read", () => {
    const dir = tempProject({ "s.json": '{"mcpServers":{"a":{"url":"https://example.com/"}}, // note\r"enableAllProjectMcpServers": true,\r"x": 1\n}' });
    assert.ok(codes(["--root", dir, "--config", "s.json"]).includes("ENABLE_ALL_PROJECT_SERVERS"));
  });
});

describe("F9: default-mode names are masked before they are cut", () => {
  it("a token past the length limit is not half shown", () => {
    for (let seed = 1; seed <= 6; seed++) {
      const tok = syntheticTokens(seed, 40).mixed;
      const name = `analytics-warehouse-connector-primary-eu-west-region-${tok}`;
      const dir = tempProject({ ".mcp.json": { mcpServers: { [name]: { type: "http", url: "https://h.example.com/" } } }, "t.json": { tools: [{ name: `${name}_tool`, inputSchema: { type: "object" } }] } });
      for (const extra of [[], ["--format", "json"], ["--emit-pins"]]) {
        const out = run(["--root", dir, "--config", ".mcp.json", "--tools", `${name}=t.json`, "--fail-on", "never", ...extra]).out;
        for (let i = 0; i + 6 <= tok.length; i++) assert.ok(!out.includes(tok.slice(i, i + 6)), `seed ${seed} ${extra.join(" ")}`);
      }
    }
  });
});


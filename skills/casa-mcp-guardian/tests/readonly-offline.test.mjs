// SPDX-License-Identifier: AGPL-3.0-only
// Security properties of the script itself:
//   · read-only and no child processes: it runs under Node's permission model with read access only
//     (any write or spawn throws ERR_ACCESS_DENIED);
//   · offline: a preload makes every network entry point throw, and the run still succeeds;
//   · statically, the sources import only node:fs, node:path, node:crypto, node:url and `homedir` from
//     node:os (to recognize the home folder), and contain no write, spawn or network call.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { opaqueId } from "../scripts/lib/present.mjs";
import { CLI, SKILL_DIR, tempProject } from "./helpers.mjs";

const SCRIPTS = join(SKILL_DIR, "scripts");
const sources = () => [join(SCRIPTS, "mcp-guardian.mjs"), ...readdirSync(join(SCRIPTS, "lib")).map((f) => join(SCRIPTS, "lib", f))];

function fixture() {
  return tempProject({
    ".mcp.json": { mcpServers: { a: { type: "http", url: "https://mcp.example.com/mcp" }, b: { command: "npx", args: ["-y", "some-server"] } } },
    "tools.json": { tools: [{ name: "list_x", inputSchema: { type: "object" } }, { name: "delete_x", inputSchema: { type: "object" } }] },
    // Version 2 pins: opaque 128-bit id per tool; a wrong hash makes "list_x" a changed tool.
    "pins.json": { version: 2, tools: { [opaqueId("tool", "srv", "list_x")]: { server: opaqueId("server", "srv"), sha256: "0".repeat(64) } } },
  });
}

describe("the script itself", () => {
  it("runs with read-only file access and no permission to spawn or write", () => {
    const dir = fixture();
    const r = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${SKILL_DIR}`, `--allow-fs-read=${dir}`, CLI, "--root", dir, "--config", ".mcp.json", "--tools", "srv=tools.json", "--pins", "pins.json", "--format", "json", "--fail-on", "never"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /ERR_ACCESS_DENIED/);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.mode, { network: false, writes: false, toolCalls: false, names: "masked-heuristic" });
    assert.ok(out.findings.some((f) => f.code === "TOOL_CHANGED"));
  });

  it("works with every network entry point disabled", () => {
    const dir = fixture();
    const preload = join(dir, "no-network.mjs");
    writeFileSync(preload, [
      "import net from 'node:net'; import dns from 'node:dns'; import http from 'node:http'; import https from 'node:https'; import tls from 'node:tls';",
      "const boom = () => { throw new Error('NETWORK_USED'); };",
      "net.connect = boom; net.createConnection = boom; net.Socket.prototype.connect = boom; tls.connect = boom;",
      "dns.lookup = boom; dns.resolve = boom; dns.promises.lookup = boom; dns.promises.resolve = boom;",
      "http.request = boom; http.get = boom; https.request = boom; https.get = boom; globalThis.fetch = boom; globalThis.WebSocket = boom;",
    ].join("\n"));
    const r = spawnSync(process.execPath, ["--import", preload, CLI, "--root", dir, "--config", ".mcp.json", "--tools", "srv=tools.json", "--fail-on", "never"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout + r.stderr, /NETWORK_USED/);
    assert.match(r.stdout, /MCP Guardian/);
  });

  it("imports only fs, path, crypto, url and os.homedir, and has no write, spawn or network call", () => {
    for (const f of sources()) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/^\s*import\b([^;]*?)\bfrom\s+["']([^"']+)["']/gm)) {
        const mod = m[2];
        if (mod === "node:os") { assert.match(m[1], /^\s*\{\s*homedir(,\s*userInfo)?\s*\}\s*$/, `${f}: from node:os only homedir and userInfo`); continue; }
        assert.ok(mod.startsWith("./") || ["node:fs", "node:path", "node:crypto", "node:url"].includes(mod), `${f} imports ${mod}`);
      }
      assert.doesNotMatch(src, /\b(writeFile|appendFile|createWriteStream|mkdir|rmSync|unlink|rename|copyFile|XMLHttpRequest|WebSocket)\b|(?<![.\w])(spawn|spawnSync|exec|execSync|execFile|fork|fetch|require)\s*\(/, f);
      assert.doesNotMatch(src, /\beval\(|new Function\(/, f);
    }
  });

  it("does not read the home folder or any file it was not given (only the fixed project paths)", () => {
    const dir = tempProject({ "unrelated.json": { mcpServers: { x: { url: "http://evil.example" } } } });
    const r = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${SKILL_DIR}`, ...[".mcp.json", ".cursor/mcp.json", ".vscode/mcp.json", ".claude/settings.json", ".claude/settings.local.json"].map((f) => `--allow-fs-read=${join(dir, f)}`), CLI, "--root", dir], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /evil\.example/);
  });
});

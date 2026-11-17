// SPDX-License-Identifier: AGPL-3.0-only
// Protected mode (--redact-names) and stable pins (T8.2, finding T7-02).
//
// A synthetic secret of UNKNOWN format (hex, base64url, lower+digits, mixed, letters only, lowercase
// only; fixed seeds, so nothing flakes) is planted in EVERY free-text field the skill reads. In protected
// mode, no 8-character fragment of any of them may appear in any output: Markdown (en, pt), JSON, pins,
// standard error. Classification and exit codes must not depend on the mode.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../scripts/mcp-guardian.mjs";
import { opaqueId } from "../scripts/lib/present.mjs";
import { CLI, fragments, syntheticTokens, tempProject } from "./helpers.mjs";

/** All synthetic secrets of one seed, plus DNS-safe and scheme-safe variants. */
function secretsFor(seed) {
  const t = syntheticTokens(seed, 32);
  const l = syntheticTokens(seed + 100, 32);
  return { ...t, lower: l.alnum.replace(/\d/g, "q"), dns: l.alnum, scheme: `x${l.hex}` };
}

/** Builds a project where every free-text field carries a different secret. Returns the planted values. */
/** @param {number} seed @param {"mcpServers" | "servers" | "mcp.servers"} [layout] */
function plant(seed, layout = "mcpServers") {
  const s = secretsFor(seed);
  // The format rotates with the seed: over 8 seeds, every field gets every format, letters-only included.
  const pick = (/** @type {number} */ i) => Object.values(s)[(i + seed) % Object.values(s).length] + String(i);
  /** @type {string[]} */
  const planted = [];
  const P = (/** @type {number} */ i) => { const v = pick(i); planted.push(v); return v; };
  const S = Array.from({ length: 40 }, (_, i) => P(i));
  const host = `${s.dns}.example.com`;
  planted.push(s.dns, s.scheme);
  const entries = {
      [`srv_${S[0]}`]: { type: "http", url: `https://${host}/hooks/${S[1]}?token=${S[2]}&api_key_${S[3]}=1` },
      [`srv2_${S[4]}`]: { type: S[5], url: `https://u${S[6]}:p${S[7]}@h.example.com/` },
      [`srv3_${S[8]}`]: { url: `${s.scheme}://h.example.com/x` },
      [`srv4_${S[9]}`]: {
        command: `/opt/${S[10]}/bin/${S[11]}`, args: [`--api-key=${S[12]}`, S[13]],
        env: { API_KEY: S[14], [`TOKEN_${S[15]}`]: "plain-value-not-shaped", [`KEY_${S[16]}`]: S[17] },
        headers: { [`X-${S[18]}`]: S[19] },
        alwaysAllow: [`tool_${S[20]}`, `tool_${S[21]}`],
      },
      [`srv5_${S[22]}`]: { command: "npx", args: ["-y", `pkg${S[23]}@${S[24]}`] },
      [`srv6_${S[0]}x`]: { type: "http", url: `https://[2001:db8::1]:8443/${S[1]}x` },
  };
  /** @type {Record<string, unknown>} */
  const cfg = layout === "servers" ? { servers: entries } : layout === "mcp.servers" ? { mcp: { servers: entries } } : { mcpServers: entries };
  const tool = (/** @type {string} */ name, /** @type {string} */ secret) => ({
    name, description: `Lists things. ${secret}`, inputSchema: { type: "object", properties: { [`p_${S[25]}`]: { type: "string", description: S[26] } } }, annotations: { [`x${S[27]}`]: true, readOnlyHint: true },
  });
  const files = {
    [`cfg-${S[28]}.json`]: cfg,
    [`tools-${S[29]}.json`]: { tools: [tool(`get_${S[30]}`, S[31]), tool(`dup_${S[32]}`, S[33])] },
    "t2.json": { tools: [tool(`dup_${S[32]}`, S[33]), tool(`delete_${S[34]}`, S[35])] },
  };
  const dir = tempProject(files);
  // Pins with an untrusted label and a pinned tool that is gone (TOOL_REMOVED shows the label).
  const serverB = `SRV${S[36]}`;
  writeFileSync(join(dir, `pins-${S[37]}.json`), JSON.stringify({ version: 2, tools: {
    [opaqueId("tool", serverB, `gone_${S[38]}`)]: { server: opaqueId("server", serverB), sha256: "0".repeat(64), label: `label ${S[39]}` },
  } }));
  const args = ["--root", dir, "--config", `cfg-${S[28]}.json`, "--tools", `tools-${S[29]}.json`, "--tools", `${serverB}=t2.json`, "--pins", `pins-${S[37]}.json`, "--critical-pattern", S[0]];
  return { dir, args, planted, S };
}

/** @param {string} text @param {string[]} secrets @param {string} where */
function assertNoFragment(text, secrets, where) {
  for (const sec of secrets) for (const f of fragments(sec, 8)) assert.ok(!text.includes(f), `${where}: fragment of a planted secret`);
}

describe("protected mode: no planted secret, whatever its format, in any output", () => {
  for (const [seed, layout] of /** @type {const} */ ([[1, "mcpServers"], [2, "mcpServers"], [3, "servers"], [4, "servers"], [5, "mcp.servers"], [6, "mcp.servers"], [7, "mcpServers"], [8, "servers"]])) {
    it(`seed ${seed}, layout ${layout}: Markdown (en, pt), JSON, pins and standard error`, () => {
      const { args, planted } = plant(seed, layout);
      const outputs = [
        run([...args, "--redact-names"]),
        run([...args, "--redact-names", "--lang", "pt"]),
        run([...args, "--redact-names", "--format", "json"]),
        run([...args, "--redact-names", "--emit-pins"]),
      ];
      for (const [i, r] of outputs.entries()) assertNoFragment(`${r.out}\n${r.err}`, planted, `output ${i}`);
      const json = JSON.parse(outputs[2]?.out ?? "{}");
      assert.equal(json.mode.names, "redacted");
      // The report is still useful: every expected finding is there.
      const codes = new Set(json.findings.map((f) => f.code));
      for (const c of ["URL_SECRET_PATH", "URL_SECRET_PARAM", "URL_CREDENTIALS", "URL_PROTOCOL", "LITERAL_SECRET", "UNPINNED_PACKAGE", "AUTO_APPROVE", "TOOL_NAME_COLLISION", "TOOL_REMOVED", "TOOL_NEW"])
        assert.ok(codes.has(c), `${c} present`);
    });
  }

  it("the real executable (child process): stdout and stderr of every output form", () => {
    for (const [seed, layout] of /** @type {const} */ ([[11, "mcpServers"], [12, "servers"], [13, "mcp.servers"]])) {
      const { args, planted } = plant(seed, layout);
      for (const extra of [[], ["--lang", "pt"], ["--format", "json"], ["--emit-pins"], ["--fail-on", "never"]]) {
        const r = spawnSync(process.execPath, [CLI, ...args, "--redact-names", ...extra], { encoding: "utf8" });
        assertNoFragment(`${r.stdout}\n${r.stderr}`, planted, `child ${layout} ${extra.join(" ")}`);
        assert.ok(r.status === 0 || r.status === 1, `exit ${r.status}`);
      }
    }
  });

  it("error paths never repeat the input either", () => {
    const { planted, S, dir } = plant(9);
    const letters = syntheticTokens(9, 24).letters.toLowerCase();
    planted.push(letters);
    for (const r of [
      run(["--redact-names", `--${letters}`]),
      run([`--${letters}`]),
      run(["--redact-names", "--critical-pattern", `/(${S[0]}/`]),
      run(["--critical-pattern", `/(${S[0]}/`]),
      run(["--redact-names", "--root", dir, "--config", `missing-${S[1]}.json`, "--format", "json"]),
    ]) assertNoFragment(`${r.out}\n${r.err}`, planted, "error path");
  });
});

describe("classification and exit codes do not depend on the mode", () => {
  for (const seed of [1, 2, 3]) {
    it(`seed ${seed}`, () => {
      const { args } = plant(seed);
      for (const failOn of ["high", "critical", "medium"]) {
        const a = run([...args, "--format", "json", "--fail-on", failOn]);
        const b = run([...args, "--format", "json", "--fail-on", failOn, "--redact-names"]);
        assert.equal(a.code, b.code, `exit code, --fail-on ${failOn}`);
        const ja = JSON.parse(a.out);
        const jb = JSON.parse(b.out);
        const f = (/** @type {any} */ j) => j.findings.map((x) => `${x.severity} ${x.code}`).sort();
        const t = (/** @type {any} */ j) => j.tools.map((x) => `${x.risk} ${x.category} ${x.usable} ${x.signals.join(",")}`).sort();
        assert.deepEqual(f(jb), f(ja));
        assert.deepEqual(t(jb), t(ja));
        assert.equal(jb.servers.length, ja.servers.length);
      }
    });
  }
});

describe("pins: opaque, stable, independent of the display mode", () => {
  const listing = { tools: [{ name: "list_issues", inputSchema: { type: "object" } }, { name: "delete_repo", inputSchema: { type: "object" } }] };

  it("same ids and hashes in both modes; labels only in the default mode", () => {
    const dir = tempProject({ "t.json": listing });
    const a = JSON.parse(run(["--root", dir, "--tools", "gh=t.json", "--emit-pins"]).out);
    const b = JSON.parse(run(["--root", dir, "--tools", "gh=t.json", "--emit-pins", "--redact-names"]).out);
    assert.equal(a.version, 2);
    assert.deepEqual(Object.keys(a.tools).sort(), Object.keys(b.tools).sort());
    for (const [id, e] of Object.entries(a.tools)) {
      assert.match(id, /^[0-9a-f]{32}$/); // 128 bits
      assert.equal(e.sha256, b.tools[id].sha256);
      assert.equal(e.server, b.tools[id].server);
      assert.equal(typeof e.label, "string");
      assert.equal(b.tools[id].label, undefined);
    }
    assert.ok(a.tools[opaqueId("tool", "gh", "list_issues")]);
  });

  it("pins saved in one mode compare clean in the other", () => {
    const dir = tempProject({ "t.json": listing });
    for (const [emit, check] of [[[], ["--redact-names"]], [["--redact-names"], []]]) {
      const pins = run(["--root", dir, "--tools", "gh=t.json", "--emit-pins", ...emit]).out;
      writeFileSync(join(dir, "p.json"), pins);
      const r = JSON.parse(run(["--root", dir, "--tools", "gh=t.json", "--pins", "p.json", "--format", "json", "--fail-on", "never", ...check]).out);
      assert.deepEqual(r.findings.filter((x) => x.code.startsWith("TOOL_") || x.code === "PINS_INVALID"), []);
    }
  });

  it("ids are domain-separated and unambiguous", () => {
    assert.notEqual(opaqueId("tool", "a/b", "c"), opaqueId("tool", "a", "b/c"));
    assert.notEqual(opaqueId("tool", "ab", "c"), opaqueId("tool", "a", "bc"));
    assert.notEqual(opaqueId("tool", "srv", "x"), opaqueId("server", "srv", "x"));
    assert.equal(opaqueId("tool", "srv", "x"), opaqueId("tool", "srv", "x"));
  });

  it("version 1 pins, wrong ids or wrong hashes are PINS_INVALID", () => {
    const dir = tempProject({
      "t.json": listing,
      "v1.json": { version: 1, tools: { "gh/list_issues": "0".repeat(64) } },
      "badid.json": { version: 2, tools: { "gh/list_issues": { server: "0".repeat(32), sha256: "0".repeat(64) } } },
      "badsha.json": { version: 2, tools: { [opaqueId("tool", "gh", "list_issues")]: { server: opaqueId("server", "gh"), sha256: "zz" } } },
    });
    for (const p of ["v1.json", "badid.json", "badsha.json"]) {
      const r = JSON.parse(run(["--root", dir, "--tools", "gh=t.json", "--pins", p, "--format", "json", "--fail-on", "never"]).out);
      assert.ok(r.findings.some((x) => x.code === "PINS_INVALID"), p);
    }
  });
});

describe("default mode: values never shown; long random tokens in names masked", () => {
  it("no value of any format reaches the output (URL path, query, user info, env, headers, args, package version, descriptions)", () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const { args, S } = plant(seed);
      const values = [S[1], S[2], S[6], S[7], S[12], S[13], S[14], S[17], S[19], S[24], S[26], S[31], S[33], S[35]];
      for (const extra of [[], ["--format", "json"], ["--emit-pins"]]) {
        const r = run([...args, ...extra]);
        assertNoFragment(`${r.out}\n${r.err}`, values, `default ${extra.join(" ")}`);
      }
    }
  });

  it("values that look like plain words (passphrases), which no heuristic would mask, never reach the output", () => {
    // Readable on purpose: the heuristic leaves them alone, so only "values are never printed" protects them.
    const W = Array.from({ length: 11 }, (_, i) => `correct-horse-battery-staple-${["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo"][i]}`);
    const dir = tempProject({
      ".mcp.json": { mcpServers: {
        a: { type: "http", url: `https://u:${W[0]}@h.example.com/hooks/${W[1]}?token=${W[2]}` },
        b: { command: "node", args: [`--api-key=${W[3]}`, W[4]], env: { API_KEY: W[5] }, headers: { Authorization: `Bearer ${W[6]}` } },
        c: { command: "npx", args: ["-y", `some-server@${W[7]}`] },
        d: { command: "uvx", args: [`some-tool==${W[8]}`] },
      } },
      "tools.json": { tools: [{ name: "list_x", description: `Lists x. ${W[9]}`, inputSchema: { type: "object", properties: { q: { type: "string", description: W[10] } } } }] },
    });
    for (const extra of [[], ["--lang", "pt"], ["--format", "json"], ["--emit-pins"]]) {
      const r = run(["--root", dir, "--config", ".mcp.json", "--tools", "s=tools.json", ...extra]);
      assertNoFragment(`${r.out}\n${r.err}`, W.map((w) => w.slice("correct-horse-battery-staple-".length - 9)), `passphrase ${extra.join(" ")}`);
      assert.ok(!r.out.includes("battery-staple"), extra.join(" "));
    }
  });

  it("40-character tokens (hex, base64url, alphanumeric, mixed) inside names are masked", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const tk = syntheticTokens(seed, 40);
      for (const t of [tk.hex, tk.base64url, tk.alnum, tk.mixed]) {
        const dir = tempProject({
          ".mcp.json": { mcpServers: { [`srv_${t}`]: { type: "http", url: "https://h.example.com/mcp" } } },
          "tools.json": { tools: [{ name: `get_${t}_list`, inputSchema: { type: "object" } }] },
        });
        for (const extra of [[], ["--format", "json"], ["--emit-pins"]]) {
          const r = run(["--root", dir, "--config", ".mcp.json", "--tools", `s_${t}=tools.json`, ...extra]);
          assertNoFragment(`${r.out}\n${r.err}`, [t], `seed ${seed}`);
        }
      }
    }
  });

  it("ordinary names stay readable, and the report says how to share it safely", () => {
    const dir = tempProject({ "tools.json": { tools: [{ name: "getUserProfileV2", inputSchema: { type: "object" } }, { name: "s3_list_objects_v2", inputSchema: { type: "object" } }] } });
    const r = run(["--root", dir, "--tools", "github=tools.json"]);
    assert.match(r.out, /getUserProfileV2/);
    assert.match(r.out, /s3_list_objects_v2/);
    assert.match(r.out, /\| github \|/);
    assert.match(r.out, /run again with --redact-names/);
    assert.equal(JSON.parse(run(["--root", dir, "--tools", "github=tools.json", "--format", "json"]).out).mode.names, "masked-heuristic");
  });
});

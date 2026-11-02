// SPDX-License-Identifier: AGPL-3.0-only
// O portão de licenças reprova o que deve reprovar (não basta passar no lockfile atual).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/check-licenses.mjs", import.meta.url));
function run(packages: Record<string, { version: string; license?: string }>) {
  const dir = mkdtempSync(join(tmpdir(), "lic-"));
  const lock = join(dir, "package-lock.json");
  const entries = Object.fromEntries(Object.entries(packages).map(([n, v]) => [`node_modules/${n}`, v]));
  writeFileSync(lock, JSON.stringify({ lockfileVersion: 3, packages: { "": {}, ...entries } }));
  return spawnSync(process.execPath, [script, lock], { encoding: "utf8" });
}

describe("license gate", () => {
  it("passes permissive and OR-expressions with a permissive side", () => {
    assert.equal(run({ a: { version: "1", license: "MIT" }, b: { version: "1", license: "(MIT OR GPL-3.0-or-later)" } }).status, 0);
  });
  it("blocks GPL, AGPL from third parties, FSL, Remotion, unknown and AND with a blocked side", () => {
    for (const license of ["GPL-3.0-only", "AGPL-3.0-only", "FSL-1.1-MIT", "Remotion License", "SEE LICENSE IN LICENSE.md", undefined, "MIT AND GPL-2.0-only"])
      assert.equal(run({ x: { version: "1", ...(license ? { license } : {}) } }).status, 1, String(license));
  });
  it("LGPL and MPL need a registered exception", () => {
    assert.equal(run({ sharp: { version: "1", license: "LGPL-3.0-or-later" } }).status, 1);
    assert.equal(run({ mb: { version: "1", license: "MPL-2.0" } }).status, 1);
  });
});

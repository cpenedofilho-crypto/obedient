// SPDX-License-Identifier: Apache-2.0
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateToolDeclaration } from "./index.ts";

describe("sdk", () => {
  it("does not import any AGPL package (keeps Apache-2.0 clean)", () => {
    const src = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
    assert.doesNotMatch(src, /from\s+["']@obedient\//);
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
    assert.equal(pkg.license, "Apache-2.0");
    assert.equal(pkg.dependencies, undefined);
  });

  it("validates tool declarations", () => {
    assert.deepEqual(validateToolDeclaration({ system: "cal", name: "cal.list", description: "lista", risk: "LOW", category: "READ" }), []);
    assert.ok(validateToolDeclaration({ system: "cal", name: "x", description: "y", risk: "HIGH", category: "READ" }).length > 0);
    assert.ok(validateToolDeclaration({}).length >= 3);
  });
});

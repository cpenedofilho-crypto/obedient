// SPDX-License-Identifier: AGPL-3.0-only
//
// The reviewer note (docs/skills/casa-mcp-guardian-nota-revisores.md, T4 item 3) stays true to the code:
// every file it names exists and holds the kind of pattern it claims, its quick-check grep really finds
// nothing, it never asks a reviewer to ignore a finding, and it is not shipped inside the skill folder.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const SKILL = join(ROOT, "skills", "casa-mcp-guardian");
const NOTE = join(ROOT, "docs", "skills", "casa-mcp-guardian-nota-revisores.md");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe("casa-mcp-guardian: reviewer note", () => {
  const note = readFileSync(NOTE, "utf8");

  it("every file it names exists in the skill", () => {
    const named = [...note.matchAll(/`((?:scripts|references)\/[\w./-]+)`/g)].map((m) => m[1] ?? "");
    assert.ok(named.length >= 5, `${named.length} files named`);
    for (const f of named) assert.ok(existsSync(join(SKILL, f)), f);
  });

  it("each pattern file holds what the note says it holds", () => {
    const read = (f: string) => readFileSync(join(SKILL, "scripts", "lib", f), "utf8");
    assert.match(read("untrusted.mjs"), /override_instructions/);
    assert.match(read("secrets.mjs"), /credential_shape/);
    assert.match(read("endpoint.mjs"), /169\.254|metadata/);
    assert.match(read("audit.mjs"), /PIPE_TO_SHELL/);
  });

  it("its quick-check grep finds nothing in the scripts", () => {
    const re = /child_process|fetch\(|https?\.request|net\.|writeFile|eval\(/;
    for (const f of files(join(SKILL, "scripts"))) assert.doesNotMatch(readFileSync(f, "utf8"), re, f);
  });

  it("never asks a reviewer to ignore, skip or trust a finding", () => {
    const english = note.slice(note.indexOf("**Note for reviewers"));
    assert.doesNotMatch(english, /\b(please )?(ignore|disregard|skip|whitelist|allowlist)\b/i);
    assert.doesNotMatch(english, /\bsafe to\b|\bfalse positives?\b/i);
    assert.match(english, /Please verify them rather than take\s+our word for it/);
  });

  it("is not shipped inside the skill folder", () => {
    for (const f of files(SKILL)) assert.doesNotMatch(readFileSync(f, "utf8"), /Note for reviewers/, f);
  });
});

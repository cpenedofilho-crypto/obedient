// SPDX-License-Identifier: AGPL-3.0-only
// The skill as a package: SKILL.md follows the Agent Skills format, every file it points to exists,
// both READMEs exist, and nothing tied to internal products or clients was carried over.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { SKILL_DIR } from "./helpers.mjs";
import { MESSAGES } from "../scripts/lib/messages.mjs";

function frontmatter(md) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  assert.ok(m, "SKILL.md starts with YAML frontmatter");
  const out = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([a-z_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

function files(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe("SKILL.md", () => {
  const md = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
  const fm = frontmatter(md);
  it("name matches the folder and the format rules", () => {
    assert.equal(fm.name, basename(SKILL_DIR));
    assert.match(fm.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(fm.name.length <= 64);
    assert.doesNotMatch(fm.name, /anthropic|claude/);
  });
  it("description says what and when, within 1024 characters, without markup", () => {
    assert.ok(fm.description && fm.description.length >= 100 && fm.description.length <= 1024, `${fm.description?.length}`);
    assert.doesNotMatch(fm.description, /[<>]/);
    assert.match(fm.description, /Use (before|when)/);
  });
  it("declares the license", () => assert.equal(fm.license, "AGPL-3.0-only"));
  it("every relative link and script it mentions exists", () => {
    for (const m of md.matchAll(/\]\(([^)#]+)\)/g)) assert.ok(existsSync(join(SKILL_DIR, m[1])), m[1]);
    for (const m of md.matchAll(/\bscripts\/[\w./-]+\.mjs\b/g)) assert.ok(existsSync(join(SKILL_DIR, m[0])), m[0]);
  });
  it("bilingual documentation exists, and every finding code is documented", () => {
    for (const f of ["README.md", "README.pt-BR.md", "references/checks.md"]) assert.ok(existsSync(join(SKILL_DIR, f)), f);
    const checks = readFileSync(join(SKILL_DIR, "references/checks.md"), "utf8");
    const undocumented = Object.keys(MESSAGES).filter((c) => !c.startsWith("FILE_") && !checks.includes(c));
    assert.deepEqual(undocumented, []);
    for (const [code, m] of Object.entries(MESSAGES)) assert.ok(m.en && m.pt && m.fix_en && m.fix_pt, code);
  });
});

describe("nothing internal was carried over", () => {
  // Product, client and person names from the source repositories, and the removed product rules.
  const FORBIDDEN = [
    /\bmotor[_ -]?(iga|triagem)\b/i, /\bmotor_/i, /\brecupera\b/i, /\bronda\b/i, /\brepique\b/i, /growth[ -]?os/i, /\bobedient\b/i,
    /\biga\b/i, /\bbia\b/i, /\bdots?\b/i, /\bjuca\b/i, /\bnat[aá]lia\b/i, /\bohana\b/i, /\bcopacabana\b/i, /petr[oó]polis/i,
    /meta ads/i, /ads_update_entity|ads_create_ad_set|ads_experiment/, /quem_sou/, /cpenedofilho/i, /@gmail\.com/i,
  ];
  // The README and checks may name the OBEDIENT repository as the origin (provenance), nothing else.
  const ORIGIN_ALLOWED = new Set(["README.md", "README.pt-BR.md"]);
  it("no client, product or person names in the code, tests or SKILL.md", () => {
    const hits = [];
    for (const f of files(SKILL_DIR)) {
      const rel = relative(SKILL_DIR, f);
      const text = readFileSync(f, "utf8");
      for (const re of FORBIDDEN) {
        if (re.source === "\\bobedient\\b" && (ORIGIN_ALLOWED.has(rel) || rel.startsWith("tests/") || rel.startsWith("scripts/"))) continue;
        if (rel === "tests/skill.test.mjs" || (rel === "tests/classify.test.mjs" && re.source.includes("ads_update_entity"))) continue;
        if (re.test(text)) hits.push(`${rel}: ${re}`);
      }
    }
    assert.deepEqual(hits, []);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// casa-mcp-guardian: the release records agree with the files (T6). The version in the release plan is
// the one in the CHANGELOG; the packaging recipe ships the CHANGELOG; every file the PR added is in
// PROVENANCE.md; and the LICENSE is described as what it is (older http:// variant), with the hash
// recorded in the docs equal to the real one.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const SKILL = "skills/casa-mcp-guardian";

describe("casa-mcp-guardian: release records", () => {
  const plan = read("docs/skills/casa-mcp-guardian-release.md");
  const changelog = read(`${SKILL}/CHANGELOG.md`);
  const provenance = read("docs/licensing/PROVENANCE.md");
  const record = read("docs/skills/casa-mcp-guardian.md");

  it("the release plan uses the CHANGELOG version and ships the CHANGELOG", () => {
    const version = /^## (\d+\.\d+\.\d+) /m.exec(changelog)?.[1] ?? "";
    assert.equal(version, "0.1.0");
    assert.match(plan, new RegExp(`\\*\\*Versão:\\*\\* \`${version.replace(/\./g, "\\.")}\``));
    assert.match(plan, new RegExp(`casa-mcp-guardian-v${version.replace(/\./g, "\\.")}`));
    assert.match(plan, /inc = \[[^\]]*"CHANGELOG\.md"[^\]]*\]/);
  });

  it("every file this PR added outside the skill folder is in PROVENANCE.md", () => {
    for (const f of [
      `${SKILL}/LICENSE`, `${SKILL}/NOTICE`, `${SKILL}/CHANGELOG.md`,
      "docs/skills/casa-mcp-guardian-release.md", "docs/skills/casa-mcp-guardian-nota-revisores.md",
      "tests/skills/casa-mcp-guardian-nota.test.ts", "tests/skills/casa-mcp-guardian-release.test.ts",
      "tests/skills/casa-mcp-guardian-paridade.test.ts", "tsconfig.skills.json",
    ]) assert.ok(provenance.includes(`\`${f}\``), f);
  });

  it("the LICENSE is described as the older http:// variant, and the recorded hash is the real one", () => {
    const sha = createHash("sha256").update(readFileSync(join(ROOT, SKILL, "LICENSE"))).digest("hex");
    assert.ok(record.includes(sha), "full hash in docs/skills/casa-mcp-guardian.md");
    for (const [name, text] of [["record", record], ["provenance", provenance], ["plan", plan]] as const) {
      assert.ok(text.includes(sha.slice(0, 8)), `${name} cites the hash`);
      // The old wrong statements, as statements (the record may quote them to explain the correction).
      assert.doesNotMatch(text, /O arquivo é o texto no layout do gnu\.org com URLs `https`|Texto da AGPL-3\.0 no layout do gnu\.org \(sha256/, name);
    }
    const lic = readFileSync(join(ROOT, SKILL, "LICENSE"), "utf8");
    assert.match(lic, /<http:\/\/fsf\.org\/>/);
    assert.match(record, /variante \*\*antiga\*\*, com URLs `http`/);
    assert.match(plan, /Trocar só depois da aprovação\s+jurídica/);
  });

  it("the T4 item in the plan is marked done and the open gates stay open", () => {
    assert.match(plan, /- \[x\] Proposta T4, itens 1 a 4/);
    for (const gate of [/- \[ \] Autorização de quem publica diante da D15/, /- \[ \] Revisão jurídica/, /- \[ \] \*\*Texto da `LICENSE` da skill aprovado/, /- \[ \] Revisão do PR por um mantenedor/])
      assert.match(plan, gate);
  });
});

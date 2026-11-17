// SPDX-License-Identifier: AGPL-3.0-only
// The skill as a package: SKILL.md follows the Agent Skills format, every file it points to exists,
// both READMEs exist, and nothing tied to internal products or clients was carried over.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { SKILL_DIR } from "./helpers.mjs";
import { MESSAGES } from "../scripts/lib/messages.mjs";

// A deliberately small YAML subset: one "key: value" per line, the value either plain (no ": ", no
// " #", no leading quote or indicator) or a double-quoted scalar with no escapes and no inner quote.
// Anything else fails, so the frontmatter stays readable by every Agent Skills client, including the
// stricter parsers reported in Cursor for unquoted values with colons.
function scalar(key, raw) {
  if (raw.startsWith('"')) {
    assert.ok(raw.length >= 2 && raw.endsWith('"'), `${key}: closing quote`);
    const inner = raw.slice(1, -1);
    assert.doesNotMatch(inner, /["\\]/, `${key}: no inner quote or backslash escape`);
    return { value: inner, quoted: true };
  }
  assert.doesNotMatch(raw, /^['&*!|>%@`{[\]-]|: | #/, `${key}: plain scalar YAML would misread`);
  return { value: raw, quoted: false };
}

function frontmatter(md) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  assert.ok(m, "SKILL.md starts with YAML frontmatter");
  const out = {};
  const quoted = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([a-z_-]+): (.+)$/.exec(line);
    assert.ok(kv, `frontmatter line is "key: value": ${line.slice(0, 40)}`);
    assert.ok(!(kv[1] in out), `${kv[1]} appears once`);
    const s = scalar(kv[1], kv[2]);
    out[kv[1]] = s.value;
    quoted[kv[1]] = s.quoted;
  }
  return { ...out, quoted };
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
  it("the description is a double-quoted YAML scalar", () => assert.equal(fm.quoted.description, true));
  it("declares the license", () => assert.equal(fm.license, "AGPL-3.0-only"));
  it("compatibility states only the Node.js versions tested and structural Claude Code/Cursor 2.4+ support, without claiming a functional check", () => {
    assert.equal(fm.quoted.compatibility, true);
    assert.ok(fm.compatibility.length >= 1 && fm.compatibility.length <= 500, `${fm.compatibility.length}`);
    assert.match(fm.compatibility, /Node\.js 22 or newer \(tested on 22 and 24\)/);
    assert.match(fm.compatibility, /structurally compatible with Claude Code and with Cursor 2\.4 or newer/);
    assert.match(fm.compatibility, /not been verified/);
    assert.doesNotMatch(fm.compatibility, /\b(tested|verified|validated) (in|with|on) Cursor/i);
  });
  it("only known frontmatter fields", () => {
    const known = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools", "quoted"]);
    assert.deepEqual(Object.keys(fm).filter((k) => !known.has(k)), []);
  });
  it("every relative link and script it mentions exists", () => {
    for (const m of md.matchAll(/\]\(([^)#]+)\)/g)) assert.ok(existsSync(join(SKILL_DIR, m[1])), m[1]);
    for (const m of md.matchAll(/\bscripts\/[\w./-]+\.mjs\b/g)) assert.ok(existsSync(join(SKILL_DIR, m[0])), m[0]);
  });
  it("command examples call the script by the skill path, so they work from the user's project", () => {
    const commands = [...md.matchAll(/^node (\S+)/gm)].map((m) => m[1]);
    assert.ok(commands.length >= 4, `${commands.length} examples`);
    for (const c of commands) assert.equal(c, "<path-to-this-skill>/scripts/mcp-guardian.mjs");
  });
  it("the agent is told not to open raw files, to ask before personal or global configs, and not to create pin files on its own", () => {
    assert.match(md, /Do not open the raw files yourself/);
    assert.match(md, /Do not `cat`, print, quote or summarize their raw JSON/);
    assert.match(md, /Before\s+reading any personal or global config/);
    assert.match(md, /ask the user and wait for\s+a yes/);
    assert.match(md, /No pin file unless asked/);
    assert.match(md, /never create or overwrite a pin file on your\s+own initiative/);
  });
  it("a raw description is read by a person outside the conversation, never pasted into it", () => {
    assert.match(md, /outside this conversation \(in their own editor\)/);
    assert.match(md, /Do not open, paste or\s+summarize that description here, and do not ask the user to paste it/);
    assert.doesNotMatch(md, /read\s+its description in the raw file\.\s*$/m);
  });
  it("rotation is recommended unless the file never left the machine; when in doubt, rotate", () => {
    assert.match(md, /Recommend rotating it unless the user confirms the file never left this machine/);
    assert.match(md, /when in doubt, rotate/);
    assert.doesNotMatch(md, /because it has already been on disk/);
    for (const code of ["LITERAL_SECRET", "URL_CREDENTIALS", "URL_SECRET_PARAM"]) {
      assert.match(MESSAGES[code].fix_en, /unless the file never left this machine .*when in doubt, rotate\./, code);
      assert.match(MESSAGES[code].fix_pt, /a menos que o arquivo nunca tenha saído desta máquina .*na dúvida, troque\./, code);
    }
  });
  it("rule 2 does not order rotation unconditionally (T1)", () => {
    const rule2 = /^2\. \*\*Never print[\s\S]*?(?=^3\. )/m.exec(md)?.[0] ?? "";
    assert.ok(rule2, "rule 2 found");
    assert.doesNotMatch(rule2, /say it should be rotated/);
    assert.match(rule2, /Recommend rotating\s+it unless the user confirms the file never left this machine/);
    assert.match(rule2, /when in doubt, rotate/);
  });
  it("the agent stops when the script is not on disk and never recreates it", () => {
    assert.match(md, /\*\*Stop if the script is not on disk\.\*\*/);
    assert.match(md, /exists as a local file/);
    assert.match(md, /stop and tell the user to\s+install the whole skill folder locally first/);
    assert.match(md, /Do not recreate, download or rewrite the script/);
    // The stop comes before the first command the agent could run.
    assert.ok(md.indexOf("Stop if the script is not on disk") < md.indexOf("node <path-to-this-skill>"));
  });
  it("references/checks.md explains every check in English and Portuguese (T3)", () => {
    const checks = readFileSync(join(SKILL_DIR, "references/checks.md"), "utf8");
    const rows = checks.split("\n").filter((l) => /^\| `/.test(l));
    assert.ok(rows.length >= 25, `${rows.length} rows`);
    for (const r of rows) {
      const cells = r.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
      assert.equal(cells.length, 4, r.slice(0, 40));
      assert.ok(cells[2].length > 10 && cells[3].length > 10, r.slice(0, 40));
      assert.notEqual(cells[2], cells[3], r.slice(0, 40));
    }
    assert.equal((checks.match(/\| Why \| Por quê \|/g) || []).length, 2);
    assert.match(checks, /Em português:/);
    assert.match(checks, /nunca uma quebra/);
  });
  it("the packaged docs describe attack examples instead of carrying literal payloads (T4)", () => {
    for (const f of ["SKILL.md", "README.md", "README.pt-BR.md", "NOTICE", "references/checks.md"]) {
      const text = readFileSync(join(SKILL_DIR, f), "utf8");
      assert.doesNotMatch(text, /ignore (all |the )?previous instructions/i, f);
      assert.doesNotMatch(text, /\bsk-(test|live|proj|ant)-/i, f);
    }
    for (const f of ["README.md", "README.pt-BR.md"]) {
      const text = readFileSync(join(SKILL_DIR, f), "utf8");
      assert.match(text, /TOOL_INJECTION_SIGNAL/, f); // the risk is still documented
      assert.match(text, /skills\/casa-mcp-guardian\/tests\)/, f); // and points to the real cases
    }
  });
  it("the docs say the home-folder protection covers discovery only, not file-system isolation", () => {
    assert.match(md, /covers automatic discovery only/);
    assert.match(md, /This is not file-system isolation/);
    assert.match(readFileSync(join(SKILL_DIR, "README.md"), "utf8"), /This is not file-system isolation/);
    assert.match(readFileSync(join(SKILL_DIR, "README.pt-BR.md"), "utf8"), /Não é isolamento do sistema de arquivos/);
  });
  it("no document claims a Node.js version that was not tested", () => {
    for (const f of ["SKILL.md", "README.md", "README.pt-BR.md"]) {
      const text = readFileSync(join(SKILL_DIR, f), "utf8");
      assert.doesNotMatch(text, /Node(\.js)? ?(18|20)\b/, f);
      assert.match(text, /Node\.js 22 ou mais novo|Node\.js 22 or newer/, f);
    }
  });
  it("bilingual documentation exists, and every finding code is documented", () => {
    for (const f of ["README.md", "README.pt-BR.md", "references/checks.md"]) assert.ok(existsSync(join(SKILL_DIR, f)), f);
    const checks = readFileSync(join(SKILL_DIR, "references/checks.md"), "utf8");
    const undocumented = Object.keys(MESSAGES).filter((c) => !c.startsWith("FILE_") && !checks.includes(c));
    assert.deepEqual(undocumented, []);
    for (const [code, m] of Object.entries(MESSAGES)) assert.ok(m.en && m.pt && m.fix_en && m.fix_pt, code);
  });
});

describe("license and notices travel with the skill", () => {
  // AGPL-3.0 text in the gnu.org layout (https URLs). Same bytes as the copies in two independent
  // AGPL projects; equal, after whitespace normalization, to the SPDX text of the repository LICENSE.
  const AGPL_SHA256 = "57c8ff33c9c0cfc3ef00e650a1cc910d7ee479a8bc509f6c9209a7c2a11399d6";
  it("LICENSE is the full AGPL-3.0 text", () => {
    const text = readFileSync(join(SKILL_DIR, "LICENSE"));
    assert.equal(createHash("sha256").update(text).digest("hex"), AGPL_SHA256);
    assert.match(text.toString("utf8"), /^\s+GNU AFFERO GENERAL PUBLIC LICENSE\n\s+Version 3, 19 November 2007/);
  });
  it("NOTICE has the copyright, the license, the source and the third-party statement", () => {
    const n = readFileSync(join(SKILL_DIR, "NOTICE"), "utf8");
    assert.match(n, /Copyright \(C\) 2026 Cláudio Penedo\./);
    assert.match(n, /AGPL-3\.0-only/);
    assert.match(n, /LICENSE file/);
    assert.match(n, /complete source/);
    assert.match(n, /Third-party components: none/);
    assert.match(n, /not available yet/);
  });
  it("every source file carries the same SPDX identifier", () => {
    const sources = files(SKILL_DIR).filter((f) => f.endsWith(".mjs"));
    for (const f of sources) assert.match(readFileSync(f, "utf8"), /SPDX-License-Identifier: AGPL-3\.0-only/, relative(SKILL_DIR, f));
  });
  it("no relative link in the docs points outside the skill folder", () => {
    for (const f of files(SKILL_DIR).filter((x) => x.endsWith(".md"))) {
      for (const m of readFileSync(f, "utf8").matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
        const target = m[1];
        if (/^https?:\/\//.test(target)) continue;
        const abs = resolve(dirname(f), target);
        assert.ok(abs === SKILL_DIR || abs.startsWith(SKILL_DIR + sep), `${relative(SKILL_DIR, f)} -> ${target}`);
        assert.ok(existsSync(abs), `${relative(SKILL_DIR, f)} -> ${target}`);
      }
    }
  });
  it("the docs do not offer a commercial license as available", () => {
    for (const f of ["README.md", "README.pt-BR.md", "NOTICE"]) {
      const text = readFileSync(join(SKILL_DIR, f), "utf8");
      assert.doesNotMatch(text, /oferece licença comercial|commercial license is offered/i, f);
    }
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
  const ORIGIN_ALLOWED = new Set(["README.md", "README.pt-BR.md", "NOTICE"]);
  // The public source URL is the one place the owner's account name may appear.
  const SOURCE_URL = /https:\/\/github\.com\/cpenedofilho-crypto\/obedient\b[^\s)]*/g;
  it("no client, product or person names in the code, tests or SKILL.md", () => {
    const hits = [];
    for (const f of files(SKILL_DIR)) {
      const rel = relative(SKILL_DIR, f);
      if (rel === "LICENSE") continue; // the license text itself
      const raw = readFileSync(f, "utf8");
      const text = ORIGIN_ALLOWED.has(rel) ? raw.replace(SOURCE_URL, "") : raw;
      for (const re of FORBIDDEN) {
        if (re.source === "\\bobedient\\b" && (ORIGIN_ALLOWED.has(rel) || rel.startsWith("tests/") || rel.startsWith("scripts/"))) continue;
        if (rel === "tests/skill.test.mjs" || (rel === "tests/classify.test.mjs" && re.source.includes("ads_update_entity"))) continue;
        if (re.test(text)) hits.push(`${rel}: ${re}`);
      }
    }
    assert.deepEqual(hits, []);
  });
});

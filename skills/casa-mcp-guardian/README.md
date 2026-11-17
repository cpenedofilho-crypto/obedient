# casa-mcp-guardian

[Português](README.pt-BR.md)

An Agent Skill that audits MCP (Model Context Protocol) server configurations and tool listings before
you trust them. It reads the files, ranks every tool by risk, and points out what needs a human
decision. It never connects to a server, never writes a file and never prints a credential.

**Status:** pre-release (0.1). Not published on any marketplace.

## What it checks

- **Endpoints:** `http://` to remote hosts, cloud-metadata and private addresses (including IPv6 and
  decimal/hex/octal spellings), credentials in the URL, credential-like query parameters.
- **Credentials written in config:** env, headers and command-line flags, by key name and by value
  shape. Only the key path is reported.
- **Supply chain:** `npx`/`uvx`/`pnpm dlx`/`pipx run` without an exact version, container images without
  a digest, `sh -c` wrappers, `curl | sh`.
- **Auto-approval:** `alwaysAllow`, `autoApprove`, `allowedTools`, `trust`, `enableAllProjectMcpServers`.
- **Tools** (from a saved `tools/list` result): risk and category from the name and boolean annotations
  (a server's annotation never lowers what the name reveals); prompt-injection signals and hidden
  characters in tool **and parameter** descriptions; names with control characters; name collisions
  between servers; tools without an object input schema.
- **Silent changes:** pins (SHA-256 of name, description, schema and annotations) to detect a tool that
  changes after you approved it.

The full list, with severities, is in [references/checks.md](references/checks.md).

## Install

The skill is a folder with `SKILL.md`, `scripts/` and `references/`.

- **Claude Code:** copy `casa-mcp-guardian/` to `.claude/skills/` in your project (or
  `~/.claude/skills/` for all projects). Claude loads it when the task matches the description in
  `SKILL.md`.
- **Cursor and other tools that read `SKILL.md` folders:** place the folder where the tool documents
  Agent Skills. Compatibility with Cursor has **not been verified** in this release.
- **Without an agent:** `node scripts/mcp-guardian.mjs` works on its own (Node.js 18+, no dependencies).

## Use

```bash
node scripts/mcp-guardian.mjs                                   # project config files
node scripts/mcp-guardian.mjs --config .mcp.json --lang pt      # one file, report in Portuguese
node scripts/mcp-guardian.mjs --tools github=tools.json         # a saved tools/list result
node scripts/mcp-guardian.mjs --tools github=tools.json --emit-pins > mcp-pins.json
node scripts/mcp-guardian.mjs --tools github=tools-new.json --pins mcp-pins.json
node scripts/mcp-guardian.mjs --format json --fail-on critical  # for CI
```

| Option | Meaning |
| --- | --- |
| `--config FILE` | Config to audit (repeatable). Without it (and without `--tools`): `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.claude/settings.json`, `.claude/settings.local.json` in `--root`. Never the home folder. |
| `--tools [SERVER=]FILE` | A saved `tools/list` result: array, `{ "tools": [...] }` or a JSON-RPC response (repeatable). |
| `--pins FILE` / `--emit-pins` | Compare with saved pins / print pins to standard output. |
| `--critical-pattern TEXT\|/REGEX/` | Your own critical tools, e.g. the ones that move money in your stack (repeatable). |
| `--format md\|json`, `--lang en\|pt` | Report format and language. |
| `--fail-on LEVEL\|never` | Exit 1 at or above this severity (default HIGH). |
| `--root DIR` | Folder that relative paths refer to (default: current folder). |

Exit codes: `0` nothing at or above `--fail-on`; `1` something at or above it; `2` usage error.

To get a tool listing without this skill touching the network, export it from your MCP client or from
the MCP Inspector and save the JSON.

## Guarantees and how they are tested

| Guarantee | Test |
| --- | --- |
| Read-only, no processes | Runs under Node's permission model with read access only (`tests/readonly-offline.test.mjs`). |
| Offline | Runs with every network entry point (`net`, `tls`, `dns`, `http`, `https`, `fetch`, `WebSocket`) forced to throw. |
| Imports only `fs`, `path`, `crypto`, `url` | Static check of every source file. |
| No credential in any output | Random credentials of every supported shape; no output (Markdown, JSON, English, Portuguese, pins, errors) contains the value or any 8-character piece of it (`tests/no-leak.test.mjs`). |
| Untrusted text stays data | Descriptions are never reproduced; ANSI, bidi, zero-width and Markdown control characters are removed from names (`tests/untrusted.test.mjs`). |
| Same verdicts as the original classifier | Regression cases ported from the OBEDIENT integration gateway (`tests/classify.test.mjs`), plus a parity test against the original source in the OBEDIENT repository. |

## Limits

- Static analysis: a public host name that resolves to a private address (DNS rebinding) is not
  detected.
- Risk comes from names and annotations: an innocently named dangerous tool is not caught.
- Injection detection is heuristic (English and Portuguese); no signal does not mean safe.
- Only the approval settings listed above are read.

## License and origin

AGPL-3.0-only, like the OBEDIENT repository it comes from (see the repository `LICENSE`). The
classifier and the endpoint checks are adapted from `packages/integration-gateway` and
`packages/server/src/mcp-servidores.ts` of the same repository and author; rules tied to specific
products were removed. A commercial license is offered by Casa de IA Educação e Consultoria Ltda (see
`COMMERCIAL-LICENSE.md`, a draft). Provenance: `docs/licensing/PROVENANCE.md`.

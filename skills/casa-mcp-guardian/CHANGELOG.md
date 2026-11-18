# Changelog

## 0.1.0 (unreleased)

First public version. Read-only, offline audit of MCP configs and saved `tools/list` listings.

- Checks: plaintext, cloud-metadata and private endpoints; credentials in URLs, query strings,
  env, headers and arguments (reported by key path only); unpinned `npx`/`uvx`/`pnpm dlx`/`pipx run`
  packages and container images; `sh -c` wrappers and download-piped-to-shell commands;
  auto-approval settings.
- Tools: risk and category from names and boolean annotations; prompt-injection signs and hidden
  characters in tool and parameter descriptions; duplicate names; SHA-256 pins for silent changes.
- Never reads personal or global configs implicitly: the home folder is refused as a root, and
  default paths that leave the project through a symlink are skipped. Files named with `--config`,
  `--tools` or `--pins` are read as given; this is not file-system isolation.
- Two modes. Default: names readable, token-like parts masked (a heuristic with a measured residual
  risk). Protected (`--redact-names`): every free identifier (server, tool and file names, hosts,
  commands, config keys, URL parameter names, package names, pin labels) replaced by neutral labels;
  required before a report is shared or sent to another system. Values are never shown in either mode,
  and the URL path and query are never shown.
- Pins format version 3: keyed by an opaque, domain-separated 128-bit id, so they compare the same in both
  modes. The id identifies; it does not anonymize.
- The same tool of the same server repeated, in one listing or across listings, is always a finding (TOOL_DUPLICATE_NAME); a definition nested
  too deeply to inspect is a finding (TOOL_SCHEMA_TOO_DEEP); `--emit-pins` refuses unreadable, empty,
  duplicated or too-deep listings, listings with entries that are not tools, and runs with no listing.
- A listing with `nextCursor` (more pages) is incomplete: it is a finding (TOOLS_LISTING_INCOMPLETE)
  and `--emit-pins` refuses it, also when the pages are given separately.
- Reports in Markdown or JSON, English or Portuguese. Exit codes 0, 1 and 2 (2 = usage error or an
  input that could not be processed; fixed message, never input or a stack trace).
- Requires Node.js 22 or newer (tested on 22 and 24). No dependencies.
- Agent Skills format. Structurally compatible with Claude Code and Cursor 2.4+; loading and
  triggering were not tested in either.
- License: AGPL-3.0-only.

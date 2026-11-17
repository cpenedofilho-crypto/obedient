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
- Reports in Markdown or JSON, English or Portuguese. Exit codes 0, 1 and 2.
- Requires Node.js 22 or newer (tested on 22 and 24). No dependencies.
- Agent Skills format. Structurally compatible with Claude Code and Cursor 2.4+; loading and
  triggering were not tested in either.
- License: AGPL-3.0-only.

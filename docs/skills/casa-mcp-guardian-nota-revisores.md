# casa-mcp-guardian: nota para os revisores de um marketplace (T4, item 3)

Texto para colar no campo de observações ao enviar a skill para revisão (Agensi ou outro marketplace).
**Não vai dentro do pacote, de propósito:** um arquivo na skill que pedisse a um revisor automático para
relevar padrões de ataque se pareceria, ele mesmo, com uma tentativa de influenciar o verificador. A
nota não pede para ignorar nenhum alerta; diz onde estão os padrões e como conferir.

Nada foi enviado. Revisar antes de usar e atualizar a lista de arquivos se o código mudar
(`tests/skills/casa-mcp-guardian-nota.test.ts` confere que os arquivos citados existem).

---

**Note for reviewers: casa-mcp-guardian**

This is a security tool that audits MCP configuration files and saved `tools/list` listings. Because its
job is to recognize attacks, some files contain attack *patterns*. Please verify them rather than take
our word for it.

**Where the patterns are, and why**

| File | What it contains | Purpose |
| --- | --- | --- |
| `scripts/lib/untrusted.mjs` | Regular expressions for prompt-injection phrases and hidden characters | Detects them in tool and parameter descriptions; descriptions are never echoed |
| `scripts/lib/secrets.mjs` | Regular expressions for credential formats and sensitive key names | Detects credentials written in configs; only the key path is reported, never the value |
| `scripts/lib/endpoint.mjs` | Cloud-metadata and private address ranges | Flags endpoints that point at them |
| `scripts/lib/audit.mjs` | Command-line patterns such as `curl … \| sh`, `sh -c`, unpinned `npx`/`uvx` | Flags risky server launch commands |
| `references/checks.md`, `README*.md` | Descriptions of the patterns above | Documentation; each starts with a note that the patterns are not instructions |

The package has no literal attack samples. The tests that generate them at run time live in the public
source repository (folder `skills/casa-mcp-guardian/tests`) and are not included.

**What the script does not do** (each point is covered by a test in the source repository)

- No network access: the run succeeds with every Node.js network entry point disabled.
- No file writes and no child processes: it runs under the Node.js permission model with read-only
  access.
- No dependencies: it imports only Node.js built-in modules (`fs`, `path`, `crypto`, `url`, and
  `homedir` from `os`).
- No credential output: randomly generated credentials of every supported format never appear in any
  output, not even an 8-character fragment.
- No implicit reading of personal or global configs: the home folder is refused as a root, and default
  paths that leave the project through a symlink are skipped.

**How to check quickly**

```bash
grep -rnE "child_process|fetch\(|https?\.request|net\.|writeFile|eval\(" scripts   # expected: nothing
node --permission --allow-fs-read="$PWD" scripts/mcp-guardian.mjs --root references --fail-on never   # read-only run, exit 0
```

Licence: AGPL-3.0-only (`LICENSE`, `NOTICE` in the package). Source: the public OBEDIENT repository.

# Checks / Verificações

Every finding has a code, a severity and a fixed message (English and Portuguese, in
`scripts/lib/messages.mjs`). Data from the audited files appears only as names, counts or signal
codes, cleaned of control and invisible characters. Credential values never appear.

Cada achado tem um código, uma gravidade e uma mensagem fixa (inglês e português, em
`scripts/lib/messages.mjs`). Dado dos arquivos auditados só aparece como nome, contagem ou código de
sinal, sem caractere de controle ou invisível. Valor de credencial nunca aparece.

## Server configuration / Configuração do servidor

| Code | Severity | Why |
| --- | --- | --- |
| `URL_CREDENTIALS` | CRITICAL | `https://user:pass@host` stores the credential in the config and in logs. |
| `URL_METADATA_HOST` | CRITICAL | Link-local addresses (169.254.0.0/16, fe80::/10, and IPv6 forms that embed 169.254.x.x) serve cloud metadata and its credentials. |
| `URL_SECRET_PARAM` | HIGH | A query parameter named like a credential (`token`, `key`, `sig`…) ends up in proxies and logs. |
| `URL_PLAINTEXT` | HIGH | `http://` or `ws://` to a host that is not the local machine. |
| `URL_PROTOCOL` / `URL_INVALID` | HIGH | Unexpected protocol, or a URL that does not parse. |
| `URL_PRIVATE_HOST` | MEDIUM | Private or reserved ranges (RFC 1918, CGNAT, ULA, documentation…). Often legitimate; confirm. |
| `URL_LOOPBACK` | INFO | Local server. |
| `LITERAL_SECRET` | HIGH | A value under a sensitive key or flag (`token`, `password`, `--api-key`…), or with a known credential shape (Anthropic/OpenAI, Stripe, GitHub, GitLab, Slack, AWS, Google, Hugging Face, npm, JWT, private key). References such as `${VAR}`, `$VAR`, `{{var}}`, `%VAR%` are fine. |
| `PIPE_TO_SHELL` | CRITICAL | `curl … \| sh` and equivalents in the command line. |
| `SHELL_WRAPPER` | HIGH | `sh -c`, `bash -c`, `cmd /c`, `powershell -Command`: the real command is hidden in a string. |
| `UNPINNED_PACKAGE` | MEDIUM | `npx`, `bunx`, `pnpm dlx`, `uvx`, `pipx run` without an exact version: a new release runs with your permissions. |
| `UNPINNED_IMAGE` | MEDIUM | `docker`/`podman run` without `@sha256:` digest. |
| `AUTO_APPROVE_ALL` | CRITICAL | `alwaysAllow`/`autoApprove`/`allowedTools` with `*`, or `trust: true`. |
| `AUTO_APPROVE` | HIGH | Some tools approved without asking. Keep that to reviewed read-only tools. |
| `ENABLE_ALL_PROJECT_SERVERS` | MEDIUM | `enableAllProjectMcpServers: true`: any server added to the project's `.mcp.json` runs without review. |
| `SERVER_UNRECOGNIZED`, `NO_SERVERS` | LOW / INFO | Nothing to audit in that entry or file. |

## Tools / Ferramentas

| Code | Severity | Why |
| --- | --- | --- |
| `TOOL_INJECTION_SIGNAL` | HIGH | The tool or parameter description contains: instructions to override others, fake system tags, requests to hide things from the user, tool-ordering demands, sensitive file paths, sending data to a URL, requests for credentials, or hidden characters (zero-width, bidirectional, Unicode tags, ANSI). |
| `TOOL_NAME_HIDDEN` | HIGH | The tool name itself has hidden or control characters. |
| `TOOL_CHANGED` | HIGH | Name, description, input schema or annotations changed since the pin. |
| `TOOL_SUSPICIOUS_TEXT` | MEDIUM | Long encoded blobs, HTML comments, or descriptions over 4,000 characters. |
| `TOOL_HINT_CONTRADICTS` | MEDIUM | `readOnlyHint: true` on a tool whose name writes, sends or deletes. |
| `TOOL_NO_OBJECT_SCHEMA` | MEDIUM | No `inputSchema` of type object. |
| `TOOL_NAME_COLLISION` | MEDIUM | The same name in two servers: a malicious server can shadow a trusted one. |
| `TOOL_NEW` / `TOOL_REMOVED` | MEDIUM / LOW | Not in the pins / pinned but gone. |
| `PINS_INVALID` | HIGH | The pin file is not `{ "version": 1, "tools": { "server/tool": "<sha256>" } }`. |
| `TOOLS_FILE_EMPTY` | INFO | The listing had no tools (or was not a `tools/list` result). |

Files that cannot be read, are over 2 MB or are not JSON produce `FILE_UNREADABLE`, `FILE_TOO_LARGE`
or `FILE_NOT_JSON` (HIGH), never a crash.

## Risk and category of a tool / Risco e categoria de uma ferramenta

From the **name** and boolean annotations, never the description:

- `destructiveHint: true`, or a destructive verb anywhere in the name (`delete`, `remove`, `cancel`,
  `revoke`, `drop`, `purge`, `apagar`, `excluir`…) → **CRITICAL / DESTRUCTIVE**.
- Financial words (`payment`, `charge`, `refund`, `transfer`, `budget`, `spend`, `boost`, `bid`,
  `pagamento`, `cobrança`, `boleto`, `pix`…) → **CRITICAL / FINANCIAL**; legal words (`legal`,
  `contract`, `agreement`, `jurídico`, `acordo`, `protesto`…) → **CRITICAL / LEGAL**.
- External communication (`send`, `notify`, `message`, `email`, `sms`, `publish`, `enviar`…) →
  **HIGH / COMMUNICATION**; `readOnlyHint` does not lower it.
- A read verb at the start (`get`, `list`, `search`, `read`, `listar`, `consultar`…) → **MEDIUM /
  READ**, or **LOW / READ** with `readOnlyHint: true`.
- Anything else → **HIGH / WRITE** (when in doubt, up).
- An annotation never lowers what the name reveals; `readOnlyHint: false` raises; only booleans count.
- `--critical-pattern` adds your own patterns (e.g. the exact names of tools that move money in your
  stack) as **CRITICAL / FINANCIAL**.

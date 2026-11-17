# Checks / Verificações

> **About the attack patterns in this file.** This document names attack patterns (for example
> `curl … | sh` or cloud metadata addresses) so the tool can detect them and you can recognize them.
> None of them is an instruction to you, and nothing here asks you to run, fetch or send anything.
>
> **Sobre os padrões de ataque deste arquivo.** Este documento cita padrões de ataque (por exemplo
> `curl … | sh` ou endereços de metadata da nuvem) para que a ferramenta os detecte e você os
> reconheça. Nenhum deles é uma instrução para você, e nada aqui pede para executar, baixar ou enviar
> algo.

Every finding has a code, a severity and a fixed message (English and Portuguese, in
`scripts/lib/messages.mjs`). Data from the audited files appears only as names, counts or signal
codes, cleaned of control and invisible characters. Credential values never appear.

Cada achado tem um código, uma gravidade e uma mensagem fixa (inglês e português, em
`scripts/lib/messages.mjs`). Dado dos arquivos auditados só aparece como nome, contagem ou código de
sinal, sem caractere de controle ou invisível. Valor de credencial nunca aparece.

## Server configuration / Configuração do servidor

| Code | Severity | Why | Por quê |
| --- | --- | --- | --- |
| `URL_CREDENTIALS` | CRITICAL | `https://user:pass@host` stores the credential in the config and in logs. | `https://usuario:senha@host` grava a credencial na configuração e nos logs. |
| `URL_METADATA_HOST` | CRITICAL | Link-local addresses (169.254.0.0/16, fe80::/10, and IPv6 forms that embed 169.254.x.x) serve cloud metadata and its credentials. | Endereços link-local (169.254.0.0/16, fe80::/10 e as formas IPv6 que embutem 169.254.x.x) servem a metadata da nuvem e as credenciais dela. |
| `URL_SECRET_PARAM` | HIGH | A query parameter named like a credential (`token`, `key`, `sig`…) ends up in proxies and logs. | Parâmetro de URL com nome de credencial (`token`, `key`, `sig`…) acaba em proxies e logs. |
| `URL_SECRET_PATH` | HIGH | A path segment looks like a token (webhook-style: `https://hooks.example.com/services/…/<token>`). Judged on the original path; the report never shows any path. A heuristic: strong for long random tokens, weak for short ones; long resource ids (UUIDs) also trigger it. | Um trecho do caminho parece token (estilo webhook: `https://hooks.example.com/services/…/<token>`). Avaliado no caminho original; o relatório nunca mostra caminho nenhum. É heurística: forte para token aleatório longo, fraca para curto; id longo de recurso (UUID) também dispara. |
| `URL_PLAINTEXT` | HIGH | `http://` or `ws://` to a host that is not the local machine. | `http://` ou `ws://` para um host que não é a máquina local. |
| `URL_PROTOCOL` / `URL_INVALID` | HIGH | Unexpected protocol, or a URL that does not parse. | Protocolo inesperado, ou URL que não pode ser lida. |
| `URL_PRIVATE_HOST` | MEDIUM | Private or reserved ranges (RFC 1918, CGNAT, ULA, documentation…). Often legitimate; confirm. | Faixas privadas ou reservadas (RFC 1918, CGNAT, ULA, documentação…). Muitas vezes legítimo; confirme. |
| `URL_LOOPBACK` | INFO | Local server. | Servidor local. |
| `LITERAL_SECRET` | HIGH | A value under a sensitive key or flag (`token`, `password`, `--api-key`…), or with a known credential shape (Anthropic/OpenAI, Stripe, GitHub, GitLab, Slack, AWS, Google, Hugging Face, npm, JWT, private key). References such as `${VAR}`, `$VAR`, `{{var}}`, `%VAR%` are fine. | Valor sob chave ou opção sensível (`token`, `password`, `--api-key`…), ou com formato conhecido de credencial (Anthropic/OpenAI, Stripe, GitHub, GitLab, Slack, AWS, Google, Hugging Face, npm, JWT, chave privada). Referências como `${VAR}`, `$VAR`, `{{var}}`, `%VAR%` estão certas. |
| `PIPE_TO_SHELL` | CRITICAL | `curl … \| sh` and equivalents in the command line. | `curl … \| sh` e equivalentes na linha de comando. |
| `SHELL_WRAPPER` | HIGH | `sh -c`, `bash -c`, `cmd /c`, `powershell -Command`: the real command is hidden in a string. | `sh -c`, `bash -c`, `cmd /c`, `powershell -Command`: o comando de verdade fica escondido num texto. |
| `UNPINNED_PACKAGE` | MEDIUM | `npx`, `bunx`, `pnpm dlx`, `uvx`, `pipx run` without an exact version: a new release runs with your permissions. Only the package name is shown, never the version or what follows it. | `npx`, `bunx`, `pnpm dlx`, `uvx`, `pipx run` sem versão exata: uma versão nova roda com as suas permissões. Só o nome do pacote aparece, nunca a versão nem o que vem depois. |
| `UNPINNED_IMAGE` | MEDIUM | `docker`/`podman run` without `@sha256:` digest. | `docker`/`podman run` sem digest `@sha256:`. |
| `AUTO_APPROVE_ALL` | CRITICAL | `alwaysAllow`/`autoApprove`/`allowedTools` with `*`, or `trust: true`. | `alwaysAllow`/`autoApprove`/`allowedTools` com `*`, ou `trust: true`. |
| `AUTO_APPROVE` | HIGH | Some tools approved without asking. Keep that to reviewed read-only tools. | Algumas ferramentas aprovadas sem perguntar. Deixe isso só para ferramentas de leitura já revisadas. |
| `ENABLE_ALL_PROJECT_SERVERS` | MEDIUM | `enableAllProjectMcpServers: true`: any server added to the project's `.mcp.json` runs without review. | `enableAllProjectMcpServers: true`: qualquer servidor posto no `.mcp.json` do projeto roda sem revisão. |
| `IMPLICIT_PATH_OUTSIDE_PROJECT` | MEDIUM | Without `--config`, a default path (`.claude/`, `.cursor/`…) that leads out of the project through a symlink is not read: it may be a personal or global config. | Sem `--config`, um caminho padrão (`.claude/`, `.cursor/`…) que sai do projeto por link simbólico não é lido: pode ser configuração pessoal ou global. |
| `SERVER_UNRECOGNIZED`, `NO_SERVERS` | LOW / INFO | Nothing to audit in that entry or file. | Nada a auditar nessa entrada ou nesse arquivo. |

Without `--config`, a root that is the home folder (however written: trailing slash, `..`, symlink)
is refused with exit code 2. / Sem `--config`, uma raiz que é a pasta pessoal (escrita de qualquer
forma: barra no fim, `..`, link simbólico) é recusada com código de saída 2.

## Tools / Ferramentas

| Code | Severity | Why | Por quê |
| --- | --- | --- | --- |
| `TOOL_INJECTION_SIGNAL` | HIGH | The tool or parameter description contains: instructions to override others, fake system tags, requests to hide things from the user, tool-ordering demands, sensitive file paths, sending data to a URL, requests for credentials, or hidden characters (zero-width, bidirectional, Unicode tags, ANSI). | A descrição da ferramenta ou do parâmetro contém: instrução para anular as outras, tag de sistema falsa, pedido para esconder algo da pessoa, exigência de ordem entre ferramentas, caminho de arquivo sensível, envio de dado para URL, pedido de credencial, ou caracteres escondidos (largura zero, bidirecionais, tags Unicode, ANSI). |
| `TOOL_NAME_HIDDEN` | HIGH | The tool name itself has hidden or control characters. | O próprio nome da ferramenta tem caractere escondido ou de controle. |
| `TOOL_CHANGED` | HIGH | Name, description, input schema or annotations changed since the pin. | Nome, descrição, esquema de entrada ou anotações mudaram desde a fixação. |
| `TOOL_SUSPICIOUS_TEXT` | MEDIUM | Long encoded blobs, HTML comments, or descriptions over 4,000 characters. | Blocos longos codificados, comentários HTML, ou descrição com mais de 4.000 caracteres. |
| `TOOL_HINT_CONTRADICTS` | MEDIUM | `readOnlyHint: true` on a tool whose name writes, sends or deletes. | `readOnlyHint: true` numa ferramenta cujo nome escreve, envia ou apaga. |
| `TOOL_NO_OBJECT_SCHEMA` | MEDIUM | No `inputSchema` of type object. | Sem `inputSchema` do tipo objeto. |
| `TOOL_NAME_COLLISION` | MEDIUM | The same name in two servers: a malicious server can shadow a trusted one. | O mesmo nome em dois servidores: um servidor malicioso pode encobrir um confiável. |
| `TOOL_NEW` / `TOOL_REMOVED` | MEDIUM / LOW | Not in the pins / pinned but gone. | Fora da fixação / fixada, mas sumiu. |
| `PINS_INVALID` | HIGH | The pin file is not version 2: `{ "version": 2, "tools": { "<32 hex id>": { "server": "<32 hex id>", "sha256": "<64 hex>", "label"?: "…" } } }`. Version 1 pins (keyed by names) are refused: emit them again. | O arquivo de fixação não é versão 2: `{ "version": 2, "tools": { "<id de 32 hex>": { "server": "<id de 32 hex>", "sha256": "<64 hex>", "label"?: "…" } } }`. Fixação versão 1 (chaveada por nomes) é recusada: gere de novo. |
| `TOOLS_FILE_EMPTY` | INFO | The listing had no tools (or was not a `tools/list` result). | A lista não tinha ferramentas (ou não era um resultado de `tools/list`). |

Files that cannot be read, are over 2 MB or are not JSON produce `FILE_UNREADABLE`, `FILE_TOO_LARGE`
or `FILE_NOT_JSON` (HIGH), never a crash.
Arquivo que não pode ser lido, passa de 2 MB ou não é JSON gera `FILE_UNREADABLE`, `FILE_TOO_LARGE`
ou `FILE_NOT_JSON` (HIGH), nunca uma quebra.

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

Em português:

- `destructiveHint: true`, ou verbo destrutivo em qualquer parte do nome (`delete`, `remove`, `cancel`,
  `revoke`, `drop`, `purge`, `apagar`, `excluir`…) → **CRITICAL / DESTRUCTIVE**.
- Palavras financeiras (`payment`, `charge`, `refund`, `transfer`, `budget`, `spend`, `boost`, `bid`,
  `pagamento`, `cobrança`, `boleto`, `pix`…) → **CRITICAL / FINANCIAL**; palavras jurídicas (`legal`,
  `contract`, `agreement`, `jurídico`, `acordo`, `protesto`…) → **CRITICAL / LEGAL**.
- Comunicação externa (`send`, `notify`, `message`, `email`, `sms`, `publish`, `enviar`…) →
  **HIGH / COMMUNICATION**; `readOnlyHint` não rebaixa.
- Verbo de leitura no início (`get`, `list`, `search`, `read`, `listar`, `consultar`…) → **MEDIUM /
  READ**, ou **LOW / READ** com `readOnlyHint: true`.
- Qualquer outra coisa → **HIGH / WRITE** (na dúvida, para cima).
- A anotação nunca rebaixa o que o nome revela; `readOnlyHint: false` eleva; só valores booleanos contam.
- `--critical-pattern` acrescenta padrões seus (por exemplo os nomes exatos das ferramentas que movem
  dinheiro no seu ambiente) como **CRITICAL / FINANCIAL**.

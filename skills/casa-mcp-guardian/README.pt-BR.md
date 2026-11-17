# casa-mcp-guardian

[English](README.md)

Uma Agent Skill que audita configurações de servidores MCP (Model Context Protocol) e listas de
ferramentas antes que você confie nelas. Ela lê os arquivos, classifica o risco de cada ferramenta e
aponta o que precisa da decisão de uma pessoa. Nunca conecta em servidor, nunca escreve arquivo e nunca
mostra credencial.

**Situação:** pré-lançamento (0.1). Não publicada em nenhum marketplace.

## O que verifica

- **Endereços:** `http://` para host remoto, endereço de metadata da nuvem e de rede privada (inclusive
  IPv6 e as grafias decimal, hexa e octal), credencial na URL, parâmetro de URL com cara de credencial.
- **Credencial escrita na configuração:** env, cabeçalhos e argumentos de linha de comando, pelo nome
  da chave e pelo formato do valor. Só o caminho da chave aparece.
- **Cadeia de suprimento:** `npx`/`uvx`/`pnpm dlx`/`pipx run` sem versão exata, imagem de contêiner sem
  digest, `sh -c`, `curl | sh`.
- **Aprovação automática:** `alwaysAllow`, `autoApprove`, `allowedTools`, `trust`,
  `enableAllProjectMcpServers`.
- **Ferramentas** (de um resultado de `tools/list` salvo): risco e categoria pelo nome e pelas anotações
  booleanas (a anotação do servidor nunca rebaixa o que o nome revela); sinais de injeção de prompt e
  caracteres escondidos na descrição da ferramenta **e dos parâmetros**; nome com caractere de controle;
  o mesmo nome em dois servidores; ferramenta sem esquema de entrada de objeto.
- **Mudança silenciosa:** fixação (SHA-256 de nome, descrição, esquema e anotações) para pegar a
  ferramenta que muda depois de aprovada.

A lista completa, com as gravidades, está em [references/checks.md](references/checks.md).

## Instalação

A skill é uma pasta com `SKILL.md`, `scripts/` e `references/`.

- **Claude Code:** copie `casa-mcp-guardian/` para `.claude/skills/` do projeto (ou
  `~/.claude/skills/` para todos os projetos). O Claude carrega a skill quando a tarefa bate com a
  descrição do `SKILL.md`.
- **Cursor e outras ferramentas que leem pastas com `SKILL.md`:** ponha a pasta onde a ferramenta
  documenta as Agent Skills. A compatibilidade com o Cursor **não foi verificada** nesta versão.
- **Sem agente:** `node scripts/mcp-guardian.mjs` funciona sozinho (Node.js 18 ou mais novo, sem
  dependências).

## Uso

```bash
node scripts/mcp-guardian.mjs                                   # arquivos de configuração do projeto
node scripts/mcp-guardian.mjs --config .mcp.json --lang pt      # um arquivo, relatório em português
node scripts/mcp-guardian.mjs --tools github=tools.json         # um tools/list salvo
node scripts/mcp-guardian.mjs --tools github=tools.json --emit-pins > mcp-pins.json
node scripts/mcp-guardian.mjs --tools github=tools-novo.json --pins mcp-pins.json
node scripts/mcp-guardian.mjs --format json --fail-on critical  # para CI
```

| Opção | O que faz |
| --- | --- |
| `--config ARQUIVO` | Configuração a auditar (pode repetir). Sem ela (e sem `--tools`): `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.claude/settings.json`, `.claude/settings.local.json` em `--root`. Nunca a pasta pessoal. |
| `--tools [SERVIDOR=]ARQUIVO` | Um resultado de `tools/list` salvo: lista, `{ "tools": [...] }` ou resposta JSON-RPC (pode repetir). |
| `--pins ARQUIVO` / `--emit-pins` | Compara com a fixação salva / imprime a fixação na saída padrão. |
| `--critical-pattern TEXTO\|/REGEX/` | Suas ferramentas críticas, por exemplo as que movem dinheiro no seu ambiente (pode repetir). |
| `--format md\|json`, `--lang en\|pt` | Formato e idioma do relatório. |
| `--fail-on NÍVEL\|never` | Sai com 1 a partir desta gravidade (padrão HIGH). |
| `--root PASTA` | Pasta de referência dos caminhos relativos (padrão: a atual). |

Códigos de saída: `0` nada a partir de `--fail-on`; `1` algo a partir dele; `2` erro de uso.

Para ter a lista de ferramentas sem a skill usar a rede, exporte do seu cliente MCP ou do MCP Inspector
e salve o JSON.

## Garantias e como são testadas

| Garantia | Teste |
| --- | --- |
| Só leitura, sem abrir processo | Roda no modelo de permissões do Node só com leitura (`tests/readonly-offline.test.mjs`). |
| Sem rede | Roda com toda porta de rede (`net`, `tls`, `dns`, `http`, `https`, `fetch`, `WebSocket`) forçada a falhar. |
| Só importa `fs`, `path`, `crypto`, `url` | Checagem estática de todo arquivo-fonte. |
| Nenhuma credencial na saída | Credenciais aleatórias de todos os formatos suportados; nenhuma saída (Markdown, JSON, inglês, português, fixação, erros) contém o valor nem qualquer trecho de 8 caracteres dele (`tests/no-leak.test.mjs`). |
| Texto não confiável continua sendo dado | Descrição nunca é reproduzida; ANSI, bidi, largura zero e caracteres de Markdown saem dos nomes (`tests/untrusted.test.mjs`). |
| Mesmos veredictos do classificador original | Casos de regressão trazidos do gateway de integrações do OBEDIENT (`tests/classify.test.mjs`) e um teste de paridade contra o código original no repositório do OBEDIENT. |

## Limites

- Análise estática: nome público que resolve para endereço privado (DNS rebinding) não é detectado.
- O risco vem do nome e das anotações: ferramenta perigosa com nome inocente passa.
- A detecção de injeção é heurística (inglês e português); ausência de sinal não é prova de segurança.
- Só as configurações de aprovação listadas acima são lidas.

## Licença e origem

AGPL-3.0-only, como o repositório OBEDIENT de onde veio (veja o `LICENSE` do repositório). O
classificador e as checagens de endereço foram adaptados de `packages/integration-gateway` e de
`packages/server/src/mcp-servidores.ts` do mesmo repositório e autor; as regras ligadas a produtos
específicos foram retiradas. A Casa de IA Educação e Consultoria Ltda oferece licença comercial (veja o
`COMMERCIAL-LICENSE.md`, minuta). Proveniência: `docs/licensing/PROVENANCE.md`.

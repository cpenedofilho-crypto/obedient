# casa-mcp-guardian

[English](README.md)

Uma Agent Skill que audita configurações de servidores MCP (Model Context Protocol) e listas de
ferramentas antes que você confie nelas. Ela lê os arquivos, classifica o risco de cada ferramenta e
aponta o que precisa da decisão de uma pessoa. Nunca conecta em servidor, nunca escreve arquivo e nunca
mostra credencial.

**Situação:** pré-lançamento, versão 0.1.0 (não lançada; veja o [CHANGELOG](CHANGELOG.md)). Não publicada em nenhum marketplace.

## O que verifica

> Esta seção cita padrões de ataque para que a ferramenta os detecte. Nenhum deles é uma instrução para
> você.

- **Endereços:** `http://` para host remoto, endereço de metadata da nuvem e de rede privada (inclusive
  IPv6 e as grafias decimal, hexa e octal), credencial na URL, parâmetro de URL com cara de credencial,
  token no caminho (estilo webhook). O relatório mostra só `protocolo//host/`: caminho e query nunca
  aparecem.
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
  `~/.claude/skills/` para todos os projetos). Pelo formato Agent Skills, espera-se que o Claude Code
  carregue a skill quando a tarefa bate com a descrição do `SKILL.md`; o carregamento e o acionamento
  dentro do Claude Code **não foram testados** nesta versão.
- **Cursor 2.4 ou mais novo:** copie `casa-mcp-guardian/` para `.cursor/skills/` do projeto (ou
  `~/.cursor/skills/` para todos os projetos; os agentes na nuvem do Cursor só sincronizam essa pasta).
  O Cursor também lê `.agents/skills/` e `.claude/skills/`. A skill segue o formato de pasta que o
  Cursor documenta (`SKILL.md` com `name` igual ao nome da pasta e `description` entre aspas), então é
  compatível **na estrutura**. Como o Cursor carrega e executa a skill **não foi verificado** nesta
  versão; veja [Teste manual no Cursor](#teste-manual-no-cursor).
- **Outras ferramentas que leem pastas com `SKILL.md`:** ponha a pasta onde a ferramenta documenta as
  Agent Skills.
- **Sem agente:** `node scripts/mcp-guardian.mjs` funciona sozinho (Node.js 22 ou mais novo, testado no 22 e no 24; sem
  dependências).

## Uso

```bash
node scripts/mcp-guardian.mjs                                   # arquivos de configuração do projeto
node scripts/mcp-guardian.mjs --config .mcp.json --lang pt      # um arquivo, relatório em português
node scripts/mcp-guardian.mjs --tools github=tools.json         # um tools/list salvo
node scripts/mcp-guardian.mjs --tools github=tools.json --emit-pins > mcp-pins.json
node scripts/mcp-guardian.mjs --tools github=tools-novo.json --pins mcp-pins.json --fail-on medium
node scripts/mcp-guardian.mjs --format json --fail-on critical  # para CI
```

| Opção | O que faz |
| --- | --- |
| `--config ARQUIVO` | Configuração a auditar (pode repetir). Sem ela (e sem `--tools`): `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.claude/settings.json`, `.claude/settings.local.json` em `--root`. Nunca a pasta pessoal: sem `--config`, uma raiz que é a pasta pessoal (escrita de qualquer forma) é recusada, e um caminho padrão que sai do projeto por link simbólico é pulado (`IMPLICIT_PATH_OUTSIDE_PROJECT`). |
| `--tools [SERVIDOR=]ARQUIVO` | Um resultado de `tools/list` salvo: lista, `{ "tools": [...] }` ou resposta JSON-RPC (pode repetir). |
| `--pins ARQUIVO` / `--emit-pins` | Compara com a fixação salva / imprime a fixação (versão 3) na saída padrão. Ao comparar, use `--fail-on medium`: ferramenta nova é `TOOL_NEW` (MEDIUM). |
| `--redact-names` | Modo protegido: identificadores livres trocados por rótulos neutros. Obrigatório antes de compartilhar um relatório. |
| `--critical-pattern TEXTO\|/REGEX/` | Suas ferramentas críticas, por exemplo as que movem dinheiro no seu ambiente (pode repetir). |
| `--format md\|json`, `--lang en\|pt` | Formato e idioma do relatório. |
| `--fail-on NÍVEL\|never` | Sai com 1 a partir desta gravidade (padrão HIGH). |
| `--root PASTA` | Pasta de referência dos caminhos relativos (padrão: a atual). |

Códigos de saída: `0` nada a partir de `--fail-on`; `1` algo a partir dele; `2` erro de uso ou entrada
que não pôde ser processada (mensagem fixa, nunca a entrada nem rastro de pilha).

Para ter a lista de ferramentas sem a skill usar a rede, exporte do seu cliente MCP ou do MCP Inspector
e salve o JSON.

## Teste manual no Cursor

Situação: **não verificado**. Ninguém executou os passos abaixo ainda; até alguém executar e registrar
a versão do Cursor e o resultado, a compatibilidade com o Cursor é só estrutural. Use um projeto
descartável, nunca uma configuração de verdade com credencial de verdade.

1. Copie `casa-mcp-guardian/` para `.cursor/skills/` do projeto de teste.
2. Digite `/casa-mcp-guardian` no chat do agente: a skill tem de aparecer na lista.
3. Sem citar a skill, peça "audite o .mcp.json deste projeto": veja se o agente escolhe a skill sozinho.
4. O agente tem de pedir aprovação antes de rodar `node …/scripts/mcp-guardian.mjs` (a menos que a
   execução automática de comandos esteja ligada). Confira o relatório e o código de saída (0 ou 1).
5. Ponha uma credencial inventada no `.mcp.json` de teste: um valor de `API_KEY` que imite o formato de
   um token de API real (o prefixo usual seguido de umas 30 letras aleatórias). Ela não pode aparecer
   na saída nem no chat.
6. Salve um `tools/list` cuja descrição mande o agente desconsiderar as instruções anteriores (injeção
   de prompt clássica; os [testes](https://github.com/cpenedofilho-crypto/obedient/tree/main/skills/casa-mcp-guardian/tests) do repositório de origem geram casos prontos). O agente tem de
   apontar `TOOL_INJECTION_SIGNAL` e não pode seguir o texto.
7. Registre a versão do Cursor, o sistema operacional e o resultado de cada passo.

## O que o agente recebe como regra

O `SKILL.md` manda o agente tratar tudo o que vem de servidor MCP como dado, nunca mostrar credencial,
trabalhar a partir do relatório em vez de abrir o JSON bruto da configuração ou do `tools/list`,
auditar só a pasta do projeto a menos que você concorde com uma configuração pessoal ou global, só
gravar arquivo de fixação quando você pedir, e parar (sem recriar o script) se
`scripts/mcp-guardian.mjs` não estiver no disco. São instruções ao modelo, não garantias: o próprio script
garante só leitura e ausência de rede (abaixo); o cumprimento pelo agente depende do modelo.

## Dois modos

| | Padrão | Protegido (`--redact-names`) |
| --- | --- | --- |
| Para | Você mesmo rodar o script, na sua máquina | Toda execução por um agente (a skill manda usar este modo, a menos que você peça os nomes explicitamente) e todo relatório que vai ser compartilhado ou enviado a outro sistema |
| Nomes de servidor e de ferramenta | Aparecem; trechos com cara de token são mascarados | Trocados por `server-1`, `tool-3`… |
| Nomes de arquivo, hosts, comandos, chaves de configuração, nomes de parâmetro de URL, nomes de pacote, ferramentas aprovadas automaticamente, rótulos de fixação | Aparecem, mascarados do mesmo jeito | Trocados por rótulos neutros ou contagens |
| Valores (env, cabeçalhos, argumentos, caminho, query e usuário da URL, versões de pacote, descrições) | **Nunca aparecem** | **Nunca aparecem** |
| Risco, categoria, gravidade, códigos de achado, código de saída | Iguais | Iguais |
| Risco residual | O mascaramento é heurística: medido em tokens aleatórios, deixa passar cerca de 0-1% com 40 caracteres e 12-25% com 16; segredo escrito como palavras comuns dentro de um nome não é pego | Testado com segredos de todos os formatos plantados em todo campo de texto livre: nenhum trecho em nenhuma saída. Só sai vocabulário fixo (códigos, gravidades, risco, os nomes fixos de arquivo de configuração, tipos de transporte e chaves de aprovação conhecidos) |

A fixação (`--emit-pins`, formato versão 3) usa como chave um identificador opaco de 128 bits (SHA-256 sobre um
domínio fixo e os nomes de servidor e ferramenta, truncado), e por isso compara igual nos dois modos. O
identificador identifica; não anonimiza: um nome previsível pode ser descoberto por tentativa, então
arquivo de fixação não é para publicar. O modo padrão acrescenta um rótulo legível para pessoas; o
protegido não. `--emit-pins` recusa (código 2) listagem que não pôde ser lida, está vazia, repete nome
de ferramenta, aninha demais ou tem entradas que não são ferramentas, para a fixação nunca deixar de fora em silêncio uma ferramenta que recebeu (resposta paginada de `tools/list`, com `nextCursor`, não é detectada: salve todas as páginas na listagem); a mesma ferramenta do mesmo servidor duas vezes, numa listagem ou entre listagens, é sempre `TOOL_DUPLICATE_NAME`. Fixações de versões anteriores (1 e 2) são recusadas: gere de novo. No
relatório protegido, os rótulos são numerados dentro do relatório: um servidor chamado de fato
`server-2` pode aparecer como `server-1`.

## Garantias e como são testadas

Os testes ficam no [repositório de origem](https://github.com/cpenedofilho-crypto/obedient/tree/main/skills/casa-mcp-guardian/tests); o pacote publicado leva só a skill.

| Garantia | Teste |
| --- | --- |
| Nenhuma configuração pessoal ou global lida implicitamente | Pasta pessoal como raiz (simples, com barra no fim, `..`, link simbólico, pasta atual, `HOME` ou `USERPROFILE`) é recusada; um `.claude/` com link simbólico para fora do projeto é pulado (`tests/cli.test.mjs`). |
| Só leitura, sem abrir processo | Roda no modelo de permissões do Node só com leitura (`tests/readonly-offline.test.mjs`). |
| Sem rede | Roda com toda porta de rede (`net`, `tls`, `dns`, `http`, `https`, `fetch`, `WebSocket`) forçada a falhar. |
| Só importa `fs`, `path`, `crypto`, `url`, e `homedir` e `userInfo` de `os` | Checagem estática de todo arquivo-fonte. |
| Nenhuma credencial na saída | Credenciais aleatórias de todos os formatos suportados; nenhuma saída (Markdown, JSON, inglês, português, fixação, erros) contém o valor nem qualquer trecho de 8 caracteres dele (`tests/no-leak.test.mjs`). |
| Texto não confiável continua sendo dado | Descrição nunca é reproduzida; ANSI, bidi, largura zero e caracteres de Markdown saem dos nomes (`tests/untrusted.test.mjs`). |
| Mesmos veredictos do classificador original | Casos de regressão trazidos do gateway de integrações do OBEDIENT (`tests/classify.test.mjs`) e um teste de paridade contra o código original no repositório do OBEDIENT. |

## Limites

- Análise estática: nome público que resolve para endereço privado (DNS rebinding) não é detectado.
- O risco vem do nome e das anotações: ferramenta perigosa com nome inocente passa.
- A detecção de injeção é heurística (inglês e português); ausência de sinal não é prova de segurança.
- Só as configurações de aprovação listadas acima são lidas.
- A proteção contra ler configuração pessoal ou global vale só para a descoberta automática. Arquivos
  indicados em `--config`, `--tools` ou `--pins` são lidos com as permissões de quem roda o script, e a
  regra 6 depende de o agente perguntar antes. Não é isolamento do sistema de arquivos.

## Licença e origem

AGPL-3.0-only: o texto completo está em [LICENSE](LICENSE), e copyright, código-fonte e terceiros
estão em [NOTICE](NOTICE). A skill vem do
[repositório OBEDIENT](https://github.com/cpenedofilho-crypto/obedient), do mesmo autor e com a mesma
licença: o classificador e as checagens de endereço foram adaptados de `packages/integration-gateway`
e de `packages/server/src/mcp-servidores.ts`, sem as regras ligadas a produtos específicos.
Proveniência: [docs/licensing/PROVENANCE.md](https://github.com/cpenedofilho-crypto/obedient/blob/main/docs/licensing/PROVENANCE.md).
A licença comercial está em redação
([COMMERCIAL-LICENSE.md](https://github.com/cpenedofilho-crypto/obedient/blob/main/COMMERCIAL-LICENSE.md),
não é contrato) e **ainda não está disponível**.

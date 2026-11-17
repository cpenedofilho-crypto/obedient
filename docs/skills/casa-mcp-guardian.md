# casa-mcp-guardian: validação, resultados, limites e pendências

Registro de 17/11/2026. A skill fica em `skills/casa-mcp-guardian/`. Nada foi publicado (nem na Agensi
nem em outro marketplace), nada foi mesclado e nada foi para produção.

## 1. Licença, proveniência e direitos (antes de extrair)

| Pergunta | Resposta | Evidência |
| --- | --- | --- |
| De onde vem o código reaproveitado? | `packages/integration-gateway/src/risco.ts` e `seguranca.ts` (que vieram do `casa-de-ia/src/mcp-gateway/`, mesmo autor) e `classificarFerramentaMcp` de `packages/server/src/mcp-servidores.ts` | `docs/licensing/PROVENANCE.md`; cabeçalho de cada arquivo |
| Há código de terceiros? | Não. Nenhuma menção de cópia externa, nenhuma dependência: só `node:fs`, `node:path`, `node:crypto` e `node:url` | Busca por "copied from/adapted from/copyright" nos arquivos de origem; teste estático de importações |
| Quem é o titular? | Cláudio Penedo. Os autores de commit desses arquivos são o fundador (identidades unificadas na `.mailmap`) e "Claude" na conta dele; os termos da Anthropic registrados cedem os outputs ao usuário | `git log --follow` dos arquivos de origem nos dois repositórios; `docs/licensing/termos-provedores.md` |
| Licença de saída | **AGPL-3.0-only**, a mesma do repositório. Extrair dentro do OBEDIENT não muda a licença | `LICENSE`; `SPDX-License-Identifier` em todo arquivo novo; `license:` no `SKILL.md` |
| Há impedimento? | **Não para extrair sob AGPL.** Relicenciar a skill (Apache-2.0 ou comercial) é decisão do titular e da licenciada exclusiva (D15) e **não foi feita aqui** | `GOVERNANCE.md` §1; `COMMERCIAL-LICENSE.md` (minuta) |
| Ressalva | A maior parte do código é "IA-R" (gerado por IA com revisão humana); a revisão do fundador consta "em andamento". Isso pesa na cadeia de titularidade numa venda corporativa | `PROVENANCE.md`, `ai-contributions.md` |

## 2. O que foi feito

- **Classificador** (`scripts/lib/classify.mjs`): risco e categoria pelo nome e pelas anotações booleanas; a anotação nunca rebaixa. Retirado: a lista exata de ferramentas de uma plataforma de anúncios e o verbo `quem_sou` de produto interno. Acrescentado: `notify` conta como comunicação; `--critical-pattern` para a pessoa marcar as ferramentas críticas do próprio ambiente.
- **Endereços** (`endpoint.mjs`): separa loopback (INFO), metadata da nuvem (CRITICAL) e rede privada (MEDIUM), com as grafias IPv4 e IPv6 do original; credencial na URL; parâmetro com cara de credencial; `http` para fora.
- **Credenciais** (`secrets.mjs`): por nome de chave, por bandeira de linha de comando e por formato do valor; devolve só o caminho; última barreira `scrubCredentials` sobre toda a saída.
- **Texto não confiável** (`untrusted.mjs`): sinais de injeção em inglês e português, na descrição da ferramenta e dos parâmetros; caracteres escondidos; nada da descrição é reproduzido; nomes limpos de ANSI, bidi, largura zero e Markdown.
- **Configuração**: `.mcp.json`, Cursor, VS Code (JSONC), configurações do Claude Code; pacote sem versão, imagem sem digest, `sh -c`, `curl | sh`, aprovação automática.
- **Fixação**: SHA-256 de nome, descrição, esquema e anotações; detecta ferramenta nova, alterada e removida. `--emit-pins` imprime; o script não escreve arquivo.
- **Relatório** Markdown ou JSON, em inglês ou português; códigos de saída 0, 1 e 2.
- **Documentação**: `SKILL.md` (em inglês, para o agente), `README.md` e `README.pt-BR.md`, `references/checks.md` bilíngue.

## 3. Resultados dos testes (17/11/2026, Node 22.23)

| Suíte | Casos | Resultado |
| --- | --- | --- |
| Regressão do classificador (`skills/.../tests/classify.test.mjs`) | 27 | passou |
| Paridade com o original (`tests/skills/casa-mcp-guardian-paridade.test.ts`) | 2 (30.042 combinações nome × anotação) | passou; **nenhuma diferença fora das três intencionais** |
| Endereços (`endpoint.test.mjs`) | 6 | passou |
| Não vazamento (`no-leak.test.mjs`) | 5 | passou: nenhuma saída (Markdown, JSON, inglês, português, fixação, erros) contém credencial nem trecho de 8 caracteres dela |
| Texto não confiável (`untrusted.test.mjs`) | 20 | passou |
| Somente leitura, sem rede, sem processo (`readonly-offline.test.mjs`) | 4 | passou: modelo de permissões do Node só com leitura; toda porta de rede forçada a falhar; importações só de `fs`, `path`, `crypto`, `url` |
| Linha de comando e fixação (`cli.test.mjs`) | 10 | passou |
| Pacote da skill (`skill.test.mjs`) | 17 | passou: frontmatter num subconjunto estrito de YAML; `compatibility` só com as versões de Node testadas (22 e 24) e compatibilidade só estrutural com Cursor 2.4+; nenhum documento cita Node 18 ou 20; as regras 5 a 7 do agente (não abrir JSON bruto, perguntar antes de configuração pessoal ou global, não criar fixação sem pedido); `LICENSE` com o texto integral da AGPL (sha256 fixo) e `NOTICE` com copyright, licença, fonte e terceiros; SPDX em todo `.mjs`; nenhum link relativo saindo da pasta; nenhuma oferta de licença comercial como disponível; exemplos pelo caminho da skill; nenhum nome de cliente, produto ou pessoa. Teste de mutação: 8 mutações (Node 18, cada regra removida, `LICENSE` alterada, `NOTICE` sem terceiros, link para fora, licença comercial "oferecida") reprovam |
| Versões do Node (fora do monorepo, pasta copiada) | 89 por versão | passou no Node 22.23.4 e no 24.22.1. Node 18 e 20 **não testados** (não instalados no ambiente; a instalação foi barrada pela política da sessão), por isso não são declarados |
| gitleaks 8.24.3 (a mesma versão do CI, checksum conferido) sobre `skills/`, `tests/skills/`, `docs/skills/` | — | nenhum vazamento (as credenciais de teste são geradas na execução, nunca gravadas) |
| `npm run check` do repositório inteiro | 553 testes; typecheck (inclui o novo `tsconfig.skills.json`, estrito); licenças | 552 passaram, 0 falharam, 1 pulado (anterior, só roda no Postgres do CI) |

**Defeito achado na revisão do `SKILL.md` (corrigido no commit seguinte ao `9f83896`):** os exemplos de
"How to run" usavam `node scripts/mcp-guardian.mjs`, que só funciona com a pasta da skill como pasta
atual; rodado da pasta do projeto, como o próprio texto manda, dava `MODULE_NOT_FOUND`. Os exemplos
passaram a usar `<path-to-this-skill>/scripts/…`, e um teste confere todos.

**Defeitos que os testes pegaram e foram corrigidos antes do commit:**
- bandeira e cabeçalho com hífen (`--api-key`, `X-Api-Key`) não eram reconhecidos como sensíveis;
- a mensagem de opção desconhecida repetia os primeiros 40 caracteres da opção, o que podia ecoar uma credencial colada por engano;
- `notify` não contava como comunicação;
- a checagem de existência do arquivo quebrava quando a permissão de leitura era negada.

**Fumaça com configuração real:** o `.mcp.json` do repositório do Motor (5 servidores) foi auditado só
lendo; nenhum achado. Só contagens e códigos foram exibidos.

## 4. Limites conhecidos

- Análise estática: DNS rebinding (nome público que resolve para endereço privado) não é detectado. O guarda de conexão existe no OBEDIENT (`fetch-seguro.ts`) mas não entrou, porque a skill não usa a rede.
- Risco pelo nome: ferramenta perigosa com nome inocente passa.
- Sinais de injeção são heurísticos (inglês e português). Ausência de sinal não prova segurança.
- O modelo de permissões do Node 22 não cobre rede; a garantia "sem rede" vem do teste com as portas de rede desligadas e da checagem estática.
- Só as chaves de aprovação listadas são lidas; configurações de outros clientes podem ter outras.
- A remoção de vírgula final do JSONC é feita por expressão regular; um texto que contenha `,}` dentro de uma string é alterado só para a leitura (não afeta segredo nem saída).
- Testado só em Linux, Node 22 e 24. Windows, macOS, Node 18 e 20 não foram executados. O teste de somente leitura usa `--permission`, estável a partir do Node 22.
- O campo `data` dos achados (nomes de chave, códigos de sinal) não é traduzido.

## 5. Pendências (decisões e próximos passos)

1. **Licença de distribuição**: manter AGPL-3.0-only, relicenciar para Apache-2.0, ou licença comercial. Decisão do titular (D15). Até lá, a skill só deve circular sob AGPL.
2. **Revisão humana do `SKILL.md`**: é texto que orienta o modelo de quem instalar.
3. **Compatibilidade com o Cursor**: **estrutural** com o Cursor 2.4+ (formato de pasta, `name` igual à pasta, `description` entre aspas, `compatibility` no frontmatter, conferidos por `tests/skill.test.mjs`). **Funcional: não verificada**; o roteiro de teste manual está no README (seção "Manual test in Cursor" / "Teste manual no Cursor"). O item do PR só se marca depois desse teste, com versão do Cursor e sistema registrados.
4. **Avaliação de acionamento**: medir se o agente aciona a skill nos pedidos certos e não nos errados.
5. **Modo ao vivo opcional** (listar ferramentas direto do servidor com `fetchSeguro`): ficou fora de propósito.
6. **Saída SARIF** para integrar com a aba de segurança do GitHub: não feito.
7. **Publicação** (Agensi ou outro): não feita. Pendências fora do código, nenhuma aprovada aqui: termos da Agensi lidos na fonte (o site não abre na rede da sessão), autorização de quem publica diante da D15, revisão humana, revisão jurídica, teste funcional no Cursor, nome (seção 6).
8. **Texto da `LICENSE`**: o gnu.org recusou conexão nesta sessão. O arquivo é o texto no layout do gnu.org com URLs `https`, idêntico byte a byte nas cópias de dois projetos AGPL independentes e, com espaços normalizados, igual ao texto SPDX da `LICENSE` do repositório. Conferir contra https://www.gnu.org/licenses/agpl-3.0.txt antes de publicar; se diferir, trocar o arquivo e o sha256 do teste.

## 6. Nome (anterioridade, 17/11/2026, só busca na web)

Nenhuma troca foi feita. Busca em diretórios de MCP, npm, PyPI e GitHub; **não** substitui busca de
marca no INPI, USPTO e EUIPO.

| Nome | Situação |
| --- | --- |
| MCP Guardian | ocupado: pelo menos 4 projetos, um com plano pago |
| MCP Preflight | ocupado: pelo menos 6 projetos; um (newlifesolution) faz auditoria estática de configuração e `tools/list` com saída SARIF, função quase igual |
| Portcullis | ocupado: pelo menos 7 gateways MCP |
| Tollgate | ocupado (`agent-tollgate`, MIT) |
| mcp-audit, mcp-config-lint, mcp-security-audit | ocupados (vários pacotes e skills) |
| Quayguard | nenhum resultado na web; candidato, sujeito a busca de marca |
| `casa-mcp-guardian` (atual) | o prefixo "casa" distingue, mas "MCP Guardian" no nome herda a confusão; "casa" sem busca de marca |

## 7. Pacote para publicação (montado, não enviado)

Conteúdo: `SKILL.md`, `README.md`, `README.pt-BR.md`, `LICENSE`, `NOTICE`, `references/` e `scripts/`
(14 arquivos). `tests/` fica fora: os testes têm textos de injeção e formatos de credencial gerados de
propósito, que um verificador automático pode tomar por ataque; o README aponta para eles no
repositório. Montagem: zip com a pasta `casa-mcp-guardian/` na raiz, data fixa (17/11/2026) e
permissão 644, para que o mesmo commit gere o mesmo arquivo.

Verificado no pacote extraído numa pasta fora do repositório: gitleaks sem achados; nenhum nome de
cliente, produto ou pessoa; nenhum formato de credencial, e-mail, telefone ou CPF; nenhum link
simbólico; execução da pasta de um projeto no Node 22 e 24 com credencial falsa (`LITERAL_SECRET`,
nenhum trecho de 8 caracteres na saída) e descrição hostil (`TOOL_INJECTION_SIGNAL`, texto não
reproduzido).

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
| Endereços (`endpoint.test.mjs`) | 10 | passou. Desde o T8.1: o relatório mostra só `protocolo//host/`, nunca caminho nem query; `URL_SECRET_PATH` decidido no caminho **original**, com tokens sintéticos de formato desconhecido (hex, base64url, alfanumérico, misto; gerador de semente fixa, 25 sementes × 4 formas de URL); caminhos comuns não disparam |
| Não vazamento (`no-leak.test.mjs`) | 5 | passou: nenhuma saída (Markdown, JSON, inglês, português, fixação, erros) contém credencial nem trecho de 8 caracteres dela |
| Modo protegido e fixação (`redaction.test.mjs`, T8.2) | 22 | passou. Segredos sintéticos de **todos** os formatos (hex, base64url, alfanumérico, misto, só letras, só minúsculas; formato girando por campo em 8 sementes) plantados em todo campo de texto livre, nos layouts `mcpServers`, `servers` e `mcp.servers` (desde o T10), com URL IPv6 e esquema estranho, e também pelo executável real em subprocesso: nome de arquivo de configuração, de listagem e de fixação; chave de servidor; host, caminho, query, usuário e protocolo da URL; `type`; nome e valor de `env`, cabeçalho e argumento; comando; pacote e versão; lista de aprovação automática; nome, descrição, parâmetro e anotação de ferramenta; colisão de nomes; rótulo de fixação; opção desconhecida; padrão inválido; arquivo inexistente. Com `--redact-names`: nenhum trecho de 8 caracteres em Markdown (en, pt), JSON, fixação e `stderr`. Classificação (código, gravidade, risco, categoria, sinais) e código de saída iguais nos dois modos, com `--fail-on` high, critical e medium. Fixação: mesmos ids e hashes nos dois modos, salva num e conferida no outro sem achado; ids de 128 bits com separação de domínio e sem ambiguidade; versão 1 e formato errado viram `PINS_INVALID`. Modo padrão: valores nunca aparecem, inclusive frases legíveis que nenhuma heurística mascara; tokens de 40 caracteres (hex, base64url, alfanumérico, misto) em nomes mascarados. Mutações: 18, todas reprovam |
| Regressões da revisão T9 (`t10.test.mjs`, T10) | 19 | passou. F1: cópia alterada de ferramenta com nome repetido é `TOOL_CHANGED` em qualquer ordem; nome repetido é sempre `TOOL_DUPLICATE_NAME` (HIGH); `--emit-pins` recusa. F2: surrogates soltos dão ids distintos. F3: valor de `--token`, `--registry`, `--index-url` nunca tomado como pacote. F4: 5 formas de fixação malformada viram `PINS_INVALID`; 200 mil níveis viram `TOOL_SCHEMA_TOO_DEEP`; erro inesperado vira mensagem fixa e saída 2. F5: `--emit-pins` recusa entrada ilegível, inválida ou vazia. F6: `HOME` alterado não esconde a pasta pessoal real. F7: `/../` e fragmento examinados. F8: comentário de bloco não junta tokens; `//` termina em CR. F9: mascara antes de cortar. Executável real em subprocesso para F1, F4, F5 e F6. Mutações: 21 (uma por correção), todas reprovam |
| Texto não confiável (`untrusted.test.mjs`) | 20 | passou |
| Somente leitura, sem rede, sem processo (`readonly-offline.test.mjs`) | 4 | passou: modelo de permissões do Node só com leitura; toda porta de rede forçada a falhar; importações só de `fs`, `path`, `crypto`, `url` |
| Linha de comando e fixação (`cli.test.mjs`) | 21 | passou. Inclui 8 casos de regressão de configuração pessoal ou global (T2): pasta pessoal como raiz escrita de seis formas (simples, barra no fim, `/./`, `sub/..`, link simbólico, link com barra), `HOME` com barra no fim e `USERPROFILE`, pasta atual sem `--root` (inglês e português), modelo de permissões sem acesso para resolver link; projeto dentro da pasta pessoal auditado normalmente; `--config` explícito lido; `.claude/` e `.mcp.json` com link simbólico para fora do projeto pulados (`IMPLICIT_PATH_OUTSIDE_PROJECT`) sem ler a credencial deles; raiz que é link para um projeto continua auditada. Desde o T8.3: JSONC com valores que imitam a sintaxe (`,}`, `,]`, `//`, `/* */`, aspas escapadas) é lido igual ao `JSON.parse`, e dá o mesmo relatório que o JSON puro |
| Pacote da skill (`skill.test.mjs`) | 28 | passou: frontmatter num subconjunto estrito de YAML; `compatibility` só com as versões de Node testadas (22 e 24) e compatibilidade só estrutural com Cursor 2.4+; nenhum documento cita Node 18 ou 20; as regras 5 a 7 do agente (não abrir JSON bruto, perguntar antes de configuração pessoal ou global, não criar fixação sem pedido); a descrição suspeita é lida por uma pessoa fora da conversa, nunca colada nela; rotação de credencial recomendada a menos que o arquivo nunca tenha saído da máquina, e na dúvida rotacionar (no `SKILL.md` e nas mensagens fixas de `LITERAL_SECRET`, `URL_CREDENTIALS` e `URL_SECRET_PARAM`, nos dois idiomas); `LICENSE` com o texto integral da AGPL (sha256 fixo) e `NOTICE` com copyright, licença, fonte e terceiros; SPDX em todo `.mjs`; nenhum link relativo saindo da pasta; nenhuma oferta de licença comercial como disponível; exemplos pelo caminho da skill; nenhum nome de cliente, produto ou pessoa. Regra 2 sem rotação incondicional (T1); instrução de parada quando o script não está no disco, antes do primeiro comando; `checks.md` com as duas colunas, inglês e português, em todas as linhas (T3); nenhuma carga literal de ataque nos documentos do pacote, com o risco ainda documentado e apontando para os testes (T4); a ressalva de que a proteção da pasta pessoal vale só para a descoberta automática. Teste de mutação: 13 mutações reprovam (Node 18, cada regra removida, `LICENSE` alterada, `NOTICE` sem terceiros, link para fora, licença comercial "oferecida", descrição sem "fora da conversa", permissão de colar, rotação incondicional, sem "na dúvida", mensagem sem a ressalva) |
| Versões do Node (fora do monorepo, pasta copiada) | 156 por versão | passou no Node 22.23.4 e no 24.22.1. Node 18 e 20 **não testados** (não instalados no ambiente; a instalação foi barrada pela política da sessão), por isso não são declarados |
| gitleaks 8.24.3 (a mesma versão do CI, checksum conferido) sobre `skills/`, `tests/skills/`, `docs/skills/` | — | nenhum vazamento (as credenciais de teste são geradas na execução, nunca gravadas) |
| `npm run check` do repositório inteiro | 573 testes; typecheck (inclui `tsconfig.skills.json`, estrito); licenças | 572 passaram, 0 falharam, 1 pulado (anterior, só roda no Postgres do CI) |

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

**Mutações da rodada T1–T3 (commit seguinte ao `6356fc5`):** 8 de 9 reprovaram (recusa da pasta
pessoal removida, checagem de link removida, resolução de link removida, `HOME`/`USERPROFILE`
ignorados, `node:os` importado inteiro, regra 2 incondicional, instrução de parada removida, célula em
português igual à inglesa). A nona (tirar a barra final do caminho) sobreviveu porque a linha era
redundante: `resolve()` já tira a barra. A linha foi removida em vez de mantida sem teste.

## 4. Limites conhecidos

- `URL_SECRET_PATH` é heurística, medida em 17/11/2026 sobre 20 mil tokens aleatórios por tipo: com 40 caracteres a detecção é praticamente total em hex, base64url, alfanumérico e misto, e perde ~1% dos só-minúsculas; com 16 caracteres perde de 12% a 25%. Id longo de recurso (UUID, IDs do Slack) também dispara. O caminho **nunca** aparece no relatório, detectado ou não.
- Análise estática: DNS rebinding (nome público que resolve para endereço privado) não é detectado. O guarda de conexão existe no OBEDIENT (`fetch-seguro.ts`) mas não entrou, porque a skill não usa a rede.
- Risco pelo nome: ferramenta perigosa com nome inocente passa.
- Sinais de injeção são heurísticos (inglês e português). Ausência de sinal não prova segurança.
- O modelo de permissões do Node 22 não cobre rede; a garantia "sem rede" vem do teste com as portas de rede desligadas e da checagem estática.
- Só as chaves de aprovação listadas são lidas; configurações de outros clientes podem ter outras.
- ~~A remoção de vírgula final do JSONC é feita por expressão regular~~ **Corrigido no T8.3 (achado T7-03):** o registro anterior dizia que um `,}` dentro de string "não afeta segredo nem saída", e estava errado: o valor lido mudava (`https://j.example.com/a,}` virava `/a}`). Agora comentário e vírgula final são tratados na mesma leitura que reconhece strings, e um teste confere que JSONC e JSON puro dão o mesmo relatório.
- Testado só em Linux, Node 22 e 24. Windows, macOS, Node 18 e 20 não foram executados. O teste de somente leitura usa `--permission`, estável a partir do Node 22.
- O campo `data` dos achados (nomes de chave, códigos de sinal) não é traduzido.
- A recusa da pasta pessoal reconhece `os.homedir()`, `HOME` e `USERPROFILE`. Configuração global fora
  da pasta pessoal (por exemplo `/etc`, ou a pasta de configuração do Claude Desktop no Windows e no
  macOS) não está na lista padrão e só é lida com `--config`; a regra 6 manda o agente perguntar antes.
- Sob o modelo de permissões do Node sem acesso de leitura à pasta pessoal, link simbólico não pode ser
  resolvido; a comparação cai no caminho resolvido, e a recusa da pasta pessoal continua valendo
  (testado).

- **Nomes no modo padrão (T8.2):** o mascaramento é heurística. Medido em 20 mil tokens aleatórios por tipo (17/11/2026): com 40 caracteres deixa passar ~0% (só minúsculas ~1%); com 32, até 0,25% (só minúsculas ~2,5%); com 16, de 12% a 25%. Segredo escrito como palavras comuns dentro de um nome não é pego. Por isso o modo protegido (`--redact-names`) é **obrigatório** para relatório compartilhado ou enviado a outro sistema (regra 9 do `SKILL.md`). A ferramenta não tem como saber se o relatório será compartilhado: a obrigação é de quem roda e do agente, não do código.
- **Modo protegido:** a garantia vale para os campos listados no teste `redaction.test.mjs` (todo texto livre que a skill lê). O que sai é vocabulário fixo: códigos, gravidades, risco, categoria, sinais, os nomes fixos de arquivo de configuração padrão, tipos de transporte conhecidos e chaves de aprovação conhecidas. Contagens (de parâmetros, de ferramentas aprovadas, de trechos de caminho) aparecem.
- **Fixação versão 2:** o id é SHA-256 truncado em 128 bits sobre domínio fixo e nomes com prefixo de tamanho. Identifica, não anonimiza: um nome previsível pode ser descoberto por tentativa. Fixação versão 1 é recusada; é preciso gerar de novo.
- **A própria conversa com o agente (decidido em 17/11/2026):** a regra 9 do `SKILL.md` manda o agente rodar **sempre** com `--redact-names`. O modo legível fica para a pessoa rodar na própria máquina; o agente só o usa quando a pessoa pede explicitamente os nomes na conversa, e só para aquela execução. O que sair da conversa usa sempre a saída protegida. Todos os exemplos de comando do `SKILL.md` trazem `--redact-names`, e um teste reprova se algum deixar de trazer. Continua sendo instrução ao modelo: o script não sabe quem o chama.

- **Revisão independente T9 e correções T10 (17/11/2026).** A revisão (agente separado, sem a avaliação do autor) não achou vazamento no modo protegido e achou 10 problemas fora dele, corrigidos no T10: F1 e F2 em `90c2140`, F3 em `440ade1`, F4 e F5 em `c227ad1`, F6 a F9 em `090b9bf`, F10 e a cobertura de layouts no commit de documentação seguinte. **Correção de registro:** a medição do mascaramento do modo padrão (T8.2) usou nomes curtos; em nomes longos, o corte no tamanho máximo acontecia antes do mascaramento e deixava parte do token à mostra (F9). Corrigido; a medição continua valendo para o detector.
- **Fixação:** fixações geradas antes de `90c2140` precisam ser geradas de novo (o id passou a ser calculado sobre a forma JSON dos nomes).

## 5. Pendências (decisões e próximos passos)

1. **Licença de distribuição**: manter AGPL-3.0-only, relicenciar para Apache-2.0, ou licença comercial. Decisão do titular (D15). Até lá, a skill só deve circular sob AGPL.
2. **Revisão humana do `SKILL.md`**: é texto que orienta o modelo de quem instalar.
3. **Compatibilidade com o Cursor**: **estrutural** com o Cursor 2.4+ (formato de pasta, `name` igual à pasta, `description` entre aspas, `compatibility` no frontmatter, conferidos por `tests/skill.test.mjs`). **Funcional: não verificada**; o roteiro de teste manual está no README (seção "Manual test in Cursor" / "Teste manual no Cursor"). O item do PR só se marca depois desse teste, com versão do Cursor e sistema registrados.
4. **Avaliação de acionamento**: medir se o agente aciona a skill nos pedidos certos e não nos errados.
5. **Modo ao vivo opcional** (listar ferramentas direto do servidor com `fetchSeguro`): ficou fora de propósito.
6. **Saída SARIF** para integrar com a aba de segurança do GitHub: não feito.
7. **Publicação** (Agensi ou outro): não feita. Pendências fora do código, nenhuma aprovada aqui: termos da Agensi lidos na fonte (o site não abre na rede da sessão), autorização de quem publica diante da D15, revisão humana, revisão jurídica, teste funcional no Cursor, nome (seção 6).
8. **Texto da `LICENSE`** (corrigido em 17/11/2026, auditoria T5): o arquivo da skill é a variante **antiga**, com URLs `http` (sha256 `57c8ff33c9c0cfc3ef00e650a1cc910d7ee479a8bc509f6c9209a7c2a11399d6`), a mesma da `LICENSE` da raiz depois de normalizar espaços. O texto oficial atual da GNU (`https://ftp.gnu.org/gnu/Licenses/agpl-3.0.txt`, Last-Modified 30/09/2017, sha256 `0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0`) difere em 3 linhas (4, 646 e 661), só no esquema `http`/`https`; os termos são idênticos. O registro anterior dizia o contrário ("layout do gnu.org com URLs `https`"): o `diff` foi lido na direção errada. **Trocar o arquivo pelo texto oficial depende de aprovação jurídica** (roteiro de release, seção 1); a `LICENSE` da raiz é análise à parte, porque vale para o repositório inteiro.

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
| Quayguard | nenhum resultado na web. **Candidato provisório: "Casa de IA Quayguard"** (17/11/2026), sem renomear a pasta; depende de busca na WIPO Global Brand Database e nos registros nacionais e regionais (INPI, USPTO, EUIPO). Busca vazia na web não libera o nome |
| `casa-mcp-guardian` (atual) | o prefixo "casa" distingue, mas "MCP Guardian" no nome herda a confusão; "casa" sem busca de marca |

## 7. Pacote para publicação (montado, não enviado)

Conteúdo: `SKILL.md`, `README.md`, `README.pt-BR.md`, `LICENSE`, `NOTICE`, `CHANGELOG.md`, `references/` e `scripts/`
(16 arquivos desde o T8.2, com `scripts/lib/present.mjs`; 15 no T6; 14 antes). `tests/` fica fora: os testes têm textos de injeção e formatos de credencial gerados de
propósito, que um verificador automático pode tomar por ataque; o README aponta para eles no
repositório. Montagem: zip com a pasta `casa-mcp-guardian/` na raiz, data fixa (17/11/2026) e
permissão 644, para que o mesmo commit gere o mesmo arquivo.

Verificado no pacote extraído numa pasta fora do repositório: gitleaks sem achados; nenhum nome de
cliente, produto ou pessoa; nenhum formato de credencial, e-mail, telefone ou CPF; nenhum link
simbólico; execução da pasta de um projeto no Node 22 e 24 com credencial falsa (`LITERAL_SECRET`,
nenhum trecho de 8 caracteres na saída) e descrição hostil (`TOOL_INJECTION_SIGNAL`, texto não
reproduzido).

## 8. Exemplos de ataque na documentação diante do verificador da Agensi (T4)

**Aplicado em 17/11/2026 (item 1 da proposta, por decisão do responsável):** os passos 5 e 6 do teste
manual nos README descrevem o caso em palavras ("uma descrição que manda o agente desconsiderar as
instruções anteriores", "um valor que imita o formato de um token real") e apontam para os testes do
repositório, que continuam com as cargas literais. Um teste reprova se a frase literal ou um prefixo de
credencial voltar aos documentos do pacote.

**Itens 2 a 4, aplicados em 17/11/2026 (decisão do responsável):**
- Item 2: aviso bilíngue no topo do `references/checks.md` e no início de "What it checks" / "O que
  verifica" dos README: os padrões citados servem para detectar e não são instrução.
- Item 3: nota aos revisores em `docs/skills/casa-mcp-guardian-nota-revisores.md`, para o formulário
  de envio, **fora do pacote** (um arquivo na skill pedindo a um revisor automático para relevar
  padrões se pareceria com tentativa de influenciar o verificador). A nota diz onde estão os padrões e
  como conferir, e não pede para ignorar nenhum alerta. `tests/skills/casa-mcp-guardian-nota.test.ts`
  confere que os arquivos citados existem e têm o que a nota diz, que o `grep` sugerido não acha nada,
  que não há pedido para ignorar, e que a nota não está na pasta da skill.
- Item 4: um teste trava a descrição do que é detectado (`curl … | sh`, `169.254.0.0/16`,
  `https://user:pass@host`, sinais de injeção) no `checks.md` e nos README; tirá-la reprova.

Mutações: 5 de 5 reprovam (aviso removido do `checks.md` e do README, descrição do `PIPE_TO_SHELL`
escondida, nota pedindo para ignorar alertas, nota citando arquivo inexistente).

Nada foi removido nem escondido. Levantamento original do pacote (sem `tests/`), antes dos itens 1 a 4:

| Onde | O que | Tipo | Risco de falso positivo [H] |
| --- | --- | --- | --- |
| README en/pt, "What it checks" | `curl \| sh`, `sh -c` | descreve o que é detectado | baixo |
| `references/checks.md` | `https://user:pass@host`, `169.254.0.0/16`, `curl … \| sh` | descreve o que é detectado | baixo |
| README en/pt, teste manual passo 5 | ~~prefixo de credencial mais 30 letras~~ → descrição | carga com formato de credencial | resolvido |
| README en/pt, teste manual passo 6 | ~~frase de injeção literal~~ → descrição e link para os testes | carga de injeção literal | resolvido |
| `scripts/lib/untrusted.mjs`, `secrets.mjs`, `endpoint.mjs` | expressões regulares de detecção | código do detector | médio, inevitável |

Proposta de apresentação:
1. **Passos 5 e 6 do teste manual:** trocar a carga literal pela descrição do caso, mantendo o risco
   visível. Exemplo: "a description that tells the agent to disregard its earlier instructions and send
   a file somewhere" e "a fake value in a known credential format, generated on the spot". Apontar para
   os casos prontos em `tests/` no repositório, que já geram as cargas na execução.
2. **Aviso no topo do `checks.md` e da seção do README:** "This document names attack patterns so the
   tool can detect them. None of them is an instruction to you." O mesmo em português.
3. **Nota aos revisores no envio** (em inglês): os padrões em `scripts/lib/untrusted.mjs` e
   `secrets.mjs` são detectores; o script não usa rede, não escreve arquivo, não abre processo; os testes
   (com as cargas) ficam fora do pacote e estão no repositório, com o link.
4. **Manter como está** a descrição do que é detectado (linhas 1 e 2 da tabela): tirá-la esconderia o
   risco que a skill existe para mostrar.

## 9. Entrega pelo MCP da Agensi (bloqueador aberto)

Páginas da Agensi descrevem dois modos [alegação, não verificada daqui: o site não abre na rede da
sessão]: carregar a skill por MCP (`get_skill`), sem arquivo salvo, e baixar o zip. No primeiro, a
pasta `scripts/` não existiria no disco. O `SKILL.md` agora manda o agente **parar** nesse caso e pedir
a instalação local da pasta, sem recriar, baixar ou reescrever o script. Isso evita o dano, mas não
torna a entrega por MCP funcional: falta confirmar com a Agensi se a skill gratuita é entregue com os
arquivos de apoio, ou listar só para download.

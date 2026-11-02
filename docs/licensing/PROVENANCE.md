# Proveniência

Este arquivo registra a origem de cada arquivo do repositório. Serve de base para a cadeia de
titularidade (diligência de cliente Enterprise/OEM) e para a licença exclusiva do autor à Casa de
IA.

## Declaração de identidade do autor

Os autores de commit **"Samar"**, **"cpenedofilho"**, **"cpenedofilho-crypto"**, **"Claudio
Penedo"** e **"Cláudio Penedo"**, todos com o e-mail `cpenedofilho@gmail.com`, são a **mesma
pessoa: Cláudio Penedo**. "Samar" é o nome de usuário herdado de um notebook comprado usado, que nunca
foi alterado (decisão D2, 02/11/2026). O `.mailmap` deste repositório unifica
essas identidades.

*Declaração a ser confirmada por escrito no instrumento de licença (ponto 13).*

## Ferramentas de IA

Todas as contas de IA usadas (Claude Code, API Anthropic, Codex/OpenAI) estão **no nome do
fundador, pessoa física** (confirmado em 02/11/2026). Os termos vigentes estão em
`termos-provedores.md`.

Tipos de autoria usados abaixo:

| Tipo | Significado |
|---|---|
| **H** | Escrito por pessoa |
| **IA-R** | Gerado por IA, com revisão humana |
| **IA-H** | Gerado por IA, com edição humana substancial |
| **AD** | Adaptado de um arquivo de origem do mesmo autor, com mudança registrada |
| **T** | Texto de terceiro, sob a licença indicada |

## Arquivos

| Arquivo | Origem | Commit de origem | Tipo | Observação |
|---|---|---|---|---|
| `LICENSE` | spdx/license-list-data, `text/AGPL-3.0-only.txt` (sha256 `d8a6cc31…96bee`) | n/a | T | Conferido contra o npm `spdx-license-list@6.12.0`. Trocar pelo arquivo canônico do gnu.org antes de publicar |
| `packages/sdk/LICENSE` | spdx/license-list-data, `text/Apache-2.0.txt` (sha256 `074e6e32…615ff`) | n/a | T | Idem |
| `packages/policy-engine/src/index.ts` | `casa-de-ia/src/governanca/motor-de-politicas.ts` | `224c960` (autores no histórico: Claudio Penedo, 04/10/2026; Claude, 19/10/2026) | AD | Nomes em inglês; aprovador passou de papel de organização (`manager`/`org_admin`) para o usuário (`user`/`user_strong_auth`); `effectiveRisk` exposto. Semântica mantida |
| `packages/policy-engine/src/index.test.ts` | `casa-de-ia/src/governanca/motor-de-politicas.test.ts` | `224c960` | AD | De vitest para node:test; mesmos casos, mais o caso de piso por categoria |
| `packages/integration-gateway/src/tipos.ts`, `risco.ts`, `seguranca.ts` | `casa-de-ia/src/mcp-gateway/` (mesmos nomes; de `seguranca.ts` só a parte genérica) | `45ba448` (últimos commits nesses arquivos: cpenedofilho-crypto, 31/10/2026) | AD | Código idêntico; dois comentários trocaram nome de cliente por exemplo genérico |
| `packages/integration-gateway/src/index.test.ts` | `casa-de-ia/src/mcp-gateway/regras.test.ts` e `categorias.test.ts` | `45ba448` | AD | Endpoint real de produção trocado por host de exemplo |
| `packages/event-bus/src/tipos.ts`, `regras.ts`, `consumidores.ts`, `produtores.ts` | `casa-de-ia/src/event-bus/` (mesmos nomes) | `45ba448` (últimos commits: cpenedofilho-crypto 31/10/2026; Claude 01/11/2026) | AD | Regras idênticas; fontes, entidades e tipos deixaram de ser listas fixas e vêm do vocabulário; guardas de `undefined` exigidas pelo tsconfig estrito |
| `packages/event-bus/src/vocabulario.ts` | Mecanismo de `casa-de-ia/src/event-bus/vocabulario.ts` | `45ba448` | AD | Lista fixa virou `criarVocabulario()`; as conferências do teste do Growth OS rodam na construção |
| `packages/event-bus/src/memoria.ts`, `vocabulario-obedient.ts` | Semântica de `despachar.ts`/`ingresso.ts` do Growth OS | `45ba448` | IA-R | Código novo; nenhuma linha copiada |
| `packages/event-bus/src/regras.test.ts` | `casa-de-ia/src/event-bus/regras.test.ts` | `45ba448` | AD | Sem o contrato HTTP (zod); nomes de cliente trocados por genéricos |
| `packages/mission-engine/src/transicoes.ts`, `plano.ts`, `esquema.ts`, `autonomia.ts` | `casa-de-ia/src/equipes/` (mesmos nomes) | `45ba448` (últimos commits nesses arquivos: Claude, 14 e 15/10/2026) | AD | Código idêntico; só os imports mudaram (`autonomia.ts` passa a importar do `integration-gateway`) |
| `packages/mission-engine/src/tipos.ts` | `casa-de-ia/src/equipes/tipos.ts` | `45ba448` | AD | Só a parte genérica; as listas do negócio do Growth OS ficaram lá |
| `packages/mission-engine/src/index.test.ts` | `casa-de-ia/src/equipes/equipes.test.ts` e `arquitetura.test.ts` | `45ba448` | AD | Sem os casos que leem migrations do Growth OS; teste cruzado com o Policy Engine é novo |
| `packages/ethics-engine/src/approvals.ts` | Desenho de `ronda-app/lib/assistente/acoes.ts` (proposta e cartão, prazo de 30 min) e de `recupera-os/docs/migrations/60_aprovacoes_limites_servidor.sql` (quem pede não decide, prazo ≤ 72 h, hash) | n/a | IA-R | Nenhuma linha copiada; só o desenho |
| `packages/ethics-engine/src/audit.ts` | Desenho da imutabilidade de `interacoes` no Recupera OS | n/a | IA-R | Código novo |
| `packages/dots-adapter/src/index.ts` | Nomes de ferramenta conferidos em `recupera-mcp/src/agentic/tools/*.ts` e `motor-triagem-iga/mcp/tools/*` (todas READ/LOW) | n/a | IA-R | Nenhum código importado dos dois repositórios |
| Todos os demais arquivos | Criados em 02/11/2026 com assistência de IA | n/a | IA-R | Revisão do fundador em andamento; publicado como pré-alfa por decisão D12 |

## O que NÃO veio para cá, de propósito

- Prompts, tools e tabelas do Dot Recupera (domínio de cobrança).
- Qualquer coisa do Motor de Triagem além dos nomes de ferramenta.
- Material de cliente.
- O subprojeto de vídeo (Remotion).
- Os `CLAUDE.md` dos repositórios de origem.

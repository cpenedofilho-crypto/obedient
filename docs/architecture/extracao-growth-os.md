# Extração das peças genéricas do Growth OS (decisão D7, opção A)

**Decisão (02/11/2026):** a coordenação de agentes não é reescrita no OBEDIENT. As peças genéricas
do Growth OS (`casa-de-ia`) saem para pacotes do OBEDIENT, e o Growth OS passa a consumi-las.
Resultado: uma implementação só, com um conjunto de testes só.

## Medição (02/11/2026, `casa-de-ia` em `45ba448`)

| Módulo | Linhas | Depende de banco (Prisma) | Arquivos sem banco |
|---|---|---|---|
| `mcp-gateway` | 2.300 | 6 de 9 arquivos | `tipos`, `risco`, `seguranca` (parte genérica), `conexao` |
| `event-bus` | 2.309 | 7 de 12 | `tipos`, `regras`, `vocabulario`, `consumidores`, `produtores`, `api` |
| `equipes` | 5.414 | 17 de 23 | `tipos`, `transicoes`, `plano`, `esquema`, `contratos`, `autonomia`, `modelos`, `integracao` |
| `agent-runtime` | 2.065 | 9 de 11 | `tipos`, `modelo-anthropic` |
| `governanca` | 760 | 2 de 2 (o motor puro já saiu) | n/a |
| `triggers` | 827 | 4 de 4 | `agenda` |

Conclusão: o que é regra pura sai copiando. O que fala com banco sai **atrás de uma porta**: uma
interface que o Growth OS implementa com Prisma e o OBEDIENT com o próprio banco.

## Etapas

| # | O quê | Para | Estado | Critério de pronto |
|---|---|---|---|---|
| 1 | Motor de políticas | `@obedient/policy-engine` | **Feito** | 17 testes portados |
| 2 | Tipos, classificação de risco e categoria de ferramenta, SSRF, redação, hash de argumentos | `@obedient/integration-gateway` | **Feito** | Mesmo código (só dois comentários mudaram), 52 testes portados |
| 3 | Event bus: tipos, regras, consumidores e produtores; vocabulário virou parâmetro (`criarVocabulario`); barramento em memória como contrato; vocabulário próprio do OBEDIENT | `@obedient/event-bus` | **Feito** | Testes de regra portados; contrato do barramento testado (idempotência, isolamento entre tenants, retry, dead letter, eventos derivados). A porta Postgres do Growth OS entra na etapa 6 |
| 4 | Missões e equipes: tipos, máquina de estados (missão e tarefa), plano com dependências e camadas, subconjunto de JSON Schema, autonomia e delegação | `@obedient/mission-engine` | **Feito** | Casos portados; novo teste cruzado prova que a autonomia nunca libera mais que o Policy Engine. Contratos (zod), modelos de equipe e integração com os produtos ficaram no Growth OS: são do negócio dele |
| 5 | Agent runtime: o laço do run (modelo, ferramentas, limites, retomada após aprovação) sem banco; roteamento de modelo; limpeza de dado pessoal no resultado de ferramenta; ligação com o Ethics Engine | `@obedient/agent-orchestrator` (+ `dado-pessoal` no `integration-gateway`) | **Feito** | Regras do `executar.ts` testadas com modelo roteirizado; aprovação executa uma vez com o payload exato; instrução injetada em resultado não vira ação. Ficaram no Growth OS: fila e reivindicação de runs (Postgres), orçamento por organização, ferramentas internas, delegação em equipe e o adaptador do SDK |
| 6 | O Growth OS passa a importar os pacotes | PRs no `casa-de-ia` | **Feito** (02/11/2026): motor de políticas (casa-de-ia#164, diferencial com 20 000 casos); risco, segurança e dado pessoal (#165, código idêntico); event bus (#166, diferencial com 20 000 eventos, textos de recusa iguais via `mensagens`); missões (#167, código idêntico); tipos do runtime e roteamento de modelo (#167, diferencial em todas as 255 combinações). **Fica no Growth OS, por decisão:** o laço do run (`executar.ts`), que grava cada passo no banco; a `executarRodada` devolve o estado no fim, e trocar muda o que fica salvo se o processo cair no meio (decisão D16) | `npm test`, `test:db` e harness do Growth OS verdes em cada PR; nenhuma mudança de comportamento em produção |

## Como o Growth OS consome (decidido na etapa 6)

- **Cópia fixada e conferida ("vendoring").** O `casa-de-ia` guarda em `vendor/obedient/` os arquivos
  de um commit exato da `main` do OBEDIENT, com um `MANIFEST.json` de hashes. Um teste do Growth OS
  (`src/governanca/obedient-vendor.test.ts`) reprova qualquer edição local e qualquer arquivo fora do
  manifesto. Para atualizar, roda-se `scripts/obedient-vendor.mjs <checkout> <sha>` no `casa-de-ia`.
- **Por que não dependência npm:** o npm não instala subpacote de monorepo por git, e publicar num
  registro exigiria token no build da Vercel. A cópia não tem rede no build, e o OBEDIENT continua sendo
  a fonte única.
- **Onde o código é idêntico** (`integration-gateway`), os arquivos do Growth OS viram reexportações.
  **Onde mudou** (`policy-engine` em inglês, vocabulário parametrizado, laço sem banco), entra um
  adaptador fino com **teste diferencial**: a implementação antiga do Growth OS fica guardada como
  referência e é comparada com a nova em milhares de casos gerados.

## Efeito de licença (registrado)

- **Esses pacotes são AGPL-3.0-only.** O Growth OS, privado, passa a depender deles. Como o autor
  é o mesmo e a Casa de IA é a licenciada exclusiva, o Growth OS usa esse código pela licença do
  titular, não pela AGPL. A §13 não se aplica a quem detém os direitos.
- **Isso só se mantém enquanto toda contribuição externa entrar com CLA.** Código de terceiro sob
  AGPL sem CLA dentro desses pacotes obrigaria o Growth OS. Por isso o `CONTRIBUTING.md` segura os
  merges externos até o CLA 1.0.

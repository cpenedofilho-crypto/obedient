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
| 4 | Equipes e missões: tipos, transições (máquina de estados), plano, autonomia, contratos | `@obedient/mission-engine` | Próxima | Transições e autonomia testadas sem banco |
| 5 | Agent runtime: execução com porta de modelo e porta de fila | `@obedient/agent-orchestrator` | A fazer | Rodada de agente com modelo falso, como o executor do Dot já faz |
| 6 | O Growth OS passa a importar os pacotes | PR no `casa-de-ia` | A fazer | `npm test`, `test:db` e harness do Growth OS verdes; nenhuma mudança de comportamento em produção |

## Como o Growth OS vai consumir

- **Agora:** dependência git apontando para uma tag do repositório `obedient`, por exemplo
  `"@obedient/policy-engine": "github:cpenedofilho-crypto/obedient#v0.1.0"`, com o subcaminho do
  pacote. Alternativa: publicar no npm quando houver release.
- **Nomes:** o `integration-gateway` manteve os nomes em português, para que a troca no Growth OS
  seja só de import. O `policy-engine` passou para inglês. Na etapa 6 entra um adaptador fino no
  Growth OS (`decidir → decide`) com o teste original como prova.

## Efeito de licença (registrado)

- **Esses pacotes são AGPL-3.0-only.** O Growth OS, privado, passa a depender deles. Como o autor
  é o mesmo e a Casa de IA é a licenciada exclusiva, o Growth OS usa esse código pela licença do
  titular, não pela AGPL. A §13 não se aplica a quem detém os direitos.
- **Isso só se mantém enquanto toda contribuição externa entrar com CLA.** Código de terceiro sob
  AGPL sem CLA dentro desses pacotes obrigaria o Growth OS. Por isso o `CONTRIBUTING.md` segura os
  merges externos até o CLA 1.0.

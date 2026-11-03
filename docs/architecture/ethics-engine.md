# Ethics Engine

**Princípio:** o modelo propõe, o backend decide e a pessoa autoriza o que é sensível. Nenhuma
decisão de autorização lê texto do modelo.

## Fluxo de uma ação (`EthicsEngine.authorize`)

```
modelo escolhe ferramenta + argumentos
  → agente ≠ usuário?                         (não pode se passar pelo usuário)
  → parada de emergência?                     → denied            Art. 9º
  → grant vigente que cobre a ferramenta?     → denied se não há  Art. 3º
  → risco efetivo ≤ risco máximo do grant?    → denied se passa
  → valor ≤ limite do grant? (ilegível nega)  → denied            Art. 6º
  → dado pessoal: finalidade + consentimento? → denied            Art. 4º
  → Policy Engine (políticas do usuário + autonomia do grant)
       deny .......................... denied
       allow ......................... allowed            (quem chama executa)
       require_approval .............. proposta → cartão → aprovação → execução única
       require_privileged_approval ... idem, com autenticação forte
  → auditoria encadeada em todas as saídas                       Art. 8º
  → o sistema de destino aplica a PRÓPRIA política (RLS, Policy Engine do Recupera, Motor V2)
```

Qualquer exceção vira `denied` (fail-closed).

## Peças

| Peça | Arquivo | Origem do desenho |
|---|---|---|
| Policy Engine | `packages/policy-engine/src/index.ts` | Extraído do Growth OS (`casa-de-ia`) |
| Delegated Authority Registry | `packages/ethics-engine/src/grants.ts` | Novo |
| Consent Manager | `packages/ethics-engine/src/consent.ts` | Novo (LGPD) |
| Human Approval Gateway | `packages/ethics-engine/src/approvals.ts` | Ronda (proposta e cartão) + Recupera (hash, quem pede não decide) |
| Emergency Stop | `packages/ethics-engine/src/emergency-stop.ts` | Novo |
| Audit Trail | `packages/ethics-engine/src/audit.ts` | Imutabilidade das `interacoes` do Recupera, com cadeia de hash |
| Policy Versioning | `CONSTITUTION_VERSION` gravado em cada grant e cada decisão | Novo |
| Policy Test Suite | `tests/constitution/constitution.test.ts` | Padrão das suítes SQL do Ronda |

## Armazenamento (Fase 4b)

O motor é assíncrono e cada componente lê e grava por uma porta: `GrantStore`, `ConsentStore`,
`ProposalStore`, `StopStore` e `AuditSink`. As implementações em memória são o padrão e servem aos
testes; o Postgres entra pelas mesmas portas (`@obedient/store-postgres`).

- **Toda leitura é por usuário** (`listByUser`), nunca "todos os registros", para que a RLS do banco
  possa filtrar sem esconder nada de que o motor precise.
- **A cadeia de auditoria é por usuário:** `seq` e `prevHash` contam dentro do usuário, e
  `verify(userId)` confere a trilha de uma pessoa sem ler a das outras. O que não é de ninguém
  (parada global) fica na cadeia `"*"`. `AuditSink.append` recebe a cabeça atual da cadeia e grava
  sem que outra gravação do mesmo usuário passe no meio.
- **A troca de estado da proposta é atômica** (`ProposalStore.transition`, compare-and-set): aprovar,
  rejeitar, reivindicar a execução e concluir só gravam se a proposta ainda estiver no estado
  esperado. É o que impede, com vários processos, duas aprovações ou duas execuções.

## Limites conhecidos (registrados, não escondidos)

- **Quem chama informa o `kind` do aprovador e do liberador da parada.** No servidor, isso vem da
  sessão autenticada, nunca do corpo da requisição. É a integração da Fase 4b.
- **Autenticação forte é um booleano informado.** A prova real (passkey, biometria) é da camada
  de sessão.
- **Risco e categoria vêm do registro da ferramenta.** Um registro errado gera decisão errada.
  Por isso o SDK valida a declaração e recusa "READ com risco HIGH".

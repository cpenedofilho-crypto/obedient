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

## O que ainda é memória (e precisa virar banco)

Grants, consentimentos, propostas e auditoria têm implementação em memória, atrás de interfaces
(`GrantStore`, `AuditSink`). A Fase 4b troca isso por Postgres:

- **RLS por usuário.**
- **Auditoria append-only:** sem UPDATE nem DELETE concedidos, como as `interacoes` do Recupera.
- **Reivindicação da proposta atômica:** `UPDATE … WHERE status='approved' RETURNING`.

O comportamento é fixado pelos testes, que são o contrato da troca.

## Limites conhecidos (registrados, não escondidos)

- **Quem chama informa o `kind` do aprovador e do liberador da parada.** No servidor, isso vem da
  sessão autenticada, nunca do corpo da requisição. É a integração da Fase 4b.
- **Autenticação forte é um booleano informado.** A prova real (passkey, biometria) é da camada
  de sessão.
- **Risco e categoria vêm do registro da ferramenta.** Um registro errado gera decisão errada.
  Por isso o SDK valida a declaração e recusa "READ com risco HIGH".

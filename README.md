# OBEDIENT

Agente pessoal open source governado por uma **Constituição Ética verificável**: o modelo
propõe, o backend decide e a pessoa autoriza o que é sensível.

> **Estado: pré-alfa.** Os documentos jurídicos deste repositório (Constituição, CLA, licença
> comercial, governança) são **minutas não revisadas** e podem mudar. **Ainda não aceitamos
> contribuições externas**: o CLA está em revisão jurídica (ver `CONTRIBUTING.md`).

## O que já existe

| Pacote | Licença | O que faz |
|---|---|---|
| `@obedient/core` | AGPL-3.0-only | Tipos, relógio injetável, hash canônico de payload |
| `@obedient/policy-engine` | AGPL-3.0-only | Decisão pura: `deny > aprovação forte > aprovação > allow`, piso CRITICAL por categoria |
| `@obedient/ethics-engine` | AGPL-3.0-only | Grants (Art. 3º), consentimento (Art. 4º), aprovação humana com hash e execução única (Art. 1º e 12), parada de emergência (Art. 9º), auditoria encadeada (Art. 8º) |
| `@obedient/integration-gateway` | AGPL-3.0-only | Risco e categoria de ferramenta MCP de terceiros sem confiar nas dicas do servidor, proteção contra SSRF, redação de dado pessoal (extraído do Growth OS, decisão D7) |
| `@obedient/event-bus` | AGPL-3.0-only | Barramento de eventos: vocabulário declarado por sistema, idempotência, rede contra dado pessoal, retry com espera dobrada e dead letter (extraído do Growth OS, D7) |
| `@obedient/mission-engine` | AGPL-3.0-only | Máquina de estados de missão e tarefa, plano com dependências em camadas, autonomia por níveis que só restringe e delegação por interseção (extraído do Growth OS, D7) |
| `@obedient/agent-orchestrator` | AGPL-3.0-only | O laço do agente: modelo propõe, cada ferramenta passa pelo Ethics Engine, o que exige pessoa para o run até a aprovação e executa uma vez; limites de passos, tokens, prazo, laço e ferramenta inválida (extraído do Growth OS, D7) |
| `@obedient/dots-adapter` | AGPL-3.0-only | O DOTS como agente subordinado, **só leitura**, por MCP |
| `@obedient/store-postgres` | AGPL-3.0-only | O Ethics Engine em Postgres: RLS forçada por usuário, auditoria só de inclusão com a cadeia conferida pelo banco, execução única da proposta e sessão autenticada (`docs/architecture/persistencia.md`) |
| `@obedient/memory` | AGPL-3.0-only | Memória pessoal com aprendizado opt-in por assunto: toda lição visível e apagável; desligar apaga; treino de modelo de terceiro só com consentimento separado (`docs/architecture/memoria-e-direitos.md`) |
| `@obedient/server` | AGPL-3.0-only | O servidor e o app (PWA) onde a pessoa decide: entrada por passkey, cartões de aprovação, parada, autorizações e trilha, com fila sem internet (`docs/architecture/app.md`) |
| `@obedient/sdk` | **Apache-2.0** | Contrato de protocolo para integradores, sem dependência do núcleo AGPL |

O que **ainda não existe** (sem stub, sem pasta vazia): missões persistidas e a API pela qual o agente chega ao servidor. A ordem está em `docs/ROADMAP.md` e a extração do Growth OS em
`docs/architecture/extracao-growth-os.md`.

## Rodar

```bash
npm install
npm run check      # typecheck + testes (inclui a suíte constitucional) + allowlist de licenças
```

Node 22 ou mais novo.

## Documentos

- [`CONSTITUTION.md`](CONSTITUTION.md): princípios, regras verificáveis e obrigações legais
- [`GOVERNANCE.md`](GOVERNANCE.md): titular, papel do fundador, mantenedores, releases
- [`CONTRIBUTING.md`](CONTRIBUTING.md), [`CLA.md`](CLA.md),
  [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md), [`SECURITY.md`](SECURITY.md)
- [`COMMERCIAL-LICENSE.md`](COMMERCIAL-LICENSE.md), [`TRADEMARKS.md`](TRADEMARKS.md),
  [`NOTICE`](NOTICE)
- [`docs/architecture/ethics-engine.md`](docs/architecture/ethics-engine.md),
  [`docs/architecture/dots.md`](docs/architecture/dots.md)
- [`docs/licensing/PROVENANCE.md`](docs/licensing/PROVENANCE.md): de onde veio cada arquivo
- [`docs/governance/decisoes.md`](docs/governance/decisoes.md): decisões D1 a D15 do fundador

## Licença

GNU Affero General Public License v3.0 only (`LICENSE`), exceto `packages/sdk` (Apache-2.0).
Licença comercial, para quem não pode cumprir a AGPL, pela Casa de IA Educação e Consultoria
Ltda (`COMMERCIAL-LICENSE.md`).

Copyright (C) 2026 Cláudio Penedo. A licença exclusiva de exploração comercial à Casa de IA
Educação e Consultoria Ltda (CNPJ 69.761.208/0001-20) está em formalização; a licença AGPL-3.0
deste repositório já vale para todos.

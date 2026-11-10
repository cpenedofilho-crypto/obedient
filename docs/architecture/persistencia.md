# Persistência: Postgres com RLS (Fase 4b)

Pacote: `@obedient/store-postgres`. Ele implementa as portas do Ethics Engine (`GrantStore`,
`ConsentStore`, `ProposalStore`, `StopStore`, `AuditSink`) sobre Postgres, com a migration em
`packages/store-postgres/sql/`.

## O caminho de uma requisição

```
token do cliente ─► hash ─► obedient.session_resolve()  (papel obedient_auth)
                                   │ usuário + reautenticação recente
                                   ▼
          transação: SET LOCAL ROLE obedient_app
                     set_config('obedient.user_id', usuário, true)
                                   │
                                   ▼
              motorNaTransacao(tx) ─► stores ─► RLS ─► commit (ou rollback)
```

- **O usuário da transação vem só da sessão**, resolvida no banco, nunca do corpo da requisição.
- **Papel e usuário são `SET LOCAL`:** valem só dentro da transação. A conexão volta ao pool sem
  identidade nenhuma.
- **Tudo o que o motor faz numa requisição entra no mesmo commit**, inclusive o que os ouvintes da
  parada de emergência fazem (cancelar propostas, registrar na trilha), ou sai inteiro no rollback.
- **Pedido em nome de outro usuário** dentro de uma sessão falha inteiro (`UNAUTHENTICATED`), antes
  de qualquer gravação.

## Papéis

| Papel | Login? | O que pode |
|---|---|---|
| dono do schema | quem roda a migration | cria e altera o schema; **não é o papel do servidor** |
| `obedient_app` | não | as linhas do próprio usuário (RLS). Em grant, só revogar; em proposta, só o estado; na auditoria, só incluir e ler |
| `obedient_operator` | não | a parada **global** e a cadeia de auditoria `"*"`. Não lê nada de usuário |
| `obedient_auth` | não | emitir, resolver, elevar e encerrar sessão, só pelas funções |
| papel de login do servidor | sim | **membro** dos três acima; não é dono nem superusuário |

O servidor escolhe o papel em cada transação. Por isso o código do servidor é confiável por
definição, como o service role nos outros produtos. A RLS é a segunda barreira, e a primeira é a
API: não existe caminho no pacote que abra transação de usuário sem `comoUsuario()` ou
`Sessoes.comSessao()`.

## RLS

- **Ligada e forçada** em `grants`, `consents`, `proposals`, `emergency_stops` e `audit_log`. A
  policy é `user_id = obedient.current_user_id()`, que lê o valor da transação; sem usuário, nenhuma
  linha casa.
- **A parada global é lida por todos** (ela bloqueia todos) e gravada só pelo operador.
- **`audit_heads` e `sessions`** têm RLS ligada sem `FORCE`. Só as funções `SECURITY DEFINER` (o dono)
  escrevem nelas, e nenhum outro papel tem policy de escrita. `sessions` não tem policy nem privilégio
  para ninguém.

## Auditoria só de inclusão

- **Nenhum papel tem `UPDATE` ou `DELETE`** em `audit_log`.
- **Um gatilho recusa `UPDATE`, `DELETE` e `TRUNCATE`** até para o dono da tabela. Correção se faz
  com entrada nova.
- **A cadeia é conferida pelo banco:** o gatilho de inclusão exige `seq = cabeça + 1` e
  `prev_hash = hash da cabeça` e atualiza a cabeça, sob uma trava por usuário (advisory lock da
  transação). Duas gravações simultâneas do mesmo usuário entram uma depois da outra.
- **O hash em si é conferido pelo motor** (`verify(userId)`), porque o JSON canônico vive no código.
  O banco garante a ordem e a continuidade; o motor, o conteúdo.
- **A entrada tem de bater com as colunas** (`seq`, `hash`, `prevHash`, `userId`, e `event` e `at`
  presentes), com `is distinct from` (migration 0007): uma entrada `'{}'` com a cadeia certa não
  entra mais.
- **Limite conhecido:** o dono das tabelas (o papel que migra) pode desligar os gatilhos, reescrever
  a trilha e recalcular a cadeia, e `verify()` não acusa. Fechar isso exige ancorar a cabeça fora do
  banco (assinatura com chave fora do Postgres, ou checkpoints publicados), ainda não feito.

## Propostas: máquina de estados no banco

Migration 0007, por gatilho, para todo papel (o dono inclusive):

- **Toda proposta nasce `pending`,** sem decisão nem execução, e com grant.
- **Só as transições do motor valem:**
  - `pending` → `approved`, `rejected` ou `expired`;
  - `approved` → `executing`, `rejected` ou `expired`;
  - `executing` → `executed` ou `failed`.
- **Aprovar exige `decided_by` igual a `user_id`.**
- **Com o status igual** (o "apagar o que o OBEDIENT sabe" esvazia o conteúdo), decisão e execução não
  mudam.

Isto fecha atalhos que nem o motor permite. Uma proposta forjada já aprovada, ou sem grant, ou um
status que pula etapa, era aceita pelo papel do app. Quem tem SQL na transação da pessoa ainda pode
aprovar em nome dela: essa barreira é o servidor.

`missions.proposta_id` aponta para `(user_id, id)`: o id de uma proposta de outra pessoa é recusado
igual a um id inexistente, sem servir para descobrir se ele existe.

## Execução única

`ProposalStore.transition` é um único `UPDATE … WHERE id = $1 AND status = ANY($2) RETURNING *`.
Com duas transações ao mesmo tempo, a segunda espera a primeira e não encontra mais o estado antigo.
O teste com quatro execuções simultâneas roda no PGlite e, no CI, num Postgres 17 de verdade (job
`postgres`).

## Sessão

- **O token tem 32 bytes aleatórios** e é entregue uma vez só. O banco guarda
  `sha256("obedient.session:" + token)`.
- **Prazo padrão de 12 h.** Encerrar vale na hora.
- **A reautenticação vale por 5 minutos** (`STRONG_AUTH_WINDOW_MS`). É ela que libera a aprovação de
  ação CRITICAL (`user_strong_auth`).
- **Quem confirma a pessoa (senha, passkey, biometria) é o provedor de identidade, fora deste
  pacote.** O pacote começa depois disso: `Sessoes.emitir()` e `Sessoes.elevar()`.

## Testes

`packages/store-postgres/src/store.test.ts`:

- **Os mesmos cenários do motor em memória e da suíte constitucional:** grant, revogação em cascata,
  prazo, consentimento, proposta, execução única, reautenticação, vencimento, parada do usuário e
  global, trilha.
- **Isolamento:** um usuário pede pelo id as coisas do outro e não acha nada. `UPDATE` direto não
  muda nada, e `INSERT` com o dono errado é recusado.
- **O papel do app não altera escopo, finalidade nem limites** de um grant, não apaga nada e não lê
  sessão.
- **A trilha não muda nem para o dono das tabelas, e o banco recusa entrada que não continua a
  cadeia.**
- **Sessão:** vence, é encerrada, a reautenticação expira, e o usuário da transação vem da sessão.
- **Prova de mutação, feita ao criar a suíte:**
  - trocar a policy de grants por `true` reprova 2 testes de isolamento;
  - desligar a conferência da cadeia no gatilho reprova o teste da cadeia.

Sem `OBEDIENT_TEST_DATABASE_URL`, roda no PGlite (Postgres em WebAssembly, com papéis e RLS de
verdade). Com ela, roda no Postgres indicado, que precisa ser local.

## O que ainda não existe

- **Políticas do usuário (`policiesFor`) no banco.** Hoje elas chegam por função; a tabela entra
  junto com a tela de políticas.
- **Provedor de identidade e servidor HTTP.** Ficam para a Fase 5, junto com o app.
- **Rotação e expurgo de sessões vencidas.** É um job de manutenção, que só apaga sessão vencida há
  mais de N dias. A trilha nunca é expurgada.

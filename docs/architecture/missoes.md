# Missões (Fase 6, parte 2)

Arts. 5º (honestidade), 7º (persistência responsável) e 9º (direito de interrupção) da Constituição.
Pacote `@obedient/missions`; armazenamento em `@obedient/store-postgres` (migration 0004).

## O que é uma missão

É o que a pessoa pede no app ("Descobrir o horário do dentista"). O agente persegue o pedido em
**tentativas**. Cada tentativa termina de um destes jeitos:

| Resultado da tentativa | A missão fica |
|---|---|
| `feito` | Terminou, com a explicação do que fez |
| `nao_sei` | Terminou como "Não soube responder", com a explicação (Art. 5º) |
| `nao_consegui` | "Não conseguiu", com a explicação (Art. 5º) |
| `aguardando_aprovacao` | Esperando a pessoa aprovar um pedido; aprovado, segue; recusado ou vencido, vira impedimento |
| `falha_temporaria` | `retrying`: tenta de novo depois de um intervalo, ou vira impedimento |
| `impedida` | `blocked`: o executor não pode seguir sem a pessoa (por exemplo, uma ação ficou sem resultado confirmado) |

## Estados e transições (decisão D20, marco M2, 19/11/2026)

Uma única tabela de transições (`TRANSICOES` em `packages/missions`) decide para onde cada estado pode
ir. Todo `estado` muda por ela, e o banco confere a mesma tabela num gatilho
(`obedient.mission_transitions`, migration `0009_estados.sql`): fora dela, nada muda, mesmo que o código
erre. Um teste exige que a tabela do banco seja igual à do código.

| Estado | Significado | Pode ir para |
|---|---|---|
| `created` | criada, esperando a primeira tentativa | planning, running*, failed, cancelled |
| `planning` | o plano está sendo feito (entra em uso no M5) | running, waiting_approval, blocked, failed, cancelled |
| `running` | uma tentativa está reservada e rodando | verifying, waiting_approval, retrying, blocked, completed*, failed, cancelled |
| `verifying` | os critérios estão sendo conferidos (entra em uso no M3) | completed, running, blocked, failed, cancelled |
| `retrying` | falhou de passagem e espera a hora da próxima tentativa | running, blocked, failed, cancelled |
| `waiting_approval` | espera a pessoa decidir um pedido | running, blocked, failed, cancelled |
| `blocked` | parou e precisa da pessoa | retrying, planning, running, failed, cancelled |
| `completed`, `failed`, `cancelled` | fim | nada |

\* Provisórias: `created → running` sai com o planejador (M5), e `running → completed` sai com o
verificador (M3).

- Missão nasce `created` (o banco recusa outro estado na inserção).
- "Tentar de novo" leva `blocked → retrying`, com a próxima tentativa na hora.
- Até o M2, "esperando tentativa" era um `running` sem reserva. A migration leva as que existiam para
  `created` (sem tentativa) ou `retrying` (já tentou); `running` com reserva continua `running`.
- Para a pessoa, `created` aparece como "Trabalhando nisso" (a primeira tentativa sai em segundos) e
  `retrying` como "Vai tentar de novo em breve".

## Regras do Art. 7º

- **Teto de tentativas:** de 1 a 5, padrão 3. O banco também confere (`CHECK`).
- **Intervalo crescente:** 30 s, 1 min, 2 min, 4 min… até 1 h.
- **Teto de custo por missão:** padrão R$ 15 (decisão D21), máximo R$ 100, conferido antes **e** depois de cada
  tentativa.
- **Impedimento explicado, nunca laço.** Ao bater num teto, ou quando o pedido de aprovação é
  recusado ou vence, a missão para com um texto que diz por quê e o que a pessoa pode fazer: "Tentou
  3 vez(es) e não conseguiu. Último erro: …" ou "Chegou ao teto de custo (R$ 1,00)…". Parada, ela
  não tenta mais sozinha. A pessoa escolhe "Tentar de novo" (zera as tentativas; com o teto
  estourado, só aumentando o teto) ou "Cancelar".

## Reservar, executar, concluir

Uma tentativa pode levar minutos (modelo, ferramentas). Por isso ela é dividida em três passos:

1. **Reservar** (transação curta). Confere a parada, a aprovação pendente, a hora e o teto. Conta a
   tentativa e grava: se o processo cair durante a execução, a tentativa já contou.
2. **Executar**, fora de qualquer transação.
3. **Concluir** (transação curta). Aplica o resultado.

A troca é **atômica pela versão** da missão. Com reservas simultâneas, só uma conta: o teste roda 4 ao mesmo tempo
num Postgres real. Se a pessoa cancelar ou apertar parar durante a execução, a conclusão encontra
outra versão, descarta o resultado e registra `mission.result_discarded`.

## Art. 9º

Parar cancela as missões abertas **no mesmo commit** da parada. O servidor monta as missões em toda
requisição (`contexto.ts`) justamente para o ouvinte da parada estar sempre registrado. Com a parada
acionada, nenhuma tentativa começa.

## Art. 5º: identificação das mensagens

A pessoa configura no app como as mensagens enviadas em nome dela se identificam ("Enviada pelo
assistente da Ana"). Com o servidor (`exigirIdentificacao`), ferramenta de categoria
`COMMUNICATION` só passa no Ethics Engine se `args.identificacao` for **exatamente** esse texto.
Sem identificação configurada, nenhuma mensagem sai. Trocar a assinatura invalida a antiga.

## O que a trilha guarda

A trilha guarda o tipo de desfecho, a tentativa, o custo e o texto do impedimento (que é do
sistema). **Não guarda** o objetivo nem a explicação, que podem ter conteúdo da pessoa: ficam na
missão, que a pessoa apaga com "Apagar o que o OBEDIENT sabe sobre mim" (a 0004 estende a função:
objetivo e explicação esvaziados, abertas canceladas).

## Quem executa a tentativa

Uma porta (`Executor`). No servidor é o laço do agente com o modelo e as ferramentas governadas, e
um agendador percorre quem tem missão devida: ver [`executor.md`](./executor.md). Duas regras desta
camada vieram com ele:

- **Continuar depois de uma aprovação é a mesma tentativa:** não conta outra.
- **A missão guarda onde a tentativa parou (`rodada`),** para o executor continuar dali. A conversa
  some ao terminar, impedir, cancelar e apagar.

## Testes

- **`packages/missions/src/index.test.ts`** (12):
  - intervalo;
  - teto de tentativas e impedimento;
  - exceção conta como falha;
  - teto de custo antes e depois;
  - tentar de novo;
  - limites;
  - "não sei" e "não consegui" sem conteúdo na trilha;
  - aprovação aceita e recusada;
  - parada;
  - cancelar;
  - resultado descartado depois de cancelar;
  - reserva única.
- **`packages/store-postgres/src/missoes.test.ts`** (8), no PGlite e no Postgres real:
  - reservar e concluir em transações separadas;
  - 4 reservas simultâneas, uma conta;
  - **corrida forçada:** duas transações leem a mesma versão e as duas tentam gravar; só a primeira
    grava. Só roda no Postgres, porque o PGlite tem uma conexão só;
  - o banco recusa limite fora do Art. 7º e não deixa mudar o objetivo;
  - RLS;
  - parar no mesmo commit;
  - apagar;
  - identificação.
- **`packages/server/src/api.test.ts`** (6 novos):
  - pedir pelo app e "não sei" no painel;
  - impedimento, tentar de novo e cancelar;
  - parar cancela;
  - cancelada durante a tentativa;
  - identificação;
  - isolamento.
- **`e2e/app.e2e.ts`** (3 novos): pedir em um toque; impedimento por teto de custo com axe sem
  violação; assinatura trocada barra a antiga.
- **`tests/constitution/constitution.test.ts`:** Arts. 5º, 7º e 10.
- **Prova de mutação:** tirar `and versao = $2` do `UPDATE` das missões reprova a corrida forçada.
  O teste das 4 reservas simultâneas **não** pegava essa mutação: as transações são rápidas, a
  segunda já lê a missão reservada e desiste pela regra de estado, sem chegar à troca atômica. Por
  isso a corrida forçada existe.

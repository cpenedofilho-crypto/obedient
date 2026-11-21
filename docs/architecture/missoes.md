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
| `created` | criada, esperando a primeira tentativa | planning, running*, blocked, failed, cancelled |
| `planning` | o planejador está fazendo o plano (M5, só com "planejar antes") | running, waiting_approval, retrying, blocked, failed, cancelled |
| `running` | uma tentativa está reservada e rodando | verifying, waiting_approval, retrying, blocked, failed, cancelled |
| `verifying` | as evidências estão sendo gravadas e conferidas (M3) | completed, running, blocked, failed, cancelled |
| `retrying` | falhou de passagem e espera a hora da próxima tentativa | planning, running, blocked, failed, cancelled |
| `waiting_approval` | espera a pessoa decidir um pedido, ou aprovar o plano (M5) | running, blocked, failed, cancelled |
| `blocked` | parou e precisa da pessoa | retrying, planning, running, failed, cancelled |
| `completed`, `failed`, `cancelled` | fim | nada |

\* `created → running` era provisória até o planejador. No M5 ela ficou: planejar é uma opção da pessoa
("planejar antes"), e a missão sem plano continua indo direto para a execução. A outra aresta
provisória, `running → completed`, saiu no M3: terminar passa sempre por `verifying`.
`created → blocked` entrou no M4 (teto do mês); `planning → retrying` e `retrying → planning`, no M5.

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

## Critérios de conclusão e verificação (decisão D20, marco M3, 19/11/2026)

Uma missão só termina "feito" quando cada critério tem evidência conferida por **código**, nunca porque
o agente disse que terminou.

- **Critérios**, numa lista fechada, fixados na criação (até 10; o app não altera depois):
  - `ferramenta_ok`: uma ferramenta (nome exato ou prefixo com `*`) rodou com sucesso nesta missão,
    pelo menos `minimo` vezes. Conferido no registro de passos (M1): conta só o fim com sucesso, nunca
    o início nem o erro;
  - `resultado_conforme`: o `resultado` que o agente entrega em `concluir_missao` segue um esquema (o
    subconjunto de JSON Schema do `mission-engine`). A evidência guarda o hash do resultado, nunca o
    resultado.
- **Quando confere:** no momento em que o agente chama `concluir_missao` com "feito". Se não confere, o
  agente recebe o que faltou (frases do verificador) e pode corrigir, até 2 voltas por tentativa. Na
  terceira, o "feito" vai com as evidências que não conferem e a missão vai de `verifying` para
  `blocked`, com o motivo escrito para a pessoa.
- **Sem critério:** a missão termina, e a evidência diz isso ("Nenhum critério definido: conferido só o
  registro de passos"). Nada é apresentado como verificado sem ter sido.
- **"Não sei"** também passa por `verifying` e deixa evidência; **"não consegui"** vai direto a `failed`.
- **Evidências** em `obedient.mission_evidence` (migration `0010_verificacao.sql`): só inserção, RLS por
  pessoa; "apagar o que o OBEDIENT sabe" apaga as evidências e esvazia os critérios.
- **No app:** a ação `criar_missao` aceita `criterios`; o painel mostra "Conferido: N de M critério(s)" ou
  "Sem critério de conclusão: conferido só o registro de passos". Na tela de criação, o critério entra
  pela opção "Só dar por feito se ele usar esse sistema" (M4), que vira `ferramenta_ok` com `<sistema>/*`.
- **Ainda não:** o verificador é só determinístico. Uma revisão por outro modelo, só com ferramentas de
  leitura, dobraria o custo de cada missão e depende de decisão.

## Mandato, prazo final e teto do mês (decisão D20, marco M4; D21; D22; 19/11/2026)

O mandato é o que a pessoa diz que a missão pode fazer. Ele **só estreita** o que os grants já
permitem, nunca amplia, e o objetivo escrito nunca vira autorização.

- **Ferramentas:** lista de nomes exatos ou prefixos com `*` (até 30; sem curinga sozinho, mínimo de 3
  caracteres antes do `*`, como nos grants). A missão só **enxerga** as ferramentas listadas: as outras
  nem são oferecidas ao agente. Sem lista, valem as que a pessoa conectou, como antes. Isto é mais
  estrito que o plano (que previa levar a ferramenta de fora do mandato a `waiting_approval`): fora do
  mandato é recusa, e ampliar é a pessoa criar outra missão.
- **Prazo final:** até 30 dias à frente. Passado o prazo, a missão não tenta mais e termina `failed`
  com "não conseguiu" ("Passou do prazo final que você deu"); "tentar de novo" é recusado. Cada
  tentativa também tem o prazo dela limitado pelo prazo final.
- **Autonomia:** o mandato não tem campo de autonomia (D22). Só leitura é autônoma; toda escrita,
  inclusive MEDIUM, continua pedindo aprovação (D18).
- **Fixo depois de criado:** o app não altera o mandato (`missions.mandato_ferramentas` e
  `missions.prazo_final_em`, migration `0011_mandato.sql`).
- **Teto do mês (D21):** R$ 300 por pessoa por mês (mês do Brasil, UTC−3), somando o gasto de todas as
  tentativas, gravado em `obedient.mission_spend` no fim de cada tentativa (também quando o resultado é
  descartado: o gasto aconteceu). Com o teto atingido, nenhuma tentativa começa (`created → blocked`,
  transição nova) e a missão em andamento para em `blocked` com "Chegou ao teto do mês". Dentro da
  tentativa, o executor usa o menor entre o que resta da missão e o que resta do mês. O painel mostra
  o gasto do mês e avisa ao passar de 80%. "Apagar o que o OBEDIENT sabe" não apaga o gasto: é
  contabilidade sem conteúdo da pessoa, e apagá-lo zeraria o teto.
- **No app:** `criar_missao` aceita `mandato: { ferramentas?, prazoFinalEm? }`; a forma é conferida na
  entrada e o prazo (que depende do relógio) na criação. A tela tem "Pode usar" (tudo o que está
  conectado, ou um sistema só) e "Até quando" (sem prazo, amanhã, 7 ou 29 dias).
- **Ambientes (M5):** o mandato pode limitar a missão a `producao`, `homologacao` e/ou `teste`. O
  ambiente de cada servidor MCP vem da configuração dele (`ambiente`); o que não declara, e o Google
  e o Growth OS, contam como produção. Fixo depois da criação (`missions.mandato_ambientes`, migration
  `0015_ambientes.sql`). A ação `criar_missao` aceita `mandato.ambientes`; a tela ainda não tem campo
  para isso, só mostra o limite no cartão da missão.

## Reservas com dono e cerca (decisão D20, marco M5, 19/11/2026)

A reserva de uma tentativa já era uma troca atômica pela versão, e a conclusão de um processo que
perdeu a reserva já era descartada. Faltava o meio: um processo lento, com a reserva vencida e tomada
por outro, ainda podia gravar passos e chamar ferramentas.

- **Cerca:** `missions.cerca` sobe a cada reserva (inclusive a continuação depois de uma aprovação) e
  nunca desce (gatilho no banco). `missions.reservada_por` diz qual processo tem a reserva: nome da
  máquina, pid e um sufixo aleatório, sem dado da pessoa. Terminar, impedir ou cancelar tira o dono.
- **Passo com cerca velha é recusado pelo banco** (migration `0012_cerca.sql`). Como o início de uma
  chamada é gravado antes da chamada (M1), o processo que perdeu a reserva não chama mais nada; a
  tentativa dele termina em falha passageira e a conclusão é descartada pela versão.
- **O executor também confere a cerca ao começar** e, se ela mudou, não chama o modelo. É uma camada a
  mais: sem ela, o banco recusa o primeiro passo do mesmo jeito (por isso a mutação que a remove não
  reprova nenhum teste; o que os testes conferem é que o processo A não chama nada).
- **Vários processos:** com a cerca, dois processos podem rodar o agendador ao mesmo tempo sem que um
  escreva por cima do outro. A consulta de quem tem missão devida continua uma por volta.

## Plano em DAG e aprovação do plano (decisão D20, marco M5, 19/11/2026)

Opcional: só a missão criada com **"Planejar antes e me mostrar o plano"** passa por ele. Sem isso, nada
muda.

- **`planning`:** a primeira tentativa é do planejador, um modelo que só tem a ferramenta `propor_plano`.
  Ele não age; propõe de 1 a 30 tarefas, cada uma com chave, título e dependências. O plano é conferido
  por `validarPlano` (mission-engine): sem ciclo, sem dependência desconhecida ou de si mesma, até 10
  dependências por tarefa. Plano que não confere volta ao planejador com o motivo, até 2 correções.
  Sem plano, falha passageira (`retrying` e de novo `planning`).
- **Aprovação:** com o plano, a missão vai para `waiting_approval` e a pessoa vê as tarefas no cartão
  da missão. Ela aprova **pelo hash** do plano (aprova exatamente o que viu; hash diferente é recusado)
  ou recusa. **Aprovar o plano não autoriza ação nenhuma:** cada escrita continua pedindo a aprovação
  dela na hora (D18, D22). Sem decisão, o agendador não pega a missão.
- **Recusar** para a missão (`blocked`). "Tentar de novo" planeja outra vez, com outra versão do plano;
  as tarefas da versão recusada não são reaproveitadas.
- **Execução:** aprovado, a tentativa seguinte executa. O plano entra na conversa como **dado** (é texto
  de um modelo), com o estado de cada tarefa, e o agente ganha `concluir_tarefa`. Marcar uma tarefa
  feita exige as dependências feitas; o banco confere de novo e não deixa uma tarefa feita voltar a
  pendente.
- **"Feito" só com todas as tarefas feitas.** O executor devolve ao agente o que falta (conta como volta
  de verificação), e a missão confere de novo ao concluir, pelo que está gravado: a evidência
  `plano_completo` do agente é descartada e refeita.
- **Tentativas:** o planejamento conta como uma tentativa (com o padrão de 3: planejar, executar e mais
  uma). "Tentar de novo" zera a contagem, e o plano aprovado continua valendo.
- **Banco:** migration `0014_plano.sql` (`mission_tasks` e `mission_task_deps`, só inserção, RLS por
  pessoa; o app só muda o estado da tarefa). "Apagar o que o OBEDIENT sabe" apaga as tarefas e tira o
  plano. "Baixar meus dados" leva o plano junto com a missão.
- **Ainda não:** tarefas da mesma camada rodando em paralelo, e um modelo diferente para o planejador
  (hoje é o mesmo do executor; trocar é decisão A5).

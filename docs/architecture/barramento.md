# Barramento de eventos (decisão D20, marco M7, 20/11/2026)

O barramento do OBEDIENT existia só em memória (`packages/event-bus/src/memoria.ts`) e não era usado.
Agora tem implementação em Postgres (`packages/store-postgres/src/barramento.ts`, migration
`0017_barramento.sql`), com a mesma semântica do barramento em memória, que continua sendo o contrato,
e do despachante do Growth OS (`casa-de-ia/src/event-bus/despachar.ts`). O tenant é a **pessoa**.

## Publicar

- **Validação pelo vocabulário** (`VOCABULARIO_OBEDIENT`): tipo, fonte e entidade conhecidos, id de
  entidade interna em UUID e dado pessoal recusado no payload. Tudo-ou-nada: um evento inválido no lote
  não deixa gravar nenhum.
- **Idempotência** por pessoa, fonte e chave, com o hash do conteúdo: mesma chave e mesmo conteúdo é
  duplicado (devolve o mesmo evento); conteúdo diferente é conflito.
- **Na transação de quem publica (outbox):** o evento só existe se o fato gravou. Se a transação cai, os
  dois somem.
- **Só inserção:** o app não altera nem apaga evento.

## Entregar

- Cada evento gera uma entrega por assinatura **ativa** da mesma pessoa cujo padrão casa (`mission.*`,
  `mission.created`, `*`).
- **Reivindicação** com `FOR UPDATE SKIP LOCKED`: dois despachantes nunca pegam a mesma entrega. A
  tentativa é contada na reivindicação, então um processo que morre no meio também gasta tentativa.
- **Trava com prazo e dono:** a entrega fica `processing` por 5 min (`locked_until`, `locked_by`).
  Vencida, outro despachante pode pegá-la. **Cerca:** o desfecho só é gravado se a trava ainda for de
  quem o produziu; quem perdeu a trava não grava por cima.
- **O consumidor roda fora da transação.** Falha volta a `failed` com espera base × 2^(n-1), até 6 h.
  Esgotadas as tentativas, ou com `ErroPermanente`, vai para `dead_letter`; reprocessar é decisão de uma
  pessoa e zera as tentativas. Consumidor não registrado neste deploy conta como falha.
- **Evento derivado** herda a correlação e aponta a causa (`causation_id`).
- **O agendador** descobre só QUEM tem entrega devida (`pessoas_com_entrega_devida`, sem ler evento) e
  despacha pessoa por pessoa, na RLS dela.

## O que as missões publicam

`mission.created`, `mission.blocked`, `mission.completed` (feito e não sei), `mission.failed`,
`mission.cancelled`, `mission.waiting_approval`, `mission.plan_proposed` e `mission.waiting_external`.
O payload leva só o estado, o desfecho e a tentativa; o objetivo, a explicação e o impedimento ficam na
missão, que tem RLS. A chave de idempotência é missão, versão e evento.

## Direitos

"Apagar o que o OBEDIENT sabe" apaga os eventos, as entregas e as assinaturas da pessoa.

## Ainda não

- **Nenhum consumidor registrado no servidor.** O agendador despacha quando recebe um registro de
  consumidores (`eventos`), mas o servidor ainda não registra nenhum. O primeiro candidato é o painel
  atualizar sem sondagem; fica para quando a tela pedir.
- `proposal.*`, `grant.*` e `emergency_stop.*` estão no vocabulário e ainda não são publicados.

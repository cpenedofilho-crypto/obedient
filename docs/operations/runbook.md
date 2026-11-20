# Runbook de operação do OBEDIENT (M7, 20/11/2026)

Para quem opera o servidor. Cada passo de produção é feito por uma pessoa. O agente não faz nenhum:
deploy de produção, migration em produção e segredo estão na lista do que não se delega (CONSTITUTION).

**Estado:** a produção roda no Railway, em `obedient-production.up.railway.app` (D25). Ainda faltam
da A4: homologação, guarda das chaves (Anthropic, cofre), backup testado e destino dos alertas.
Enquanto faltarem, a produção não recebe dado de cliente.

## O que roda

| Peça | Onde | Comando |
|---|---|---|
| API e app (passkeys, missões, aprovações) | serviço do Railway | `node --import tsx packages/server/src/cli.ts servir` |
| Executor das missões e agendador | o mesmo processo, com `OBEDIENT_AGENTE=ligado` | idem |
| Barramento de eventos | o mesmo processo (agendador), tabelas `obedient.events*` | idem |
| Banco | Postgres gerenciado, sem porta pública | só migrations versionadas (`packages/store-postgres/sql/`) |

## Publicar uma versão

A ordem importa: **migrar antes de subir o código novo.** O código novo confere as migrations no `/ready`
e não fica pronto sem elas. O código velho continua funcionando com o schema novo, porque as migrations
só acrescentam.

1. Conferir o PR: CI verde e revisão de uma pessoa. CI verde sozinho não autoriza publicar.
2. Fazer o merge na `main`. O merge é da pessoa.
3. Aplicar as migrations com a conexão do dono do schema:
   `OBEDIENT_OWNER_DATABASE_URL=… node --import tsx packages/server/src/cli.ts migrar`.
   A saída lista o que foi aplicado. Se nada mudou, a saída é "nada a aplicar".
4. Publicar o serviço no Railway.
5. Conferir de fora:
   - `GET /health` → `{"vivo":true,"versao":"<12 primeiros do commit>"}`. A versão tem de ser a do merge.
     Diferente: o deploy não chegou.
   - `GET /ready` → `{"pronto":true}`. Com `503 migrations`, a resposta diz o nome das pendentes ou
     divergentes: volte ao passo 3. Com `503 banco`, o banco não responde.
   - `GET /metrics` com o token das métricas: `obedient_alerta{tipo="parada_geral"} 0`.

## Voltar uma versão

- **Código:** republicar no Railway o deploy anterior. Um rollback de código não desfaz migration.
- **Migration:** não há "desaplicar". Migration nova só acrescenta (coluna, tabela, função), então o
  código anterior continua funcionando com ela. Uma correção de schema é sempre uma migration nova.
- **Missão no meio de uma tentativa:** a reserva vence em 15 minutos e outro processo a retoma. Passo de
  escrita sem desfecho vira `incerto` e a missão para, pedindo à pessoa que confira (M4). Nada se repete
  sozinho.

## Parar tudo

- **O agente de uma pessoa:** ela mesma toca "parar" no app. Isso barra o agente dela e cancela os
  pedidos que esperavam aprovação.
- **O agente de todos:** tirar `OBEDIENT_AGENTE=ligado` e republicar. A API e as aprovações continuam
  no ar; nenhuma missão roda.
- **Tudo:** parar o serviço no Railway.
- **Parada geral do Ethics Engine:** quando ligada, o medidor `obedient_alerta{tipo="parada_geral"}`
  acende, e só o operador libera (a pessoa não). **Ainda não há comando no servidor para ligá-la.**
  Até existir, use os três meios acima.
- **Uma integração:** tirar as variáveis dela (todas) e republicar. Ela some do catálogo; os grants
  continuam no banco e voltam a valer quando a integração voltar. Para tirar a autoridade de uma
  pessoa, use `cli.ts <integração> retirar <usuario>`.

## Variáveis de ambiente

Os segredos ficam nas variáveis do serviço no Railway, postas pelo responsável. Nunca vão para o
repositório, a conversa com um agente ou um log.

| Variável | Segredo? | Para quê |
|---|---|---|
| `OBEDIENT_DATABASE_URL` | sim | conexão do servidor (papel de login sem posse do schema) |
| `OBEDIENT_OWNER_DATABASE_URL` | sim | só `migrar` e `convite`; não fica no serviço |
| `OBEDIENT_ORIGIN`, `OBEDIENT_RP_ID`, `OBEDIENT_PORT` | não | origem do app e das passkeys |
| `OBEDIENT_CHAVES_COFRE` | sim | cofre das credenciais das pessoas (`cli.ts chave`) |
| `OBEDIENT_METRICAS_TOKEN` | sim | sem ele, `/metrics` responde 404 |
| `OBEDIENT_AGENTE`, `OBEDIENT_MODELO`, `OBEDIENT_MODELO_PLANEJADOR`, `OBEDIENT_ESFORCO` | não | executor e modelos (D28) |
| `ANTHROPIC_API_KEY` | sim | o SDK lê do ambiente |
| `OBEDIENT_GOOGLE_CLIENT_ID` / `_SECRET` | o segredo, sim | integrações com o Google |
| `OBEDIENT_GROWTH_OS_*` | `_SEGREDO`, sim | Growth OS por A2A |
| `OBEDIENT_MCP_SERVIDORES`, `OBEDIENT_MCP_<…>_TOKEN` | os tokens, sim | servidores MCP do dono |
| `OBEDIENT_VERCEL_TOKEN`, `OBEDIENT_VERCEL_TIME`, `OBEDIENT_DEPLOYS_*` | o token, sim | deploys só leitura (A8, D27) |
| `OBEDIENT_VERSAO` | não | opcional; sem ela, vale `RAILWAY_GIT_COMMIT_SHA` |

Nas integrações, é tudo ou nada: se só parte das variáveis estiver definida, o servidor não sobe e diz
qual falta. Assim um erro de configuração aparece na subida, não no meio de uma missão.

### O token da Vercel (A8)

1. No painel da Vercel, criar um token com o escopo mais restrito que ela permitir (só o time dos
   projetos, com prazo).
2. Pôr em `OBEDIENT_VERCEL_TOKEN`, nas variáveis do serviço no Railway. Nunca no chat nem num arquivo.
3. Listar os projetos em `OBEDIENT_DEPLOYS_PROJETOS` e as pessoas em `OBEDIENT_DEPLOYS_USUARIOS`.
4. Republicar e conceder a autoridade: `cli.ts deploys conceder <usuario>` (vale 30 dias).

O OBEDIENT só lê. Mesmo que a Vercel não ofereça token de leitura, o código não tem chamada de escrita
(`packages/server/src/deploys.ts`).

## Alertas

Os alertas são medidores 0/1 em `/metrics`. Quem avisa alguém é a infraestrutura que lê as métricas;
o destino ainda está pendente na A4. Até ele existir, quem opera confere `/metrics` à mão depois de
cada publicação.

| Medidor | Aceso quando | O que fazer |
|---|---|---|
| `parada_geral` | a parada geral está ligada | confirmar que foi de propósito |
| `reserva_vencida` | uma missão tem a reserva vencida | um processo caiu no meio; ver os logs do Railway |
| `bloqueadas_acumuladas` | 10 ou mais missões esperando a pessoa | avisar as pessoas, ou procurar uma ferramenta quebrada |
| `teto_do_mes` | alguém atingiu o teto mensal (D21) | decisão da pessoa; nada a fazer no servidor |

## Backup (pendente, A4)

Ainda não existe backup testado. Antes de qualquer dado de cliente:

- backup cifrado do Postgres, guardado longe das chaves do cofre;
- restauração testada num banco isolado, com o `/ready` verde e uma missão de teste aberta do começo
  ao fim;
- as chaves do cofre (`OBEDIENT_CHAVES_COFRE`) guardadas à parte. Sem elas, as credenciais das pessoas
  no backup não se abrem, e isso é de propósito.

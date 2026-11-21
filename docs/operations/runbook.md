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

**O merge na `main` já é o deploy.** O Railway publica sozinho cada commit da `main` (os deploys
aparecem no GitHub como `zealous-integrity / production`). Não existe um passo "publicar" separado.

A ordem é: **migrar, e logo em seguida juntar.** O código novo confere as migrations no `/ready` e não
funciona sem elas. O código velho também **não** funciona com todas as migrations novas: desde a 0009
(M2), o banco exige que toda missão nasça `created`, e o código anterior ao #51 cria missões já como
`running`. Conferido em 21/11/2026 rodando a suíte da `7921d1f` contra o banco migrado até a 0017: 50
testes falham. Todos, menos um, por esse motivo; o outro é só do ambiente de teste (dono sem
superusuário). Por isso há uma janela curta entre o `migrar` e o fim do deploy em
que ninguém cria missão nova; o resto continua no ar. Faça os dois passos em seguida.

1. Conferir o PR: CI verde e revisão de uma pessoa. CI verde sozinho não autoriza publicar.
2. Aplicar as migrations com a conexão do dono do schema, **a partir do código que vai entrar** (a
   branch do PR):
   `OBEDIENT_OWNER_DATABASE_URL=… node --import tsx packages/server/src/cli.ts migrar`.
   A saída lista o que foi aplicado. Se nada mudou, a saída é "nada a aplicar".
3. Fazer o merge na `main`, logo depois. O merge é da pessoa, e ele dispara o deploy.
4. Esperar o deploy terminar no Railway.
5. Conferir de fora:
   - `GET /health` → `{"vivo":true,"versao":"<12 primeiros do commit>"}`. A versão tem de ser a do merge.
     Diferente: o deploy não chegou.
   - `GET /ready` → `{"pronto":true}`. Com `503 migrations`, a resposta diz o nome das pendentes ou
     divergentes: volte ao passo 2. Com `503 banco`, o banco não responde.
   - `GET /metrics` com o token das métricas: `obedient_alerta{tipo="parada_geral"} 0`.

## Voltar uma versão

- **Código:** republicar no Railway um deploy anterior. Um rollback de código não desfaz migration.
  **Nunca volte para antes do #51** (o Mission Executor M0 a M5): esse código não cria missão com a
  0009 aplicada. Entre versões do #51 em diante, as migrations só acrescentaram.
- **Migration:** não há "desaplicar". Uma correção de schema é sempre uma migration nova. Antes de
  juntar uma migration que mude regra de estado ou CHECK, rode a suíte da versão no ar contra o banco
  migrado (como no teste de 21/11), para saber se o código velho continua funcionando com ela.
- **Missão no meio de uma tentativa:** a reserva vence em 15 minutos e outro processo a retoma. Passo de
  escrita sem desfecho vira `incerto` e a missão para, pedindo à pessoa que confira (M4). Nada se repete
  sozinho.

## Parar tudo

- **O agente de uma pessoa:** ela mesma toca "parar" no app. Isso barra o agente dela e cancela os
  pedidos que esperavam aprovação.
- **O agente de todos:** tirar `OBEDIENT_AGENTE=ligado` e republicar. A API e as aprovações continuam
  no ar; nenhuma missão roda.
- **Tudo:** parar o serviço no Railway.
- **Parada geral do Ethics Engine:** nenhum agente chama ferramenta, para ninguém, em todos os
  processos ao mesmo tempo (fica no banco). A API e o app continuam no ar.
  - Ligar: `cli.ts parada ligar <motivo>` (o motivo é obrigatório e fica gravado com o operador).
  - Ver: `cli.ts parada ver`. O medidor `obedient_alerta{tipo="parada_geral"}` acende.
  - Liberar: `cli.ts parada liberar`. Só o operador libera; a pessoa e o agente, não.
  - Usa `OBEDIENT_DATABASE_URL` (a conexão do servidor), não a do dono do schema.
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

1. No painel da Vercel (Account Settings → Tokens), criar um token com o escopo mais restrito que ela
   permitir: só o time `cpenedofilho-crypto's projects` e com prazo de validade.
2. Nas variáveis do serviço no Railway, pôr as quatro juntas. Com só parte delas, o servidor não sobe:

   ```
   OBEDIENT_VERCEL_TOKEN=<o token; nunca no chat nem num arquivo>
   OBEDIENT_VERCEL_TIME=team_9zADhEpEXuR5nYuXflQQijYW
   OBEDIENT_DEPLOYS_USUARIOS=<o seu id no OBEDIENT, o mesmo do convite>
   OBEDIENT_DEPLOYS_PROJETOS=[{"id":"motor_iga","nome":"Motor de Triagem IGA","projeto":"prj_tKUIOOvvxMCJSpknbUNNC6HWe7El","saude":"https://motor-triagem-iga.vercel.app/api/health"}, {"id":"recupera_os","nome":"Recupera OS","projeto":"prj_yG3xhm1gMNZMrjgZ9bgBehSOiMI8"}, {"id":"casa_de_ia","nome":"Growth OS (casa-de-ia)","projeto":"prj_yc5V3hq0vMQXWg66i7hXIZhbpGZ2"}, {"id":"casa_de_ia_site","nome":"Site da Casa de IA","projeto":"prj_V2T8NvZgvDnSDmq2kNOhGcZfGTeT"}, {"id":"ronda","nome":"Ronda","projeto":"prj_8LCNpK8w8wvtqCZfsjdhnRE9ZVOX"}, {"id":"repique","nome":"Repique","projeto":"prj_SGGCh13tROcHYJilAc5XdxSSwEV0"}, {"id":"lean_vision","nome":"Lean Vision","projeto":"prj_2PvPy6fjhzPiAsc84ek4Elz5A612"}]
   ```

   Os sete projetos são os do time em 21/11/2026 (D29). Só o Motor tem rota de saúde
   (`/api/health`, 200 em 21/11); os outros entram sem `saude` até terem uma.
3. Republicar e conceder a autoridade: `cli.ts deploys conceder <o seu id>` (vale 30 dias; renove com o
   mesmo comando).

O OBEDIENT só lê. Mesmo que a Vercel não ofereça token de leitura, o código não tem chamada de escrita
(`packages/server/src/deploys.ts`).

## Alertas

Os alertas são medidores 0/1 em `/metrics`. Quem avisa é o **vigia** (`.github/workflows/vigia.yml`,
D29): a cada 15 minutos ele confere `/health`, `/ready` e os medidores, e abre um issue com o rótulo
`vigia` atribuído ao dono do repositório. O GitHub avisa por e-mail e no celular. O mesmo problema não
gera aviso novo a cada volta: ele só comenta quando o relatório muda. Quando tudo volta ao normal, o
vigia comenta e fecha o issue.

Para ligar, **depois de publicar a versão com `/health`** (antes disso, a produção responde a página
do app e o vigia acusaria):

1. Em Settings → Secrets and variables → Actions do repositório:
   - segredo `OBEDIENT_METRICAS_TOKEN`: o mesmo valor da variável do Railway;
   - variável `OBEDIENT_VIGIA` = `ligado`;
   - variável `OBEDIENT_URL`, só se o endereço não for `https://obedient-production.up.railway.app`.
2. Rodar uma vez à mão (Actions → vigia → Run workflow) e conferir o relatório.

| Medidor | Aceso quando | O que fazer |
|---|---|---|
| `parada_geral` | a parada geral está ligada | confirmar que foi de propósito |
| `reserva_vencida` | uma missão tem a reserva vencida | um processo caiu no meio; ver os logs do Railway |
| `bloqueadas_acumuladas` | 10 ou mais missões esperando a pessoa | avisar as pessoas, ou procurar uma ferramenta quebrada |
| `teto_do_mes` | alguém atingiu o teto mensal (D21) | decisão da pessoa; nada a fazer no servidor |

## Backup (A4)

Scripts em `scripts/backup/`, testados em 21/11/2026 num Postgres 16 local, com duas missões e os
eventos delas. Nenhum dado de produção foi usado.

**Fazer o backup:**

```
OBEDIENT_BACKUP_URL=<administrador do Postgres, ou papel com BYPASSRLS> \
OBEDIENT_BACKUP_SENHA=<senha do arquivo, 20+ caracteres> \
scripts/backup/backup.sh <pasta>
```

- Gera o dump cifrado (AES-256, PBKDF2), a contagem de linhas por tabela (só números) e o hash dos
  dois.
- As tabelas têm RLS forçada. Por isso, com o dono do schema o `pg_dump` recusa: é preciso o
  administrador.

**Testar a restauração** num Postgres **isolado**, nunca o da produção:

```
OBEDIENT_RESTAURO_URL=<administrador do Postgres isolado, banco postgres> \
OBEDIENT_BACKUP_SENHA=… OBEDIENT_RESTAURO_ISOLADO=sim \
scripts/backup/restaurar-teste.sh <pasta>/obedient-<data>.dump.enc [--manter]
```

- Confere o hash, abre o arquivo e cria os papéis pelas migrations.
- Restaura num banco novo sem `--no-owner`: as funções restritas voltam com o dono delas, nunca como
  do administrador.
- Confere as linhas de cada tabela contra a contagem do backup e as migrations, que é o mesmo que o
  `/ready` confere.
- Com `--manter`, o banco fica, para abrir o servidor contra ele e levar uma missão de teste até o fim.
- Recusa sem a confirmação de isolado, ou se a URL for a do servidor. Senha errada, arquivo trocado e
  contagem que não bate também falham, e foram testados.

**Guarda:**
- a senha do backup num gerenciador de senhas, longe do backup;
- as chaves do cofre (`OBEDIENT_CHAVES_COFRE`) e a chave da Anthropic guardadas à parte, no
  gerenciador e nas variáveis do Railway. Sem as chaves do cofre, as credenciais das pessoas no backup
  não se abrem, e isso é de propósito.

**Ainda falta** (responsável):
1. escolher onde o backup fica, fora do Railway;
2. rodar o primeiro backup da produção e o teste de restauração;
3. definir a frequência (sugestão: diária, guardando 14).

## Homologação (A4, pendente)

Um segundo ambiente no Railway, com banco próprio e só dados fictícios. Ele cobra à parte, por isso a
criação é do responsável:
1. criar o ambiente `homologacao` no projeto do Railway, com Postgres próprio;
2. variáveis próprias: outro `OBEDIENT_ORIGIN`, cofre com chaves novas e token de métricas novo;
3. publicar a branch a homologar, rodar `migrar` e conferir `/ready`;
4. só depois disso, juntar na `main` e publicar a produção.

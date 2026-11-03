# Integrações (Fase 7)

Pacote `@obedient/integrations`; migration 0005.

- **7.1, conexões:** como a pessoa liga o Google ao OBEDIENT e como a credencial é guardada, usada e
  revogada.
- **7.2, ferramentas:** o que o agente faz com essas conexões, sempre pelo Ethics Engine.
- **7.3, executor das missões:** vem no próximo PR.

## Catálogo e escopo mínimo

| Integração | Escopos pedidos ao Google | O que **não** pede |
|---|---|---|
| Google Agenda | `calendar.events` | configurações da agenda, outras agendas além dos eventos |
| Gmail | `gmail.readonly`, `gmail.send` | `gmail.modify` e `mail.google.com`: o agente não apaga nem arquiva e-mail |
| Google Drive | `drive.file` | `drive` e `drive.readonly`: o agente só vê o que ele mesmo criou |

- **Cada ferramenta é declarada no catálogo com risco, categoria e os dados pessoais que toca.** O
  modelo nunca decide isso. A declaração passa pela validação do SDK, e um teste confere que nenhuma
  ferramenta sai da sua integração.
- **Apagar compromisso é `DESTRUCTIVE`:** conta como crítico e pede passkey.
- **Mandar e-mail é `COMMUNICATION` de risco alto:** sempre pede aprovação e precisa da assinatura da
  pessoa (Art. 5º).

## Conectar (OAuth 2.0 com PKCE)

```
app: "Conectar" ─► POST /api/conexoes/iniciar
        servidor grava state (hash), nonce (hash), PKCE verifier (cifrado); cookie Lax com o nonce
     ─► accounts.google.com (a pessoa autoriza)
     ─► GET /api/conexoes/retorno?state&code     (chega SEM a sessão: o cookie dela é Strict)
        confere state + nonce do cookie (uso único, 10 min) → troca o código (com o verifier)
        confere os escopos devolvidos → grava a credencial cifrada → 303 para /?conexao=ok
```

- **O retorno se prende ao fluxo duas vezes:** pelo `state`, que está no banco com o usuário que
  iniciou, e pelo **nonce no cookie do navegador** que iniciou. Sem o segundo, alguém poderia fazer
  a vítima completar um fluxo iniciado na conta dele e ligar a conta Google da vítima ao OBEDIENT do
  atacante.
- **Escopos devolvidos são conferidos.**
  - Faltou algum, porque a pessoa desmarcou na tela do Google: não conecta, e o app explica.
  - Veio a mais, por concessão antiga na conta: não conecta e pede para remover o acesso antigo.
    O mínimo vale também aqui.
- **`include_granted_scopes=false`:** cada integração pede só o seu, sem somar concessões anteriores.

## Cofre

- **Cifra:** AES-256-GCM com chave **fora do banco** (`OBEDIENT_CHAVES_COFRE`, gerada por `cli.ts
  chave`).
- **Dado autenticado:** usuário e integração entram no dado autenticado da cifra. Uma cifra copiada
  para a linha de outra pessoa, ou de outra integração, não abre.
- **Rotação de chave:** cada cifra leva o id da chave; a primeira da lista cifra, e as outras
  continuam abrindo.
- **Credencial nunca sai do servidor.** O painel e a exportação mostram nome, escopos e data.

## Token, renovação e revogação

- **Renovação:** o token de acesso é renovado quando falta menos de 1 minuto. A chamada ao Google
  acontece **fora** de transação. `invalid_grant` (a pessoa revogou no Google) desfaz a conexão
  aqui também.
- **Revogação:**
  - desconectar, **parar** (Art. 9º) e **apagar o que o OBEDIENT sabe** tiram as conexões **na
    mesma transação** e põem as credenciais numa fila (`token_revocations`);
  - a revogação no Google é feita logo depois do commit;
  - sem rede, fica na fila para a próxima vez, mas a conexão já não serve desde o commit.
- **Na parada,** a retirada das conexões roda num `SAVEPOINT`: um erro nela não pode impedir a parada
  de ser gravada.

## Ferramentas (7.2)

| Ferramenta | Categoria e risco | O que faz e o que não faz |
|---|---|---|
| `google_agenda.listar_eventos` | READ, baixo | Período em UTC; devolve título, horário, local e número de participantes, nunca a descrição |
| `google_agenda.criar_evento` | WRITE, médio | **Sem convidados e com `sendUpdates=none`:** criar compromisso não manda nada a ninguém (convidar seria comunicação) |
| `google_agenda.apagar_evento` | DESTRUCTIVE, crítico | Pede passkey; o id é validado antes de virar URL |
| `google_gmail.buscar_mensagens` | READ, baixo | Até 10 mensagens; corpo em texto, cortado em 4.000 caracteres |
| `google_gmail.enviar_mensagem` | COMMUNICATION, alto | **Um** destinatário; a assinatura da pessoa vai sempre no fim; cabeçalho com quebra de linha é recusado (sem `Bcc` injetado); sempre pede aprovação |
| `google_drive.listar_arquivos` | READ, baixo | Só o que o app criou (`drive.file`) |
| `google_drive.criar_documento` | WRITE, médio | Cria um Google Docs a partir de texto |

- **Argumentos:** cada ferramenta tem esquema com `additionalProperties: false`. Argumento fora do
  esquema, tipo errado, data inválida ou texto longo demais é recusado **antes da rede**.
- **Resultado:** volta curto e marcado como conteúdo externo. É dado, nunca instrução.

### O que conectar concede (e desconectar retira)

Conectar é o ato da pessoa, depois de ler a explicação da integração. Ele cria duas coisas, as duas
visíveis e revogáveis no app:

- **um grant** para o agente, só com as ferramentas daquela integração (`google_agenda.*`), com a
  explicação como finalidade, prazo de 30 dias e autonomia só até risco baixo. Reconectar substitui
  o grant anterior;
- **o consentimento** para as categorias de dado que as ferramentas declaram, com a finalidade
  `integracao:<id>`.

**Desconectar, parar e apagar retiram os dois.** Com isso:

- ler a agenda roda sozinho;
- criar compromisso roda sozinho (risco médio, padrão do sistema);
- mandar e-mail pede aprovação;
- apagar compromisso pede passkey.

### Fora do banco

O Google pode demorar. Por isso o servidor usa `chamarComEthicsEmEtapas`, e cada etapa de banco é uma
transação curta:

1. autorizar;
2. reivindicar a aprovação, se houver (`claimApproved`, uma vez só);
3. chamar o Google, **fora** de qualquer transação;
4. concluir (`completeApproved`).

O teste roda no PGlite, que tem uma conexão só: se alguma etapa abrisse transação dentro de outra,
ele travaria.

## Configuração do servidor

| Variável | Para quê |
|---|---|
| `OBEDIENT_GOOGLE_CLIENT_ID`, `OBEDIENT_GOOGLE_CLIENT_SECRET` | Cliente OAuth do Google. Sem eles, o app mostra as integrações e diz que o servidor não as tem ligadas |
| `OBEDIENT_CHAVES_COFRE` | Chaves do cofre, `id:base64,…` |

**O que você precisa fazer no Google Cloud** (é sua conta; eu não crio):

1. Crie um projeto.
2. Ative as APIs Calendar, Gmail e Drive.
3. Configure a tela de consentimento.
4. Crie um cliente OAuth "Aplicativo da Web" com o redirect `<OBEDIENT_ORIGIN>/api/conexoes/retorno`.

**Atenção a dois limites do Google:**

- **`gmail.readonly` e `gmail.send` são escopos restritos.** Para uso por terceiros, o Google exige
  verificação e uma avaliação de segurança anual.
- **Em modo de teste**, até 100 usuários de teste, os refresh tokens **vencem em 7 dias**: a pessoa
  reconecta toda semana.

Para uso pessoal, o modo de teste basta.

## Testes

- **`packages/integrations/src/conexoes.test.ts`** (11), contra um Google falso
  (`google-falso.ts`):
  - escopo mínimo e PKCE;
  - credencial cifrada e invisível;
  - state de uso único, de 10 minutos, e só no navegador que começou;
  - escopos a menos e a mais;
  - renovação e `invalid_grant`;
  - revogação com e sem rede;
  - parar e apagar;
  - isolamento e cifra presa à pessoa;
  - o app não lê o state;
  - catálogo;
  - cofre (rotação e adulteração).
- **`packages/server/src/api.test.ts`** (5 novos):
  - conectar pelo caminho do navegador, com o cookie conferido;
  - retorno sem o cookie;
  - a pessoa recusou no Google;
  - desconectar e parar revogam;
  - servidor sem integração.
- **`e2e/app.e2e.ts`** (1 novo): conectar e desconectar no navegador. A "tela do Google" é
  interceptada e redireciona de volta como o Google faria. O axe não acusou violações.
- **`packages/integrations/src/ferramentas.test.ts`** (8): contrato de cada ferramenta com a API do
  Google (método, URL, token, corpo, leitura da resposta), injeção de cabeçalho, limites e esquema.
- **`packages/integrations/src/governadas.test.ts`** (7): as ferramentas pelo Ethics Engine com o
  banco e o Google falso:
  - sem conexão, nada;
  - conectar a Agenda não abre o Gmail;
  - apagar pede passkey e executa uma vez com o payload aprovado;
  - e-mail só com a assinatura certa e aprovação;
  - desconectar tira grant e consentimento;
  - reconectar não acumula grant.
- **Prova de mutação:**
  - tirar a conferência do nonce no retorno reprova o teste "só no navegador que começou";
  - tirar a conferência do payload na aprovação reprova os testes de payload trocado. Mesmo sem
    ela, o que executaria é o payload guardado: a conferência dá a recusa clara.

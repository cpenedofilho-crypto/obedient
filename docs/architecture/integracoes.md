# Integrações (Fase 7)

Pacote `@obedient/integrations`; migration 0005.

- **7.1, conexões:** como a pessoa liga o Google ao OBEDIENT e como a credencial é guardada, usada e
  revogada.
- **7.2, ferramentas:** o que o agente faz com essas conexões, sempre pelo Ethics Engine.
- **7.3, executor das missões:** o laço do agente com o modelo e estas ferramentas, em
  [`executor.md`](./executor.md).

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

## Growth OS por A2A (fase 3 da auditoria A2A, 08/11/2026)

O Growth OS é o servidor A2A da casa. O OBEDIENT fala com ele como cliente, pelo `@obedient/a2a-client`. A diferença para o Google é que a credencial não é de uma pessoa: é uma aplicação M2M no WorkOS, cadastrada no Growth OS por uma pessoa, presa a uma organização e a uma lista fechada de skills. O código está em `packages/server/src/growth-os.ts`.

**Quem pode usar:**
- só as pessoas que o dono do servidor lista em `OBEDIENT_GROWTH_OS_USUARIOS`;
- e só depois de um ato explícito: `cli.ts growth-os conceder <usuario>`.

**O que o ato cria:** um grant do Ethics Engine (`growth_os.*`, risco máximo LOW, autonomia até LOW, 30 dias), com a finalidade escrita.
- O grant aparece no app como o de qualquer integração.
- Tira-se pelo app ou com `growth-os retirar`.
- Sem grant vigente, a ferramenta nem é oferecida ao modelo.

**O que as ferramentas fazem:** `growth_os.resumo_operacional` e `growth_os.catalogo_marketplace` são só leitura.
- O executor escolhe a skill pela ferramenta autorizada. O que o modelo põe nos argumentos não chega ao Growth OS.
- Volta ao modelo só o estado e as partes `data`, como `conteudo_externo`. Texto livre do servidor não volta.

**Comprar no marketplace do Growth OS (12/11/2026)** é um sistema à parte para o Ethics Engine, `growth_os_compras`, para o grant de leitura nunca cobrir uma ação que gasta. O pagamento lá é simulado (carteiras contábeis), mas a regra aqui é a de dinheiro.
- O ato é outro: `cli.ts growth-os conceder-compras <usuario> <teto_em_micro_unidades>` (e `retirar-compras`). Só para quem está em `OBEDIENT_GROWTH_OS_USUARIOS`.
- O grant é `growth_os_compras.*`, 30 dias, **sem autonomia** e com teto de valor por compra no campo `preco_maximo_micros`. Acima do teto, o Ethics Engine nega sem criar proposta.
- A ferramenta `growth_os_compras.comprar_conhecimento` é categoria `FINANCIAL`: toda compra para e pede a aprovação da pessoa, com reautenticação. Sem o grant, ela nem é oferecida.
- Depois de aprovada, o executor lê o catálogo e só compra se a oferta está à venda, a compra está ligada lá e o preço não passa do que a pessoa aprovou. Preço de oferta não muda no Growth OS: preço novo é oferta nova.
- Ao Growth OS vão só a oferta e a consulta. Quem paga e o teto de lá saem do cadastro do cliente A2A no Growth OS, feito por pessoa.
- Se o Growth OS recusa (sem saldo, acima do teto de lá), o código do erro volta ao modelo.

**Configuração:** todas as variáveis ou nenhuma, senão o servidor não sobe.
- `OBEDIENT_GROWTH_OS_CARD_URL`, `_TOKEN_URL`, `_CLIENT_ID`, `_SEGREDO` e `_USUARIOS`.
- O card e o token precisam ser https.
- O segredo é lido do ambiente na hora de pedir o token e nunca vai para log, banco ou conversa.

## Servidores MCP do dono (cliente MCP genérico, 09/11/2026)

O OBEDIENT conversa com qualquer servidor MCP que fale Streamable HTTP, como o Motor IGA e o Recupera OS. Usa o SDK oficial, e a saída para a rede passa pelo `fetchSeguro`. O código está em `packages/server/src/mcp-servidores.ts`.

**Quem decide o que entra é o dono do servidor**, na variável `OBEDIENT_MCP_SERVIDORES`, em JSON. Exemplo:

```json
[{"id":"motor_iga","nome":"Motor IGA","url":"https://…/mcp","token_env":"OBEDIENT_MCP_MOTOR_IGA_TOKEN",
  "usuarios":["Juca"],"ferramentas":["motor_quem_sou_eu","motor_listar_leads_quentes"]}]
```

**Regras da configuração:**
- **`id`** vira o sistema do Ethics Engine. Os ids `obedient`, `growth_os` e `google_*` são reservados.
- **`url`** precisa ser https e não pode levar usuário nem senha.
- **`token_env`** é o **nome** da variável que guarda o token (`OBEDIENT_MCP_*`). O valor do token é lido a cada chamada e nunca aparece no JSON, no log nem na conversa.
- **`ferramentas`** é a lista fechada, com até 40 nomes:
  - só é oferecido o que o dono listou **e** o servidor anuncia em `tools/list`;
  - ferramenta nova no servidor não aparece sozinha;
  - do servidor vem só o esquema de entrada e uma descrição cortada em 400 caracteres;
  - chamar uma ferramenta fora da lista é recusado antes de chegar à rede.
- **Configuração inválida:** o servidor não sobe.

**Autoridade:**
- Só as pessoas em `usuarios` podem receber a autoridade, e só depois de um ato explícito: `cli.ts mcp conceder <servidor> <usuario>`.
- O ato cria um grant `<id>.*`, que vale **só para leitura de risco baixo** e por 30 dias.
- O grant aparece no app e pode ser tirado lá ou com `cli.ts mcp retirar <servidor> <usuario>`.
- Sem grant vigente, as ferramentas do servidor nem são oferecidas.
- Escrita fica para uma fase seguinte, com aprovação.

**Resultado e falhas:**
- O resultado volta ao modelo como `conteudo_externo`, com o texto e os dados estruturados cortados em 20 mil caracteres.
- Servidor fora do ar não derruba a missão: as ferramentas dele ficam de fora daquela vez, e o motivo vai para o log (`mcp.indisponivel`). O motivo é uma classe fechada: `sem_token`, `recusado_401`, `recusado_403`, `nao_encontrado_404`, `erro_servidor_5xx`, `http_<código>`, `destino_proibido`, `tempo_esgotado`, `rede`, `resposta_invalida` ou `erro`. A mensagem do erro nunca entra, porque é texto do servidor de fora, e o token também não.

### Servidor MCP com a conta da pessoa (OAuth, 10/11/2026)

Alguns servidores só aceitam o token de um **usuário**, emitido pelo Authorization Server deles. É o caso do Recupera OS, que usa o Supabase OAuth Server. Para esses, a entrada do servidor em `OBEDIENT_MCP_SERVIDORES` usa `oauth` no lugar de `token_env`:

```json
{"id":"recupera","nome":"Recupera OS","url":"https://…/mcp","usuarios":["Juca"],
 "ferramentas":["recupera.minhas_capacidades","recupera.analisar_recuperacao"],
 "oauth":{"client_id":"<cliente público no Authorization Server>","issuer":"https://<projeto>.supabase.co/auth/v1","escopos":["openid"]},
 "cabecalhos":{"x-recupera-escola-id":"<uuid da escola do agente>"}}
```

O código está em `packages/server/src/mcp-oauth.ts` e segue o mesmo desenho da conexão com o Google:

- **A pessoa conecta no app.** O fluxo usa PKCE S256 e um `state` de uso único, preso ao navegador. O retorno vai para `<OBEDIENT_ORIGIN>/api/conexoes/mcp/retorno`, que é o endereço a cadastrar no cliente OAuth do servidor.
  - Conectar concede ao agente a leitura daquele servidor: grant `<id>.*`, risco baixo, 30 dias.
  - Desconectar tira a conexão e o grant.
- **Cliente público, sem segredo.** O emissor vem da configuração do dono. A descoberta (RFC 8414) só vale se:
  - o `issuer` devolvido for o configurado;
  - os endpoints forem https na mesma origem;
  - houver S256.
- **A credencial fica cifrada no cofre** (`OBEDIENT_CHAVES_COFRE`, obrigatório nesse caso) e é renovada antes de vencer. Se a renovação for recusada (`invalid_grant`), a conexão cai.
- **Sem endpoint de revogação:** ao desconectar, parar ou apagar, a credencial é descartada aqui. A fila de revogação do Google passou a levar **só** `google_*`. Antes, ela mandaria qualquer token ao endpoint do Google.
- **`cabecalhos` (opcional):** cabeçalhos fixos que não são segredo, como `x-recupera-escola-id`.
  - Só nomes `x-…`; o servidor não sobe com nome que pareça credencial (`auth`, `token`, `key`, `secret`, `cookie`).
  - Nunca substituem o `authorization`.
  - No Recupera, prendem a sessão à escola do agente cadastrado em `agentes_ia`.

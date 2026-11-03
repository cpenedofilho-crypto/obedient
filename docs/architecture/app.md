# App e servidor (Fase 5)

O app é onde a pessoa **decide**: aprova ou recusa o que o agente pediu, vê e tira autorizações,
aperta parar. O servidor (`@obedient/server`) é o caminho entre o app e o Ethics Engine em Postgres
(`docs/architecture/persistencia.md`).

## Entrada: passkey, sem senha

| Fluxo | Como |
|---|---|
| Primeiro aparelho | O dono do servidor gera um **convite** (`cli.ts convite <usuario>`): código de 10 caracteres, uso único, vale 24 h, e o banco guarda só o hash. A pessoa digita o código no app e cadastra a passkey do aparelho |
| Entrar | A passkey do aparelho assina um desafio. O servidor não diz quem existe: o aparelho escolhe a passkey |
| Ação sensível | Aprovar ação CRITICAL exige **reautenticação** com a passkey nos últimos 5 minutos (Art. 1º) |

- **O que é conferido:**
  - verificação do usuário no aparelho (biometria ou PIN do aparelho) é obrigatória;
  - cada desafio serve uma vez, para um propósito e, quando houver, para um usuário, e vence em 5 minutos;
  - a origem e o domínio da passkey são conferidos, então página falsa não serve;
  - contador que não avança é recusado, por indicar passkey copiada.
- **Quem confere:** a criptografia é da `@simplewebauthn/server` (MIT). A trava do contador existe
  lá e de novo aqui; por isso o teste de mutação que tira a nossa não reprova, e isso é esperado.
- **Sessão:** cookie `__Host-obedient` (HttpOnly, Secure, SameSite=Strict, 12 h). O token
  só existe no cookie, e o banco guarda o hash.

## API

| Rota | Sessão? | O quê |
|---|---|---|
| `POST /api/convite/opcoes`, `/api/convite/concluir` | não | cadastrar a primeira passkey |
| `POST /api/entrar/opcoes`, `/api/entrar` | não | entrar |
| `GET /api/painel` | sim | parada, pedidos, autorizações vigentes, últimas 30 linhas da trilha |
| `POST /api/acoes` | sim | `aprovar`, `recusar`, `parar`, `liberar`, `revogar` |
| `POST /api/reautenticar/opcoes`, `/api/reautenticar` | sim | reautenticar com a passkey |
| `POST /api/sair` | sim | encerrar a sessão |

**Barreiras.** Todo `POST` precisa de:

- `Origin` igual à origem do app;
- `content-type: application/json`;
- o cabeçalho `x-obedient: 1`.

Com o cookie SameSite=Strict, isso fecha CSRF. O usuário de tudo vem da sessão, e todo acesso a
dado roda dentro de `comoUsuario()`, sob RLS. Erro interno não vaza detalhe para o aparelho.

**Cabeçalhos.** Todo arquivo sai com:

- política de conteúdo estrita: só script e estilo do próprio app, nada inline, nenhum iframe;
- `nosniff`, `no-referrer` e COOP/CORP `same-origin`.

## Ações: fila do aparelho e idempotência

Toda ação é gravada **primeiro** no aparelho e só depois enviada, então a tela nunca espera a rede.
Cada ação leva um `opId` gerado no aparelho, e o servidor guarda o resultado em
`obedient.client_ops`, na mesma transação da ação. Reenviar devolve o mesmo resultado (`repetida: true`)
sem fazer de novo. Se o mesmo `opId` chegar duas vezes ao mesmo tempo, a segunda perde na chave
única e lê o resultado da primeira.

- **Recusa do motor é resultado definitivo:** pedido vencido, já decidido, mudado depois do cartão
  ou sem reautenticação. Ela é guardada com uma mensagem em português, e o aparelho não tenta de novo.
- **Erro de infraestrutura:** volta como falha temporária, e o aparelho reenvia depois.

## O painel vem dos dados

O cartão mostra agente, sistema, ação e os argumentos como chave e valor, montados do payload
gravado, nunca do texto do modelo. Aprovar envia o **hash** do que o cartão mostrou. Se o pedido
tiver mudado, a aprovação é recusada.

## O app (PWA)

`packages/server/public/`: HTML, CSS e JavaScript sem build e sem framework. O JavaScript é
checado pelo TypeScript (`tsconfig.app.json`, `checkJs`) no `npm run typecheck`.

| Tela | O que tem |
|---|---|
| Entrar | "Entrar com passkey" e "Tenho um convite" |
| Painel | Botão de parar; pedidos esperando a pessoa; o que cada agente pode fazer; o que aconteceu |

**Toques.** Parar é **um toque**. Aprovar é **um toque**; se a ação for sensível, mais a passkey do
aparelho. Tirar uma autorização é **um toque**. Liberar o agente pede uma confirmação, porque é o
único sentido inseguro. Não há botão de salvar nem modal de sucesso: o cartão muda para
"Aprovado. Enviando…" e depois "Aprovado.".

**Sem internet.**

- **A ação vai para a fila no IndexedDB** (`fila.js`) e a tela segue. A fila envia `parar` e
  `liberar` antes de tudo, e o resto do mais antigo para o mais novo. Para no primeiro erro de rede
  e retoma com o **mesmo** `opId`.
- **O painel guarda a última cópia no aparelho.** Sem rede, mostra "Sem internet. Mostrando o que
  veio às HH:MM" e quantas ações esperam para enviar.
- **O service worker guarda só a casca do app**, nunca resposta da API (a mesma decisão do Ronda):
  uma segunda fonte de verdade offline faria um pedido aprovado "voltar" para a tela.
- **Parar sem internet é honesto:** a tela diz "Vai chegar ao servidor assim que este aparelho tiver
  internet. Enquanto isso, o agente ainda não sabe."
- **Ação sensível precisa de internet:** a passkey confirma com um desafio do servidor. A tela diz
  isso, em vez de fingir que aprovou.

**Texto do agente nunca vira HTML.** Argumentos e motivos entram com `textContent`, e a CSP barra
script inline mesmo que algo escape.

**Português direto.** O motor de políticas fala inglês, porque é API. O painel traduz cada motivo
(`motivoParaPessoa`, com teste que gera todos os motivos reais e reprova se sobrar inglês), os
níveis de risco (baixo, médio, alto, crítico) e o escopo ("qualquer ação em email").

**Acessibilidade.**

- alvos de toque de 48 px;
- foco visível;
- tema claro e escuro;
- `prefers-reduced-motion`;
- regiões `aria-live` para conexão e parada;
- cor nunca é o único sinal ("Barrado ·", "Atenção ·");
- link "Ir para o conteúdo".

## Testes

`packages/server/src/api.test.ts`, com um autenticador WebAuthn de software
(`autenticador-de-teste.ts`). No PGlite e, no CI, também no Postgres 17:

- **Passkey:**
  - o convite vale uma vez;
  - entrar funciona, e desafio repetido, origem falsa, contador repetido e passkey desconhecida são recusados;
  - a passkey sem contador (sincronizada) entra;
  - reautenticar com a passkey de outra pessoa não vale.
- **CSRF e sessão:** sem `Origin`, com outra origem, sem o cabeçalho ou com outro tipo de conteúdo,
  o pedido é recusado. Sem sessão, nada. Sair encerra.
- **Ações:**
  - aprovar uma vez só, inclusive com 4 envios simultâneos do mesmo `opId`;
  - hash adulterado é recusado;
  - CRITICAL só passa com reautenticação dos últimos 5 minutos;
  - parar barra o agente e cancela os pedidos;
  - a parada geral só o operador libera;
  - tirar uma autorização tira o acesso.
- **Isolamento:** a sessão de uma pessoa não vê nem decide nada de outra, mesmo com o id certo.
- **Servidor:** arquivo fora de `public/` não existe, e a política de conteúdo não tem `unsafe`.
- **Prova de mutação:** tirar a checagem de origem reprova o teste de CSRF.
- **Fila do aparelho** (`fila.test.ts`):
  - ordem de envio;
  - sem rede, nada se perde e o reenvio usa o mesmo `opId`;
  - sessão vencida;
  - recusa definitiva;
  - drenagens simultâneas;
  - limpeza.
- **Português** (`painel.test.ts`): todo motivo real do motor sai traduzido.

## Ponta a ponta (`e2e/app.e2e.ts`, `npm run test:e2e`, job `e2e` do CI)

Chromium de celular (390 × 844), passkey pelo autenticador virtual do navegador, servidor de
desenvolvimento (`src/dev.ts`: banco em memória e dados fictícios). O que se confere:

- **Convite e entrada:** o convite cadastra a passkey; sair e entrar de novo sem convite funciona;
  um aparelho sem passkey não entra.
- **Aprovar:** é um toque; a ação sensível passa pela passkey; recusar e tirar autorização
  funcionam, e o agente perde o acesso.
- **Texto do agente:** `<img onerror>` nos argumentos aparece como texto, e nenhum elemento é criado.
- **Sem internet:** parar fica na fila e **sobrevive a recarregar a página**. A casca vem do service
  worker; o painel e a fila, do IndexedDB. Quando a rede volta, a parada chega e o agente é barrado.
- **Liberar** pede confirmação.
- **Acessibilidade:** axe sem violação (WCAG 2.0, 2.1 e 2.2, níveis A e AA) na entrada e no painel.
  Nenhum controle visível tem menos de 44 px.
- **Erros:** nenhum erro de JavaScript na página.
- **Prova de mutação:** trocar `textContent` por `innerHTML` nos detalhes do cartão reprova o teste
  de XSS.

Rodar o app à mão: `node --import tsx packages/server/src/dev.ts` imprime a URL e um convite.


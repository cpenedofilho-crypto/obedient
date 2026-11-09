# Executor das missões (Fase 7, parte 3)

O que faz uma missão andar sozinha. São três peças:

- **modelo:** pacote `@obedient/modelo-anthropic`;
- **executor:** `packages/server/src/executor.ts`;
- **agendador:** `packages/server/src/agendador.ts`.

Migration 0006.

```
agendador (a cada 30 s, papel do operador)
  └─ pessoas_com_missao_devida()  → só ids
       └─ processarMissoes (papel da pessoa)
            reservar ─► executor ─► concluir
                          └─ executarRodada (agent-orchestrator)
                               ├─ modelo: ModeloAnthropic
                               └─ ferramentas: concluir_missao
                                              + as do Google, por chamarComEthicsEmEtapas
```

## Uma tentativa é uma rodada do laço do agente

- **O modelo recebe:**
  - as instruções, com as regras da Constituição;
  - a identificação das mensagens da pessoa (Art. 5º);
  - o que a memória pode usar (só as categorias que a pessoa ligou);
  - a data no fuso dela;
  - o pedido.
- **Ferramentas:** só as das integrações que a pessoa **conectou**, mais `concluir_missao`.
- **Cada ferramenta do Google passa pelo Ethics Engine.** Sem grant, ela é negada. Acima da
  autonomia do grant, vira pedido de aprovação.
- **Transações curtas:** cada etapa de banco é uma transação curta, e a chamada ao Google fica fora
  delas, como na 7.2.
- **O desfecho é dito pelo agente,** com `concluir_missao`: `feito`, `nao_sei` ou `nao_consegui`, e
  a explicação para a pessoa. **Terminar sem chamar não é "feito"** (Art. 5º). A tentativa conta como
  falha, e a próxima continua a conversa pedindo o desfecho.

## Pedido de aprovação: a mesma tentativa continua

- **A tentativa para e guarda a conversa** na missão (`missions.rodada`, migration 0006).
- **Decidido o pedido, ela continua dali.** A ação aprovada roda **uma vez**, com o payload aprovado.
  Todos os resultados daquela volta vão ao modelo numa mensagem só.
- **Continuar não conta outra tentativa.** Uma missão de 1 tentativa termina mesmo passando por uma
  aprovação.
- **Dois pedidos na mesma volta:** a missão só continua quando a pessoa tiver decidido os dois. Antes
  disso, o que ainda está pendente não é tratado como recusado.
- **Recusado ou vencido:** vira impedimento, como antes. A conversa guardada é apagada.

**A conversa guardada tem conteúdo da pessoa.** Ela só aparece para a pessoa (RLS) e tem limite de
tamanho no banco. Some quando a missão termina, é cancelada, fica impedida ou quando a pessoa usa
"apagar o que o OBEDIENT sabe" (a 0006 estende a função).

## Como cada rodada termina

| A rodada | A tentativa |
|---|---|
| Concluiu com `concluir_missao` | O desfecho que o agente disse |
| Concluiu sem `concluir_missao` | Falha passageira; a próxima continua e pede o desfecho |
| Parou num pedido de aprovação | Espera a pessoa, com a conversa guardada |
| Erro passageiro do modelo (rede, 408, 409, 429, 5xx, 529), prazo de 10 min | Falha passageira; a próxima continua a conversa |
| Chave recusada, sem crédito, pedido inválido | Falha passageira; depois do teto de tentativas, impedimento com o erro |
| Teto de custo | Para antes da próxima chamada ao modelo; a missão fica impedida explicando |
| A pessoa parou ou cancelou | Para antes da próxima chamada; o resultado é descartado |
| Recusa do modelo, resposta cortada, passos demais, laço, ferramenta inexistente | "Não consegui", com o motivo |

**A ferramenta que já rodou não roda de novo** quando a tentativa seguinte continua a conversa.

## Custo (Art. 7º)

- **Como o gasto é somado:** em dólares, por resposta, pelo modelo que de fato respondeu. Com
  fallback, cada tentativa conta pelo preço do modelo dela.
- **Conversão para o teto da missão:** `OBEDIENT_CENTAVOS_POR_DOLAR`, padrão 600 (R$ 6,00). O padrão
  fica de propósito acima do câmbio: o teto erra para o lado de parar antes.
- **Conferência:** o gasto é conferido antes de cada chamada ao modelo. **A tentativa pode passar
  do teto por no máximo uma resposta.**
- **Modelo fora da tabela de preços:** o servidor não sobe. Sem preço, o teto não vale.
- **Fallback que responde com um modelo novo** (fora da tabela): é cobrado pelo preço do modelo
  mais caro.

## O modelo

- **SDK:** o oficial, `@anthropic-ai/sdk` 1.3.0, Apache-2.0 (na allowlist de licenças).
- **Modelo e esforço:** padrão `claude-opus-5-5`, com esforço `high`. O raciocínio fica no modo
  adaptativo do modelo.
- **Fallback (`fallbacks: "default"`):** se os classificadores de segurança recusarem um pedido, a
  Anthropic o refaz no servidor num modelo indicado para aquela categoria. Vem ligado e pode ser
  desligado (`OBEDIENT_FALLBACK=desligado`).
- **Cache:** automático. No laço, cada volta repete o começo da conversa.
- **A conversa só cresce no fim:** o conteúdo da resposta (raciocínio incluído) volta ao modelo como
  veio, sem edição.

## O agendador

- **A cada 30 s,** o operador pergunta ao banco **quem** tem missão para andar: tentativa vencida,
  ou pedido de aprovação já decidido ou vencido.
- **A função `pessoas_com_missao_devida()` devolve só o id da pessoa.** Ela é do papel
  `obedient_scheduler`, que lê só quatro colunas das missões e três dos pedidos.
- **O operador continua sem ler missão nenhuma**, e o app não chama a função.
- **Cada missão roda com o papel da própria pessoa.**
- **Voltas não se sobrepõem.** Se uma pessoa falha, as outras seguem.
- **O log diz o que aconteceu, nunca o conteúdo.**
- **Uma pessoa de cada vez:** uma missão longa segura a volta. Para uso pessoal, basta.

## Dado de terceiros

O resultado das ferramentas volta ao modelo **sem** a limpeza de dado pessoal do Growth OS.

- **Por que pode:** o consentimento que a pessoa dá ao conectar a integração (finalidade
  `integracao:<id>`) cobre justamente isso, e o Ethics Engine o confere a cada chamada (Art. 4º).
- **Continua marcado como `conteudo_externo`:** as instruções dizem ao modelo que é dado, nunca
  instrução.
- **Um e-mail que "mande" o agente fazer algo não muda nada:** a ação continua passando pelo grant e
  pela aprovação.

## Configuração do servidor

| Variável | Para quê |
|---|---|
| `OBEDIENT_AGENTE=ligado` | Liga o executor e o agendador. Padrão: desligado |
| `ANTHROPIC_API_KEY` | Credencial da Anthropic, lida pelo SDK |
| `OBEDIENT_MODELO` | Modelo; precisa estar na tabela de preços |
| `OBEDIENT_ESFORCO` | `low`, `medium`, `high` (padrão), `xhigh` ou `max` |
| `OBEDIENT_FALLBACK=desligado` | Não refazer no servidor o que os classificadores recusarem |
| `OBEDIENT_CENTAVOS_POR_DOLAR` | Câmbio para o teto de custo (padrão 600) |
| `OBEDIENT_FUSO` | Fuso das pessoas (padrão `America/Sao_Paulo`) |

## Testes

- **`packages/modelo-anthropic/src/index.test.ts`** (5), contra uma API falsa (o `fetch` do SDK):
  - o pedido que sai: modelo, esforço, ferramentas, cache, fallback, sem `temperature` e sem mexer
    no raciocínio;
  - a resposta volta sem edição;
  - o gasto por modelo, com e sem fallback;
  - modelo sem preço;
  - a leitura de cada erro.
- **`packages/server/src/executor.test.ts`** (8), com o banco, o Google falso e um modelo
  roteirizado:
  - ler a agenda e concluir, com o custo na missão e só as ferramentas conectadas;
  - apagar compromisso com passkey: a mesma tentativa continua e apaga uma vez;
  - dois pedidos na mesma volta;
  - terminar sem desfecho;
  - teto de custo;
  - parar no meio;
  - erro passageiro continuando a conversa;
  - o agendador, com um log sem conteúdo.
- **`packages/store-postgres/src/missoes.test.ts`** (2 novos), no PGlite e no Postgres real:
  - a conversa guardada vai, volta e é apagada;
  - o agendador vê só quem tem missão devida;
  - o operador não lê missão, e o app não chama o agendador.
- **`packages/missions/src/index.test.ts`:** continuar depois da aprovação não conta tentativa, e o
  executor recebe a conversa.
- **Prova de mutação.** Cada uma destas mudanças reprova pelo menos um teste:
  - continuar contando tentativa;
  - não conferir o teto no meio;
  - não reler a missão;
  - "terminar sem desfecho vira feito";
  - não esperar o segundo pedido;
  - não zerar o orçamento da tentativa.

  O teste dos dois pedidos **não** pegava a falta da espera enquanto aprovava o pedido que a missão
  não esperava. Agora ele aprova justamente o que a missão espera.


## Aprender nas missões (Art. 10, 09/11/2026)

Até 09/11 o executor só **lia** as lições: nenhuma missão gravava nada, e "O que ele já aprendeu" ficava vazio. Agora o agente tem a ferramenta interna `lembrar(categoria, texto)`:

- **Quando aparece:** só se a pessoa ligou ao menos uma categoria, e só com as categorias ligadas. A recusa por categoria desligada continua no `Memoria.lembrar`, com consentimento e registro na trilha.
- **O que guarda:** o que a própria pessoa disse no pedido da missão, numa frase curta. A lição aparece no app e pode ser apagada.
- **A trava:** depois que a conversa recebe resultado de outro sistema (e-mail, documento, resumo do Growth OS), `lembrar` é recusada naquela tentativa, e a conversa guardada carrega isso. Assim, um texto de fora não vira "preferência da pessoa" nem volta nas próximas missões como contexto confiável.

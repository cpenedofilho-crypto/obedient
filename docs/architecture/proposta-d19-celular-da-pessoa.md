# Proposta D19: o OBEDIENT no celular da própria pessoa

> **Estado: proposta, não decidida.** Nada aqui muda código nem a D17 até o fundador decidir e a
> linha entrar em `docs/governance/decisoes.md`. Escrita em 17/11/2026, somente leitura do que existe.

## A ideia

A pessoa está no celular, abre o OBEDIENT, manda um **áudio** ("troca a música", "manda para minha
mãe que chego às 8", "paga a conta de luz") e o OBEDIENT executa **na tela do celular dela, como se
fosse ela**, e no fim entrega a tarefa pronta, com a trilha do que fez.

É o equivalente, no celular, da extensão do Chrome que hoje age no navegador do computador.

## O que já existe e serve

| Peça | Onde | Serve como está? |
|---|---|---|
| Motor com cinco ferramentas, política por risco, tela aprovada = tela executada, parada, máscara | `@obedient/mobile-control` (`docs/architecture/mobile.md`) | **Sim.** É o cérebro e a trava |
| Porta do aparelho: `iniciar`, `capturar`, `executar`, `encerrar` | `AdaptadorMovel` em `packages/mobile-control/src/tipos.ts` | **Sim.** Muda só quem a implementa |
| Executor atual (adb, emulador) | `executores/mobile-control` do casa-de-ia | Não: exige computador e adb, e recusa aparelho real de propósito |
| App onde a pessoa aprova (passkey, cartões, parar, trilha, fila offline) | `@obedient/server` (PWA, `docs/architecture/app.md`) | **Sim**, para aprovar. Não age em outros apps |
| Risco médio pede aprovação por padrão | D18 | Sim. A autonomia de toque e digitação vem de grant, não do padrão |

## Por que o Artemis não é o caminho

Avaliado em 05/11/2026 (`casa-de-ia/executores/android-qa`, commit `351ca84` do Artemis):

- precisa de um **computador** ligado ao celular por adb (cabo ou depuração sem fio no modo
  desenvolvedor), o que nenhum usuário comum vai manter;
- roda em Python no computador, com o **laço de decisão próprio**: o modelo dele vê a tela e toca,
  sem passar pelo Ethics Engine a cada ação, o que contorna a Constituição;
- há alegação pública da Minitap de que a maior parte do código foi copiada do `mobile-use`; trazer
  isso para um projeto AGPL com licença comercial pesa em `docs/licensing/PROVENANCE.md`.

O Artemis continua útil onde já está: **testar** PWAs (Ronda, Repique, e o próprio app do OBEDIENT)
num emulador, pelo `android-qa`.

## A arquitetura proposta

```
áudio → app OBEDIENT Android → texto (transcrição)
      → servidor: laço do agente + @obedient/mobile-control (política, Ethics Engine, aprovação)
      → comando aprovado → AdaptadorAcessibilidade (no próprio celular) toca/digita/desliza
      → captura nova → próximo passo → "pronto" + trilha
```

- **Executor novo: app Android nativo (Kotlin)** com um `AccessibilityService`. Ele lê a árvore da
  tela e executa gestos, sem computador e sem root. Implementa a mesma porta `AdaptadorMovel`, com o
  mesmo vocabulário fechado (tocar por id, digitar, deslizar, início, voltar, abrir app da lista).
- **O app não decide nada.** Ele só cumpre um comando que veio assinado do servidor para aquela
  sessão, e só se a tela que ele vê tiver o mesmo hash da tela aprovada. Comando fora do vocabulário
  ou de outra sessão é recusado no aparelho também (segunda trava, como a RLS é a segunda trava no
  banco).
- **Parar sempre funciona do próprio celular:** botão flutuante e notificação fixa enquanto o
  OBEDIENT age; tocar nele chama a parada de emergência e desliga o serviço.
- **iPhone continua fora:** o iOS não permite que um app controle outros.

## Faixas de risco por tipo de tarefa

| Faixa | Exemplos | Regra proposta |
|---|---|---|
| A. Mídia e utilidades | trocar música, volume, despertador, abrir rota no mapa | Roda sozinho, se a pessoa der o grant de autonomia (D18) |
| B. Mensagem | WhatsApp para mãe, filho, funcionário | **Cartão de aprovação** com destinatário e texto exatos antes do "Enviar"; uma mensagem por pedido; nunca lista nem envio em lote. Hoje a D17 nega app de mensagem: esta faixa abre só com a D19 |
| C. Dinheiro | pagar conta, Pix, boleto | **O OBEDIENT prepara, a pessoa dá o último toque.** Ele preenche e para na tela de confirmação; quem confirma é a pessoa, com a biometria/senha do banco. O OBEDIENT nunca toca em "Pagar", "Confirmar" ou "Transferir" em app financeiro |
| D. Dados financeiros | conciliar extrato do cartão | **API antes da tela:** Open Finance ou o PDF da fatura por `@obedient/integrations`. Tela só como plano B, só leitura |
| Sempre negado | configurações, loja, instalador, autenticador, gerenciador de senhas, desligar o próprio serviço | Igual à D17 |

## Riscos que decidem se isto é viável

1. **Política da Google Play para Accessibility API.** É o risco nº 1 e precisa ser lido na fonte
   oficial antes de qualquer código (`support.google.com/googleplay/android-developer/answer/10964491`).
   O que as buscas de 17/11/2026 indicam, **ainda não conferido no texto oficial**: assistentes e
   ferramentas de automação não se qualificam como `isAccessibilityTool`; apps que não são
   ferramenta de acessibilidade precisam de divulgação destacada e consentimento; e há relatos de
   que iniciar, planejar e executar ações de forma autônoma pela API é proibido para quem não é
   ferramenta de acessibilidade. Se isso se confirmar, o app **não entra na Play** e a distribuição
   seria por instalação direta (APK), o que limita muito o público.
2. **Modo de Proteção Avançada do Android** (16/17): relatos de que ele bloqueia serviços de
   acessibilidade de apps que não são ferramenta de acessibilidade. Conferir.
3. **Bancos no Brasil.** Controle por acessibilidade é o mecanismo dos golpes de "mão fantasma"
   (trojans bancários que movimentam Pix pela tela). Muitos apps de banco bloqueiam captura de tela
   (`FLAG_SECURE`) e se recusam a abrir com um serviço de acessibilidade ligado. A faixa C pode não
   funcionar em parte dos bancos mesmo sendo correta. **Nenhum recurso de evasão de detecção**
   (já está na D17 e continua).
4. **WhatsApp.** Os termos proíbem envio automatizado; mensagem pontual pedida pela pessoa é
   diferente do disparo em massa, mas o risco de bloqueio é da **conta da pessoa**. Precisa estar
   escrito no consentimento.
5. **Prints vão ao provedor do modelo.** No celular real a tela tem dado real (de terceiros
   também). Exige: máscara antes de subir (já existe), termo do provedor revisado em
   `docs/licensing/termos-provedores.md`, e opção de usar só a árvore de acessibilidade, sem imagem.
6. **Custo e latência.** Cada passo é uma captura e uma chamada de modelo. Teto por missão já existe
   (`@obedient/missions`); falta medir o custo real de uma tarefa típica.

## Fases propostas

| Fase | Entrega | Portão para seguir |
|---|---|---|
| 0 | Ler a política da Play e a do Modo de Proteção Avançada na fonte oficial; escrever o resultado aqui | Se a Play proibir agente autônomo, decidir entre APK direto ou parar |
| 1 | App Android com o `AdaptadorAcessibilidade`, **só faixa A**, num celular de teste do fundador, com a segunda trava no aparelho e o botão de parar | Testes do motor passando com o adaptador novo; prova de mutação das duas travas |
| 2 | Entrada por áudio e a entrega "pronto" com a trilha | Custo e tempo medidos por tarefa |
| 3 | Faixa B (mensagem) com cartão de aprovação | Decisão escrita sobre o risco de bloqueio da conta |
| 4 | Faixa C (preparar pagamento até a tela de confirmação) e D por API | Lista de bancos testados; nenhum toque de confirmação pelo agente |

## O que muda na D17 se a D19 for aprovada

- "Fase 1: emulador isolado, só dados sintéticos" passa a valer só para o **teste**; o celular da
  própria pessoa entra pelo adaptador de acessibilidade, com consentimento explícito.
- "Apps de mensagem negados" vira a faixa B com aprovação; "pagamento negado" vira a faixa C
  (preparar, nunca confirmar).
- Configurações, loja, instalador e autenticador continuam negados; evasão de detecção continua
  proibida.

## Decisões pedidas ao fundador

1. Aprovar a D19 como direção (celular da própria pessoa, por acessibilidade, nas faixas acima)?
2. Aceitar a regra "o OBEDIENT prepara, a pessoa dá o último toque" para dinheiro?
3. Se a Play proibir agente autônomo por acessibilidade: distribuir por APK direto ou esperar?

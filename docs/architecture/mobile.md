# Mobile Control Engine (decisão D17)

Pacote `@obedient/mobile-control`. O agente usa um celular por cinco ferramentas, cada uma governada
pelo Ethics Engine, com um adaptador de aparelho por trás. O plano completo, de 05/11/2026, é a
auditoria somente leitura que levou à D17.

## Escopo desta fase

- **Fase 1:** emulador Android isolado e só dados sintéticos.
- **Fora por enquanto:** iPhone.
- **Este pacote é o núcleo,** sem I/O: contratos, política, percepção e motor, testados com um
  celular falso (`adaptador-falso.ts`). O executor que fala com o emulador por adb fica no Growth OS
  (`executores/`, ao lado do `android-qa`) e implementa a porta `AdaptadorMovel`.
- **Phone Harness (MIT):** só referência para o vocabulário de operações; nenhum código copiado. O CLI dele não é usado: ele roda Python arbitrário, tem
  shell no aparelho e telemetria ligada que envia o texto do script.

## Ferramentas

| Ferramenta | Risco | Observação |
|---|---|---|
| `mobile_list_devices` | READ, LOW | Só os aparelhos do próprio tenant |
| `mobile_start_session` | WRITE, MEDIUM | Até 30 min; uma sessão aberta por aparelho |
| `mobile_observe` | READ, LOW | App em primeiro plano e elementos com id, sem coordenada, já mascarados |
| `mobile_act` | conforme a ação (abaixo) | Toque e digitação pelo id do elemento da observação mais recente |
| `mobile_stop_session` | sem autorização | Tirar poder sempre funciona, mesmo sem grant |

O vocabulário de `mobile_act` é fechado: `input.tap_element`, `input.text`, `input.swipe`,
`nav.home`, `nav.back`, `apps.launch`. Ficam de fora, de propósito, estas operações, que nenhum
adaptador expõe:

- shell e comando livre;
- instalar app;
- abrir URL qualquer;
- enviar arquivo;
- ler a área de transferência.

## Política (`politica.ts`)

| Ação | Risco | Com o grant padrão de conectar |
|---|---|---|
| Observar, deslizar, voltar, início | LOW | Roda sozinho |
| Abrir app da lista, tocar, digitar | MEDIUM | Roda sozinho |
| Tocar em "Enviar", "Responder", "Compartilhar"… | HIGH, COMMUNICATION | Pede aprovação |
| Tocar em "Confirmar", "Aceitar"… | HIGH | Pede aprovação |
| Tocar em "Pagar", "Comprar", "Transferir"… | CRITICAL, FINANCIAL | Passkey |
| Tocar em "Excluir", "Apagar"… | CRITICAL, DESTRUCTIVE | Passkey |

- **O texto do alvo só sobe o risco, nunca baixa.** Uma tela que diz "isto não é um pagamento" ainda
  contém "pagamento".
- **Apps sempre negados:** configurações, loja, instalador de pacotes, autenticador e shell, mais os
  negados do aparelho. App fora da lista do aparelho também não abre.
- **App negado em primeiro plano:** só sair dele é permitido (início ou voltar).
- **App de mensagem:** negado por padrão (`permiteMensagens: false`). As réguas de envio dos produtos
  rodam no servidor, e um agente no aparelho passaria por fora delas. Com a permissão, digitar e
  enviar nele são COMMUNICATION.

## A tela aprovada é a tela executada

- **O hash da tela entra no payload que a pessoa aprova.** Ele é calculado depois da máscara, sobre
  app, textos e posições arredondadas.
- **Na execução, o motor observa de novo.** Se a tela mudou (outro app na frente, uma notificação), a
  ação não acontece: o resultado é `tela_mudou`, com a tela nova para o agente pedir de novo.
- **Só a observação mais recente vale para agir.**

## Parar

- **Grant revogado ou parada acionada:** o Ethics Engine nega a próxima ação, e o motor fecha a sessão
  na hora e manda o adaptador encerrar.
- **Parada de emergência** (`ligarParada`): fecha todas as sessões da pessoa no mesmo instante.
- **Prazo e limite de passos** fecham a sessão.

## O que vai ao modelo e o que fica guardado

- **Máscara:** campo de senha nunca tem o texto lido. E-mail e sequência de seis ou mais dígitos
  (código de verificação, cartão, CPF, telefone) viram marcadores.
- **Conteúdo externo:** tudo o que a tela mostra vai como `conteudo_externo`. O motor só lê o texto
  para subir o risco de um toque.
- **Registro do motor:** hash dos argumentos, risco, categoria, desfecho e hashes da tela. Nunca
  o texto digitado nem o conteúdo da tela.
- **Telas antigas:** a observação anterior some quando chega a nova.

## Testes

`packages/mobile-control/src/motor.test.ts` (20), com o Ethics Engine de verdade e o celular falso.

- **Os dez cenários do protótipo:**
  - sessão autorizada, captura, elementos, abrir o app de demonstração;
  - formulário com dados sintéticos, aprovação antes de enviar e envio executado uma vez;
  - resultado verificado, encerrar e auditoria sem o que foi digitado;
  - revogar a autorização no meio.
- **Guardas:**
  - parada de emergência;
  - tela que mudou depois da aprovação;
  - observação desatualizada;
  - apps negados e fora da lista;
  - tela que tenta mandar no agente;
  - o texto do botão só sobe o risco;
  - app de mensagem;
  - prazo e passos;
  - isolamento entre pessoas;
  - uma sessão por aparelho;
  - esquema e vocabulário;
  - aparelho que falha;
  - credencial só como nome.
- **Peças puras:** máscara, hash da tela, classificação.
- **Pelo laço do agente:** o modelo pede, a pessoa aprova, a retomada executa uma vez.

**Prova de mutação:** cada uma destas mudanças reprova pelo menos um teste:

- não conferir a tela;
- não fechar a sessão quando o Ethics nega;
- aceitar observação velha;
- não travar app negado na frente;
- não ligar a parada;
- não conferir o dono da sessão;
- tirar a máscara de dígitos;
- liberar app de mensagem;
- tirar a tela do payload aprovado;
- tirar o prazo.

## Pelo MCP Gateway do Growth OS (`@obedient/mobile-mcp`)

No Growth OS quem governa é o MCP Gateway, que decide risco e aprovação **por ferramenta**, pelo nome
e pelas anotações (`classificar()` do `@obedient/integration-gateway`, o mesmo código que ele roda). O
risco de um toque depende da tela, então por esse caminho agir tem dois passos.

| Ferramenta | Risco no Gateway | Faz |
|---|---|---|
| `mobile_listar_aparelhos` | LOW, READ | Os aparelhos da organização |
| `mobile_iniciar_sessao` | HIGH, WRITE | Abre a sessão (pede aprovação) |
| `mobile_ler_tela` | LOW, READ | A tela mascarada, como `conteudo_externo` |
| `mobile_propor_acao` | LOW, READ | **Não age.** Confere e classifica; devolve a faixa, a ferramenta de executar e o resumo |
| `mobile_executar_acao` | HIGH, WRITE | Faixa comum. É HIGH por padrão (escrita sem anotação); uma pessoa pode rebaixar para MEDIUM, com auditoria |
| `mobile_executar_acao_alta` | HIGH, WRITE | Faixa alta (enviar, confirmar) |
| `mobile_executar_acao_critica` | CRITICAL, DESTRUCTIVE | Faixa crítica (pagar, excluir); aprovação privilegiada |
| `mobile_encerrar_sessao` | HIGH, WRITE | Encerra. Recomenda-se rebaixar para LOW: só tira poder, e a sessão vence sozinha em até 30 min |

**Regras do motor na execução de uma proposta:**

- só pela ferramenta da faixa dela;
- só uma vez;
- só até 10 minutos;
- só com o **resumo** exato que a proposta devolveu. É esse texto que a pessoa lê no pedido de
  aprovação do Gateway, e ele sai dos dados da proposta, nunca do modelo;
- e só se a tela não tiver mudado.

O teste `packages/mobile-mcp/src/servidor.test.ts` passa cada ferramenta pelo classificador do Gateway
e reprova se alguma mudar de faixa.

**Servidor** (`servir.ts`):

- HTTP streamable, sem estado por requisição, uma organização por instância;
- token conferido em tempo constante;
- Host conferido pelo nome, contra DNS rebinding;
- corpo limitado.

O aparelho é o serviço `executores/mobile-control` do casa-de-ia, falado pelo `AdaptadorHttp`, que
desconfia da resposta: formato, tipos e tamanho, e o texto de senha nunca passa.

```bash
MOBILE_MCP_TENANT=<organization_id> MOBILE_MCP_TOKEN=<token> MOBILE_MCP_HOSTS=mobile.interno \
MOBILE_CONTROL_URL=http://127.0.0.1:8765 MOBILE_CONTROL_TOKEN=<token do serviço> \
MOBILE_MCP_APPS_PERMITIDOS=dev.obedient.demo \
node --import tsx packages/mobile-mcp/src/servir.ts
```

Por enquanto, sessões e propostas vivem no processo: reiniciar o servidor encerra tudo, o que falha
fechado.

## A seguir

1. **No casa-de-ia:** registrar o servidor em `mcp_servers`, com o token como `secret_ref` e
   `MCP_SEGREDOS`; registrar a exceção em `docs/SECURITY.md`; aplicar os rebaixamentos de risco
   recomendados acima.
2. **Fase 2:** imagem com o emulador, o serviço do aparelho e este servidor; rodar o app de
   demonstração com dados sintéticos.
3. **Persistência** das sessões e propostas, quando mais de uma instância precisar enxergá-las.

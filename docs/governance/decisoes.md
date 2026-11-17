# Decisões do fundador

Registro das decisões que moldam o projeto. Uma decisão nova entra aqui antes de mudar código ou
documento.

| # | Data | Decisão | Efeito |
|---|---|---|---|
| D1 | 02/11/2026 | O titular do projeto oficial é a **Casa de IA Educação e Consultoria Ltda** (CNPJ 69.761.208/0001-20) | Licenciadora da AGPL e da licença comercial |
| D2 | 02/11/2026 | "Samar" é o nome de usuário herdado do notebook do fundador | Todos os commits com `cpenedofilho@gmail.com` são do fundador (`.mailmap`) |
| D3 | 02/11/2026 | Nenhum dos sistemas de origem foi desenvolvido sob contrato com cliente | Material e dados de cliente continuam fora do OBEDIENT |
| D4 | proposta | AGPL-3.0-only + licença comercial; SDK em Apache-2.0 | Aplicado neste repositório |
| D5 | proposta | CLA de licença ampla (não cessão) | `CLA.md` (minuta) |
| D6 | proposta | "DOTS" não é marca pública | `TRADEMARKS.md` |
| D7 | 02/11/2026 | **Opção A:** as peças genéricas de coordenação de agentes saem do Growth OS para pacotes do OBEDIENT, e o Growth OS passa a consumi-las | Plano em `docs/architecture/extracao-growth-os.md` |
| D8 | proposta | O Cloud publica o código-fonte das versões que roda | Pendente |
| D9 | proposta | Mobile começa como PWA | Pendente (Fase 5) |
| D10 | proposta | Aviso de 60 dias para emenda que reduz proteção | Pendente; o `GOVERNANCE.md` usa 30 dias de comentário |
| D11 | proposta | Texto da Constituição sob CC BY 4.0 | Pendente |
| D12 | 02/11/2026 | **Repositório público desde já** | Publicado como pré-alfa. Contribuição externa só é aceita depois que o CLA for revisado (`CONTRIBUTING.md`) |
| D13 | 02/11/2026 | Quem usa os sistemas de origem não é titular deles | Registrado no instrumento de licença |
| D14 | 02/11/2026 | A estrutura societária foi tratada no instrumento de licença (documento privado) | n/a |
| D15 | 02/11/2026 | **Opção A:** o fundador continua autor e titular, e concede **licença exclusiva** à Casa de IA | `GOVERNANCE.md` §1; instrumento a ser redigido pelo advogado |
| D16 | 02/11/2026 | O laço do run com banco (`executar.ts`, que grava cada passo) **fica no Growth OS**. O OBEDIENT mantém a `executarRodada` sem banco para quem usa o pacote puro | Etapa 6 encerrada sem trocar o laço; nada muda em produção. Reabrir só com um gancho por passo no `agent-orchestrator` e teste que compare o que fica gravado |
| D17 | 05/11/2026 | **Celulares pelo Mobile Control Engine, com motor próprio.** O Phone Harness (MIT) é só referência e, no futuro, adaptador opcional para a nuvem dele; o CLI dele nunca executa ações (roda Python arbitrário, tem shell no aparelho e telemetria ligada). **iPhone fica fora por enquanto.** Fase 1: emulador Android isolado, só dados sintéticos, prints só de staging para o provedor do modelo; apps de mensagem, pagamento, configurações e loja negados; transporte do executor por HTTP interno com `secret_ref`; nenhum recurso de evasão de detecção | Plano de 05/11/2026 (auditoria somente leitura); fase 1 começa por `packages/mobile-control`. **Desde a D19 (17/11/2026), estas restrições valem para teste e emulador;** o celular da própria pessoa segue a D19 |
| D18 | 16/11/2026 | **Risco médio pede a pessoa por padrão.** O padrão do Policy Engine para MEDIUM passa de `allow` a `require_approval`; só a autonomia que um grant der (`autonomousUpTo`) libera o médio. Grant concedido pela linha de comando fica registrado como do operador (`operador:<nome>`), nunca como se a pessoa tivesse concedido. Entrada, convite e ações ganham limite de taxa; o que só tira poder do agente (parar, revogar, desconectar, apagar) nunca é limitado | Fase F0 do Service Delivery Engine da Casa de IA (decisão D6 de lá). Criar compromisso na Agenda e documento no Drive passam a pedir aprovação |
| D19 | 17/11/2026 | **OBEDIENT no celular da própria pessoa, por Serviço de Acessibilidade num app Android** (no lugar do adb), pela mesma porta `AdaptadorMovel`; o motor e o Ethics Engine decidem, o aparelho só cumpre comando aprovado e confere a tela. Faixas: mídia e utilidades sozinhas (com grant, D18); mensagem só com cartão de aprovação, uma por pedido; **dinheiro: o OBEDIENT prepara e para na tela de confirmação, a pessoa dá o último toque** (o agente nunca toca em pagar, confirmar ou transferir em app financeiro); extrato por API antes da tela. **Distribuição por APK direto**, fora da Play. iPhone continua fora; configurações, loja, instalador e autenticador continuam negados; nenhuma evasão de detecção. Artemis só para teste (`android-qa` do casa-de-ia) | Arquitetura e fases em `docs/architecture/proposta-d19-celular-da-pessoa.md`. Fase 0 (verificação de desenvolvedor do Android para APK no Brasil, Play Protect, Modo de Proteção Avançada, bancos) antes de qualquer código |

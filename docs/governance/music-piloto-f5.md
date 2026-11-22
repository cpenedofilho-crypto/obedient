# Piloto fechado da música adaptativa — F5 (proposta)

**Estado:** proposta de 22/11/2026, **não iniciada e bloqueada**. A D31 proíbe dado real de pessoa e
distribuição do app antes do fim da F0. Este documento deixa o piloto pronto para começar quando as
condições da seção 1 estiverem cumpridas. Nada aqui autoriza recrutar ninguém. O texto de consentimento
(seção 4) é rascunho para o advogado, não texto final.

## 1. Condições para começar (todas, com evidência)

| # | Condição | Evidência esperada | Situação em 22/11/2026 |
|---|---|---|---|
| C1 | Parecer de FTO sobre US 12,681,987 e as famílias da F0 §2 | Parecer escrito do agente de patentes | **Pendente** |
| C2 | Posição sobre AGPL × lojas, e licença comercial e CLA revisados | Parecer e versões revisadas de `COMMERCIAL-LICENSE.md` e `CLA.md` | **Pendente** |
| C3 | RIPD aprovado e texto de consentimento final (seção 4) | RIPD assinado; `VERSAO_TEXTO` do app trocada para a versão aprovada | **Pendente** |
| C4 | Catálogo real: contrato-modelo, ≥ 60 faixas, cobertura ≥ 8 por faixa de energia, publicadas em homologação | Rascunho sem problemas e saída do `musica:ingerir` | **Pendente** (nenhuma faixa) |
| C5 | Login no app (Supabase Auth) e sincronização com o Growth OS | PR mergeado com teste; redirect `obedient-musica://auth/confirmar` no Supabase; SMTP próprio; link testado em aparelho | **Em parte:** código e testes prontos (PR do login); falta a configuração no Supabase e o teste em aparelho |
| C6 | Build nativo e teste em aparelho: Android e iOS, BLE real com ao menos 3 sensores (cinta, relógio em broadcast, WHOOP), áudio e Bluetooth com a tela apagada, p95 < 50 ms por amostra, consumo < 5 %/h | Relatório de teste com modelos e versões | **Pendente** (sem Android SDK nem Xcode neste ambiente) |
| C7 | Growth OS de homologação com as migrations `20261129_musica` e `20261130_musica_arquivos`, o bucket `musica` e a `SUPABASE_SERVICE_ROLE_KEY` | Registro no runbook | **Pendente** |
| C8 | PRs obedient#61, #62, #63 e casa-de-ia#214 mergeados | Commits na `main` | **Pendente** (CI verde, esperando revisão) |
| C9 | Distribuição de teste fechada (TestFlight interno e Play teste interno), sem loja pública | Convites por e-mail | **Pendente**; depende de C2 |
| C10 | Decisão escrita do responsável liberando `EXPO_PUBLIC_SINAL_REAL=1` só no build do piloto | Linha nova em `decisoes.md` | **Pendente** |

**Piloto de produto, não pesquisa científica.** Se a intenção for publicar os resultados como pesquisa
com seres humanos, o piloto precisa de um Comitê de Ética em Pesquisa (CEP/CONEP) e de um TCLE próprio.
É pergunta para o advogado antes de C3.

## 2. Desenho do piloto

| Item | Proposta |
|---|---|
| Quem | 20 a 50 adultos (18+), voluntários, de **uma** organização do Growth OS escolhida pelo responsável |
| Duração | 4 semanas, com pelo menos 2 treinos por semana por pessoa |
| Aparelhos | Android e iPhone próprios. Sensores: cinta BLE, relógio Garmin ou Polar em broadcast, WHOOP |
| Modo | Semanas 1 e 2 em "só sugerir"; semanas 3 e 4 em "adaptar sozinho". A pessoa pode trocar a qualquer hora |
| O que sai do aparelho | Só o resumo de contagens, com o consentimento separado de agregados (`music_session_aggregates`) |
| Questionário | Opcional, no fim de cada semana e fora do app de música (ferramenta aprovada pelo responsável), sem frequência cardíaca |
| Saída | A qualquer momento, sem justificativa: "apagar meus dados" no app e saída da lista do piloto |

## 3. Triagem e segurança

- **Antes de entrar:** o PAR-Q+ (questionário de prontidão para atividade física), aplicado fora do app.
  Quem tiver alguma resposta "sim" só entra com liberação médica. O app não guarda as respostas.
- **Fora do piloto:** gestantes; pessoas com marca-passo, arritmia diagnosticada ou cardiopatia; uso de
  betabloqueador (altera a frequência cardíaca e as zonas). A lista final é do advogado e de um
  profissional de saúde.
- **No app:**
  - o aviso de que não é dispositivo médico já está no texto de consentimento;
  - não há meta que empurre intensidade, e a música acompanha a zona, sem puxar o ritmo;
  - os controles manuais vencem sempre.
- **Regra de parada:** qualquer relato de mal-estar durante o uso para o piloto daquela pessoa e entra no
  registro de incidentes. Dois relatos parecidos suspendem o piloto inteiro até revisão.

## 4. Rascunho do texto de consentimento do piloto (para o advogado)

> **Piloto da música adaptativa — [organização]**
>
> Você está convidado a testar, por 4 semanas, um app que escolhe a música do seu treino pelo seu
> esforço. Para isso, o app lê a sua frequência cardíaca do sensor que você conectar. Esse é um dado de
> saúde e **fica só no seu celular**: não vai para a Casa de IA, para a sua organização nem para treinar
> inteligência artificial.
>
> Se você autorizar, e só se autorizar, ao fim de cada treino o app envia à sua organização um resumo
> **sem** frequência cardíaca, **sem** as músicas e **sem** horário: duração, quantas vezes a música
> trocou e quantas vezes você pulou.
>
> O app **não é dispositivo médico**. Se você sentir mal-estar, pare o treino e procure atendimento.
> Você pode sair do piloto a qualquer momento, revogar as autorizações no próprio app e apagar seus dados
> pelo botão "Apagar meus dados".
>
> Controlador: Casa de IA Educação e Consultoria Ltda. Contato do encarregado: [a definir].

## 5. Métricas e critérios de sucesso (só com agregados)

Fonte: `GET /api/musica/agregados` (semanas com ≥ 5 sessões) e o questionário opcional.

| Métrica | Como medir | Meta proposta |
|---|---|---|
| Pulos manuais por sessão | `pulosPorSessao` | ≤ 2 nas semanas 3 e 4 |
| Uso da adaptação | `percentualAdaptadoMedio` | ≥ 70 % |
| Sessões por pessoa por semana | sessões ÷ participantes ativos | ≥ 2 |
| Permanência | quem ainda usa na semana 4 ÷ quem começou | ≥ 60 % |
| Satisfação | questionário: "a música combinou com meu esforço" (1 a 5) | média ≥ 4 |
| Segurança | relatos de mal-estar relacionados | 0 |
| Técnica | travamentos e perda de sinal relatados; latência em aparelho | sem bloqueador aberto |

**Decisão no fim:** seguir para lançamento, ajustar (energia por zona, intervalo mínimo, histerese) e
repetir, ou parar. Toda mudança de parâmetro vira PR com os números.

## 6. Custos estimados do piloto (premissas)

| Item | Estimativa | Premissa |
|---|---|---|
| Sensores emprestados | R$ 3–8 mil | 10 cintas BLE para quem não tem relógio compatível |
| Contas de desenvolvedor | US$ 99/ano (Apple) + US$ 25 (Google) | Distribuição de teste |
| Suporte durante 4 semanas | ~R$ 30 mil | Já previsto no plano (F5) |
| Jurídico do piloto | Incluído na F0 | Consentimento, RIPD, PAR-Q+ |

## 7. O que já está pronto no código para o piloto

- Agregados com mínimo de 5 sessões por semana e sem pessoa (casa-de-ia#214).
- Modo "só sugerir" e "adaptar sozinho", com controles manuais (obedient#62).
- "Apagar meus dados", que alcança aparelho, servidor e arquivos baixados (#62 e #63).
- O sensor real atrás de `EXPO_PUBLIC_SINAL_REAL`, desligado por padrão (#62).

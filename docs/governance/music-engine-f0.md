# Music Intelligence Engine — Dossiê da F0 (para revisão jurídica)

**Estado:** preparado em 22/11/2026 a partir da auditoria somente leitura de 11/11/2026. **Não é
parecer jurídico.** É o material para o advogado de propriedade intelectual e o de proteção de dados
decidirem. Nenhuma conclusão aqui autoriza lançar, distribuir ou tratar dado real.

Legenda: **[V]** lido na fonte primária; **[VS]** só trecho de busca citando a fonte primária;
**[NV]** não verificado.

## 1. O que se pede ao advogado

1. **Liberdade de operação (FTO)** do desenho descrito em `docs/architecture/music-engine.md`, nos
   EUA e no Brasil, frente às patentes da seção 2.
2. **AGPL × lojas de apps:** se a Casa de IA pode distribuir na App Store e na Play um app que inclui
   `@obedient/music-engine` (AGPL-3.0-only), e em que termos (seção 4).
3. **Licença comercial e CLA:** revisar `COMMERCIAL-LICENSE.md` e `CLA.md` (minutas), porque a
   distribuição nas lojas pode depender deles.
4. **LGPD:** validar a base legal, o texto de consentimento e o relatório de impacto (seção 5).
5. **Catálogo próprio:** modelo de contrato de encomenda e de licença de biblioteca, e a questão do
   ECAD (seção 6).

## 2. Patentes

### 2.1 US 12,681,987 B2 (citada pelo app ArcX/MusicBoost) [V]

Reivindicações lidas no PDF oficial da USPTO. Inventor e requerente: Paul Allen Blair. Depósito
08/01/2025, concessão 14/07/2026, 12 reivindicações (independentes 1 e 7). Titularidade pela ArcX
Technology Ltd e família em outros países: **[NV]**.

Quadro de elementos da reivindicação 1, comparado ao desenho atual:

| Elemento da reivindicação 1 | No motor | Onde |
|---|---|---|
| (a) dados biométricos de pelo menos um sensor biométrico multimodal | **Presente**: frequência cardíaca e RR por BLE | `sensor/parse-2a37.ts` |
| (a) entrada explícita do usuário com **humor**, tipo de treino e intensidade | **Ausente**: não há humor nem tipo de treino; a pessoa só informa FC de repouso e máxima, gêneros e faixa de energia | `music-contracts` (`Preferencias`, `ConfigContexto`) |
| (b) pré-processar para remover ruído e artefatos | **Presente** | `contexto/filtro-artefatos.ts` |
| (b) identificar métricas-chave | **Presente** (bpm suavizado) | `contexto/engine.ts` |
| (b) **classificar em conjunto estado fisiológico e psicológico**, com humor + treino + intensidade como entradas de um **algoritmo de machine learning** | **Ausente**: só zona fisiológica por regra fixa (Karvonen) com histerese; sem estado psicológico; sem modelo aprendido | `contexto/zonas.ts`, `contexto/engine.ts` |
| (c) gerar playlist a partir do perfil fisio + psico | **Parcial**: escolhe a próxima faixa por energia da zona fisiológica | `decisao/decidir.ts` |
| Dep. 5/11: atualizar o perfil e modificar a playlist | Análogo presente | `sessao.ts` |
| Dep. 6/12: grupo, reprodução simultânea e transições coordenadas | **Ausente** | guarda de desenho |

Pergunta ao advogado: a ausência dos elementos "humor/tipo/intensidade como entrada" e
"classificação conjunta fisio + psico por ML" afasta a infração literal e por equivalentes?

### 2.2 Outras patentes do campo

Só a folha de rosto foi lida na USPTO; status de taxas e datas de expiração são **[NV]** (estimativas
de 20 anos do depósito mais ajuste).

| Patente | Titular | Objeto (resumo) | Expiração estimada | Como o desenho se afasta (a confirmar) |
|---|---|---|---|---|
| US 7,683,252 B2 | Microsoft | escolher música para fazer o usuário acelerar, desacelerar ou manter o ritmo | ~jan/2027 [NV] | o motor acompanha a zona escolhida pela pessoa, não tenta conduzir o ritmo; **pedir análise das reivindicações** e confirmar a expiração |
| US 9,183,822 B2 | Google | selecionar trecho pelo ritmo e **alterar o tempo** para casar | ~2033 | sem alteração do áudio |
| US 9,595,932 B2 | Nike | **modificar a composição** conforme a atividade | ~2035 | sem recomposição nem stems adaptativos |
| US 11,058,304 B2 | Valencell | música com tempo correlacionado à FC e **alteração do tempo para mudar a FC** | ~2037 | sem alteração de tempo; o motor não usa o BPM da faixa |
| US 10,372,757; 9,536,560; 10,282,163; 9,570,059; 11,868,397 | Spotify | busca por tempo, cadência → seleção, alinhamento de fase, troca entre versões, playlists por faixa de tempo | ~2035 | sem cadência, sem BPM casado, sem alinhamento de batida, sem versões da mesma música |
| US 2008/0153671 A1 | Philips | FC → ajustar o tempo do áudio | pedido; status [NV] | possível arte anterior |
| US 2008/0097633 A1 | Texas Instruments | ajustar o tempo à FC | pedido; status [NV] | possível arte anterior |
| US 7,888,581 B2 | Agere | ajustar a cadência das músicas | ~2028 [NV] | sem alteração do áudio |

Não encontrados com número: patentes da Weav Music, RockMyRun e TempoRun, e de Apple ou Sony sobre o
tema. Bases bloqueadas na auditoria: Google Patents, Espacenet, Justia. Uma busca completa de
anterioridade e de famílias (BR, EP, WO) fica para o escritório.

## 3. Termos de plataforma

| Plataforma | Situação no motor | Observação |
|---|---|---|
| Spotify | **Fora** (D31) | Política proíbe ML/IA sobre conteúdo, mixagem e sincronização; sem BPM para apps novos desde 27/11/2024 [VS] |
| Apple Music | **Fora** (D31) | DPLA §3.3.6(D): não modificar nem sincronizar; reprodução iniciada pelo usuário; não monetizar o acesso [V] |
| BLE Heart Rate Service | Usado (padrão aberto) | Layout lido em fonte secundária; conferir a especificação da Bluetooth SIG [NV] |
| Polar BLE SDK | Opcional (F3) | Licença permite uso comercial gratuito, só para transferência de dados entre produto Polar e o app; sem marca [V] |
| Garmin, WHOOP | Só por broadcast BLE padrão | APIs de nuvem não são usadas; termos da Garmin de out/2026 restringem compartilhamento [VS] |
| Health Connect | Não usado na F1 | Se usado: declaração de app de saúde no Play Console [V]; política sobre publicidade e IA [NV] |
| HealthKit | Não usado na F1 | Guideline 5.1.3 e DPLA §3.3.3(H): sem publicidade, sem venda, sem iCloud para dado de saúde [V] |

## 4. AGPL-3.0 e lojas de apps

- O motor é AGPL-3.0-only (D31, Opção B). Um app que o inclua forma obra combinada.
- Historicamente os termos da App Store foram vistos como incompatíveis com GPL/AGPL (caso VLC,
  2011) [NV para os termos atuais].
- Caminho a validar: o titular distribui o próprio código nas lojas sob a licença comercial, o que
  pressupõe titularidade sobre todo o código (D15 e CLA assinado por cada contribuidor).
- O código do motor já está publicado neste repositório público, o que atende à oferta de fonte da
  §13 para quem o usar pela rede, desde que o app aponte para ele.

## 5. LGPD — rascunho do relatório de impacto (RIPD)

| Item | Proposta |
|---|---|
| Dado | Frequência cardíaca e intervalos RR (dado de saúde, sensível: art. 5º, II) |
| Finalidade | Escolher a próxima música durante a atividade física (`adaptacao_musical`) |
| Base legal | Consentimento específico e destacado (art. 11, I), registrado pelo Ethics Engine com `specific: true` |
| Onde é tratado | Só no aparelho; nada do sinal vai para servidor, terceiro ou modelo de IA |
| Retenção | Sinal bruto não é guardado; trilha local de decisões (sem bpm) por 24 h, configurável para zero |
| Compartilhamento | Nenhum. Resumo agregado da sessão (contagens, sem FC) só com consentimento separado e opcional |
| Direitos | Revogação imediata (para a leitura do sensor), exportação e exclusão da trilha local |
| Transferência internacional | Nenhuma do dado de saúde |
| Riscos | Inferência de condição de saúde; uso por pessoa com cardiopatia; aparelho compartilhado |
| Mitigações | Processamento local; zonas a partir de valores da própria pessoa; sem metas que empurrem intensidade; aviso de que não é dispositivo médico; controles manuais sempre disponíveis |
| A confirmar | Texto do consentimento, aviso de não ser dispositivo médico, idade mínima, papel de controlador (Casa de IA) |

## 6. Catálogo próprio (D31)

Requisitos que o contrato de cada faixa precisa cobrir, refletidos em `LicencaFaixa`:

- uso comercial em app, território e prazo (`permiteComercial`, `validaAte`);
- edição para **crossfade** e corte em fronteira de frase, que pode ser "adaptação" pela Lei 9.610,
  art. 29 (`permiteCrossfade`) [VS];
- cópia em cache no aparelho para uso offline (`permiteCacheOffline`);
- cessão ou licença dos direitos do autor da obra, dos intérpretes e do produtor fonográfico (arts. 29,
  90 e 93) [NV para o texto literal];
- evidência guardada (`evidencia`) e identificador do instrumento (`instrumento`).

Pergunta ao advogado: a reprodução para a própria pessoa dentro do app gera obrigação com o ECAD
(execução pública)? Há decisão do STJ sobre streaming como execução pública [NV].

## 7. Pendências de verificação

- Titularidade e família da US 12,681,987; status e expiração das demais (seção 2.2).
- Especificação oficial do Heart Rate Service (Bluetooth SIG).
- Termos atuais da App Store e da Play para software AGPL.
- Política da Play para Health Connect (publicidade, venda, IA) se ele for usado.
- Texto literal dos arts. 29, 90 e 93 da Lei 9.610 e a questão do ECAD.

## 8. Critério de saída da F0

A F0 termina quando houver, por escrito: o parecer de FTO (ou a lista de mudanças de desenho que ele
pedir), a posição sobre AGPL × lojas, o texto de consentimento aprovado e o modelo de contrato do
catálogo. Até lá, o motor só roda com sinal sintético, e nenhuma versão vai para loja ou para pessoa.

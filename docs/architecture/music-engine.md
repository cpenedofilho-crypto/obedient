# Music Intelligence Engine (decisão D31)

Pacotes `@obedient/music-contracts` e `@obedient/music-engine`, ambos AGPL-3.0-only. O motor escolhe
a próxima música de um **catálogo próprio** a partir da frequência cardíaca lida no aparelho, com
consentimento específico, controle manual sempre disponível e nenhuma alteração do áudio.

Este documento descreve a **F1**: núcleo sem I/O, testado só com sinal sintético. Ainda não existem
o app, o leitor Bluetooth nativo, o player nativo, o servidor e o catálogo; ver "O que falta".

## Decisões que moldam o código

| Decisão | Onde está no código |
|---|---|
| Opção B: o motor mora no OBEDIENT, sob AGPL (D31) | `packages/music-*/package.json` |
| Catálogo próprio ou licenciado; **sem Spotify** e sem Apple Music (D31) | `ORIGENS_FAIXA = ["proprio", "licenciado"]` |
| Sinal nunca sai do aparelho; só um resumo agregado opcional | `eventos.ts`, `ResumoSessao` |
| Decisão por regra explicável, sem modelo aprendido e sem humor | `contexto/engine.ts`, `decisao/decidir.ts` |
| Nenhuma alteração do áudio (tempo, tom, composição) | `PlayerNativo` não oferece isso |
| Sem sessão de grupo sincronizada | ausente; vigiado pela guarda de desenho |

As quatro últimas linhas são o desenho para evitar as patentes e os termos levantados na auditoria de
11/11/2026. **Só valem como proteção depois do parecer da F0** (`docs/governance/music-engine-f0.md`).
O teste `guarda-de-desenho.test.ts` reprova se alguma dessas peças aparecer no código.

## Módulos

```
SensorAdapter (app) ──amostras──▶ MotorDeContexto ──contexto──▶ decidir() ──decisão──▶ PlaybackAdapter ──▶ PlayerNativo (app)
                                        ▲                          ▲
                                 filtro de artefatos         Preferências (declaradas)
                                                             catálogo elegível (licença)
            MotorDePrivacidade (ConsentManager do Ethics Engine) ── corta tudo ao revogar
```

| Módulo | Arquivo | O que faz |
|---|---|---|
| Sensor | `sensor/parse-2a37.ts` | Lê os bytes da Heart Rate Measurement (0x2A37) do BLE: bpm 8/16 bits, contato, energia, RR em 1/1024 s |
| Sensor (teste) | `sensor/simulado.ts` | Sinal sintético determinístico por semente; a F1 roda só com isto |
| Filtro | `contexto/filtro-artefatos.ts` | Descarta fora de 25–250 bpm ou sem contato; salto > 25 bpm/s é duvidoso; RR ectópico (> 20 % da mediana) sai |
| Zonas | `contexto/zonas.ts` | Karvonen: fração da reserva; z1…z5 a 50/60/70/80/90 %. Repouso e máxima vêm da pessoa |
| Contexto | `contexto/engine.ts` | Média exponencial das amostras boas, histerese de 3 bpm, permanência de 20 s, perda de sinal após 5 s, fase por regra |
| Preferências | `preferencias/engine.ts` | Energia por zona (padrão ou escolhida), gêneros, bloqueadas, explícito; valida a licença de cada faixa |
| Decisão | `decisao/decidir.ts` | Função pura com motivo fechado; ordem das regras no cabeçalho do arquivo |
| Reprodução | `reproducao/catalogo-proprio.ts` | Confere a licença de novo antes de tocar; crossfade só se player e licença deixarem |
| Privacidade | `privacidade/engine.ts`, `retencao.ts` | Consentimento pelo Ethics Engine (health + biometric, específico); trilha local sem bpm, com prazo |
| Sessão | `sessao.ts` | Liga tudo; revogar para o sensor na hora; controles manuais vencem |
| Eventos | `eventos.ts` | `music.session.ended` com contagens arredondadas; recusa chaves de saúde |

## Regras de decisão (resumo)

1. Sem consentimento → nada. 2. Modo desligado, pausa, faixa travada → a pessoa manda.
3. Zona travada pela pessoa vale mesmo sem sinal; sem ela, sinal perdido há mais de 60 s → nada,
   menos que isso ou confiança abaixo de 0,5 → manter. 4. Faixa atual dentro da faixa de energia da
   zona → manter. 5. Menos de 60 s desde a última troca automática → manter (faixa que ficou
   inelegível sai na hora). 6. Escolhe a elegível mais perto do centro da faixa de energia, sem repetir
   as 20 últimas; troca na próxima fronteira de frase (até 30 s) ou na hora.

Parâmetros em constantes exportadas (`INTERVALO_MINIMO_TROCA_MS`, `LIMITE_SINAL_PERDIDO_MS`,
`CONFIANCA_MINIMA`, `HORIZONTE_FRASE_MS`, `JANELA_SEM_REPETICAO`, `PADROES_CONTEXTO`).

## Evidência da F1

- Testes: `node --import tsx --test "packages/music-*/src/**/*.test.ts"` (parser, filtro, zonas,
  contexto, decisão com 3.000 entradas aleatórias, sessão de ponta a ponta com o `ConsentManager`
  real, adaptador, trilha, eventos, guarda de desenho).
- Latência medida em 22/11/2026 neste ambiente de desenvolvimento (Node 22, servidor, não celular):
  3.600 amostras e catálogo de 500 faixas, p50 0,044 ms, p95 0,084 ms, p99 0,267 ms por amostra.
  **Não é medida em aparelho**; a meta de p95 < 50 ms no celular fica para a F3.

## O que falta (fora da F1)

| Fase | Peça | Depende de |
|---|---|---|
| F0 | Parecer de patentes, termos, LGPD, AGPL × lojas, licença comercial e CLA | Advogado; dossiê em `docs/governance/music-engine-f0.md` |
| F2 | Servidor no Growth OS: preferências, consentimento, catálogo, agregados, RLS forçada | Aprovação; migration no casa-de-ia |
| F3 | App em `apps/musica` (Expo): sensor BLE, player de dois canais, consentimento, controles, offline, cliente do Growth OS. Ver `apps/musica/README.md` | Feito no código e testado no Node; falta build nativo e teste em aparelho, login, e o sensor real fica desligado até a F0 |
| F4 | Ferramentas prontas: `@obedient/music-ingest` (análise do WAV, rascunho, envio) e o cache conferido no app. Roteiro de encomenda e checklist contratual em `docs/governance/music-catalogo-f4.md` | Contratos de encomenda e as faixas; decidir onde os arquivos ficam |
| F5 | Piloto fechado: protocolo, condições para começar, triagem, rascunho de consentimento e métricas em `docs/governance/music-piloto-f5.md` (proposta) | **Bloqueado** pelas condições C1 a C10 do documento, a começar pela F0 |

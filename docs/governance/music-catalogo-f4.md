# Catálogo próprio — roteiro da F4 (D31)

**Estado:** 22/11/2026. Roteiro e ferramentas prontos; **nenhuma faixa real encomendada, licenciada nem
publicada**. Encomendar, negociar e assinar é com o responsável. O checklist da seção 3 não é parecer
jurídico: o modelo de contrato vem do advogado (F0, `music-engine-f0.md` §6).

## 1. Encomenda (briefing para produtor ou biblioteca)

| Item | Pedido |
|---|---|
| Quantidade inicial | 60 faixas (12 por faixa de energia de 0,2), para o piloto não repetir música em treino de 45 min |
| Duração | 2 min 30 s a 4 min |
| Estrutura | Seções claras a cada 8 ou 16 compassos, onde cortar ou fundir soa natural; sem fade longo no começo |
| Energia | Cobrir do calmo (aquecimento, volta à calma) ao intenso (tiro); a ingestão mede e mostra a cobertura |
| Gênero | Lista fechada combinada antes (`genero` em minúsculas, ex.: `eletronica`, `pop`, `rock`) |
| Conteúdo explícito | Marcado por faixa |
| Entrega técnica | **Mestre:** WAV 44,1 ou 48 kHz, 16 ou 24 bits (para a análise). **Distribuição:** AAC 256 kbps em `.m4a` (o que o app baixa) |
| Arquivo de manifesto | Uma linha por faixa, no formato da seção 2 |
| O que o produtor **não** entrega | BPM, "versões" da mesma música em andamentos diferentes, stems para remixagem (fora do desenho; ver F0 §2.2) |

## 2. Manifesto de entrega

`manifesto.json`, uma entrada por faixa (caminhos relativos ao próprio manifesto):

```json
[
  {
    "trackRef": "sprint-01",
    "titulo": "Sprint",
    "origem": "proprio",
    "genero": "eletronica",
    "explicita": false,
    "mestre": "mestres/sprint-01.wav",
    "distribuicao": { "arquivo": "distribuicao/sprint-01.m4a", "formato": "audio/mp4" },
    "licenca": {
      "instrumento": "contrato-encomenda-2026-001",
      "permiteComercial": true,
      "permiteCrossfade": true,
      "permiteCacheOffline": true,
      "evidencia": "pasta-interna/contratos/2026-001.pdf",
      "validaAte": null
    }
  }
]
```

## 3. Checklist contratual (para o advogado transformar em cláusula)

- [ ] Quem é titular de **cada camada**: composição (autor), interpretação (intérpretes, Lei 9.610 art. 90) e
      gravação (produtor fonográfico, art. 93). Licença ou cessão de todas.
- [ ] **Uso comercial em app** distribuído pela Casa de IA a organizações clientes e às pessoas delas
      (B2B2C), no território e pelo prazo combinados (`validaAte`).
- [ ] **Edição para corte e crossfade** em fronteira de frase, que pode ser "adaptação" (art. 29)
      (`permiteCrossfade`). Sem mudança de andamento, tom ou composição: o desenho não faz isso.
- [ ] **Cópia no aparelho para uso offline** (`permiteCacheOffline`) e por quanto tempo depois do fim da licença.
- [ ] Proibição, ou não, de usar as faixas para **treinar IA** (o projeto não treina; deixar explícito).
- [ ] **Exclusividade** ou não; crédito ao autor (onde aparece no app).
- [ ] **ECAD:** se a reprodução dentro do app é execução pública e quem recolhe (F0 §6, pergunta aberta).
- [ ] Garantia de originalidade (sem sample não liberado) e indenização.
- [ ] Onde fica a **evidência** (contrato assinado), referenciada em `evidencia`.

## 4. Ingestão (ferramenta pronta)

```bash
npm run musica:ingerir -- rascunho entrega/manifesto.json entrega/rascunho.json
# revisão humana: abrir rascunho.json, conferir energia e fronteiras ouvindo; para trocar a energia,
# pôr "energiaRevisada" no manifesto e gerar o rascunho de novo
GROWTH_OS_TOKEN=... npm run musica:ingerir -- enviar entrega/rascunho.json --growth-os https://<growth-os> --confirmo-publicar
```

O `rascunho`:
- lê só WAV;
- mede intensidade, ataques por segundo e brilho;
- calcula a energia com fórmula fixa (`packages/music-ingest/src/analise.ts`);
- acha as fronteiras de frase por mudança de seção;
- confere a licença;
- calcula o SHA-256 e o tamanho do arquivo de distribuição;
- mostra a cobertura por faixa de energia.

**Não** mede andamento nem BPM.

O `enviar`:
- só roda com `--confirmo-publicar`, token em variável de ambiente e https;
- recusa o arquivo inteiro se alguma faixa tiver problema;
- sobe cada arquivo de distribuição pelo endereço assinado que o Growth OS devolve, depois de conferir que
  ele é o mesmo do rascunho (SHA-256 e tamanho).

**Calibração pendente:** a fórmula de energia foi testada com áudio sintético (a ordem está certa). Com as
primeiras 10 faixas reais, comparar a energia medida com a percepção de quem revisa e ajustar os limites
de `analise.ts` num PR, com os números no texto do PR.

## 5. Distribuição para o aparelho

- O Growth OS guarda, por faixa, a chave do arquivo no armazenamento, o SHA-256, o tamanho e o formato
  (casa-de-ia, F2/F4).
- `GET /api/musica/arquivo?trackRef=` devolve um endereço temporário assinado.
- O app (`apps/musica/src/catalogo/arquivos.ts`):
  - baixa;
  - confere tamanho e SHA-256;
  - guarda só o que a licença deixa guardar;
  - apaga o que saiu do catálogo ou venceu;
  - toca o resto pelo endereço temporário.
- **Onde os arquivos ficam** (bucket privado do Supabase Storage do Growth OS, ou outro) é decisão do
  responsável; o Growth OS fala com ele por uma porta só (`src/musica/armazenamento.ts` lá).

## 6. Critério de saída da F4

1. Contrato-modelo aprovado pelo advogado.
2. As 60 faixas entregues.
3. O rascunho sem problemas, com a cobertura de cada faixa de energia ≥ 8.
4. A revisão ouvida.
5. A publicação no Growth OS de homologação.
6. O app baixando e tocando em aparelho de teste.

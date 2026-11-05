# Roadmap

| Fase | Entrega | Estado |
|---|---|---|
| 0 | Auditoria de PI, licenças e governança | **Concluída** (02/11/2026) |
| 1 | Constituição, governança e documentos de contribuição (minutas) | **Feito como minuta.** Falta a revisão do advogado e a assinatura do instrumento de licença |
| 2 | Repositório, CI com portões de licença, segredos, SBOM e CLA | **Feito.** Público por decisão D12 |
| 3 | DOTS adapter só leitura | **Feito** (com cliente MCP falso nos testes; falta ligar aos servidores reais) |
| 4 | Ethics Engine: grants, consentimento, aprovação, parada, auditoria | **Feito em memória** |
| 4a | Extração do Growth OS (D7): os cinco pacotes feitos e consumidos pelo Growth OS em produção (casa-de-ia#164 a #167); o laço do run com banco fica lá (D16) | **Concluída** (02/11/2026, `docs/architecture/extracao-growth-os.md`) |
| 4b | Persistência em Postgres com RLS, auditoria append-only, sessão autenticada | **Feito** (03/11/2026, `docs/architecture/persistencia.md`). A identidade (passkey) entrou na Fase 5 |
| 5 | App mobile-first (PWA, padrão offline do Ronda) | **Feito** (03/11/2026, `docs/architecture/app.md`): entrada por passkey, aprovar, recusar, parar, liberar, tirar autorização e trilha, com fila sem internet. O agente chega ao servidor pelo executor das missões (Fase 7) |
| 6 | Memória pessoal e motor de missões (Arts. 5º, 7º, 10 e 13) | **Feito** (03/11/2026, `docs/architecture/memoria-e-direitos.md` e `docs/architecture/missoes.md`). O executor das missões (modelo e ferramentas) entrou na Fase 7 |
| 7 | Integrações (calendário, e-mail, Drive) e o executor das missões | **Feito** (03/11/2026, `docs/architecture/integracoes.md` e `docs/architecture/executor.md`): conexões e ferramentas do Google pelo Ethics Engine; missões executadas pelo laço do agente com o modelo, com aprovação, teto de custo e agendador. Para usar de verdade: cliente OAuth do Google e chave da Anthropic (do dono do servidor) |
| 7b | Mobile Control Engine: o agente usando celular por autorização (decisão D17; iPhone fora por enquanto) | **Em andamento**: núcleo feito (`docs/architecture/mobile.md`); a seguir, o executor Android no Growth OS sobre o emulador isolado |
| 8 | Community: release 0.1 (o repositório já é público desde 02/11, decisão D12) | Bloqueada: instrumento assinado, marca pesquisada, CLA revisado, auditoria de segurança |
| 9 | Cloud | Bloqueada: preços e custos pesquisados |
| 10 | Enterprise e OEM | Bloqueada: contrato comercial revisado |

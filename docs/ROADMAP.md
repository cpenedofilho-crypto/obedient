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
| 5 | App mobile-first (PWA, padrão offline do Ronda) | **Feito** (03/11/2026, `docs/architecture/app.md`): entrada por passkey, aprovar, recusar, parar, liberar, tirar autorização e trilha, com fila sem internet. O agente ainda não chega ao servidor por API: isso entra com as integrações (Fase 7) |
| 6 | Memória pessoal e motor de missões (Arts. 5º, 7º, 10 e 13) | **Feito** (03/11/2026, `docs/architecture/memoria-e-direitos.md` e `docs/architecture/missoes.md`). O executor das missões (modelo e ferramentas) entra com as integrações (Fase 7) |
| 7 | Integrações (calendário, e-mail, Drive) | **Em andamento**: conexões com o Google feitas (`docs/architecture/integracoes.md`); faltam as ferramentas e o executor das missões |
| 8 | Community: release 0.1 (o repositório já é público desde 02/11, decisão D12) | Bloqueada: instrumento assinado, marca pesquisada, CLA revisado, auditoria de segurança |
| 9 | Cloud | Bloqueada: preços e custos pesquisados |
| 10 | Enterprise e OEM | Bloqueada: contrato comercial revisado |

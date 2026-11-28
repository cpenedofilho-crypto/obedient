# Licenças de dependência: allowlist e exceções

O script `scripts/check-licenses.mjs` lê o `package-lock.json` e reprova o CI quando a regra
abaixo não é cumprida.

| Grupo | Licenças | Regra |
|---|---|---|
| Permitidas | MIT, ISC, Apache-2.0, BSD-2-Clause, BSD-3-Clause, 0BSD, Unlicense, CC0-1.0, BlueOak-1.0.0, Zlib, MIT-0, Python-2.0, CC-BY-4.0 (dados), OFL-1.1 (fontes) | Entram sem revisão |
| Com revisão | LGPL-*, MPL-2.0 | Entram com uma linha nesta tabela: pacote, motivo, obrigação |
| Bloqueadas | GPL-*, AGPL-* de terceiros, SSPL, BUSL, FSL, Elastic, Remotion, "SEE LICENSE IN", UNKNOWN | Só com decisão escrita do fundador |

Expressões `A OR B` passam se pelo menos um lado for permitido; nesse caso, registrar a escolha no
`NOTICE`. Expressões `A AND B` precisam de todos os lados permitidos.

## Exceções registradas

| Pacote | Licença | Motivo | Obrigação | Decisão |
|---|---|---|---|---|
| `axe-core` (só desenvolvimento) | MPL-2.0 | Verificação automática de acessibilidade nos testes de ponta a ponta do app (`e2e/`) | Nenhuma enquanto não for distribuído: é carregado só pelo teste, no navegador do teste, e não entra no app, no servidor nem na SBOM de produção (`npm sbom --omit dev`). Se um dia for distribuído, o código do axe modificado fica disponível sob MPL-2.0 | Registrado em 03/11/2026, Fase 5 |
| `lightningcss` e binários `lightningcss-*` (ferramenta de build) | MPL-2.0 | Dependência do Metro/Expo para CSS no build do app `apps/musica` (D31, F3). O npm a instala como produção por ser dependência do `expo` | Nenhuma enquanto não for modificado nem distribuído: roda só na máquina que compila e não entra no pacote do app (JS do Metro nem binário nativo). Se um dia for modificado e distribuído, o arquivo modificado fica disponível sob MPL-2.0 | Registrado em 22/11/2026, F3 da música (D31) |

# Como contribuir

Obrigado.

> **Por enquanto não fazemos merge de contribuição externa.** O CLA ainda é minuta e está em
> revisão jurídica. Issues e discussões são bem-vindas desde já; PRs ficam abertos até o CLA 1.0.

Antes do primeiro PR:

1. **Assine o CLA** (`CLA.md`). O bot pede no próprio PR. Sem CLA, o PR não entra, porque o
   licenciamento duplo depende dele.
2. Leia a **Constituição** (`CONSTITUTION.md`). Mudança em regra verificável vem com teste novo
   em `tests/constitution/`.

## O que não entra, nunca

- Dado pessoal de qualquer pessoa: telefone, CPF, nome real em fixture, print de conversa.
- Arquivo de cliente: CSV, planilha, PDF. O `.gitignore` bloqueia por extensão, e a regra vale
  mesmo para o que passar pelo filtro.
- Segredo, token ou chave. O CI faz varredura.
- Dependência com licença fora da allowlist (`docs/licensing/excecoes.md`). O CI reprova.
- Código copiado de outro projeto sem a origem e a licença indicadas no PR.

## Uso de IA

É permitido. Declare no PR (checkbox) e no commit (`Assisted-by: <ferramenta>`). Você revisou e
responde pelo que enviou. Detalhes em `docs/licensing/ai-contributions.md`.

## Fluxo

```bash
npm install
npm run check        # typecheck + testes + suíte constitucional + licenças
```

- Uma mudança por PR.
- Commit em português ou inglês, no imperativo, dizendo o porquê.
- **Nomeie os arquivos no `git add`.** Nunca use `git add -A`.
- Áreas críticas (`policy-engine`, `ethics-engine`, `tests/constitution`, autenticação) precisam
  de duas revisões.

## Segurança

Não abra issue pública para vulnerabilidade. Ver `SECURITY.md`.

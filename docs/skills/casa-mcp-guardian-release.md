# casa-mcp-guardian: roteiro da release open source (Caminho A)

**Situação: proposta. Nenhuma release, tag ou publicação foi feita.** Este roteiro diz o que falta
para a primeira versão de instalação local (sem marketplace). A decisão de soltar a release é do
responsável, depois das aprovações da seção 1.

Base técnica: PR #50 (branch `claude/obedient-audit-governance-i8rz7e`). Resultados dos testes e
limites em `docs/skills/casa-mcp-guardian.md`.

## 1. Aprovações que vêm antes (nenhuma aprovada aqui)

- [ ] Autorização de quem publica diante da D15 (instrumento de licença ainda não assinado).
- [ ] Revisão jurídica da distribuição sob AGPL-3.0-only.
- [ ] **Texto da `LICENSE` da skill aprovado.** Conferido em 17/11/2026 contra o oficial da GNU
      (`https://ftp.gnu.org/gnu/Licenses/agpl-3.0.txt`, 30/09/2017, sha256 `0d96a4ff…abcb0`): o arquivo
      atual (sha256 `57c8ff33…399d6`) é a variante antiga com `http`, e difere em 3 linhas, só no
      esquema das URLs. Recomendação: adotar o texto oficial com `https`. Trocar só depois da aprovação
      jurídica, junto com o sha256 do teste (`tests/skill.test.mjs`) e os registros
      (`docs/skills/casa-mcp-guardian.md` §5.8, `PROVENANCE.md`).
- [ ] `LICENSE` da raiz: mesma variante `http`. Análise separada, porque vale para o repositório inteiro.
- [ ] Revisão humana do `SKILL.md` (regras 1 a 9, instrução de parada, limites).
- [ ] Nome: manter `casa-mcp-guardian` ou adotar o candidato "Casa de IA Quayguard", depois da busca na
      WIPO Global Brand Database, INPI, USPTO e EUIPO. Trocar o nome muda a pasta, o `name` do
      frontmatter e os testes: fazer **antes** da primeira tag.
- [ ] Merge do PR #50 na `main` (a release sai de um commit da `main`).
- [x] Proposta T4, itens 1 a 4: aplicada nos commits `37737e4` e `ec2bdbe` (`docs/skills/casa-mcp-guardian.md` §8).
- [ ] Texto sobre o Cursor: manter "estrutural; funcional não verificado" ou rodar o teste manual.
- [ ] Texto sobre o Claude Code: hoje diz que o carregamento segue o formato Agent Skills e **não foi
      testado** nesta versão; rodar um teste real ou manter assim.
- [ ] Revisão do PR por um mantenedor (`GOVERNANCE.md` §4); SBOM e assinatura (§5), com o método
      recomendado Sigstore/Cosign ainda por aprovar.

## 2. Versão e tag

- **Versão:** `0.1.0` (SemVer, `GOVERNANCE.md` §5). `0.x` deixa claro que a interface pode mudar.
- **Onde a versão aparece:** proposta de acrescentar `metadata: { version: "0.1.0" }`? O padrão Agent
  Skills aceita `metadata`, mas o teste do frontmatter só lê o subconjunto `chave: valor` de uma linha;
  a alternativa simples é `version` só no `CHANGELOG.md` e no nome do zip. **Decidir antes da tag.**
- **Tag:** `casa-mcp-guardian-v0.1.0` (prefixo pela skill, porque o repositório é um monorepo e o
  OBEDIENT terá as próprias versões).

## 3. CHANGELOG

Criado em `skills/casa-mcp-guardian/CHANGELOG.md` (17/11/2026), com `0.1.0 (unreleased)`. Os README
citam a mesma versão (`tests/skills/casa-mcp-guardian-release.test.ts` confere). Texto de partida:

```markdown
# Changelog

## 0.1.0 (unreleased)

First public version. Read-only, offline audit of MCP configs and saved `tools/list` listings.

- Checks: plaintext, cloud-metadata and private endpoints; credentials in URLs, query strings,
  env, headers and arguments (reported by key path only); unpinned `npx`/`uvx`/`pnpm dlx`/`pipx run`
  packages and container images; `sh -c` wrappers and `curl | sh`; auto-approval settings.
- Tools: risk and category from names and boolean annotations; prompt-injection signs and hidden
  characters in tool and parameter descriptions; duplicate names; SHA-256 pins for silent changes.
- Never reads personal or global configs implicitly: the home folder is refused as a root, and
  default paths that leave the project through a symlink are skipped.
- Reports in Markdown or JSON, English or Portuguese. Exit codes 0, 1 and 2.
- Requires Node.js 22 or newer (tested on 22 and 24). No dependencies.
- Agent Skills format; structurally compatible with Claude Code and Cursor 2.4+ (Cursor behavior
  not verified).
```

## 4. Nota da release (rascunho, em inglês)

> **casa-mcp-guardian 0.1.0**: audit MCP servers before you trust them.
>
> An Agent Skill and a standalone Node.js script that read your MCP configuration and saved tool
> listings and point out what needs a human decision: credentials written in config, unpinned
> packages, auto-approval, metadata and plaintext endpoints, prompt-injection signs and silent tool
> changes. It never connects to a server, never writes a file and never prints a credential.
>
> Install: copy the `casa-mcp-guardian/` folder from the zip to `.claude/skills/` (Claude Code) or
> `.cursor/skills/` (Cursor 2.4+, structural compatibility only). Requires Node.js 22+.
>
> Limits: static analysis (no DNS rebinding detection), risk from names and annotations, heuristic
> injection signals. A clean report is not a guarantee.
>
> License: AGPL-3.0-only. Verify the download with the SHA-256 published below.

## 5. Pacote reproduzível

Conteúdo: `SKILL.md`, `README.md`, `README.pt-BR.md`, `LICENSE`, `NOTICE`, `CHANGELOG.md`,
`references/`, `scripts/` (16 arquivos desde o T8.2). `tests/` fica no repositório. Zip com a pasta `casa-mcp-guardian/` na
raiz, entradas em ordem alfabética, data fixa e permissão 644; o mesmo commit gera os mesmos bytes.
Receita usada na preparação (Python 3, só biblioteca padrão), rodada de dentro da pasta da skill:

```python
import os, zipfile, hashlib
inc = ["SKILL.md", "README.md", "README.pt-BR.md", "LICENSE", "NOTICE", "CHANGELOG.md"]
for d in ["scripts", "references"]:
    for r, _, fs in os.walk(d):
        inc += [os.path.join(r, f) for f in fs]
with zipfile.ZipFile("casa-mcp-guardian-0.1.0.zip", "w", zipfile.ZIP_DEFLATED) as zf:
    for f in sorted(inc):
        zi = zipfile.ZipInfo("casa-mcp-guardian/" + f, (2026, 11, 17, 0, 0, 0))
        zi.external_attr = 0o644 << 16
        zi.compress_type = zipfile.ZIP_DEFLATED
        zf.writestr(zi, open(f, "rb").read())
print(hashlib.sha256(open("casa-mcp-guardian-0.1.0.zip", "rb").read()).hexdigest())
```

Na release: trocar a data fixa pela data da tag, publicar o sha256 na nota e num arquivo
`casa-mcp-guardian-0.1.0.zip.sha256`.

## 6. Portões antes de anexar o zip

- [ ] CI verde no commit da tag (check, e2e, postgres, secrets, smoke, cla).
- [ ] Testes da skill com a pasta copiada **fora do monorepo**, no Node 22 e no 24.
- [ ] Zip gerado duas vezes a partir do commit da tag, com o mesmo sha256.
- [ ] gitleaks sobre o zip extraído; nenhum nome de cliente, produto ou pessoa; nenhum formato de
      credencial, e-mail, telefone ou CPF.
- [ ] Execução do zip extraído: da pasta pessoal sai com código 2; num projeto com credencial falsa
      aponta `LITERAL_SECRET` sem nenhum trecho dela na saída.
- [ ] Assinatura e SBOM (`GOVERNANCE.md` §5). SBOM SPDX 2.3 e CycloneDX 1.5 do candidato preparadas e
      validadas em `docs/skills/sbom/` (17/11/2026, commit `26ad14f`); precisam ser geradas de novo no
      commit da tag se algum arquivo do pacote ou a data do zip mudar. **O método de assinatura (GPG ou
      Sigstore) não foi decidido**, e nada foi assinado.

## 7. O que este roteiro não faz

Não cria tag, release, pacote em registro (npm) nem listagem em marketplace. Não muda licença. Não
trata da Agensi (Caminho B), que depende de resposta escrita da plataforma.

# SBOM do casa-mcp-guardian 0.1.0 (candidato)

**Situação: candidato. Nenhuma release, tag, assinatura ou publicação foi feita.** Estes arquivos
descrevem o pacote que a receita de `docs/skills/casa-mcp-guardian-release.md` §5 gera a partir do
commit `d75f09e5d1ab56182acd04d6cf6b5056fc363d28` (T12, depois da revisão independente). Substituem as geradas em `26ad14f`.

| Arquivo | Formato | Validação (18/11/2026) |
|---|---|---|
| `casa-mcp-guardian-0.1.0.spdx.json` | SPDX 2.3, JSON | `pyspdxtools -i` (spdx-tools 0.8.5): sem erro |
| `casa-mcp-guardian-0.1.0.cdx.json` | CycloneDX 1.5, JSON | `JsonStrictValidator` 1.5 (cyclonedx-python-lib 11.12.0): sem erro |

- **Pacote:** `casa-mcp-guardian-0.1.0.zip`, 16 arquivos, sha256
  `9cdfba99f8d0c674ff3927916f4d2cac5ec42788b14daf2acfb6f5ab898e0cc4` (gerado duas vezes, mesmos bytes).
  Cada arquivo tem SHA-1 e SHA-256 nas duas SBOM, conferidos contra o zip extraído.
- **Licença declarada:** AGPL-3.0-only. **Licença concluída:** `NOASSERTION`, porque a revisão jurídica
  está pendente (inclusive a escolha do texto da `LICENSE`, variante `http` ou `https`).
- **Dependências:** nenhuma. Só módulos internos do Node.js; Node.js 22+ é requisito de execução, não
  vai no pacote.
- **Local de download:** `NOASSERTION` (não há release).

Se qualquer arquivo do pacote mudar (inclusive a troca da `LICENSE` ou do nome), as duas SBOM e o
sha256 precisam ser gerados de novo a partir do commit da tag. A data fixa do zip também muda para a
data da tag (§5 do roteiro), e com ela o sha256 do zip.

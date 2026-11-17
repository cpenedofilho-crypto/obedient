# SBOM do casa-mcp-guardian 0.1.0 (candidato)

**Situação: candidato. Nenhuma release, tag, assinatura ou publicação foi feita.** Estes arquivos
descrevem o pacote que a receita de `docs/skills/casa-mcp-guardian-release.md` §5 gera a partir do
commit `26ad14f3f22db9abde074eaddd9c490b54935c51`.

| Arquivo | Formato | Validação (17/11/2026) |
|---|---|---|
| `casa-mcp-guardian-0.1.0.spdx.json` | SPDX 2.3, JSON | `pyspdxtools -i` (spdx-tools 0.8.5): sem erro |
| `casa-mcp-guardian-0.1.0.cdx.json` | CycloneDX 1.5, JSON | `JsonStrictValidator` 1.5 (cyclonedx-python-lib 11.12.0): sem erro |

- **Pacote:** `casa-mcp-guardian-0.1.0.zip`, 16 arquivos, sha256
  `8464d96d506d03a2bfde9ae7dac5b2d2bcf41ffbac25349dda4c4b7e3e44be5e` (gerado duas vezes, mesmos bytes).
  Cada arquivo tem SHA-1 e SHA-256 nas duas SBOM, conferidos contra o zip extraído.
- **Licença declarada:** AGPL-3.0-only. **Licença concluída:** `NOASSERTION`, porque a revisão jurídica
  está pendente (inclusive a escolha do texto da `LICENSE`, variante `http` ou `https`).
- **Dependências:** nenhuma. Só módulos internos do Node.js; Node.js 22+ é requisito de execução, não
  vai no pacote.
- **Local de download:** `NOASSERTION` (não há release).

Se qualquer arquivo do pacote mudar (inclusive a troca da `LICENSE` ou do nome), as duas SBOM e o
sha256 precisam ser gerados de novo a partir do commit da tag. A data fixa do zip também muda para a
data da tag (§5 do roteiro), e com ela o sha256 do zip.

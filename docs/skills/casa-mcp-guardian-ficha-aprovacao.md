# casa-mcp-guardian 0.1.0: ficha de aprovação dos portões

**Ficha em branco. Nenhum campo foi preenchido pelo agente, e nada aqui está aprovado.** Quem decide
preenche cada campo, com data e evidência. Esta ficha não autoriza publicação; a publicação só muda
de NO-GO pela seção 7, depois de as seções 1 a 6 estarem completas.

Base: parecer de governança T13 (`docs/skills/casa-mcp-guardian-parecer-t13.md`).

## 0. Artefato a que a ficha se refere

| Campo | Valor |
|---|---|
| Commit do pacote | `d75f09e5d1ab56182acd04d6cf6b5056fc363d28` |
| SHA-256 do zip (16 arquivos) | `9cdfba99f8d0c674ff3927916f4d2cac5ec42788b14daf2acfb6f5ab898e0cc4` |
| SBOM | `docs/skills/sbom/` (SPDX 2.3 e CycloneDX 1.5), geradas a partir do commit acima |

**Se o pacote mudar** (seção 5), anote aqui o novo commit e o novo SHA-256 e refaça os itens marcados
com ⟳: eles valem para um artefato específico.

| Novo commit | Novo SHA-256 | Data | Motivo |
|---|---|---|---|
| | | | |

**Como preencher a coluna "Decisão":** use **Aprovado**, **Aprovado com ressalva** (escreva a ressalva
em "Observação"), **Recusado** ou **Não se aplica** (justifique). Campo vazio = pendente.

## 1. Evidências técnicas (seção 2 do parecer T13)

Já estão verificadas pelo processo de auditoria. Aqui fica só o aceite de quem responde por elas.

| Item | Decisão | Responsável | Data | Observação |
|---|---|---|---|---|
| ⟳ Testes e regressões (179/179, Node 22 e 24) | | | | |
| Correções T7 a T12, com regressão e mutação | | | | |
| ⟳ Critério "nenhum segredo sintético nas saídas protegidas" | | | | |
| Recusa de fixação a partir de inventário incompleto | | | | |
| ⟳ Integridade do pacote (zip reproduzível, SBOM validadas) | | | | |
| ⟳ Segredos (gitleaks) e ausência de dependências | | | | |
| ⟳ CI verde no commit do pacote | | | | |

## 2. Governança

| Item | Decisão | Responsável | Data | Evidência (documento, link ou local) | Observação |
|---|---|---|---|---|---|
| D15: instrumento de licença exclusiva assinado | | | | | |
| Revisão humana das regras 1 a 9 do `SKILL.md` | | | | | |
| Limite de privacidade dos hashes aceito (o id identifica, não anonimiza) | | | | | |
| Revisão do PR #50 por um mantenedor (`GOVERNANCE.md` §4) | | | | | |

**Riscos residuais.** Cada um precisa de uma decisão explícita.

| Risco | Decisão (aceito / corrigir antes / documentar melhor) | Responsável | Data |
|---|---|---|---|
| R2: nomes que diferem só por caractere invisível, caixa ou espaço no fim | | | |
| G1: nome só de espaço ou de caractere invisível ainda é fixado | | | |
| G2: rótulo `TOOL_NO_OBJECT_SCHEMA` a mais em entrada sem nome | | | |
| Cursor fora do lugar da especificação não é procurado | | | |
| Chave duplicada no JSON: vale a última | | | |
| Mascaramento do modo padrão é heurística | | | |
| `--fail-on critical` deixa duplicatas passarem | | | |
| Id de fixação reversível por tentativa | | | |
| Flags de gerenciador de pacotes não interpretadas (flag booleana desconhecida, flags curtas combinadas, `uvx -n`, `--package` repetido) | | | |

## 3. Jurídico

| Item | Decisão | Responsável | Data | Evidência (parecer, e-mail, documento) | Observação |
|---|---|---|---|---|---|
| Distribuição sob AGPL-3.0-only | | | | | |
| Texto da `LICENSE`: manter o atual (`http`) ou trocar pelo oficial da GNU (`https`) | | | | | |
| `LICENSE` da raiz do repositório (análise separada) | | | | | |
| Licença concluída na SBOM (hoje `NOASSERTION`): valor a declarar depois do parecer | | | | | |
| Condições da Agensi: resposta escrita recebida e lida | | | | | |
| Condições da Agensi: compatíveis com a AGPL-3.0-only | | | | | |

## 4. Compatibilidade

Pelo roteiro em `docs/skills/teste-funcional/`. Anexe a ficha de registro do roteiro (seção 4 dele),
sem a transcrição.

| Item | Decisão | Responsável | Data | Versão do cliente e modelo | Verificador (saída 0/1) | Observação |
|---|---|---|---|---|---|---|
| ⟳ Teste funcional no Claude Code | | | | | | |
| ⟳ Teste funcional no Cursor | | | | | | |
| Texto do README e do `SKILL.md` sobre compatibilidade (manter "só estrutural" ou atualizar) | | | | — | — | |

## 5. Decisões que mudam o pacote

Cada "sim" nesta seção muda os bytes do pacote. Decida as três **antes** do teste funcional e da
assinatura; depois de qualquer "sim", gere de novo o zip, o SHA-256 e as SBOM, anote o novo artefato na
seção 0 e refaça os itens ⟳.

| Decisão | Escolha | Muda o pacote? | Responsável | Data |
|---|---|---|---|---|
| Texto da `LICENSE` (seção 3) | | sim, se trocar | | |
| Nome: manter `casa-mcp-guardian` ou adotar outro (depois da busca de marca) | | sim, se mudar | | |
| Versão: só no `CHANGELOG` e no nome do zip, ou também no frontmatter | | sim, se no frontmatter | | |
| Texto de compatibilidade (seção 4) | | sim, se atualizar | | |

## 6. Distribuição

| Item | Decisão | Responsável | Data | Observação |
|---|---|---|---|---|
| Método de assinatura (Sigstore/Cosign, GPG ou outro) | | | | |
| Quem assina e onde fica a chave ou identidade | | | | |
| Canal: GitHub release, Agensi ou ambos | | | | |
| Tag (proposta: `casa-mcp-guardian-v0.1.0`) | | | | |
| Data fixa do zip trocada pela data da tag, com SHA-256 novo publicado | | | | |
| ⟳ Assinatura feita sobre o SHA-256 final (seção 0) | | | | |

## 7. Decisão de GO/NO-GO

Antes de decidir, confira:

- [ ] as seções 1 a 6 estão preenchidas, sem campo vazio;
- [ ] nenhum item está **Recusado** sem decisão escrita sobre ele;
- [ ] o artefato da seção 0 é o mesmo dos itens ⟳ (mesmo commit e mesmo SHA-256);
- [ ] o CI está verde no commit da tag;
- [ ] o PR #50 foi revisado e o merge na `main`, se for o caminho, foi decidido à parte.

| Campo | Valor |
|---|---|
| Decisão | GO / NO-GO |
| Artefato (commit e SHA-256) | |
| Canal | |
| Condições ou ressalvas | |
| Responsável | |
| Data | |
| Assinatura | |

---

Registro de alterações desta ficha (quem mudou o quê e quando):

| Data | Quem | O que mudou |
|---|---|---|
| | | |

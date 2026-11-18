# casa-mcp-guardian 0.1.0: parecer de governança T13

**Situação: publicação NO-GO.** Este parecer separa o que tem evidência técnica do que depende de uma
pessoa. Ele não aprova nenhum portão, não autoriza publicação e não altera o pacote. Registrado em
18/11/2026 por decisão do responsável, que aceitou a conclusão de que a fase técnica tem evidências
suficientes para avançar à governança. **Esse aceite não é autorização de publicação.**

## 1. Referência técnica

| Item | Valor |
|---|---|
| Pacote auditado | commit `d75f09e5d1ab56182acd04d6cf6b5056fc363d28` |
| Documentação e SBOM | commit `25aac4a841ea44299d52e0ce2442a99f57585636` (só documentação; nenhum arquivo do pacote muda entre os dois) |
| Arquivo | `casa-mcp-guardian-0.1.0.zip`, 16 arquivos, receita reproduzível de `casa-mcp-guardian-release.md` §5 |
| SHA-256 do zip | `9cdfba99f8d0c674ff3927916f4d2cac5ec42788b14daf2acfb6f5ab898e0cc4` |
| SBOM | `docs/skills/sbom/` (SPDX 2.3 e CycloneDX 1.5) |

Conferido em 18/11/2026, somente leitura: o zip gerado de novo a partir do `d75f09e` (via `git archive`)
tem os mesmos 16 arquivos e o mesmo SHA-256, e o `25aac4a` é o HEAD local e remoto da branch do PR #50.

**Esse hash vale só para esses 16 arquivos.** Qualquer mudança neles exige gerar de novo o zip, o
SHA-256 e as duas SBOM e repetir a verificação da seção 2.

## 2. Evidências verificadas pelo processo de auditoria

Cada item tem evidência reproduzível, registrada em `casa-mcp-guardian.md` e no PR #50. O aceite de
cada um é registro do responsável; este documento não o marca.

| Item | Evidência |
|---|---|
| Testes e regressões | 179/179 no Node 22.23.4 e no 24.22.1, com a pasta copiada fora do monorepo; `npm run check` sem falhas (659 testes, 1 pulado de antes) |
| Correções T7 a T12 | cada uma com teste de regressão e mutação que reprova; no T12, os testes foram escritos antes da correção e sete mutações reprovam |
| Critério "nenhum segredo sintético nas saídas protegidas dos cenários cobertos" | testes de não vazamento; 960 execuções de fuzz no modo protegido sem vazamento (terceira revisão); cursor de paginação nunca impresso (revisão do T12) |
| Fixação a partir de inventário incompleto | `TOOLS_LISTING_INCOMPLETE` e `TOOL_ENTRY_INVALID` fazem o `--emit-pins` recusar (saída 2), inclusive com páginas em `--tools` separados e lote JSON-RPC; confirmado pela revisão independente do T12 e pela conferência da correção do F1 |
| Robustez | 16 mil entradas malformadas sem queda (terceira revisão); erro inesperado vira mensagem fixa e saída 2 |
| Integridade do pacote | zip gerado duas vezes com os mesmos bytes; SPDX validada por `pyspdxtools` 0.8.5; CycloneDX pelo validador estrito 1.5; hashes por arquivo conferidos contra o zip extraído |
| Execução do zip extraído | com credencial falsa, `LITERAL_SECRET` sem nenhum trecho dela; listagem paginada com `--emit-pins` sai com 2; a partir da pasta pessoal sai com 2 |
| Segredos e dependências | gitleaks 8.24.3 sem achados na skill, no zip extraído e em `docs/skills`; nenhum componente de terceiros, só módulos internos do Node.js |
| CI | 6/6 verdes no `25aac4a` (check, e2e, postgres, secrets, smoke, cla) |

## 3. Exige validação humana, sem assinatura (nenhum aprovado aqui)

| Item | O que a pessoa decide |
|---|---|
| Regras 1 a 9 do `SKILL.md` | se o comportamento instruído ao agente é aceitável. A regra é instrução ao modelo; o script não sabe quem o chama |
| Limite de privacidade dos hashes | aceitar que o id de fixação (SHA-256 truncado em 128 bits, com separação de domínio) identifica e não anonimiza: um nome previsível pode ser descoberto por tentativa |
| Riscos residuais | aceitar ou não: R2 (nomes que diferem só por caractere invisível, caixa ou espaço no fim); G1 (nome só de espaço ou de caractere invisível ainda é fixado); G2 (rótulo `TOOL_NO_OBJECT_SCHEMA` a mais em entrada sem nome); cursor fora do lugar da especificação não procurado; chave duplicada no JSON vale a última; heurística do modo padrão; `--fail-on critical` deixa duplicatas passarem; id reversível por tentativa |
| Testes funcionais | Claude Code e Cursor reais. Hoje a compatibilidade é só estrutural; o teste no Cursor precisa de uma máquina com o Cursor |
| Revisão de mantenedor | `GOVERNANCE.md` §4 |
| Nome e canal | manter `casa-mcp-guardian` ou outro nome, depois da busca de marca; GitHub e/ou Agensi |

## 4. Exige assinatura ou parecer formal (nenhum aprovado aqui)

| Item | Por quê |
|---|---|
| D15 | o instrumento de licença exclusiva está "a ser redigido pelo advogado" (`docs/governance/decisoes.md`) |
| Revisão jurídica da AGPL-3.0-only e do texto da `LICENSE` | a SBOM declara licença concluída `NOASSERTION` até essa revisão; a revisão fica para depois, por decisão do responsável |
| Condições da Agensi | dependem de resposta escrita da plataforma; os termos não foram lidos na fonte |
| Método de assinatura do artefato | decisão de quem responde pela release (Sigstore/Cosign recomendado, ou GPG) |
| Decisão final de GO/NO-GO | só depois das seções 2, 3 e 4 registradas |

## 5. Ordem e o que invalida o hash

Três decisões **mudam os bytes do pacote** e invalidam o SHA-256 da seção 1:

- trocar a `LICENSE` pelo texto oficial da GNU com `https` (`casa-mcp-guardian-release.md` §1);
- mudar o nome (pasta, `name` do frontmatter, testes);
- pôr a versão no frontmatter (`casa-mcp-guardian-release.md` §2).

Elas precisam ser decididas **antes** do congelamento final e da assinatura. Depois de qualquer uma,
o zip, o SHA-256 e as SBOM são gerados de novo, e a verificação da seção 2 é repetida. Se nenhuma
mudar, o `d75f09e` e o `9cdfba99f8d0c674ff3927916f4d2cac5ec42788b14daf2acfb6f5ab898e0cc4` continuam
sendo a referência. A data fixa do zip também muda para a data da tag (§5 do roteiro), e com ela o
SHA-256.

Sem nova frente de desenvolvimento até a decisão de GO/NO-GO, salvo vulnerabilidade relevante.

## 6. O que este parecer não faz

Não aprova portão, não faz merge, tag, release, assinatura, deploy nem publicação, não muda licença e
não trata dos termos da Agensi.

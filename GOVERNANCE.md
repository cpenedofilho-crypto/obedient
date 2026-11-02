# Governança do OBEDIENT

**MINUTA, NÃO REVISADA JURIDICAMENTE.**

## 1. Quem é quem

| Papel | Quem | Fonte do poder |
|---|---|---|
| **Autor e licenciante** | Cláudio Penedo (pessoa física) | Titular dos direitos patrimoniais de autor sobre o código que escreveu (Lei 9.610/98) |
| **Titular do projeto oficial e licenciadora** | Casa de IA Educação e Consultoria Ltda, CNPJ 69.761.208/0001-20 | Licença exclusiva concedida pelo autor (decisão D15, opção A) |
| **Fundador e decisor final** | Cláudio Penedo | Cláusula contratual do instrumento de licença: reconhece o fundador como decisor final do projeto oficial, independentemente da estrutura societária |
| **Mantenedores** | Nomeados pelo fundador | Este documento |
| **Contribuidores** | Qualquer pessoa com CLA assinado | `CLA.md` |

## 2. Separação que não se negocia

O fundador controla o **repositório oficial**, a **marca**, o **serviço Cloud** e a
**Constituição oficial**. Quem recebeu uma cópia sob a AGPL-3.0 tem todos os direitos da AGPL-3.0,
e nenhuma decisão de governança os reduz. Contratos comerciais vigentes também não são afetados
por decisões posteriores.

## 3. Decisões

- **Fundador (BDFL do projeto oficial):** roadmap, releases, emendas à Constituição, uso da marca,
  aceitação de mantenedores. Um veto do fundador vem com justificativa escrita e pública.
- **Mantenedores:** revisão e merge dentro das áreas atribuídas.
- **Comunidade:** propõe por issue ou RFC; comenta nas RFCs de emenda.

## 4. Aceitar contribuição

1. CLA assinado (bot no PR).
2. CI verde: typecheck, testes, suíte constitucional, allowlist de licenças e varredura de segredos.
3. Revisão de 1 mantenedor. Exigem **2**: `packages/policy-engine`, `packages/ethics-engine`,
   `tests/constitution` e qualquer coisa de autenticação.
4. Nenhum dado pessoal, nenhum arquivo de cliente, nenhum binário sem proveniência.
5. Mudança em política ou em regra verificável sempre traz teste novo na suíte constitucional.

## 5. Releases

- SemVer.
- Release assinada.
- SBOM CycloneDX e SPDX anexadas.
- Changelog.
- A versão da Constituição aplicada vai embutida (`CONSTITUTION_VERSION`).

## 6. Segurança

Ver `SECURITY.md`. As vulnerabilidades são tratadas em privado e divulgadas de forma
coordenada.

## 7. Emendas à Constituição

1. RFC pública.
2. Comentário por 30 dias (proposta).
3. Decisão escrita do fundador.
4. Nova versão, com registro em `docs/governance/constitution-log.md`.

Emenda que **reduz** proteção também exige aviso prévio público e consentimento renovado no
serviço Cloud.

## 8. Marca e forks

Forks são livres pela AGPL. O nome e o logo seguem o `TRADEMARKS.md`.

## 9. Conflitos

- Técnicos: mantenedores, e depois o fundador.
- De conduta: responsáveis pelo Código de Conduta (`CODE_OF_CONDUCT.md`).

## 10. Evolução

Quando houver mantenedores externos ativos em número suficiente, o fundador avalia criar um
conselho técnico consultivo. Transferir a marca para uma fundação é decisão futura e exclusiva do
fundador.

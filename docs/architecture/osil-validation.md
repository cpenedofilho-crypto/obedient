# OSIL — validação e limites de liberação

## Evidência observada
CI 205, commit 221bd007cf96fac82ee6725941d80505bae8c4f8:
https://github.com/cpenedofilho-crypto/obedient/actions/runs/45735885216

Seed 42, 10.000 cenários compartilhados:
| Estratégia | Sucessos | Tentativas |
|---|---:|---:|
| single-attempt | 1963 | 10000 |
| bounded-retry | 4492 | 19088 |

20 testes OSIL aprovados; suíte geral 651 aprovados, zero falhas, um ignorado.
O modelo favorece retentativas por construção. Não representa eficácia real.
Equidade e utilização não medidas; pontuação não utilizável.

## Modelo de ameaças e limites
- Adulteração: reprodução e SHA-256 detectam divergência, mas não autenticam autoria.
- Escalada: gateway somente leitura, não concede grants nem executa missões.
- Contaminação da memória: nenhuma persistência ou transferência automática.
- Consumo: contagem limitada a 10.000 por execução; chamadas repetidas ainda precisam de limites operacionais.
- Dados pessoais: laboratório usa parâmetros sintéticos; não expor entrada arbitrária via servidor.
- Isolamento: funções offline, não sandbox para código arbitrário.
- Ameaças residuais: entradas não confiáveis, saturação, viés do modelo, proveniência de versão, validação externa.

## Gates
- CI verde no HEAD e revisão independente.
- Confirmar 26 testes OSIL e regressões.
- Corrigir representação de métricas ausentes antes de usar pontuação.
- Nenhuma integração com memória pessoal, permissões ou missões sem desenho e testes próprios.
- Sem merge, migration ou deploy sem autorização específica conforme AGENTS.md.
- PR 69 permanece draft. NO-GO operacional.

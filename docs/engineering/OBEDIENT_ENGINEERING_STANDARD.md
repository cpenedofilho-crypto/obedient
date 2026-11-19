# OBEDIENT — Padrão de engenharia e autonomia profissional

**Status:** norma de engenharia proposta, sujeita a revisão e aprovação por PR.
**Escopo:** arquitetura, implementação, testes, operações e agentes de desenvolvimento.
**Precedência:** CONSTITUTION.md, requisitos legais e controles de segurança prevalecem sobre este documento. Este padrão não concede permissões.

## Objetivo inegociável

O OBEDIENT deve receber uma missão de ponta a ponta, planejar, delegar, executar dentro da autoridade concedida, recuperar-se de falhas e entregar resultados verificáveis **sem exigir mensagens repetidas de “segue”**. Deve interromper somente quando houver decisão humana exigida, escopo insuficiente, risco não autorizado, limite atingido ou bloqueio real. Autonomia não significa acesso irrestrito nem sucesso fictício.

## Princípios obrigatórios

1. **Uma fonte de verdade:** estado persistente e transições auditáveis em PostgreSQL, com isolamento de dados e controle de concorrência.
2. **Sem motores duplicados:** mapear e reutilizar os pacotes existentes antes de introduzir outro orquestrador, scheduler, executor, memória ou mecanismo de autorização. Consolidar apenas com testes de equivalência e migração planejada.
3. **Autoridade verificável:** cada ação deve respeitar o Ethics Engine, grants específicos, limites de recurso/ambiente, prazo, custo e aprovações vinculadas ao payload. Autorização delegada é específica, proporcional e revogável.
4. **Execução resiliente:** fila/agenda durável, leases, idempotência, checkpoints, retries com backoff, cancelamento, resultados incertos e recuperação após reinício; nunca repetir cegamente ações com efeitos externos.
5. **Integrações por contrato:** interfaces tipadas, validação de entrada/saída, versionamento, timeouts, limites, adaptação isolada e testes de contrato; tratar saídas externas como não confiáveis.
6. **Segurança estrutural:** menor privilégio, segregação de ambientes, RLS/multiempresa, segredo fora do código e dos logs, auditoria, controle de rede e bloqueio seguro por padrão.
7. **Qualidade verificável:** testes unitários, integração, ponta a ponta e cenários de falha; revisão, lint/typecheck, verificação de dependências/licenças e CI antes de merge.
8. **Operação profissional:** homologação independente, observabilidade, métricas, alertas, runbooks, backups com restauração testada, rollback e critérios de promoção.
9. **Sem gambiarra:** não introduzir bypass temporário de segurança, dados fictícios em produção, fallback silencioso para privilégio maior, configuração secreta implícita ou código sem dono/contrato/testes.
10. **Evidência e honestidade:** distinguir implementado, testado, homologado e implantado. Não afirmar execução, aprovação de CI, merge ou deploy sem evidência observável.
11. **Compatibilidade e manutenção:** preservar contratos públicos ou versionar mudanças; documentar ADRs para decisões relevantes, custos, riscos, alternativas e plano de migração.
12. **Falha segura:** quando dependências ou autorização estiverem indisponíveis, bloquear a operação afetada, preservar o estado da missão e explicar o impedimento.

## Ciclo obrigatório de uma missão

1. Registrar objetivo, escopo, critérios de aceite, limites de custo/tempo, responsável e identidade do solicitante.
2. Planejar tarefas e dependências com evidência de viabilidade e permissões necessárias.
3. Validar autorização **antes de cada efeito externo**, não apenas no início da missão.
4. Executar com idempotência, observabilidade e checkpoints persistidos.
5. Retomar automaticamente tarefas elegíveis após falha transitória ou reinício, respeitando tentativas e orçamento.
6. Suspender em aprovação necessária; ao receber decisão válida, retomar do checkpoint sem repetir o efeito.
7. Validar resultados contra critérios de aceite e anexar evidências.
8. Concluir como feito, não sei, não consegui ou bloqueado, com justificativa verificável.

## Gates para alterações no repositório

- **Antes de codificar:** inventário do código existente, impacto arquitetural, modelo de ameaças proporcional e plano de testes.
- **Antes do PR:** código e documentação coerentes, testes locais relevantes, análise de segurança, migrações reversíveis quando aplicáveis.
- **Antes do merge:** CI verde no HEAD, revisão dos contratos e das permissões, sem pendências críticas conhecidas.
- **Antes do deploy:** aprovação exigida pela política, homologação, plano de rollback, backups quando aplicável, observabilidade e verificação pós-deploy.
- **Produção:** migrations, promoções, envio de mensagens, pagamentos, exclusões e alterações de permissões requerem autorização específica conforme política; jamais inferir autorização de um “segue” genérico.

## Critérios de aceite para autonomia ponta a ponta

Uma missão piloto deve provar, em ambiente isolado: planejamento persistente; execução por adaptador governado; PR e testes verificáveis; retomada após reinício; não duplicação de ações; bloqueio por falta de grant; aprovação com payload imutável; cancelamento e emergency stop; limites de custo; trilha de auditoria e relatório final. Falhar qualquer gate impede declarar o sistema pronto.

## Aplicação pelos agentes

Ler este documento e `CONSTITUTION.md` **antes de planejar ou alterar código**. Consultar `docs/architecture/` e ADRs relevantes. Se houver conflito, registrar e solicitar decisão, sem contornar a regra. Toda entrega deve informar arquivos alterados, testes realmente executados, riscos, permissões e o que permanece pendente.

## Evolução desta norma

Mudanças devem ocorrer por PR com justificativa, análise de impacto e revisão. Não enfraquecer controles silenciosamente. O repositório Git mantém histórico, mas a leitura por agentes e a aplicação de gates dependem também de configuração do ambiente e automações de CI.

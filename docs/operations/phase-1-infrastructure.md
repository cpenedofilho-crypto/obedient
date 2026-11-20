# Fase 1 — infraestrutura do OBEDIENT (plano de homologação)

> A operação do servidor que já está no ar (publicar, voltar, parar, variáveis, alertas) está em
> [runbook.md](./runbook.md). Este documento continua sendo o plano da homologação.

**Estado:** projeto pre-alpha; este documento não provisiona VM nem publica serviços. Não conectar pagamentos reais.

## Topologia-alvo
- VM Linux LTS com Node.js 22+ para API e workers **quando existir um entrypoint de serviço validado**.
- Interface Next.js em projeto Vercel **separado**, ainda não criado.
- PostgreSQL gerenciado com RLS e separação por organização; não instalar banco público na VM.
- HTTPS na borda (proxy reverso), DNS, certificados automáticos; somente 443 e acesso administrativo restrito.
- API privada/autenticada; workers sem porta pública. Não expor métricas, dashboards ou filas na internet.

## Pré-requisitos antes de provisionar
1. Confirmar provedor, região, titularidade, orçamento e política de cobrança.
2. Identificar entrypoint real da API e comando de inicialização; não presumir que a biblioteca é um servidor.
3. Definir domínio/subdomínio, responsável por DNS e estratégia de rollback.
4. Definir backup criptografado e teste de restauração; separar backups de banco e segredos.
5. Identificar responsáveis por incidentes e canais de alerta; aprovar política de retenção de logs.
6. Definir secrets manager e identidade de workload com permissões mínimas; nunca salvar credenciais no repositório.

## Baseline de segurança
- VM com atualização de segurança automática e usuário não-root; SSH por chave, acesso restrito e MFA no provedor.
- Firewall default-deny; nenhuma porta de banco, Redis ou agente exposta.
- TLS, headers de segurança, limites de requisição, healthcheck sem dados sensíveis.
- Execução isolada com limites de CPU/memória e filesystem de preferência read-only; sem socket Docker no container.
- Logs estruturados com correlation ID e sem payloads confidenciais; alertas para erro, latência, disco e reinício.
- Rotação de credenciais, trilha de auditoria, isolamento multiempresa testado em banco.
- Kill switch e execução financeira desabilitada por padrão.

## Gates de aceite
- [ ] Serviço HTTP implantável com healthcheck e encerramento gracioso
- [ ] CI incluindo testes, typecheck, dependências e verificação de segredos
- [ ] Imagem de container pinada por digest e scan de vulnerabilidades
- [ ] HTTPS e autenticação ponta a ponta testados
- [ ] Backup e restauração testados em ambiente isolado
- [ ] Teste de RLS/isolamento entre organizações
- [ ] Teste de falha e rollback sem perda de dados
- [ ] Painel e API com deploys independentes
- [ ] Documentação operacional e contatos de incidente

## Ordem de execução
1. Construir/identificar entrypoint HTTP do OBEDIENT e testes de integração.
2. Criar Dockerfile multi-stage e configuração de homologação sem segredos.
3. Validar build, healthcheck, shutdown e rollback no CI.
4. Após autorização de infraestrutura e domínio, provisionar VM e publicar homologação.
5. Promover produção somente após gates de segurança e observabilidade.

**Não fazer nesta fase:** wallet, assinatura, liquidação, migração de produção, ativação de agentes com ações financeiras, criação automática de recursos faturáveis.

# Mobile Cloud Foundation — proposta

Status: proposta para revisão; não altera D17 nem habilita produção.

## Contrato
Reutilizar AdaptadorMovel e Mobile MCP. O provedor cloud deve implementar iniciar, capturar, executar e encerrar, sem expor shell, instalação, URLs arbitrárias ou clipboard. O motor existente permanece a autoridade de execução. A primeira homologação usa exclusivamente app de demonstração e dados sintéticos.

## Ameaças e controles
- Cruzamento de tenants: vincular dispositivo e sessão ao tenant autenticado no servidor, nunca aceitar identidade indicada pelo modelo.
- Efeitos externos: grants, aprovação e parada existentes antes de cada ação; não disponibilizar ferramentas do fornecedor diretamente ao modelo.
- Cobrança inesperada: reserva atômica de orçamento persistente antes de iniciar, prazo máximo, reconciliação e encerramento verificável; falha incerta bloqueia novas sessões.
- Credenciais: secret references, rede restrita, TLS e destino fixado; sem tokens em logs.
- Conteúdo de tela: não confiável, mascarado pelo motor; sem persistência de screenshots brutos nesta fase.
- Uso indevido: apenas dispositivos e aplicativos autorizados; sem contas falsas, engajamento artificial ou evasão de controles de plataformas.

## Etapas e gates
1. Testes de contrato com adaptador falso existente e simulador de falhas do fornecedor.
2. Confirmar documentação OpenAPI e semântica de idempotência, custos e encerramento; implementar adaptador isolado sem ferramentas novas expostas ao modelo.
3. Persistir leases, reservas de orçamento e reconciliação com isolamento por tenant; testar reinício, concorrência e parada.
4. Homologar com app sintético e orçamento explicitamente aprovado. Nenhum recurso pago ou conta real nesta proposta.
5. CI, revisão independente e aprovação arquitetural antes de habilitar qualquer integração externa.

## Aceite
Testar falhas de autorização, isolamento, timeout, resposta inválida, encerramento incerto, duplicidade, orçamento esgotado, revogação e parada. Não declarar integração operacional até homologação real. Nenhuma migration, deploy ou alteração de produção nesta etapa.

# Payment Engine — fase simulada

Esta fase **não realiza pagamentos**. O parser é um protótipo estrito para desafios HTTP 402
com cabeçalho `PAYMENT-REQUIRED` codificado em base64. O formato pode variar entre versões
de x402: um desafio desconhecido é recusado, nunca interpretado por aproximação.

## Limites explícitos
- Sem carteira, chave privada, assinatura, rede, facilitador, autorização ou liquidação.
- `review_required` é uma proposta de inspeção, **não** uma aprovação do Ethics Engine.
- Nenhuma cobrança pode ser paga por este pacote.
- `amount` está em unidades atômicas declaradas pelo fornecedor, **não** em reais.
- O nome da rede e do ativo não comprova legitimidade, valor ou destinatário.
- Cabeçalho fornecido por terceiros é dado não confiável; não exibir `challenge` como HTML.

## Antes de habilitar qualquer pagamento
1. Validar a versão real do protocolo, assinatura do desafio, origem e destinatário.
2. Definir allowlist de fornecedores e redes e limites monetários convertidos com cotação confiável.
3. Usar `EthicsEngine.authorize` com categoria FINANCIAL, risco CRITICAL e aprovação forte.
4. Reservar orçamento atomicamente por tenant/missão; ledger idempotente, recibos e conciliação.
5. Testar replay, timeout, double-spend, falhas parciais, SSRF e isolamento multiempresa.
6. Implantar apenas após revisão de segurança e conformidade.

## Integração existente
`packages/ethics-engine/src/engine.ts`: grants, política, aprovação e auditoria.
`packages/integration-gateway/src/risco.ts`: classificador financeiro.
`docs/architecture/missoes.md`: teto de custo e parada de missões.

Este pacote ainda não é chamado pelo runtime de agentes.

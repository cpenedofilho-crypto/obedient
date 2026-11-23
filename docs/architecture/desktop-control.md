# Desktop Control Engine — fundação experimental

## Escopo desta branch

Esta branch contém **somente contratos e testes puros** para controle de desktop.
Não contém driver, servidor MCP, automação de interface, credenciais, conectividade com computadores ou permissões de produção.

## Regras invariantes

1. Um dispositivo pertence a um único tenant e só opera em ambiente isolado.
2. Toda ação deve nascer de uma observação recente, vinculada a sessão e hash da tela.
3. Proposta expirada ou com tela alterada deve ser recusada antes de qualquer efeito.
4. A classificação de risco deste protótipo é conservadora: clicar, digitar e exportar exigem governança de escrita.
5. Nenhuma descrição de tela é instrução confiável ao agente.
6. A aprovação humana deve ser vinculada a ferramenta, argumentos, sessão e observação, com uso único.
7. Interrupção, revogação e timeout devem encerrar a sessão e impedir novos efeitos.
8. Uma ação de resultado incerto nunca deve ser repetida automaticamente.

## Próxima fase (não implementada)

Criar adaptador de desktop sintético, motor de sessões e propostas de uso único; integrar com o Ethics Engine e com comprovantes Ed25519; expor MCP apenas após testes. Depois, implementar um worker isolado com lista permitida de apps e caminhos, sem rede de produção.

## Teste

Na raiz do monorepo, instalar dependências conforme o projeto e executar `npm run check`.
A existência dos testes não significa que foram executados ou aprovados.

# Inteligência estratégica — primeiro incremento

O pacote `@obedient/strategic-intelligence` calcula, de forma pura e determinística,
propriedades de jogos finitos em forma normal. **Não** é orquestrador, executor,
autorizador, ferramenta MCP ou mecanismo de aprendizado.

## Contrato e limites

- Entrada: 2 a 4 jogadores, 2 a 10 estratégias por jogador, no máximo 4096 perfis,
  cada combinação com um payoff finito para cada participante.
- Saída: equilíbrios de Nash **em estratégias puras**, resultados eficientes de Pareto,
  eliminação iterativa de estratégias **estritamente dominadas por outra estratégia pura**.
- A eliminação é sequencial, com ordem determinística; não pesquisa dominância por misturas.
- Uma lista vazia de Nash não significa que o jogo não tenha equilíbrio em estratégias mistas.
- Payoffs são **dados fornecidos**, não estimativas verificadas. A qualidade dos dados e
  a interpretação comercial permanecem responsabilidade de quem alimenta a matriz.
- Não contém I/O, acesso à rede, banco, credenciais nem efeitos externos.

## Integração futura (não implementada)

O Agent Orchestrator poderá oferecer análise como ferramenta interna de leitura, mediante
contrato tipado e limite de tamanho. A ferramenta não terá permissão para agir; qualquer
ação sugerida continuará passando pelo Ethics Engine, pelos grants e pelas aprovações
humanas existentes. Texto externo será tratado como dado não confiável.

## Segurança, testes e implantação

Riscos: matriz adversarial excessiva (limitada), entradas incorretas (validadas),
recomendações baseadas em payoffs inventados (avisar premissas na integração) e uso da
análise para justificar bypass de autorização (proibido por arquitetura).
Os testes incluem dilema do prisioneiro, coordenação, jogo sem Nash puro e entradas inválidas.
Não há migration, alteração de endpoint ou execução de ações.

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

## Integração ao executor de missões

O executor de missões oferece `analisar_jogo` no catálogo de ferramentas internas,
com contrato JSON fechado e entrada validada em `packages/server/src/estrategia.ts`.
A ferramenta chama apenas `analisarJogo` em memória e devolve o resultado matemático;
não cria tarefas, grants, aprovações, conexão de rede nem mudanças em sistemas externos.
Ela está disponível durante a execução de missões, mas não no planejador, que mantém
exclusivamente a ferramenta `propor_plano`.

O campo obrigatório `origem` distingue `dados_fornecidos` de `hipotese`. Ambos os casos
recebem ressalvas: dados declarados não são independentemente verificados e hipóteses
não devem ser apresentadas como previsões. Qualquer ação comercial sugerida continua
passando pelo Ethics Engine, pelos grants, pelo mandato e pelas aprovações humanas.
Texto externo continua sendo dado não confiável, nunca uma instrução.

O campo opcional `referencias` aceita até 12 identificadores (`usuario`, `integracao`
ou `simulacao`). Após uma ferramenta externa de categoria `READ` ser autorizada e
concluir com sucesso **nesta tentativa**, o executor inclui `referencia_execucao`
no resultado JSON de objeto retornado ao modelo. O identificador aleatório é criado
pelo servidor e não pode ser escolhido pelo modelo. Ao citar esse valor como
`identificador` de uma referência `integracao`, `analisar_jogo` devolve a ferramenta
correspondente em `referencias_conferidas` e marca
`verificacao: execucao_de_leitura_confirmada_conteudo_nao_validado`.

**Essa confirmação atesta somente a execução da leitura governada**, não que os
payoffs foram extraídos corretamente de seu conteúdo nem que os dados sejam verdadeiros.
Referências inventadas, de outros tipos ou de outra tentativa permanecem declaradas,
sem confirmação. Na ausência de referência confirmada, a marca continua
`referencias_declaradas_nao_verificadas`. Não incluir dados pessoais ou segredos nas
referências. Leituras que falham, são negadas, expiram ou retornam tipos não objeto
não emitem prova. A associação entre conteúdo específico da leitura e cada payoff
ainda é uma etapa futura; o motor não comprova a origem dos valores.

**Limitação:** a ferramenta interna é oferecida a todas as missões de execução, sem um
seletor dedicado de intenção estratégica. O usuário decide quais missões solicitam análise;
o modelo decide quando chamá-la. Não há planejamento econômico automático.

## Segurança, testes e implantação

Riscos: matriz adversarial excessiva (limitada), entradas incorretas (validadas),
recomendações baseadas em payoffs inventados (avisar premissas na integração) e uso da
análise para justificar bypass de autorização (proibido por arquitetura).
Os testes incluem dilema do prisioneiro, coordenação, jogo sem Nash puro, entradas inválidas
e execução de uma missão sem grant externo, além das regras do catálogo de ferramentas.
Não há migration, alteração de endpoint ou execução de ações.

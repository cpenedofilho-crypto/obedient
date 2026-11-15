# OBEDIENT — Visual Design Profile (draft)

Status: **proposta em desenvolvimento**, não aprovada como equivalência pixel a pixel às referências.

## Identidade
- Produto: OBEDIENT, independente da marca institucional Casa de IA.
- Referência de direção visual: primeiro conceito Liquid Glass aprovado pelo proprietário, com três estados (entrada imersiva, navegação expandida, Mission Control).
- A interface existente é uma PWA sem framework em `packages/server/public/`. Não migrar para React ou Next.js nesta fase.
- Fundo noturno grafite, luz violeta, vidro fosco, superfícies translúcidas e profundidade sutil.
- Componentes de interface pertencem ao repositório OBEDIENT, conforme a regra de `casa-design`.

## Estado de implementação nesta branch
- `estilo.css`: base escura, painéis de vidro, cartões, formulário de missão, entrada imersiva.
- `index.html`: navegação expansível para seções existentes.
- Nenhuma mudança deliberada em `app.js`, políticas, autenticação, banco ou endpoints.
- O elemento luminoso da entrada é CSS abstrato, não é ainda o símbolo definitivo aprovado.
- A sidebar atual é um menu expansível no fluxo da página, **não** a sidebar flutuante final.
- Não existem indicadores inventados de missão ou sistemas.

## Restrições
1. Nunca ocultar ou dificultar o botão de parada e os avisos de operação offline.
2. Preservar texto como texto (não inserir conteúdo do agente como HTML).
3. Preservar hash de aprovação, passkey, RLS, idempotência e fila offline.
4. Foco visível, áreas de toque de pelo menos 48px, contraste AA e redução de movimento/transparência.
5. Não introduzir fontes externas, scripts remotos ou estilos inline sem revisar a CSP.
6. Respeitar `hidden` e não exibir seções antes da autenticação.
7. Não declarar fidelidade ao mockup sem capturas comparativas.

## Checklist antes de merge
- [ ] Conferir visualmente com as três referências originais, em 390, 1024 e 1440 px.
- [ ] Verificar abertura/fechamento do menu, navegação por teclado e leitor de tela.
- [ ] Executar `npm run check`.
- [ ] Executar `npm run test:e2e`.
- [ ] Confirmar contraste de texto sobre vidro e modo claro.
- [ ] Validar passkey, convite, aprovações, parada e fila offline.
- [ ] Revisar diferença visual com o proprietário.
- [ ] Registrar o produto no `casa-design` somente após alinhamento do perfil.

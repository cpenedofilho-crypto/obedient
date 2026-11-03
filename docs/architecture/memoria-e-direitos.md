# Memória pessoal e direitos do titular (Fase 6, parte 1)

Arts. 10 (aprendizado responsável) e 13 (direitos dos usuários) da Constituição; LGPD arts. 8º,
9º, 16, 18 e 37.

## Memória (`@obedient/memory`)

| Regra | Como |
|---|---|
| Aprender é opt-in por assunto | Consentimento de finalidade `aprendizado` por categoria. Sem ele, `lembrar()` recusa (`CONSENT_REQUIRED`) e a tentativa fica na trilha como barrada |
| Assunto sensível | `health` exige consentimento específico, o mesmo critério do Consent Manager. Um teste confere que as duas listas de sensíveis batem |
| Ver e apagar | `listar()` mostra tudo; `esquecer(id)` apaga uma lição; `esquecerTudo()` apaga todas e desliga tudo |
| Desligar apaga | `desligar(categoria)` revoga o consentimento **e** apaga as lições daquele assunto (usar o mínimo, pelo menor tempo, Art. 4º) |
| O agente só usa o que está ligado | `paraContexto()` filtra pelas categorias ainda ligadas, mesmo que a revogação tenha vindo por fora |
| Treinar modelo de terceiro | Finalidade separada (`treinar_modelo_de_terceiro`), desligada por padrão. Ligar o aprendizado **não** a liga. O OBEDIENT não tem caminho que mande dado para treino; a regra existe para que, se um dia houver, ele precise desse consentimento |
| A trilha não guarda a lição | A trilha registra evento, categoria e agente, **nunca o texto**. Ela é só de inclusão e não pode guardar o que a pessoa tem direito de apagar |

Categorias: preferências, rotina e agenda, pessoas e contatos, trabalho e projetos, finanças e
saúde (sensível). Texto de até 500 caracteres; até 2.000 lições por pessoa.

## Direitos (Art. 13)

| Direito | Onde | O quê |
|---|---|---|
| Ver e levar | `GET /api/meus-dados` | Arquivo JSON (`obedient-exportacao/1`) com tudo o que existe da pessoa (veja abaixo) |
| Apagar | ação `apagar_tudo` → `obedient.apagar_meus_dados()` | Num passo só (veja abaixo) |
| Contestar | ação `contestar` | A pessoa contesta uma ação do agente na própria trilha, dizendo o que está errado |

**O que entra na exportação:**

- autorizações;
- consentimentos, inclusive os revogados;
- pedidos, com todos os estados;
- aprendizado (categorias e lições);
- contestações;
- a trilha inteira e `trilhaIntegra`, o resultado da verificação da cadeia, para a pessoa conferir
  fora daqui.

### O que "apagar o que o OBEDIENT sabe sobre mim" faz

| | O quê |
|---|---|
| Apaga | Lições da memória; ações do aparelho já resolvidas |
| Esvazia | O conteúdo dos pedidos (argumentos e resumo) e a finalidade escrita nas autorizações |
| Encerra | Pedidos pendentes ou aprovados (recusados), autorizações (revogadas), consentimentos (revogados) |
| Guarda | **A trilha**: guarda nomes de ferramenta, hashes e motivos, nunca o conteúdo (LGPD art. 16, I e II; art. 37). **O registro dos consentimentos**: prova de que houve consentimento (LGPD art. 8º, §2º). **As contestações**: são reclamação da pessoa contra o serviço |

A conta (passkey) continua: a pessoa entra depois e vê o resultado. Encerrar a conta é outra
operação, que ainda não existe.

**Por que um papel próprio.** A função roda como `obedient_eraser`, não como o dono das tabelas. Com RLS forçada, o dono das
tabelas não enxerga linha nenhuma, e uma função `SECURITY DEFINER` comum apagaria zero linhas em
silêncio. Nos testes o dono é superusuário, então o erro passaria despercebido. O papel que apaga
tem policy por usuário e privilégio só nas colunas que esvazia.

### Contestação

- **Só se contesta entrada da própria trilha** (chave estrangeira para `audit_log`, mais a RLS).
- **O motivo fica na tabela `contestations`**, não na trilha.
- **O app não edita nem responde a contestação.** Responder é papel do operador do serviço, num
  fluxo que ainda não existe.

## No app

- **"O que o agente aprende sobre você":**
  - cada assunto com "Deixar aprender" ou "Parar de aprender";
  - assunto sensível pede uma confirmação explícita;
  - a lista do que ele já aprendeu tem "Apagar" em cada lição.
- **"Seus dados":**
  - "Baixar meus dados";
  - "Apagar o que o OBEDIENT sabe sobre mim", com confirmação que diz o que some e o que fica;
  - a lista de contestações.
- **"O que aconteceu":** cada ação de agente tem "Contestar", que abre um campo "O que está errado?".
- **Tudo passa pela fila do aparelho.** Tirar poder do agente (revogar, desligar, apagar) sai antes
  de dar (aprovar, ligar).

## Testes

- **`packages/memory/src/index.test.ts`** (9):
  - opt-in;
  - sensível;
  - desligar apaga;
  - ver e apagar;
  - isolamento;
  - contexto só com o que está ligado;
  - aprendizado não implica treino;
  - a trilha sem o texto;
  - entradas inválidas.
- **`packages/store-postgres/src/direitos.test.ts`** (9), no PGlite e no Postgres real:
  - memória sob RLS;
  - o app não altera lição;
  - contestar só a própria trilha, sem o motivo na trilha;
  - apagar num passo, guardando o que precisa e sem tocar em outra pessoa;
  - o papel que apaga preso à RLS;
  - a função recusa sem usuário ou com outro papel.
- **`packages/server/src/api.test.ts`** (5 novos): ligar, ver, apagar, desligar; sensível;
  contestar; exportar sem dado de outra pessoa; apagar tudo.
- **`e2e/app.e2e.ts`** (5 novos): aprender só com o assunto ligado; sensível com confirmação;
  contestar; baixar o arquivo e conferir a trilha; apagar tudo. Axe sem violação nas telas novas.
- **Prova de mutação:** liberar a policy do papel que apaga para `true` reprova o teste "o papel que
  apaga também está preso à RLS". Antes desse teste existir, a mesma mutação passava: a função já
  filtra por usuário, e a policy era uma segunda trava que nenhum teste exercitava sozinha.

# Acordo de Licença de Contribuidor (CLA) do OBEDIENT

**MINUTA, NÃO REVISADA JURIDICAMENTE. Não assine nem aceite este texto antes da versão 1.0.**

Este documento traz dois modelos: o **Individual (ICLA)**, para pessoa física, e o
**Corporativo (CCLA)**, para empresa que autoriza seus empregados a contribuir. A estrutura segue
a do Apache ICLA/CCLA, com quatro acréscimos explicados na nota final.

---

## Parte A — CLA Individual

**Licenciada:** Casa de IA Educação e Consultoria Ltda, CNPJ 69.761.208/0001-20 ("Casa de IA").

**1. Definições.**
- "Contribuição": qualquer obra (código, documentação, teste, design, texto) que você envie ao
  projeto OBEDIENT por qualquer canal oficial, como pull request, issue ou patch, salvo se
  marcada por escrito como "Não é Contribuição".
- "Você": a pessoa física que aceita este acordo.

**2. Titularidade.** Você continua titular da sua Contribuição. Este acordo é uma **licença**, e
não uma cessão.

**3. Licença de direitos autorais.** Você concede à Casa de IA, e a quem receber software
distribuído por ela, uma licença **mundial, não exclusiva, gratuita, perpétua e irrevogável**
para, em relação à Contribuição e às obras derivadas dela:
- (a) reproduzir;
- (b) modificar, adaptar, traduzir e criar obras derivadas;
- (c) distribuir, exibir e executar publicamente;
- (d) disponibilizar por rede, inclusive como serviço (SaaS);
- (e) **licenciar e sublicenciar sob quaisquer termos, inclusive a GNU AGPL-3.0, a Apache-2.0 e
  licenças comerciais ou proprietárias**;
- (f) incorporar em produtos de terceiros (OEM);
- (g) qualquer outra modalidade de utilização, inclusive as que vierem a existir. *Nota para o
  revisor: conferir a validade desta alínea diante do art. 49, V, da Lei 9.610/98; se for o caso,
  enumerar e renovar por aditivo.*

**4. Licença de patente.** Você concede à Casa de IA, e a quem receber o software, uma licença de
patente mundial, não exclusiva, gratuita, perpétua e irrevogável, salvo pela retaliação abaixo,
para fazer, usar, vender, oferecer, importar e transferir a Contribuição, sozinha ou combinada com
o projeto. Se alguém mover ação alegando que a Contribuição ou o projeto infringe patente, a
licença de patente concedida a essa pessoa termina na data da ação.

**5. Compromisso da Casa de IA com a comunidade.** A Casa de IA se compromete a manter cada
Contribuição aceita disponível **também** sob uma licença aprovada pela Open Source Initiative,
enquanto distribuir a obra que a contém.

**6. Suas declarações.** Você declara que:
- (a) tem o direito de conceder estas licenças. Se seu empregador tiver direitos sobre o que você
  cria, você obteve a autorização dele ou ele assinou o CCLA;
- (b) a Contribuição é criação sua ou, na parte que não for, você identificou a origem e a
  licença no próprio PR;
- (c) **se usou ferramenta de IA**, você declarou isso no PR, revisou o resultado e não conhece
  termo da ferramenta que impeça estas licenças;
- (d) a Contribuição não contém dado pessoal de terceiros nem segredo de outra empresa.

**7. Sem garantia.** Salvo acordo escrito, a Contribuição é fornecida "no estado em que se
encontra", sem garantias.

**8. Aviso de mudança.** Você avisa a Casa de IA se alguma declaração deixar de ser verdadeira.

**9. Direitos morais.** Nada aqui afeta seus direitos morais de autor. No caso de programa de
computador, a Lei 9.609/98, art. 2º, §1º, preserva o direito de reivindicar a paternidade e de se
opor a alterações não autorizadas que prejudiquem sua honra ou reputação.

**10. Lei e foro.** Lei brasileira. Foro de Petrópolis/RJ, ou arbitragem, a definir pelo
advogado.

---

## Parte B — CLA Corporativo

A empresa ("Corporação") assina o acordo e lista os empregados autorizados (Anexo A). As cláusulas
3 a 9 da Parte A valem para as Contribuições desses empregados, com a Corporação no lugar de
"Você". A Corporação avisa quando um empregado deixa de estar autorizado; isso não afeta as
Contribuições já enviadas.

---

## Nota para o revisor (por que o texto difere do Apache)

1. A **cláusula 3(e)** autoriza expressamente o licenciamento comercial e o proprietário: sem ela,
   o licenciamento duplo não se sustenta (DCO não basta).
2. A **cláusula 3(g)** e a enumeração de modalidades existem porque, no Brasil, negócio sobre
   direito autoral se interpreta restritivamente (Lei 9.610/98, arts. 4º e 49).
3. A **cláusula 5** é o compromisso recíproco que dá confiança à comunidade.
4. A **cláusula 6(c)** trata de contribuição gerada por IA (`docs/licensing/ai-contributions.md`).

**Como se aceita:** pelo bot CLA Assistant no PR (`.github/workflows/cla.yml`). As assinaturas
ficam registradas no branch `cla-signatures` deste repositório.

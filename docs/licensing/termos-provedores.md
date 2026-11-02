# Termos dos provedores de IA e de componentes

A pesquisa foi feita em 02/11/2026, lendo as páginas oficiais quando a rede da sessão permitiu. As
citações são curtas e foram extraídas por ferramenta: **conferir palavra por palavra na página
antes de citar em contrato.** Este arquivo é registro, não interpretação jurídica.

## Anthropic

| Ponto | Fonte | O que diz |
|---|---|---|
| Qual termo vale para o Claude Code | https://code.claude.com/docs/en/legal-and-compliance | "Commercial Terms of Service - for Team, Enterprise, and Claude API users"; "Consumer Terms of Service - for Free, Pro, Max, and Ultra users" |
| Outputs (consumidor) | https://www.anthropic.com/legal/consumer-terms, *Effective Oct 8, 2025*, Seção 4 | "Subject to your compliance with our Terms, … we assign to you all of our right, title, and interest—if any—in Outputs." |
| Uso comercial (consumidor) | idem | Única ocorrência de "non-commercial" encontrada: no acesso de avaliação (Seção 2). **Não foi encontrada** proibição de uso comercial dos Outputs |
| Concorrência (consumidor) | idem, Seção 3 | Proíbe usar os Serviços "To develop any products or services that compete with our Services" e para desenvolver ou treinar modelos de IA |
| Outputs (comercial/API) | https://www.anthropic.com/legal/commercial-terms, *Effective Jun 17, 2025*, Seção B | O cliente "owns its Outputs"; "Anthropic hereby assigns to Customer its right, title and interest (if any) in and to Outputs" |
| Concorrência (comercial) | idem, D.4(a) | Proíbe "access the Services to build a competing product or service, including to train competing AI models" |

**Consequência prática.** O código feito com assinatura Pro/Max cai nos termos de consumidor, e o
feito com chave de API, nos comerciais. **Nos dois há cessão dos Outputs ao fundador**, com a
ressalva "if any" (só cede o direito que existir).

A avaliação jurídica dessas cláusulas para o OBEDIENT está em andamento com o advogado do
projeto (documento privado).

## OpenAI (Codex)

**Não confirmado.** openai.com e cdn.openai.com não abrem nesta sessão. Pelo texto do buscador,
sem confirmação: os Terms of Use (consumidor) fazem cessão dos Outputs "if any", e o Services
Agreement proíbe usar Output para desenvolver modelos que concorram com a OpenAI. Conferir na fonte.
Os 2 commits do Codex no `casa-de-ia` não vieram para este repositório.

## Remotion

Fonte: https://raw.githubusercontent.com/remotion-dev/remotion/main/LICENSE.md. É uso gratuito
para "an individual", "a for-profit organization with up to 3 employees", organização sem fins
lucrativos ou avaliação. Fora disso: "You are required to obtain a Company License". Não é
licença aprovada pela OSI. O texto avisa que mudará no Remotion 5.0. **Continua NÃO INCORPORAR**
no OBEDIENT.

## ffmpeg (Debian)

**Não confirmado para o bookworm.** Há indício de `--enable-gpl` em buster, bullseye e trixie.
Conferir `debian/rules` do pacote antes de distribuir qualquer imagem que o contenha.

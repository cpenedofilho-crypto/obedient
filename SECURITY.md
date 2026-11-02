# Política de segurança

**MINUTA.** Os prazos abaixo são propostos e precisam da confirmação do fundador.

## Como reportar

**Não abra issue pública.** Use o *Private vulnerability reporting* do GitHub (aba Security do
repositório) ou o e-mail de segurança da Casa de IA. *Endereço a definir antes da publicação.*

Inclua o que você conseguiu fazer, os passos para reproduzir e a versão.

## Prazos (propostos)

| Etapa | Prazo |
|---|---|
| Confirmação de recebimento | até 72 h |
| Avaliação inicial e severidade | até 7 dias |
| Correção de crítica ou alta | até 30 dias |
| Divulgação coordenada | até 90 dias, ou antes, se a correção já tiver saído |

## Escopo

Entram:

- Os pacotes deste repositório.
- **Qualquer forma de fazer o motor violar uma regra verificável da Constituição**, por exemplo:
  executar HIGH sem aprovação, aprovar a própria proposta, escapar da parada de emergência,
  adulterar a auditoria sem a verificação acusar, ou um subagente receber mais autoridade que o
  pai.
- Injeção de instrução por conteúdo externo que leve a uma ação não autorizada.

Fora do escopo: os serviços de terceiros (provedor de modelo, hospedagem), que têm programas
próprios.

## Versões suportadas

Pré-alfa: só a `main`.

## Recompensa

Ainda não há programa de recompensa.

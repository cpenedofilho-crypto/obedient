# DOTS como agente subordinado

O DOTS é o supervisor que o fundador já opera em dois sistemas:

| Instância | Onde | Como fala |
|---|---|---|
| Dot Recupera | Executor no `recupera-mcp` (Railway), perfil `SUPERVISOR` | MCP do Recupera OS |
| Dot do Motor | Identidade `dot` no MCP V2 do Motor de Triagem | MCP V2 |

## Regra

O OBEDIENT **não importa** código de nenhum dos dois. O `@obedient/dots-adapter` é um **cliente
MCP**. Cada leitura passa por três travas, em ordem:

1. **Allowlist estrutural** de ferramentas de leitura. O adaptador não tem método de escrita, e o
   teste confere isso pela lista de métodos da classe.
2. **Ethics Engine** do OBEDIENT: grant do usuário para o agente `dots`, parada de emergência e
   auditoria.
3. **Política do servidor de destino:** perfil e teto de risco no Recupera, escopos no Motor.

A permissão efetiva é a **interseção** das três camadas. O OBEDIENT pode restringir o DOTS, nunca
ampliar o que o Recupera ou o Motor recusam.

## Parada de emergência

Ao acionar a parada para o usuário, o adaptador chama `revokeRemoteToken(sistema, usuário)` em cada
sistema configurado. O integrador implementa isso revogando o token OAuth do DOTS no servidor de
destino.

## Fase 3 (esta) e depois

- **Fase 3:** só leitura. Feito.
- **Escrita** (preparar mensagem, pedir aprovação) só depois da Fase 4b, e **reaproveitando** o
  `/decisoes-ia` do Recupera: o OBEDIENT mostra a pendência e leva o usuário até lá. Ele não
  duplica a caixa de decisões.

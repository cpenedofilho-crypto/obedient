# Integrações (Fase 7)

Pacote `@obedient/integrations`; migration 0005. Esta parte (7.1) trata das **conexões**: como a
pessoa liga o Google ao OBEDIENT e como a credencial é guardada, usada e revogada. As ferramentas
que usam essas conexões (7.2) e o executor das missões (7.3) vêm nos próximos PRs.

## Catálogo e escopo mínimo

| Integração | Escopos pedidos ao Google | O que **não** pede |
|---|---|---|
| Google Agenda | `calendar.events` | configurações da agenda, outras agendas além dos eventos |
| Gmail | `gmail.readonly`, `gmail.send` | `gmail.modify` e `mail.google.com`: o agente não apaga nem arquiva e-mail |
| Google Drive | `drive.file` | `drive` e `drive.readonly`: o agente só vê o que ele mesmo criou |

- **Cada ferramenta é declarada no catálogo com risco, categoria e os dados pessoais que toca.** O
  modelo nunca decide isso. A declaração passa pela validação do SDK, e um teste confere que nenhuma
  ferramenta sai da sua integração.
- **Apagar compromisso é `DESTRUCTIVE`:** conta como crítico e pede passkey.
- **Mandar e-mail é `COMMUNICATION` de risco alto:** sempre pede aprovação e precisa da assinatura da
  pessoa (Art. 5º).

## Conectar (OAuth 2.0 com PKCE)

```
app: "Conectar" ─► POST /api/conexoes/iniciar
        servidor grava state (hash), nonce (hash), PKCE verifier (cifrado); cookie Lax com o nonce
     ─► accounts.google.com (a pessoa autoriza)
     ─► GET /api/conexoes/retorno?state&code     (chega SEM a sessão: o cookie dela é Strict)
        confere state + nonce do cookie (uso único, 10 min) → troca o código (com o verifier)
        confere os escopos devolvidos → grava a credencial cifrada → 303 para /?conexao=ok
```

- **O retorno se prende ao fluxo duas vezes:** pelo `state`, que está no banco com o usuário que
  iniciou, e pelo **nonce no cookie do navegador** que iniciou. Sem o segundo, alguém poderia fazer
  a vítima completar um fluxo iniciado na conta dele e ligar a conta Google da vítima ao OBEDIENT do
  atacante.
- **Escopos devolvidos são conferidos.**
  - Faltou algum, porque a pessoa desmarcou na tela do Google: não conecta, e o app explica.
  - Veio a mais, por concessão antiga na conta: não conecta e pede para remover o acesso antigo.
    O mínimo vale também aqui.
- **`include_granted_scopes=false`:** cada integração pede só o seu, sem somar concessões anteriores.

## Cofre

- **Cifra:** AES-256-GCM com chave **fora do banco** (`OBEDIENT_CHAVES_COFRE`, gerada por `cli.ts
  chave`).
- **Dado autenticado:** usuário e integração entram no dado autenticado da cifra. Uma cifra copiada
  para a linha de outra pessoa, ou de outra integração, não abre.
- **Rotação de chave:** cada cifra leva o id da chave; a primeira da lista cifra, e as outras
  continuam abrindo.
- **Credencial nunca sai do servidor.** O painel e a exportação mostram nome, escopos e data.

## Token, renovação e revogação

- **Renovação:** o token de acesso é renovado quando falta menos de 1 minuto. A chamada ao Google
  acontece **fora** de transação. `invalid_grant` (a pessoa revogou no Google) desfaz a conexão
  aqui também.
- **Revogação:**
  - desconectar, **parar** (Art. 9º) e **apagar o que o OBEDIENT sabe** tiram as conexões **na
    mesma transação** e põem as credenciais numa fila (`token_revocations`);
  - a revogação no Google é feita logo depois do commit;
  - sem rede, fica na fila para a próxima vez, mas a conexão já não serve desde o commit.
- **Na parada,** a retirada das conexões roda num `SAVEPOINT`: um erro nela não pode impedir a parada
  de ser gravada.

## Configuração do servidor

| Variável | Para quê |
|---|---|
| `OBEDIENT_GOOGLE_CLIENT_ID`, `OBEDIENT_GOOGLE_CLIENT_SECRET` | Cliente OAuth do Google. Sem eles, o app mostra as integrações e diz que o servidor não as tem ligadas |
| `OBEDIENT_CHAVES_COFRE` | Chaves do cofre, `id:base64,…` |

**O que você precisa fazer no Google Cloud** (é sua conta; eu não crio):

1. Crie um projeto.
2. Ative as APIs Calendar, Gmail e Drive.
3. Configure a tela de consentimento.
4. Crie um cliente OAuth "Aplicativo da Web" com o redirect `<OBEDIENT_ORIGIN>/api/conexoes/retorno`.

**Atenção a dois limites do Google:**

- **`gmail.readonly` e `gmail.send` são escopos restritos.** Para uso por terceiros, o Google exige
  verificação e uma avaliação de segurança anual.
- **Em modo de teste**, até 100 usuários de teste, os refresh tokens **vencem em 7 dias**: a pessoa
  reconecta toda semana.

Para uso pessoal, o modo de teste basta.

## Testes

- **`packages/integrations/src/conexoes.test.ts`** (11), contra um Google falso
  (`google-falso.ts`):
  - escopo mínimo e PKCE;
  - credencial cifrada e invisível;
  - state de uso único, de 10 minutos, e só no navegador que começou;
  - escopos a menos e a mais;
  - renovação e `invalid_grant`;
  - revogação com e sem rede;
  - parar e apagar;
  - isolamento e cifra presa à pessoa;
  - o app não lê o state;
  - catálogo;
  - cofre (rotação e adulteração).
- **`packages/server/src/api.test.ts`** (5 novos):
  - conectar pelo caminho do navegador, com o cookie conferido;
  - retorno sem o cookie;
  - a pessoa recusou no Google;
  - desconectar e parar revogam;
  - servidor sem integração.
- **`e2e/app.e2e.ts`** (1 novo): conectar e desconectar no navegador. A "tela do Google" é
  interceptada e redireciona de volta como o Google faria. O axe não acusou violações.
- **Prova de mutação:** tirar a conferência do nonce no retorno reprova o teste "só no navegador que
  começou".

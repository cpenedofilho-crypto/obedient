// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Quanto vale cada ação no aparelho (risco e categoria), antes de o Ethics Engine decidir se ela
// roda sozinha, vira pedido de aprovação ou é negada. Regras como dados; o modelo nunca escolhe.
//
//   • o risco parte do tipo de ação e o texto do alvo só pode SUBIR: um botão "Pagar" vira
//     FINANCIAL (CRITICAL, passkey); "Enviar" vira COMMUNICATION (HIGH, aprovação); "Excluir" vira
//     DESTRUCTIVE (CRITICAL). Nenhum texto de tela baixa o risco;
//   • app negado nunca abre, e com um app negado em primeiro plano só sair dele é permitido
//     (início, voltar). App fora da lista do aparelho também não abre;
//   • digitar ou tocar para enviar em app de mensagem é COMMUNICATION; com o aparelho sem
//     permissão de mensagens (o padrão), é negado. As réguas de envio dos produtos rodam no
//     servidor e um agente no aparelho passaria por fora delas.

import { type RiskLevel, type ToolCategory, riskRank } from "@obedient/core";
import type { Dispositivo, Operacao } from "./tipos.ts";

/** Negados em qualquer aparelho: mexer neles muda o próprio aparelho ou dá acesso a tudo. */
export const APPS_SEMPRE_NEGADOS = [
  "com.android.settings",
  "com.android.vending",
  "com.google.android.packageinstaller",
  "com.android.packageinstaller",
  "com.google.android.apps.authenticator2",
  "com.android.shell",
] as const;

/** Apps de mensagem: o que se digita e envia neles sai do aparelho para outra pessoa. */
export const APPS_DE_MENSAGEM = [
  "com.whatsapp",
  "com.whatsapp.w4b",
  "com.google.android.apps.messaging",
  "org.telegram.messenger",
  "org.thoughtcrime.securesms",
  "com.facebook.orca",
  "com.instagram.android",
  "com.google.android.gm",
] as const;

const FINANCEIRO = /\b(pagar|pague|pagamento|comprar|compre|finalizar compra|checkout|transferir|transfer[eê]ncia|pix|assinar plano|pay|buy|purchase|order now)\b/i;
const DESTRUTIVO = /\b(excluir|apagar|deletar|remover|limpar tudo|desinstalar|delete|remove|erase|uninstall)\b/i;
const COMUNICACAO = /\b(enviar|envie|mandar|publicar|postar|compartilhar|responder|send|post|share|reply|publish)\b/i;
const CONFIRMACAO = /\b(confirmar|confirmo|aceitar|aceito|concordo|autorizar|concluir|confirm|accept|agree|authorize|allow)\b/i;

export interface Classificacao {
  risco: RiskLevel;
  categoria: ToolCategory;
  /** Preenchido quando a ação nunca roda, aprovada ou não. */
  negado: string | null;
}

const ok = (risco: RiskLevel, categoria: ToolCategory): Classificacao => ({ risco, categoria, negado: null });
const nega = (motivo: string): Classificacao => ({ risco: "CRITICAL", categoria: "DESTRUCTIVE", negado: motivo });

const ordemCategoria: ToolCategory[] = ["READ", "WRITE", "COMMUNICATION", "LEGAL", "DESTRUCTIVE", "FINANCIAL"];
/** O mais alto dos dois, em risco e em categoria: nada desce. */
function subir(a: Classificacao, b: Classificacao): Classificacao {
  return {
    risco: riskRank(b.risco) > riskRank(a.risco) ? b.risco : a.risco,
    categoria: ordemCategoria.indexOf(b.categoria) > ordemCategoria.indexOf(a.categoria) ? b.categoria : a.categoria,
    negado: a.negado ?? b.negado,
  };
}

export function appNegado(d: Dispositivo, app: string | null): boolean {
  if (!app) return false;
  return (APPS_SEMPRE_NEGADOS as readonly string[]).includes(app) || d.appsNegados.includes(app);
}
export const ehAppDeMensagem = (app: string | null) => Boolean(app && (APPS_DE_MENSAGEM as readonly string[]).includes(app));

/** Pelo texto do alvo: só sobe. */
function peloTexto(texto: string): Classificacao | null {
  if (FINANCEIRO.test(texto)) return ok("CRITICAL", "FINANCIAL");
  if (DESTRUTIVO.test(texto)) return ok("CRITICAL", "DESTRUCTIVE");
  if (COMUNICACAO.test(texto)) return ok("HIGH", "COMMUNICATION");
  if (CONFIRMACAO.test(texto)) return ok("HIGH", "WRITE");
  return null;
}

export interface PedidoClassificavel {
  operacao: Operacao;
  /** App em primeiro plano na observação em que o pedido se baseia. */
  appAtual: string | null;
  /** Texto do elemento alvo (toque ou campo), já mascarado. */
  textoAlvo?: string;
  /** App a abrir (apps.launch). */
  app?: string;
}

export function classificar(d: Dispositivo, p: PedidoClassificavel): Classificacao {
  // Saída de emergência de um app negado: sempre deixa voltar e ir ao início.
  if (p.operacao === "nav.home" || p.operacao === "nav.back") return ok("LOW", "WRITE");
  if (appNegado(d, p.appAtual)) return nega(`o app em primeiro plano (${p.appAtual}) não pode ser usado pelo agente`);

  switch (p.operacao) {
    case "input.swipe":
      return ok("LOW", "WRITE");
    case "apps.launch": {
      if (!p.app) return nega("falta o app a abrir");
      if (appNegado(d, p.app)) return nega(`o app ${p.app} não pode ser aberto pelo agente`);
      if (!d.appsPermitidos.includes(p.app)) return nega(`o app ${p.app} não está na lista deste aparelho`);
      if (ehAppDeMensagem(p.app) && !d.permiteMensagens) return nega("este aparelho não permite apps de mensagem");
      return ok("MEDIUM", "WRITE");
    }
    case "input.text": {
      let c = ok("MEDIUM", "WRITE");
      if (ehAppDeMensagem(p.appAtual)) {
        if (!d.permiteMensagens) return nega("digitar em app de mensagem não é permitido neste aparelho");
        c = subir(c, ok("HIGH", "COMMUNICATION"));
      }
      const pelo = p.textoAlvo ? peloTexto(p.textoAlvo) : null;
      return pelo ? subir(c, pelo) : c;
    }
    case "input.tap_element": {
      let c = ok("MEDIUM", "WRITE");
      const pelo = p.textoAlvo ? peloTexto(p.textoAlvo) : null;
      if (pelo) c = subir(c, pelo);
      if (ehAppDeMensagem(p.appAtual) && c.categoria === "COMMUNICATION" && !d.permiteMensagens) return nega("enviar em app de mensagem não é permitido neste aparelho");
      return c;
    }
  }
}

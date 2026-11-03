// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// O que o app mostra, montado a partir dos DADOS (nunca do texto do modelo): a parada, os pedidos
// que esperam a pessoa, o que cada agente pode fazer e o que aconteceu. Tudo lido com a RLS da
// sessão: o painel de uma pessoa não tem como incluir nada de outra.

import type { AuditEntry, EthicsEngine, Grant, Proposal } from "@obedient/ethics-engine";

export interface CartaoPedido {
  id: string;
  agente: string;
  sistema: string;
  acao: string;
  /** Argumentos como a pessoa lê: chave e valor em texto curto. */
  detalhes: { campo: string; valor: string }[];
  motivo: string;
  criadoEm: string;
  venceEm: string;
  exigeReautenticacao: boolean;
  /** O hash do que o cartão mostra: aprovar é aprovar exatamente isto. */
  hash: string;
}

export interface Autorizacao {
  id: string;
  agente: string;
  sistema: string | null;
  capacidade: string;
  /** A capacidade como a pessoa lê ("qualquer ação em email"). */
  escopo: string;
  finalidade: string;
  riscoMaximo: string;
  semPerguntarAte: string | null;
  limiteDeValor: number | null;
  venceEm: string;
  delegadaPor: string | null;
}

export interface ItemAtividade {
  seq: number;
  quando: string;
  texto: string;
  tom: "neutro" | "bom" | "atencao" | "barrado";
}

export interface Painel {
  usuario: string;
  reautenticado: boolean;
  parada: { ativa: true; global: boolean; desde: string; motivo: string } | null;
  pedidos: CartaoPedido[];
  autorizacoes: Autorizacao[];
  atividade: ItemAtividade[];
  geradoEm: string;
}

const curto = (v: unknown, max = 80): string => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

const agenteDe = (quem: string) => quem.replace(/^agent:/, "");

const RISCO: Record<string, string> = { LOW: "baixo", MEDIUM: "médio", HIGH: "alto", CRITICAL: "crítico" };
const CATEGORIA: Record<string, string> = { FINANCIAL: "financeira", LEGAL: "jurídica", DESTRUCTIVE: "destrutiva", COMMUNICATION: "de comunicação", WRITE: "de escrita", READ: "de leitura" };
export const riscoEmPortugues = (r: string | null) => (r ? (RISCO[r] ?? r) : null);

/**
 * O motivo que o motor de políticas dá (em inglês: é API) em português direto para a pessoa. Motivo
 * que já vem em português (os do Ethics Engine) passa como está.
 */
export function motivoParaPessoa(m: string): string {
  const passkey = "precisa da sua confirmação com passkey";
  let x: RegExpMatchArray | null;
  if ((x = m.match(/^risk (\w+): default is (\w+)$/))) {
    const r = riscoEmPortugues(x[1]!);
    if (x[2] === "require_privileged_approval") return `Ação de risco ${r}: ${passkey}.`;
    if (x[2] === "require_approval") return `Ação de risco ${r}: precisa da sua aprovação.`;
    if (x[2] === "deny") return `Ação de risco ${r}: você não deixa o agente fazer.`;
    return `Ação de risco ${r}: liberada.`;
  }
  if ((x = m.match(/^category (\w+) counts as CRITICAL/))) return `Ação ${CATEGORIA[x[1]!] ?? x[1]!.toLowerCase()}: sempre ${passkey}.`;
  if (/^risk CRITICAL always requires privileged approval/.test(m)) return `Ação crítica: sempre ${passkey}.`;
  if ((x = m.match(/^policy (\S+) requires (privileged approval|approval)(?: \(amount in (\S+) above ([\d.]+)\))?$/))) {
    const oque = x[2] === "approval" ? "pede a sua aprovação" : `pede ${passkey.replace("precisa da ", "a ")}`;
    const valor = x[3] ? `, porque o valor em ${x[3]} passa de ${Number(x[4]).toLocaleString("pt-BR")}` : "";
    return `Uma regra sua (${x[1]}) ${oque}${valor}.`;
  }
  if ((x = m.match(/^policy (\S+) (?:denies|blocks)/))) return `Uma regra sua (${x[1]}) não deixa o agente fazer isto.`;
  if ((x = m.match(/^policy (\S+) allows autonomous execution$/))) return `Uma regra sua (${x[1]}) deixa o agente fazer sozinho.`;
  return m;
}

/** "email.*" em email → "qualquer ação em email"; "agenda.ler_*" → "as ações agenda.ler_…". */
export function escopoParaPessoa(capacidade: string, sistema: string | null): string {
  const onde = sistema ? ` em ${sistema}` : "";
  if (sistema && capacidade === `${sistema}.*`) return `qualquer ação em ${sistema}`;
  if (capacidade.endsWith("*")) return `as ações que começam com ${capacidade.slice(0, -1)}${onde}`;
  return `${capacidade}${onde}`;
}


function cartao(p: Proposal): CartaoPedido {
  const chaves = Object.keys(p.payload.args).sort();
  return {
    id: p.id,
    agente: agenteDe(p.requestedBy),
    sistema: p.payload.systemId,
    acao: p.payload.tool,
    detalhes: chaves.slice(0, 8).map((k) => ({ campo: k, valor: curto(p.payload.args[k]) })),
    motivo: motivoParaPessoa(p.reason),
    criadoEm: p.createdAt.toISOString(),
    venceEm: p.expiresAt.toISOString(),
    exigeReautenticacao: p.approver === "user_strong_auth",
    hash: p.payloadHash,
  };
}

function autorizacao(g: Grant): Autorizacao {
  return {
    id: g.id,
    agente: g.agentId,
    sistema: g.systemId,
    capacidade: g.capability,
    escopo: escopoParaPessoa(g.capability, g.systemId),
    finalidade: g.purpose,
    riscoMaximo: riscoEmPortugues(g.limits.maxRisk)!,
    semPerguntarAte: riscoEmPortugues(g.limits.autonomousUpTo),
    limiteDeValor: g.limits.maxAmount,
    venceEm: g.expiresAt.toISOString(),
    delegadaPor: g.parentId ? g.grantedBy : null,
  };
}

/** Uma linha da trilha em português direto. O motivo técnico vem entre parênteses quando ajuda. */
export function textoDaAtividade(e: AuditEntry): Pick<ItemAtividade, "texto" | "tom"> {
  const quem = e.actor.startsWith("agent:") ? agenteDe(e.actor) : e.actor.startsWith("user:") ? "Você" : e.actor;
  const acao = e.tool ? `${e.tool}${e.systemId ? ` em ${e.systemId}` : ""}` : "";
  const motivo = e.reasons?.[0] ? ` (${curto(motivoParaPessoa(e.reasons[0]), 140)})` : "";
  switch (`${e.event}:${e.outcome}`) {
    case "action.authorize:allowed":
      return { texto: `${quem} pôde fazer ${acao}`, tom: "neutro" };
    case "action.authorize:approval_required":
      return { texto: `${quem} pediu sua aprovação para ${acao}`, tom: "atencao" };
    case "action.authorize:denied":
      return { texto: `${quem} foi barrado em ${acao}${motivo}`, tom: "barrado" };
    case "proposal.approve:approved":
      return { texto: `Você aprovou ${acao}`, tom: "bom" };
    case "proposal.approve:denied":
      return { texto: `Aprovação não aceita${motivo}`, tom: "barrado" };
    case "proposal.reject:rejected":
      return { texto: "Você recusou um pedido", tom: "neutro" };
    case "proposal.execute:executed":
      return { texto: `${quem} fez ${acao}, como você aprovou`, tom: "bom" };
    case "proposal.execute:failed":
      return { texto: `${acao} falhou ao executar${motivo}`, tom: "atencao" };
    case "proposal.execute:denied":
      return { texto: `${acao} não foi executada${motivo}`, tom: "barrado" };
    case "emergency_stop.engaged:stopped":
      return { texto: `Parada acionada${motivo}`, tom: "atencao" };
    case "emergency_stop.released:released":
      return { texto: "Parada liberada", tom: "bom" };
    case "grant.revoke:revoked":
      return { texto: `Você tirou uma autorização${motivo}`, tom: "neutro" };
    default:
      return { texto: `${e.event} (${e.outcome})`, tom: "neutro" };
  }
}

export async function montarPainel(m: EthicsEngine, userId: string, reautenticado: boolean, agora: Date, limiteAtividade = 30): Promise<Painel> {
  const parada = await m.stop.blockingScope(userId);
  const pedidos = (await m.approvals.pending(userId)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const vigentes = (await m.grants.list(userId)).filter((g) => !g.revokedAt && g.expiresAt > agora);
  const trilha = await m.audit.forUser(userId);
  return {
    usuario: userId,
    reautenticado,
    parada: parada ? { ativa: true, global: parada.scope.kind === "global", desde: parada.state.engagedAt.toISOString(), motivo: parada.state.reason } : null,
    pedidos: pedidos.map(cartao),
    autorizacoes: vigentes.map(autorizacao),
    atividade: trilha
      .slice(-limiteAtividade)
      .reverse()
      .map((e) => ({ seq: e.seq, quando: e.at, ...textoDaAtividade(e) })),
    geradoEm: agora.toISOString(),
  };
}

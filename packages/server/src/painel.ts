// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// O que o app mostra, montado a partir dos DADOS (nunca do texto do modelo): a parada, os pedidos
// que esperam a pessoa, o que cada agente pode fazer e o que aconteceu. Tudo lido com a RLS da
// sessão: o painel de uma pessoa não tem como incluir nada de outra.

import type { AuditEntry, EthicsEngine, Grant, Proposal } from "@obedient/ethics-engine";
import { CATEGORIAS_DE_APRENDIZADO, type Memoria } from "@obedient/memory";
import { ABERTAS, type Missao, type Missoes } from "@obedient/missions";
import { INTEGRACOES } from "@obedient/integrations";
import type { Contestacao } from "@obedient/store-postgres";

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
  /** Ação de agente (ou sobre um pedido dele) que a pessoa pode contestar (Art. 13). */
  contestavel: boolean;
}

export interface CategoriaNoPainel {
  id: string;
  nome: string;
  sensivel: boolean;
  ligada: boolean;
}

export interface LicaoNoPainel {
  id: string;
  categoria: string;
  categoriaNome: string;
  texto: string;
  agente: string;
  quando: string;
}

export interface ContestacaoNoPainel {
  id: string;
  seq: number;
  motivo: string;
  status: "aberta" | "respondida";
  resposta: string | null;
  quando: string;
}

export interface MissaoNoPainel {
  id: string;
  objetivo: string;
  agente: string;
  estado: string;
  /** Em português, para a pessoa: "trabalhando", "esperando você", "parada", … */
  situacao: string;
  impedimento: string | null;
  desfecho: { tipo: "feito" | "nao_sei" | "nao_consegui"; explicacao: string } | null;
  tentativas: number;
  maxTentativas: number;
  proximaTentativaEm: string | null;
  custo: string;
  teto: string;
  tetoCentavos: number;
  criadaEm: string;
}

export interface Painel {
  usuario: string;
  reautenticado: boolean;
  parada: { ativa: true; global: boolean; desde: string; motivo: string } | null;
  pedidos: CartaoPedido[];
  autorizacoes: Autorizacao[];
  atividade: ItemAtividade[];
  aprendizado: { categorias: CategoriaNoPainel[]; licoes: LicaoNoPainel[] };
  contestacoes: ContestacaoNoPainel[];
  missoes: MissaoNoPainel[];
  /** Art. 5º: como as mensagens enviadas em nome da pessoa se identificam (null = não configurada). */
  identificacao: string | null;
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

/**
 * "email.*" em email → "qualquer ação em email"; com o nome da integração ("Google Agenda") → "as
 * ações de Google Agenda que essa conexão permite"; "agenda.ler_*" → "as ações que começam com …".
 */
export function escopoParaPessoa(capacidade: string, sistema: string | null, nomeDoSistema?: string): string {
  const onde = sistema ? ` em ${nomeDoSistema ?? sistema}` : "";
  if (sistema && capacidade === `${sistema}.*`) return nomeDoSistema ? `as ações de ${nomeDoSistema} que essa conexão permite` : `qualquer ação em ${sistema}`;
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
    escopo: escopoParaPessoa(g.capability, g.systemId, INTEGRACOES.find((i) => i.id === g.systemId)?.nome),
    finalidade: g.purpose,
    riscoMaximo: riscoEmPortugues(g.limits.maxRisk)!,
    semPerguntarAte: riscoEmPortugues(g.limits.autonomousUpTo),
    limiteDeValor: g.limits.maxAmount,
    venceEm: g.expiresAt.toISOString(),
    delegadaPor: g.parentId ? g.grantedBy : null,
  };
}

const NOMES_DE_CATEGORIA: Record<string, string> = Object.fromEntries(CATEGORIAS_DE_APRENDIZADO.map((c) => [c.id, c.nome.toLowerCase()]));
/** "categoria trabalho: 1 lição(ões)" → "trabalho e projetos". */
function nomeDaCategoria(razao: string | undefined): string {
  const id = razao?.match(/^categoria (\w+)/)?.[1] ?? "";
  return id === "todas" ? "todas as categorias" : (NOMES_DE_CATEGORIA[id] ?? id);
}

const nomeDaIntegracao = (id: string | undefined) => INTEGRACOES.find((i) => i.id === id)?.nome ?? id ?? "uma integração";

const CONTESTAVEIS = new Set(["action.authorize", "proposal.execute", "memory.learn", "mission.feito", "mission.nao_sei", "mission.nao_consegui", "mission.attempt_failed"]);

const SITUACAO: Record<string, string> = {
  running: "Trabalhando nisso",
  waiting_approval: "Esperando a sua aprovação",
  blocked: "Parou e precisa de você",
  completed: "Terminou",
  failed: "Não conseguiu",
  cancelled: "Cancelada",
};
const reais = (centavos: number) => (centavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function missaoNoPainel(m: Missao): MissaoNoPainel {
  return {
    id: m.id,
    objetivo: m.objetivo,
    agente: m.agente,
    estado: m.estado,
    situacao: m.desfecho?.tipo === "nao_sei" ? "Não soube responder" : (SITUACAO[m.estado] ?? m.estado),
    impedimento: m.impedimento,
    desfecho: m.desfecho,
    tentativas: m.tentativas,
    maxTentativas: m.maxTentativas,
    proximaTentativaEm: m.proximaTentativaEm?.toISOString() ?? null,
    custo: reais(m.custoCentavos),
    teto: reais(m.tetoCustoCentavos),
    tetoCentavos: m.tetoCustoCentavos,
    criadaEm: m.criadaEm.toISOString(),
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
    case "memory.opt_in:info":
      return { texto: `Você deixou o agente aprender: ${nomeDaCategoria(e.reasons?.[0])}`, tom: "neutro" };
    case "memory.opt_out:info":
      return { texto: `Você desligou o aprendizado de ${nomeDaCategoria(e.reasons?.[0])} e apagou o que ele tinha aprendido`, tom: "neutro" };
    case "memory.learn:info":
      return { texto: `${quem} aprendeu algo sobre ${nomeDaCategoria(e.reasons?.[0])}`, tom: "neutro" };
    case "memory.learn:denied":
      return { texto: `${quem} tentou aprender sobre ${nomeDaCategoria(e.reasons?.[0])} sem a sua permissão e não guardou nada`, tom: "barrado" };
    case "memory.forget:info":
      return { texto: "Você apagou uma lição", tom: "neutro" };
    case "memory.forget_all:info":
      return { texto: "Você apagou tudo o que o agente aprendeu", tom: "neutro" };
    case "action.contested:info":
      return { texto: `Você contestou uma ação${motivo}`, tom: "atencao" };
    case "mission.created:info":
      return { texto: `Você pediu uma missão (${curto(e.reasons?.[0] ?? "", 80)})`, tom: "neutro" };
    case "mission.feito:executed":
      return { texto: `${quem} terminou uma missão`, tom: "bom" };
    case "mission.nao_sei:info":
      return { texto: `${quem} disse que não sabe responder uma missão`, tom: "atencao" };
    case "mission.nao_consegui:failed":
      return { texto: `${quem} disse que não conseguiu fazer uma missão`, tom: "atencao" };
    case "mission.attempt_failed:failed":
      return { texto: `${quem} tentou uma missão e não conseguiu (${curto(e.reasons?.[0] ?? "", 60)})`, tom: "atencao" };
    case "mission.blocked:info":
      return { texto: `Uma missão parou e precisa de você${motivo}`, tom: "atencao" };
    case "mission.waiting_approval:approval_required":
      return { texto: `Uma missão espera a sua aprovação`, tom: "atencao" };
    case "mission.cancelled:info":
      return { texto: `Missão cancelada${motivo}`, tom: "neutro" };
    case "mission.retry:info":
      return { texto: "Você mandou a missão tentar de novo", tom: "neutro" };
    case "mission.result_discarded:info":
      return { texto: "Um resultado chegou depois de a missão ser encerrada e foi descartado", tom: "neutro" };
    case "connection.added:info":
      return { texto: `Você conectou ${nomeDaIntegracao(e.systemId)}`, tom: "bom" };
    case "connection.removed:revoked":
      return { texto: `Você desconectou ${nomeDaIntegracao(e.systemId)}`, tom: "neutro" };
    case "user.data_erased:info":
      return { texto: `Você apagou o que o OBEDIENT sabia sobre você${motivo}`, tom: "neutro" };
    default:
      return { texto: `${e.event} (${e.outcome})`, tom: "neutro" };
  }
}

export async function montarPainel(
  m: EthicsEngine,
  memoria: Memoria,
  missoes: Missoes,
  contestacoes: Contestacao[],
  identificacao: string | null,
  userId: string,
  reautenticado: boolean,
  agora: Date,
  limiteAtividade = 30,
): Promise<Painel> {
  const parada = await m.stop.blockingScope(userId);
  const pedidos = (await m.approvals.pending(userId)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const vigentes = (await m.grants.list(userId)).filter((g) => !g.revokedAt && g.expiresAt > agora);
  const trilha = await m.audit.forUser(userId);
  const todas = (await missoes.listar(userId)).sort((a, b) => b.criadaEm.getTime() - a.criadaEm.getTime());
  const listaDeMissoes = [...todas.filter((x) => ABERTAS.includes(x.estado)), ...todas.filter((x) => !ABERTAS.includes(x.estado)).slice(0, 10)].map(missaoNoPainel);
  return {
    usuario: userId,
    reautenticado,
    parada: parada ? { ativa: true, global: parada.scope.kind === "global", desde: parada.state.engagedAt.toISOString(), motivo: parada.state.reason } : null,
    pedidos: pedidos.map(cartao),
    autorizacoes: vigentes.map(autorizacao),
    atividade: trilha
      .slice(-limiteAtividade)
      .reverse()
      .map((e) => ({ seq: e.seq, quando: e.at, ...textoDaAtividade(e), contestavel: CONTESTAVEIS.has(e.event) && e.actor.startsWith("agent:") })),
    aprendizado: {
      categorias: (await memoria.categorias(userId)).map((c) => ({ id: c.id, nome: c.nome, sensivel: c.sensivel, ligada: c.ligada })),
      licoes: (await memoria.listar(userId))
        .sort((a, b) => b.aprendidaEm.getTime() - a.aprendidaEm.getTime())
        .map((l) => ({ id: l.id, categoria: l.categoria, categoriaNome: CATEGORIAS_DE_APRENDIZADO.find((c) => c.id === l.categoria)?.nome ?? l.categoria, texto: l.texto, agente: l.agente, quando: l.aprendidaEm.toISOString() })),
    },
    contestacoes: contestacoes.map((c) => ({ id: c.id, seq: c.auditSeq, motivo: c.motivo, status: c.status, resposta: c.resposta, quando: c.criadaEm })),
    // Abertas primeiro; das encerradas, só as 10 mais recentes (o resto está em "Baixar meus dados").
    missoes: listaDeMissoes,
    identificacao,
    geradoEm: agora.toISOString(),
  };
}

export interface ConexaoNoPainel {
  id: string;
  nome: string;
  explicacao: string;
  /** Servidor sem integração configurada: a pessoa vê o que existe, mas não conecta. */
  disponivel: boolean;
  conectada: boolean;
  conectadaEm: string | null;
  ferramentas: { nome: string; descricao: string; risco: string }[];
  /**
   * Origem para onde o app pode mandar a pessoa ao conectar (a tela de autorização). O app só
   * redireciona se a URL devolvida pelo servidor for https nesta origem exata.
   */
  autorizaEm: string;
}

/** As integrações do catálogo, cada uma com o estado da pessoa. Nunca leva credencial. */
export function conexoesNoPainel(conectadas: readonly { integracao: string; conectada_em: unknown }[], disponivel: boolean): ConexaoNoPainel[] {
  return INTEGRACOES.map((i) => {
    const c = conectadas.find((x) => x.integracao === i.id);
    return {
      id: i.id,
      nome: i.nome,
      explicacao: i.explicacao,
      disponivel,
      conectada: !!c,
      conectadaEm: c ? new Date(c.conectada_em as string | Date).toISOString() : null,
      ferramentas: i.ferramentas.map((f) => ({ nome: f.name, descricao: f.description, risco: riscoEmPortugues(f.category === "DESTRUCTIVE" || f.category === "FINANCIAL" || f.category === "LEGAL" ? "CRITICAL" : f.risk)! })),
      autorizaEm: "https://accounts.google.com",
    };
  });
}

/** Cartões dos servidores MCP que a pessoa conecta com a conta dela (OAuth), só os da lista do dono. */
export function conexoesMcpNoPainel(
  servidores: readonly { id: string; nome: string; ferramentas: readonly string[]; usuarios: ReadonlySet<string>; oauth?: { issuer: string } }[],
  conectadas: readonly { integracao: string; conectada_em: unknown }[],
  userId: string,
): ConexaoNoPainel[] {
  return servidores
    .filter((s) => s.oauth && s.usuarios.has(userId))
    .map((s) => {
      const c = conectadas.find((x) => x.integracao === s.id);
      return {
        id: s.id,
        nome: s.nome,
        explicacao: `Ler, no ${s.nome}, o que as ferramentas listadas pelo dono do servidor mostram, com a sua conta de lá. Só leitura.`,
        disponivel: true,
        conectada: !!c,
        conectadaEm: c ? new Date(c.conectada_em as string | Date).toISOString() : null,
        ferramentas: s.ferramentas.map((f) => ({ nome: f, descricao: "leitura", risco: riscoEmPortugues("LOW")! })),
        // A tela de autorização é a do emissor que o DONO configurou (o endpoint da descoberta é conferido na mesma origem).
        autorizaEm: new URL(s.oauth!.issuer).origin,
      };
    });
}

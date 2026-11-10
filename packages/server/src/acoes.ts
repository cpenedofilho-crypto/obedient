// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// As ações que o app manda. Cada uma é gravada PRIMEIRO no aparelho (fila) e só depois enviada; a
// tela nunca espera a rede. Por isso toda ação carrega um `opId` gerado no aparelho e o servidor
// guarda o resultado em obedient.client_ops: reenviar a mesma ação devolve o mesmo resultado, sem
// fazer de novo (o padrão client_op_id do Ronda).
//
// Recusa do motor (proposta vencida, já decidida, reautenticação faltando) é resultado DEFINITIVO:
// fica guardada e o aparelho não tenta de novo. Só erro de infraestrutura volta como falha
// temporária, para o aparelho reenviar depois.

import { ObedientError } from "@obedient/core";
import { CONSTITUTION_VERSION } from "@obedient/ethics-engine";
import { type Sessao, apagarMeusDados, contestar, gravarIdentificacao } from "@obedient/store-postgres";
import { INTEGRACOES, retirarAutoridade, tirarConexoes } from "@obedient/integrations";
import type { Contexto } from "./contexto.ts";

/** O agente que trabalha nas missões que a pessoa pede pelo app. */
export const AGENTE_PADRAO = "obedient";

export type Acao =
  | { opId: string; tipo: "aprovar"; propostaId: string; hash: string }
  | { opId: string; tipo: "recusar"; propostaId: string }
  | { opId: string; tipo: "parar" }
  | { opId: string; tipo: "liberar" }
  | { opId: string; tipo: "revogar"; autorizacaoId: string }
  | { opId: string; tipo: "ligar_aprendizado"; categoria: string; especifico?: boolean }
  | { opId: string; tipo: "desligar_aprendizado"; categoria: string }
  | { opId: string; tipo: "esquecer"; licaoId: string }
  | { opId: string; tipo: "contestar"; seq: number; motivo: string }
  | { opId: string; tipo: "apagar_tudo" }
  | { opId: string; tipo: "criar_missao"; objetivo: string; tetoCentavos?: number }
  | { opId: string; tipo: "cancelar_missao"; missaoId: string }
  | { opId: string; tipo: "tentar_de_novo"; missaoId: string; novoTetoCentavos?: number }
  | { opId: string; tipo: "identificacao"; texto: string }
  | { opId: string; tipo: "desconectar"; integracao: string };

export type ResultadoAcao = { ok: true; tipo: Acao["tipo"] } | { ok: false; tipo: Acao["tipo"]; codigo: string; mensagem: string };

const OP_ID = /^[A-Za-z0-9_-]{8,64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[0-9a-f]{64}$/;

/** Validação da entrada. Devolve a ação tipada ou a lista de problemas. */
/** `outras`: ids de conexão que não são do Google (servidores MCP com OAuth da pessoa). */
export function lerAcao(corpo: unknown, outras: readonly string[] = []): Acao | string[] {
  const o = (corpo && typeof corpo === "object" ? corpo : {}) as Record<string, unknown>;
  const erros: string[] = [];
  if (typeof o.opId !== "string" || !OP_ID.test(o.opId)) erros.push("opId inválido");
  const id = (k: string) => {
    if (typeof o[k] !== "string" || !ID.test(o[k] as string)) erros.push(`${k} inválido`);
  };
  switch (o.tipo) {
    case "aprovar":
      id("propostaId");
      if (typeof o.hash !== "string" || !HASH.test(o.hash)) erros.push("hash inválido");
      break;
    case "recusar":
      id("propostaId");
      break;
    case "revogar":
      id("autorizacaoId");
      break;
    case "ligar_aprendizado":
    case "desligar_aprendizado":
      if (typeof o.categoria !== "string" || !/^[a-z_]{2,32}$/.test(o.categoria)) erros.push("categoria inválida");
      if (o.especifico !== undefined && typeof o.especifico !== "boolean") erros.push("especifico inválido");
      break;
    case "esquecer":
      id("licaoId");
      break;
    case "contestar":
      if (!Number.isInteger(o.seq) || (o.seq as number) < 1) erros.push("seq inválido");
      if (typeof o.motivo !== "string" || !o.motivo.trim() || o.motivo.length > 1000) erros.push("motivo inválido");
      break;
    case "criar_missao":
      if (typeof o.objetivo !== "string" || !o.objetivo.trim() || o.objetivo.length > 2000) erros.push("objetivo inválido");
      if (o.tetoCentavos !== undefined && !Number.isInteger(o.tetoCentavos)) erros.push("teto inválido");
      break;
    case "cancelar_missao":
      id("missaoId");
      break;
    case "tentar_de_novo":
      id("missaoId");
      if (o.novoTetoCentavos !== undefined && !Number.isInteger(o.novoTetoCentavos)) erros.push("teto inválido");
      break;
    case "identificacao":
      if (typeof o.texto !== "string" || o.texto.length > 400) erros.push("identificação inválida");
      break;
    case "desconectar":
      if (typeof o.integracao !== "string" || !(INTEGRACOES.some((i) => i.id === o.integracao) || outras.includes(o.integracao))) erros.push("integração desconhecida");
      break;
    case "parar":
    case "liberar":
    case "apagar_tudo":
      break;
    default:
      erros.push("tipo desconhecido");
  }
  if (erros.length) return erros;
  return o as unknown as Acao;
}

/** Mensagens que a pessoa lê quando a ação não pôde ser feita. */
const MENSAGEM: Partial<Record<string, string>> = {
  PROPOSAL_EXPIRED: "O pedido venceu antes da sua resposta. O agente vai precisar pedir de novo.",
  PROPOSAL_NOT_PENDING: "Esse pedido já tinha sido decidido.",
  PROPOSAL_NOT_FOUND: "Esse pedido não existe mais.",
  PAYLOAD_MISMATCH: "O pedido mudou depois que você o viu. Abra de novo para conferir.",
  STRONG_AUTH_REQUIRED: "Esta ação é sensível: confirme que é você com a passkey e aprove de novo.",
  GRANT_NOT_FOUND: "Essa autorização não existe mais.",
  CONSENT_REQUIRED: "Para isso é preciso ligar o aprendizado dessa categoria.",
  EMERGENCY_STOP: "A parada geral do serviço só pode ser liberada pelo operador.",
  INVALID_PAYLOAD: "Não deu para fazer isso. Confira e tente de novo.",
};

/** Quando a mesma recusa quer dizer outra coisa conforme a ação. */
const MENSAGEM_POR_TIPO: Partial<Record<Acao["tipo"], Partial<Record<string, string>>>> = {
  esquecer: { PROPOSAL_NOT_FOUND: "Essa lição já tinha sido apagada." },
  contestar: { PROPOSAL_NOT_FOUND: "Essa entrada não existe na sua trilha." },
  cancelar_missao: { PROPOSAL_NOT_FOUND: "Essa missão não existe mais.", PROPOSAL_NOT_PENDING: "Essa missão já tinha terminado." },
  desconectar: { GRANT_NOT_FOUND: "Essa conexão já tinha sido desfeita." },
  tentar_de_novo: { PROPOSAL_NOT_FOUND: "Essa missão não existe mais.", PROPOSAL_NOT_PENDING: "Essa missão não está parada esperando você." },
};

async function executar(ctx: Contexto, s: Sessao, a: Acao): Promise<void> {
  const { tx, motor: m, memoria, missoes, clock } = ctx;
  const eu = { id: s.userId, kind: "user" as const, strongAuth: s.strongAuth };
  switch (a.tipo) {
    case "aprovar":
      await m.approve(a.propostaId, eu, a.hash);
      return;
    case "recusar":
      await m.reject(a.propostaId, eu);
      return;
    case "parar":
      await m.stop.engage({ kind: "user", userId: s.userId }, s.userId, "acionada pela pessoa no app");
      return;
    case "liberar": {
      // Liberar é o sentido inseguro: exige passkey recente. Sem isto, outra sessão aberta (um aparelho
      // perdido) soltaria a parada que a pessoa acionou noutro aparelho.
      if (!s.strongAuth) throw new ObedientError("STRONG_AUTH_REQUIRED", "liberar o agente exige confirmar que é você");
      const atual = await m.stop.blockingScope(s.userId);
      if (atual?.scope.kind === "global") throw new ObedientError("EMERGENCY_STOP", "parada global");
      if (!atual) return; // já liberada: nada a fazer
      await m.stop.release({ kind: "user", userId: s.userId }, s.userId, "user");
      await m.audit.record({ userId: s.userId, actor: `user:${s.userId}`, event: "emergency_stop.released", outcome: "released", constitutionVersion: CONSTITUTION_VERSION });
      return;
    }
    case "revogar": {
      const revogados = await m.grants.revoke(a.autorizacaoId, s.userId);
      await m.audit.record({
        userId: s.userId,
        actor: `user:${s.userId}`,
        event: "grant.revoke",
        outcome: "revoked",
        grantId: a.autorizacaoId,
        reasons: [revogados.length > 1 ? `junto com ${revogados.length - 1} repassada(s) a outro agente` : "pelo app"],
        constitutionVersion: CONSTITUTION_VERSION,
      });
      return;
    }
    case "ligar_aprendizado":
      await memoria.ligar(s.userId, a.categoria, { especifico: a.especifico === true });
      return;
    case "desligar_aprendizado":
      await memoria.desligar(s.userId, a.categoria);
      return;
    case "esquecer":
      if (!(await memoria.esquecer(s.userId, a.licaoId))) throw new ObedientError("PROPOSAL_NOT_FOUND", "lição inexistente");
      return;
    case "contestar":
      await contestar(tx, m.audit, s.userId, a.seq, a.motivo, clock);
      return;
    case "apagar_tudo":
      await tirarConexoes(tx, s.userId, "apagar o que o OBEDIENT sabe"); // grants e consentimentos: a função de apagar revoga todos
      await apagarMeusDados(tx, m.audit, s.userId, clock);
      return;
    case "desconectar": {
      const tiradas = await tirarConexoes(tx, s.userId, "desconectada pela pessoa", a.integracao);
      if (!tiradas.length) throw new ObedientError("GRANT_NOT_FOUND", "não estava conectada");
      await retirarAutoridade(m, s.userId, a.integracao);
      await m.audit.record({ userId: s.userId, actor: `user:${s.userId}`, event: "connection.removed", outcome: "revoked", systemId: a.integracao, constitutionVersion: CONSTITUTION_VERSION });
      return;
    }
    case "criar_missao":
      await missoes.criar(s.userId, AGENTE_PADRAO, a.objetivo, a.tetoCentavos !== undefined ? { tetoCustoCentavos: a.tetoCentavos } : {});
      return;
    case "cancelar_missao":
      await missoes.cancelarPelaPessoa(s.userId, a.missaoId);
      return;
    case "tentar_de_novo":
      await missoes.tentarDeNovo(s.userId, a.missaoId, a.novoTetoCentavos !== undefined ? { novoTetoCentavos: a.novoTetoCentavos } : {});
      return;
    case "identificacao":
      await gravarIdentificacao(tx, s.userId, a.texto, clock);
      return;
  }
}

/**
 * Faz a ação uma vez só. Roda dentro da transação do usuário: a ação, a trilha e o registro do
 * resultado entram juntos no commit.
 */
export async function aplicarAcao(ctx: Contexto, s: Sessao, a: Acao): Promise<{ resultado: ResultadoAcao; repetida: boolean }> {
  const { tx, clock } = ctx;
  const ja = await tx.query<{ result: ResultadoAcao }>("select result from obedient.client_ops where user_id = $1 and op_id = $2", [s.userId, a.opId]);
  if (ja.rows[0]) return { resultado: ja.rows[0].result, repetida: true };

  let resultado: ResultadoAcao;
  try {
    await executar(ctx, s, a);
    resultado = { ok: true, tipo: a.tipo };
  } catch (e) {
    if (!(e instanceof ObedientError)) throw e; // infraestrutura: rollback, o aparelho tenta de novo
    resultado = { ok: false, tipo: a.tipo, codigo: e.code, mensagem: MENSAGEM_POR_TIPO[a.tipo]?.[e.code] ?? MENSAGEM[e.code] ?? e.message };
  }
  await tx.query("insert into obedient.client_ops (user_id, op_id, kind, result, created_at) values ($1, $2, $3, $4::jsonb, $5)", [
    s.userId,
    a.opId,
    a.tipo,
    JSON.stringify(resultado),
    clock.now(),
  ]);
  return { resultado, repetida: false };
}

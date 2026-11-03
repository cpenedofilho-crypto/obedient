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

import { type Clock, ObedientError } from "@obedient/core";
import { CONSTITUTION_VERSION, type EthicsEngine } from "@obedient/ethics-engine";
import type { Executor, Sessao } from "@obedient/store-postgres";

export type Acao =
  | { opId: string; tipo: "aprovar"; propostaId: string; hash: string }
  | { opId: string; tipo: "recusar"; propostaId: string }
  | { opId: string; tipo: "parar" }
  | { opId: string; tipo: "liberar" }
  | { opId: string; tipo: "revogar"; autorizacaoId: string };

export type ResultadoAcao = { ok: true; tipo: Acao["tipo"] } | { ok: false; tipo: Acao["tipo"]; codigo: string; mensagem: string };

const OP_ID = /^[A-Za-z0-9_-]{8,64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[0-9a-f]{64}$/;

/** Validação da entrada. Devolve a ação tipada ou a lista de problemas. */
export function lerAcao(corpo: unknown): Acao | string[] {
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
    case "parar":
    case "liberar":
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
  EMERGENCY_STOP: "A parada geral do serviço só pode ser liberada pelo operador.",
};

async function executar(m: EthicsEngine, s: Sessao, a: Acao): Promise<void> {
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
  }
}

/**
 * Faz a ação uma vez só. Roda dentro da transação do usuário: a ação, a trilha e o registro do
 * resultado entram juntos no commit.
 */
export async function aplicarAcao(tx: Executor, m: EthicsEngine, s: Sessao, a: Acao, clock: Clock): Promise<{ resultado: ResultadoAcao; repetida: boolean }> {
  const ja = await tx.query<{ result: ResultadoAcao }>("select result from obedient.client_ops where user_id = $1 and op_id = $2", [s.userId, a.opId]);
  if (ja.rows[0]) return { resultado: ja.rows[0].result, repetida: true };

  let resultado: ResultadoAcao;
  try {
    await executar(m, s, a);
    resultado = { ok: true, tipo: a.tipo };
  } catch (e) {
    if (!(e instanceof ObedientError)) throw e; // infraestrutura: rollback, o aparelho tenta de novo
    resultado = { ok: false, tipo: a.tipo, codigo: e.code, mensagem: MENSAGEM[e.code] ?? e.message };
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

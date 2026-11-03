// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Exportação dos dados da pessoa (Art. 13; LGPD art. 18, II e V): tudo o que o OBEDIENT tem sobre
// ela, em JSON (formato aberto), lido com a RLS da sessão. Leva junto a trilha inteira e o resultado
// da verificação da cadeia, para que a pessoa possa conferir fora daqui que nada foi alterado.

import { CONSTITUTION_VERSION, type EthicsEngine, verifyChain } from "@obedient/ethics-engine";
import { type Executor, contestacoes, memoriaNaTransacao } from "@obedient/store-postgres";

export const FORMATO_EXPORTACAO = "obedient-exportacao/1";

export async function exportarDados(tx: Executor, m: EthicsEngine, userId: string, agora: Date) {
  const memoria = memoriaNaTransacao(tx, m);
  const trilha = await m.audit.forUser(userId);
  let trilhaIntegra: boolean;
  try {
    trilhaIntegra = verifyChain(trilha);
  } catch {
    trilhaIntegra = false;
  }
  const parada = await m.stop.blockingScope(userId);
  return {
    formato: FORMATO_EXPORTACAO,
    geradoEm: agora.toISOString(),
    usuario: userId,
    constituicao: CONSTITUTION_VERSION,
    explicacao:
      "Tudo o que o OBEDIENT guarda sobre você. A trilha é encadeada por hash: cada entrada traz o hash da anterior, e 'trilhaIntegra' diz se a cadeia confere. Consentimentos revogados continuam aqui como registro de que houve consentimento.",
    parada: parada ? { global: parada.scope.kind === "global", desde: parada.state.engagedAt, motivo: parada.state.reason } : null,
    autorizacoes: await m.grants.list(userId),
    consentimentos: await m.consent.export(userId),
    pedidos: await todasAsPropostas(tx, userId),
    aprendizado: { categorias: await memoria.categorias(userId), licoes: await memoria.listar(userId) },
    contestacoes: await contestacoes(tx, userId),
    trilha,
    trilhaIntegra,
  };
}

/** Todas as propostas da pessoa, inclusive as decididas (o motor só lista as pendentes). */
async function todasAsPropostas(tx: Executor, userId: string) {
  const { rows } = await tx.query(
    "select id, requested_by, payload, payload_hash, summary, approver, reason, grant_id, created_at, expires_at, status, decided_by, decided_at, executed_at from obedient.proposals where user_id = $1 order by created_at, id",
    [userId],
  );
  return rows;
}

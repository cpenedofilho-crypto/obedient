// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Memória pessoal e direitos do titular sobre Postgres (Arts. 10 e 13). Tudo roda na transação da
// sessão (comoUsuario): a RLS decide o que cada consulta enxerga.

import { type Clock, type IdFactory, ObedientError, systemClock, uuid } from "@obedient/core";
import { type AuditTrail, CONSTITUTION_VERSION } from "@obedient/ethics-engine";
import { type CategoriaDeAprendizado, type Licao, Memoria, type MemoryStore } from "@obedient/memory";
import type { EthicsEngine } from "@obedient/ethics-engine";
import type { Executor } from "./db.ts";

interface LinhaMemoria {
  id: string;
  user_id: string;
  categoria: CategoriaDeAprendizado;
  texto: string;
  agente: string;
  aprendida_em: unknown;
}

export class PgMemoryStore implements MemoryStore {
  constructor(private readonly tx: Executor) {}
  async insert(l: Licao): Promise<void> {
    await this.tx.query("insert into obedient.memories (id, user_id, categoria, texto, agente, aprendida_em) values ($1,$2,$3,$4,$5,$6)", [l.id, l.userId, l.categoria, l.texto, l.agente, l.aprendidaEm]);
  }
  async listByUser(userId: string): Promise<Licao[]> {
    const { rows } = await this.tx.query<LinhaMemoria>("select * from obedient.memories where user_id = $1 order by aprendida_em, id", [userId]);
    return rows.map((r) => ({ id: r.id, userId: r.user_id, categoria: r.categoria, texto: r.texto, agente: r.agente, aprendidaEm: new Date(r.aprendida_em as string | Date) }));
  }
  async delete(userId: string, id: string): Promise<boolean> {
    return (await this.tx.query("delete from obedient.memories where user_id = $1 and id = $2 returning id", [userId, id])).rows.length > 0;
  }
  async deleteWhere(userId: string, categoria: CategoriaDeAprendizado | null): Promise<number> {
    return (await this.tx.query("delete from obedient.memories where user_id = $1 and ($2::text is null or categoria = $2) returning id", [userId, categoria])).rows.length;
  }
}

/** A memória da pessoa nesta transação, com o consentimento e a trilha do mesmo motor. */
export function memoriaNaTransacao(tx: Executor, motor: EthicsEngine, clock: Clock = systemClock): Memoria {
  return new Memoria(new PgMemoryStore(tx), motor.consent, motor.audit, clock);
}

export interface Contestacao {
  id: string;
  auditSeq: number;
  motivo: string;
  criadaEm: string;
  status: "aberta" | "respondida";
  resposta: string | null;
  respondidaEm: string | null;
}

export const MAX_MOTIVO_CONTESTACAO = 1000;

/** A pessoa contesta uma entrada da própria trilha (Art. 13). O motivo não vai para a trilha. */
export async function contestar(tx: Executor, audit: AuditTrail, userId: string, auditSeq: number, motivo: string, clock: Clock = systemClock, newId: IdFactory = uuid): Promise<Contestacao> {
  const texto = typeof motivo === "string" ? motivo.trim() : "";
  if (!Number.isInteger(auditSeq) || auditSeq < 1) throw new ObedientError("INVALID_PAYLOAD", "entrada da trilha inválida");
  if (!texto || texto.length > MAX_MOTIVO_CONTESTACAO) throw new ObedientError("INVALID_PAYLOAD", `diga o que está errado em até ${MAX_MOTIVO_CONTESTACAO} caracteres`);
  // A entrada tem de existir na trilha do próprio usuário (a RLS esconde a dos outros).
  const existe = await tx.query("select 1 from obedient.audit_log where user_id = $1 and seq = $2", [userId, auditSeq]);
  if (!existe.rows.length) throw new ObedientError("PROPOSAL_NOT_FOUND", "essa entrada não existe na sua trilha");
  const c: Contestacao = { id: newId(), auditSeq, motivo: texto, criadaEm: clock.now().toISOString(), status: "aberta", resposta: null, respondidaEm: null };
  await tx.query("insert into obedient.contestations (id, user_id, audit_seq, motivo, criada_em) values ($1,$2,$3,$4,$5)", [c.id, userId, auditSeq, texto, clock.now()]);
  await audit.record({ userId, actor: `user:${userId}`, event: "action.contested", outcome: "info", reasons: [`entrada ${auditSeq} contestada`], constitutionVersion: CONSTITUTION_VERSION });
  return c;
}

export async function contestacoes(tx: Executor, userId: string): Promise<Contestacao[]> {
  const { rows } = await tx.query<{ id: string; audit_seq: number; motivo: string; criada_em: unknown; status: Contestacao["status"]; resposta: string | null; respondida_em: unknown }>(
    "select * from obedient.contestations where user_id = $1 order by criada_em, id",
    [userId],
  );
  const iso = (v: unknown) => (v ? new Date(v as string | Date).toISOString() : null);
  return rows.map((r) => ({ id: r.id, auditSeq: r.audit_seq, motivo: r.motivo, criadaEm: iso(r.criada_em)!, status: r.status, resposta: r.resposta, respondidaEm: iso(r.respondida_em) }));
}

export interface ResultadoApagar {
  memorias: number;
  pedidos: number;
  autorizacoes: number;
  consentimentos_revogados: number;
  acoes_do_aparelho: number;
}

/** "Apague o que você sabe sobre mim" (Art. 13), num passo. Ver obedient.apagar_meus_dados(). */
export async function apagarMeusDados(tx: Executor, audit: AuditTrail, userId: string, clock: Clock = systemClock): Promise<ResultadoApagar> {
  const { rows } = await tx.query<{ r: ResultadoApagar }>("select obedient.apagar_meus_dados($1) as r", [clock.now()]);
  const r = rows[0]!.r;
  await audit.record({
    userId,
    actor: `user:${userId}`,
    event: "user.data_erased",
    outcome: "info",
    reasons: [`${r.memorias} lição(ões), ${r.pedidos} pedido(s) esvaziado(s), ${r.autorizacoes} autorização(ões) encerrada(s)`],
    constitutionVersion: CONSTITUTION_VERSION,
  });
  return r;
}
